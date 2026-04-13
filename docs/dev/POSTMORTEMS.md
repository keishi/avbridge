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
