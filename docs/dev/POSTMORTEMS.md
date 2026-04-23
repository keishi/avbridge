# Postmortems

A running log of bugs that were hard enough to root-cause that the next
engineer deserves a written account. Each entry captures:

- **Symptom** — what the user actually experienced
- **Initial hypothesis** — what we thought was wrong (and why it wasn't)
- **Root cause** — the actual bug
- **Fix** — the change that made the symptom go away
- **Generalizable lesson** — the pattern to watch for elsewhere

---

## 2026-04-12 — Fallback audio chop: stacked samples in `scheduleNow`

**Affected code:** `src/strategies/fallback/audio-output.ts`
**Ships in:** 2.2.0
**Triage time:** ~2 hours

### Symptom

When playing a software-decoded source (RealVideo rv40 @ 1024×768 from
an RMVB container was the trigger, but the bug was general to all
software-decode-bound content), audio came out as a rapid sequence of
clicks and chopping instead of the decoded stream. Video frames rendered
correctly — just at whatever rate the decoder could manage — while audio
was unlistenable.

The user's reported shape was "video is smoother but audio is very
choppy." Diagnostics showed:

```json
{
  "videoFramesDecoded": 488,
  "audioFramesDecoded": 578,
  "audioState": "playing",
  "bufferAhead": 0,
  "framesScheduled": 578
}
```

`bufferAhead: 0` was the tell: the audio scheduler was fully drained
despite 578 audio frames having been pushed through. Something was
discarding or corrupting the scheduling.

### Initial hypotheses (and why each was wrong)

1. **"Pump decodes video before audio, starving the scheduler."** We
   reordered the pump to decode audio first. It helped for *throughput*
   (less audio underrun during long video-decode windows) but the
   clicking chop remained when the decoder fell behind realtime at all.

2. **"`ff_decode_multi` is hitting AVERROR_INVALIDDATA and dropping
   packets."** There *were* a few per-packet errors logged, but the
   `ignoreErrors: true` flag was already passed and the stat counters
   showed audio frames were reaching the scheduler.

3. **"Sample-rate mismatch with `AudioContext.sampleRate` causes
   resampling artifacts."** Web Audio's automatic resampler is smooth;
   it doesn't produce clicks on sample-rate mismatch. Not it.

### Root cause

`AudioOutput.scheduleNow()` built a fresh `AudioBufferSourceNode` per
decoded chunk and scheduled it at a ctx-time computed from an anchor:

```ts
const ctxStart = this.ctxTimeAtAnchor + (this.mediaTimeOfNext - this.mediaTimeOfAnchor);
const safeStart = Math.max(ctxStart, this.ctx.currentTime);
node.start(safeStart);
this.mediaTimeOfNext += frameCount / sampleRate;
```

The anchor model assumes the decoder keeps pace with realtime — each
new `ctxStart` lands in the future relative to `ctx.currentTime`, so
each sample is scheduled just-in-time. Fine for fast decoders.

When the decoder falls behind (rv40 @ 720p+ decodes at ~2 fps on
single-threaded WASM), `ctxStart` falls into the past. The old code
"saved" this case with `Math.max(ctxStart, ctx.currentTime)`, which
looks reasonable — "don't schedule a sample with a past start time,
clamp to now."

**But clamping is wrong for a burst.** When the pump hands the
scheduler 20 stale sample buffers in one cycle (which happens any time
the decoder catches up and flushes its backlog), every single one gets
clamped to the *same* `ctx.currentTime` value. Web Audio dutifully
starts all 20 `AudioBufferSourceNode`s at that exact instant. They play
**on top of each other**, stacking as a chord of overlapping clicks
instead of a sequential audio stream.

`mediaTimeOfNext` still advances by each chunk's duration, but
`ctxTimeAtAnchor` does not, so the second, third, …, twentieth
computations of `ctxStart` also fall behind `ctx.currentTime` and also
clamp to the same "now." The drift is never resolved.

### Fix

Rebase the anchor when `ctxStart` falls behind, so the *first* lagging
sample starts at NOW and all subsequent samples in the burst compute
their `ctxStart` from a fresh anchor — landing at `NOW + offset` and
laying out sequentially on the timeline.

```ts
let ctxStart = this.ctxTimeAtAnchor + (this.mediaTimeOfNext - this.mediaTimeOfAnchor);

if (ctxStart < this.ctx.currentTime) {
  // Decoder fell behind. Rebase the anchor forward so subsequent
  // samples in the same burst schedule at NOW + offset instead of
  // all clamping to NOW.
  this.ctxTimeAtAnchor = this.ctx.currentTime;
  this.mediaTimeOfAnchor = this.mediaTimeOfNext;
  ctxStart = this.ctx.currentTime;
}

node.start(ctxStart);
this.mediaTimeOfNext += frameCount / sampleRate;
```

The visible side effect is that `now()` (the master media clock)
**jumps forward** when a rebase happens. The video renderer reads the
same clock, so it just drops any frames older than the new time — which
is correct behavior for catching up after lag.

### Generalizable lesson

**When scheduling a batch of time-sensitive events on a shared
timeline, `Math.max(scheduled, now)` is not a clamp — it's a stacking
hazard.**

The pattern shows up anywhere you build scheduled-time from an anchor:
Web Audio, `requestAnimationFrame`, `setTimeout` chains,
animation keyframes, WebTransport sends. The failure mode is that when
a burst of events falls behind, they all collapse onto the current
moment and either overwrite each other or produce a single undifferentiated
spike.

**The fix is always "rebase the anchor on the first lagging event, then
let subsequent events in the same burst schedule sequentially relative
to the new anchor."** Don't try to clamp per event. Don't try to
redistribute them across a smooth interval. Accept the catch-up as a
visible jump in the clock.

The bug had survived in the fallback strategy since the day it was
written because every test the author ran locally used files that
decoded faster than realtime on their hardware. It only surfaced when
a consumer tried a file the decoder *couldn't* keep up with. This is
another argument for running the software decoder against deliberately
hard content (high resolution, legacy codec families) as part of
regular testing — "it works on my machine" doesn't catch it.

### Other bugs fixed in the same session for completeness

1. **Cold-start gate required audio before starting playback.** On
   RM/AVI containers, the demuxer delivers a video GOP before the
   first audio packet, so the gate would wait out its full 10-second
   safety timeout on every file. Fix: add a "video ready + 500 ms
   grace period for audio" exit path.

2. **Audio decoded after video in each pump cycle.** When video decode
   takes 200-400 ms per batch (rv40 @ 720p+), the audio scheduler runs
   dry for that entire window. Fix: reorder so audio is always
   decoded first in each pump iteration. Audio decode is <1 ms per
   packet, so doing it first barely affects video throughput.

3. **Decoder read batch size was 64 KB.** At typical RV40 bitrates, a
   single 64 KB batch could produce 30+ frames in one `ff_decode_multi`
   call, blowing past the renderer's 64-frame hard cap before the
   per-batch `queueHighWater` throttle could apply backpressure.
   ~30% of frames dropped as overflow. Fix: revert to 16 KB batches.

See commit `b3fc2fb` for the full diff.

---

## 2026-04-13 — Hybrid A/V desync: clock domain drift between video PTS and AudioContext

**Affected code:** `src/strategies/fallback/video-renderer.ts`, `src/strategies/hybrid/decoder.ts`
**Ships in:** post-2.2.1 (pre-2.3.0)
**Triage time:** ~4 hours across multiple iterations

### Symptom

Playing a 1h48m Blu-ray MKV (H.264 + DTS, 1920×804, 24fps) via the
hybrid strategy (WebCodecs video + libav audio). Three symptoms:

1. **After seeking 45 minutes in**, video stuttered at ~3 fps with
   hundreds of dropped frames. Diagnostics showed `framesDroppedLate:
   459` in a single session.
2. **During continuous playback**, audio gradually drifted ahead of
   video — noticeable after ~30 seconds, severe after 2 minutes.
3. **Intermittent post-seek freeze** — after some seeks, the renderer
   dropped the entire initial GOP (34 frames) and showed nothing for
   ~1.5 seconds.

Debug logging added to the renderer showed the raw numbers:

```
position=0s:    rawDrift=+76ms     (fine)
position=496s:  rawDrift=-4614ms   (4.6 seconds behind!)
position=2730s: rawDrift=-6507ms   (6.5 seconds behind!)
```

### Initial hypotheses (and why each failed)

1. **"The pump decodes audio after video, starving the renderer."**
   Reordered to audio-first (same fix as postmortem #1). Helped with
   DTS-specific jank but didn't fix the drift.

2. **"rAF quantization causes 3:2 pulldown at 60Hz."** Replaced
   wall-clock pacing with PTS-based frame selection. Eliminated the
   pulldown stutter but exposed the underlying drift — now instead of
   slow steady drift, frames were mass-dropped as "late."

3. **"EMA-smoothed calibration can track the drift."** Measured
   `offset = paintedPTS - rawAudioNow` and smoothed with alpha=0.05.
   **Failed: feedback loop.** The measured offset already included the
   calibration (because the renderer paints the frame that the
   calibrated clock says is "on time"), so the EMA converged to
   whatever value it started at and drifted along with the error.

4. **"Two-point rate correction can measure the real clock ratio."**
   Recorded PTS and audio positions at two points 2 seconds apart,
   computed `rate = ptsDelta / audioDelta`. **Failed: measured during
   queue fill burst.** WebCodecs delivered 30 frames in 200ms during
   startup, so the PTS advanced 30 frames while only 200ms of audio
   time passed → computed rate=1.081 instead of the real ~1.001.

### Root cause

**Video PTS and AudioContext.currentTime are in different clock
domains with a systematic rate difference.**

- Video PTS: derived from the MKV file's timebase (1/1000s), set by
  the encoder, converted to microseconds by libav → WebCodecs
- Audio clock: `AudioContext.currentTime`, driven by the sound card's
  hardware oscillator

These two clocks drift ~7ms per second of media time (~0.7%). The
drift appears as a large absolute offset when seeking deep into the
file (0.7% × 3600s = 25.2s theoretical maximum for a 1-hour file).

The renderer compared `frame.timestamp` (video domain) against
`audio.now()` (audio domain) without accounting for the offset. At
the start of the file the offset was small (~76ms, invisible). After
seeking to 45 minutes, the accumulated offset was 6.5 seconds — every
frame appeared "6.5 seconds late" and was dropped.

### Fix

**Periodic re-snap calibration.** On first paint after start/seek,
snap a calibration offset:

```ts
ptsCalibrationUs = headPTS - rawAudioNowUs;
```

Then re-snap every 10 seconds. Between snaps, drift accumulates at
most 70ms (10s × 7ms/s), which is below the human lip-sync
perception threshold (~100ms). Each snap is independent — no feedback
loop, no rate estimation, no EMA.

```ts
if (!ptsCalibrated || wallNow - lastCalibrationWall > 10_000) {
  ptsCalibrationUs = headTs - rawAudioNowUs;
  ptsCalibrated = true;
  lastCalibrationWall = wallNow;
}
const audioNowUs = rawAudioNowUs + ptsCalibrationUs;
```

Calibration resets on `flush()` (seek) so the first post-seek frame
calibrates before any PTS-based dropping occurs.

Result: zero drops across all tested seek positions (8min, 23min,
38min, 61min, 83min) on the 1h48m Blu-ray MKV.

### Other bugs fixed in the same session

1. **DTS audio not recognized.** mediabunny probe returned `"unknown"`
   for DTS. Fix: re-probe with libav when mediabunny returns unknown
   codecs. Added `"dts"` and `"truehd"` to AudioCodec type and
   FALLBACK_AUDIO_CODECS.

2. **Wrong strategy for native video + fallback audio.** H.264 + DTS
   was routed to full WASM fallback (unwatchable at 1080p). Fix: route
   to hybrid (WebCodecs video + libav audio) when video is native but
   audio needs fallback.

3. **Wrong libav variant loaded.** Hybrid decoder loaded `webcodecs`
   variant (no DTS decoder) instead of `avbridge`. Fix: rewrite
   variant picker to use allowlist (webcodecs-compatible codecs)
   instead of denylist.

4. **Audio decoded after video in hybrid pump.** DTS decode blocks
   the main thread for 10-50ms, starving the renderer's rAF. Fix:
   audio-first pump ordering + 4-packet sub-batches with yields.

### Generalizable lesson

**When comparing timestamps from two unsynchronized clock domains,
absolute synchronization is impossible. The only viable solution is
periodic re-alignment bounded by human perception.**

The tempting approaches — continuous estimation (EMA), rate correction
(two-point measurement), fixed calibration — all fail for different
reasons:

- **EMA**: if the measured quantity includes the correction, you get a
  feedback loop
- **Rate measurement**: needs steady-state data, but startup/seek
  transients corrupt the signal
- **Fixed offset**: handles epoch but not rate drift

The correct model is: **treat calibration as a stateless periodic
snap, not a continuously learned value.** Each snap is independent,
has no memory of previous snaps, and bounds the maximum error to
`drift_rate × snap_interval`. Choose the interval so that bound stays
below the human perception threshold for the modality (lip sync:
~100ms, audio continuity: ~20ms, visual continuity: ~40ms).

This is how professional media players handle it too — audio is the
master clock, video is periodically re-anchored to it, and the
re-anchoring is invisible because it happens before drift becomes
perceptible.

---

## 2026-04-23 — DivX/Xvid AVI stutter: `avbsf` fragment missing from libav build

**Affected code:** `scripts/build-libav.sh`, `src/strategies/fallback/decoder.ts`, `src/strategies/hybrid/decoder.ts`
**Ships in:** 2.12.1
**Triage time:** ~30 min once the right log line was noticed

### Symptom

A perfectly ordinary AVI episode (MPEG-4 Part 2 / Xvid video + MP3
audio, 624×352) played through the fallback strategy with ~41% of
frames dropped as "late." User reported "stuttering" on local
filesystem playback — ruling out network. Runtime stats:

```
framesPainted: 180, framesDroppedLate: 124
```

The renderer logs showed a diagnostic PTS pattern:

```
PAINT  rawDrift=119.3ms    (video ahead of audio by ~120ms, normal)
WAIT   rawDrift=706.0ms    (video way ahead — "wait for audio")
...
PAINT  rawDrift=-3494.1ms  (video 3.5s BEHIND audio — backwards jump)
PAINT  rawDrift=-4343.4ms  (4.3s BEHIND)
```

Individual frame PTS values jumping backwards by several seconds is
not a drift problem — it's the decoder emitting frames in *bitstream
order* instead of *display order*.

### Initial hypotheses (and why each was wrong)

1. **"Software decoder is just too slow for 624×352 MPEG-4."** No — at
   that resolution libav WASM should manage realtime easily. And the
   pattern of *backwards PTS jumps* isn't what "too slow" looks like
   (too slow = monotonically late, not zig-zagging).

2. **"A/V calibration is broken."** The calibration snapshot at
   `calib=119.3ms` was correct for the actual audio/video relationship
   at startup. The problem wasn't calibration — it was that *later*
   frames arrived with PTS values calibration couldn't possibly
   reconcile.

### Root cause

A single console line, previously dismissed as a warning:

```
[avbridge] failed to init mpeg4_unpack_bframes BSF:
  e.av_bsf_list_parse_str_js is not a function
```

The `mpeg4_unpack_bframes` bitstream filter rewrites DivX/Xvid packets
that contain two frames packed together (a reference frame immediately
followed by a B-frame that displays *before* it). Without the filter,
the decoder emits the B-frame *after* the reference frame is decoded,
so PTS values come out non-monotonically — often with several-second
backwards jumps.

`scripts/build-libav.sh` listed `"bsf-mpeg4_unpack_bframes"` in the
fragments, which correctly adds `--enable-bsf=mpeg4_unpack_bframes` to
FFmpeg's configure (compiling the BSF C code into the WASM). But it
did **not** include the `"avbsf"` fragment, which is what sets
`-DLIBAVJS_WITH_BSF=1` and links the JS wrapper layer
(`av_bsf_list_parse_str_js`, `av_bsf_init`, `av_bsf_send_packet`,
`av_bsf_receive_packet`).

Net result: the BSF was present in the binary but unreachable from JS.
Every call from the fallback/hybrid decoder threw, was caught, and set
`bsfCtx = null` — decoding proceeded without the filter. The feature
had been "shipped" since 2.2.0 without ever actually running.

Grepping the built `libav-6.8.8.0-avbridge.wasm.mjs` for `av_bsf*`
returned zero matches — every `av_bsf_*` function the decoder expected
was missing, not just the one that threw.

### Fix

Add `"avbsf"` to the fragment list in `scripts/build-libav.sh` and
rebuild the variant. No code changes needed in the decoders — they
were correct all along. Confirm the rebuild worked by grepping the
output `.mjs` for `av_bsf_list_parse_str_js`; the webcodecs variant
(which does include `avbsf`) is the reference for what "working"
looks like.

### Generalizable lesson

**A BSF-style "fix" that's implemented in code but dead at runtime is
worse than no fix at all.** The decoder path compiled, the feature
shipped, the CHANGELOG claimed it worked. The only signal it was dead
was a `console.warn` that looked like a recoverable startup hiccup.

Three specific patterns to watch:

1. **libav.js fragment pairs.** `bsf-X`, `filter-X`, `protocol-X` etc.
   sometimes require a companion wrapper fragment (`avbsf`, `avfilter`,
   `avformat`) to be reachable from JS. Including the C-code fragment
   alone is a common footgun. **Grep the built `.mjs` for the
   functions you plan to call** — if they're missing, the binding
   layer wasn't linked.

2. **"Warning once, works forever" bugs.** An init-time warning that's
   then caught and turned into `feature = null` means the feature is
   silently absent for the entire session. These deserve louder
   treatment: a clear log line *at playback time*, not just at init
   ("no BSF available — B-frame ordering may be wrong"), or a visible
   status in diagnostics.

3. **Backwards-jumping PTS is diagnostic of packet/frame-ordering bugs,
   not clock drift.** When you see `nextPTS` go backwards by more than
   a GOP length, stop looking at the A/V sync code and start looking
   at whether frames are being emitted in the right order. Drift is
   monotonic; packed-B-frame artifacts zig-zag.

---

## 2026-04-23 — Synthetic PTS counter ignores valid neighbors → 40% drop rate on AVIs

**Affected code:** `src/strategies/fallback/decoder.ts`
**Ships in:** 2.12.1
**Triage time:** ~2 hours (most of it spent chasing the wrong hypotheses)

### Symptom

A perfectly healthy 25 fps MPEG-4 Part 2 (Xvid) AVI played back with
~40% of frames dropped as "late" and visibly choppy playback despite
the decoder keeping up with real time. Not a small-scale jitter —
large, several-second PAINT events with `nextPTS` values up to
**six seconds behind the audio clock**, interleaved with normal-looking
paints. User experience: the video looked like it was stuttering and
occasionally rewinding.

The smoking-gun log line:

```
PAINT q=15  calibAudio=2096ms  nextPTS=1960ms  rawDrift=-16.7ms  dropped=17
PAINT q=27  calibAudio=21429ms nextPTS=15400ms rawDrift=-5736ms  dropped=5
```

Each of those is the renderer painting a frame whose PTS is seconds
*behind* the audio clock, and dropping handfuls of even-staler frames
ahead of it.

### Initial hypotheses (and why each was wrong)

1. **"The `mpeg4_unpack_bframes` BSF isn't working."** We found
   earlier that the BSF wrapper functions were missing from the libav
   variant; rebuilt with the `avbsf` fragment. BSF went active. The
   *backwards-by-GOP-length* zig-zag pattern disappeared, but the
   large-scale "paint 5 seconds behind audio" pattern stayed.
   Instructive: fixing one real bug revealed that the dominant
   symptom was something else entirely.

2. **"The FPS probe is wrong."** It was — codecpar framerate wasn't
   being read, so the renderer defaulted to 30 fps instead of 25.
   Fixed. Drop rate unchanged.

3. **"The drop policy is too aggressive."** Added a diagnostic
   `AVBRIDGE_RELAX_DROP` flag that pushes the late-drop threshold out
   to 60 seconds, effectively disabling drops. User reported: no
   visible change. That ruled out the drop *policy* — the frames
   being *painted* were themselves wrong.

4. **"Decoder can't sustain real time."** Instrumented decode
   throughput. Result: 4.8 ms per batch average, slowest batch
   15.6 ms, decoder idle 95 % of the time in the pump throttle.
   Decoder was fast and bored, not starving.

### Root cause

The fallback decoder's `sanitizeFrameTimestamp` callback for invalid
PTSs (`AV_NOPTS_VALUE` output from libav) used a plain counter:

```ts
sanitizeFrameTimestamp(f, () => {
  const ts = syntheticVideoUs;
  syntheticVideoUs += videoFrameStepUs;
  return ts;
}, videoTimeBase);
```

`syntheticVideoUs` was initialized to `0` at bootstrap (or to the
seek-target on seek) and **only advanced when an invalid-PTS frame
appeared**. It did not track the surrounding valid frames.

For a stream where *every* frame has an invalid PTS, this works:
`0, 40, 80, 120 ms…` — synthetic timeline matches real time.

For a stream where *most* frames are valid and *some* are invalid
— which is exactly what libav emits for MPEG-4 Part 2 (occasionally
the decoder has no DTS/PTS info for a frame, especially around B-frame
reordering boundaries) — the counter lags far behind the valid
neighbors. At minute 5 of playback, a single invalid-PTS frame would
be tagged with a PTS near the *start* of the stream (wherever the
counter happened to be).

Those mis-stamped frames then sat in the renderer queue with
wildly-wrong timestamps. The PTS-based paint logic in the renderer
is built on the assumption that `queue[i].timestamp` is monotonic
in `i` — one lookup `bestIdx` loop walks forward and `break`s on
the first out-of-window frame. With a few back-in-time frames
scattered through the queue, the loop's behavior became undefined:
sometimes it'd paint a five-second-stale frame, sometimes it'd
drop a dozen healthy ones around a poisoned anchor.

### Fix

Anchor synthetic timestamps to the most recently emitted frame's PTS
plus one frame step, instead of a free-running counter:

```ts
sanitizeFrameTimestamp(f, () => {
  const base = lastEmittedPtsUs >= 0
    ? lastEmittedPtsUs + videoFrameStepUs
    : syntheticVideoUs;
  syntheticVideoUs = base + videoFrameStepUs;
  return base;
}, videoTimeBase);
```

Invalid-PTS frames now interpolate between their valid neighbors and
stay monotonic. Reset `lastEmittedPtsUs = -1` on seek so the anchor
doesn't carry across discontinuities.

Verification on the same AVI: drop rate went from **331 / 747 (44 %)
to 0 / 298 (0 %)**. Paint rate went from **14–16 fps to 24.8 fps**
(source rate, within rounding). `ptsRegressions` counter added by the
same investigation reports `0` across the full playback.

### Generalizable lessons

1. **Fallback paths that aren't tracked against ground truth silently
   drift.** The synthetic-timestamp counter had no relationship to the
   valid PTS stream around it. A rule of thumb: any value that's used
   in place of missing real data should be *derived* from the most
   recent real value, never from a private counter that forgot what
   the real data looks like.

2. **"Paints a frame from seconds ago" is a timestamp-corruption
   signature, not a sync bug.** A/V sync issues bound drift to tens or
   hundreds of milliseconds. When you see paints that are *seconds*
   behind the audio clock and not correlated with a seek, suspect the
   timestamp pipeline — not the renderer or the clock.

3. **Instrumentation first, hypotheses second.** Four serial hypotheses
   (BSF, fps, drop policy, decoder speed) all *looked* plausible given
   the symptom. The one that was actually true would have been
   impossible to guess; only the `PAINT ... nextPTS=15400` line with
   the regression counter and decode-throughput numbers made it
   visible. When a bug reproduces reliably, the ratio of debugging
   time to instrumentation time should favor instrumentation
   heavily — the hypothesis space is too big to guess through.

4. **Prior bugs can mask downstream bugs.** While the BSF was broken
   (emitting frames out of order), the symptom of the synthetic-PTS
   bug was drowned in the BSF's own chaos. Fixing the BSF made the
   synthetic-PTS bug visible. Expect this pattern — when one real fix
   doesn't resolve a symptom, it often just uncovered the next layer.
