# Postmortems

A running log of bugs that were hard enough to root-cause that the next
engineer deserves a written account. Each entry captures:

- **Symptom** — what the user actually experienced
- **Initial hypothesis** — what we thought was wrong (and why it wasn't)
- **Root cause** — the actual bug
- **Fix** — the change that made the symptom go away
- **Generalizable lesson** — the pattern to watch for elsewhere

---

## 2026-06-01 — Post-seek "fast-forward": synthetic PTS anchored to seek target instead of decoder landing

**Affected code:** `src/strategies/fallback/decoder.ts`
**Ships in:** 2.13.0
**Triage time:** ~4 hours, most of it spent disbelieving the user

### Symptom

On an MPEG-4 ASP + MP3 AVI (Xvid, 25 fps, 1412 s runtime), seeking
deep into the file (target 646.538 s, GOP ~10 s) produced a visible
**~1–2 seconds of fast-forwarded video** immediately after the seek
landed, after which playback returned to normal at the correct
content position. Audio was unaffected — dialogue played at the
correct content time throughout. The artifact only appeared on
seeks; cold start from t=0 played cleanly.

The user's own initial description was telling: *"I see fast
forwarded video frames... like a second or two of it."* Not "wrong
content," not "lip-sync drift" — specifically "racing video."

### Initial hypotheses (and why each was wrong)

1. **"It's 3:2 pulldown judder."** 60 Hz display × 25 fps source
   produces 33 ms / 50 ms Δwall alternation by structural necessity.
   The judder is real, identical pre- and post-seek, and the
   aggregate rate is exactly 1.00× — confirmed by `Σ Δpts / Σ Δwall
   = 1.0002×` over 107 consecutive post-seek paints. **The user kept
   insisting it was fast-forward.** This consumed an hour of "the
   data says you're wrong" before someone (Person C in a review)
   pointed out: the metric measures *label* rate, not *content*
   rate. Labels are synthesized from a monotonic counter, so the
   ratio is forced to ~1.0 whether content is racing or not. We had
   measured nothing about content.

2. **"Constant baked-in offset → permanent lip-sync error."** Once
   the user proved with an ffmpeg ground-truth extraction that the
   frame avbridge labeled `pts=646538` was actually content from
   ~642 s, the next model was "labels are stamped ahead at seek and
   stay that way." This model is internally inconsistent and Person
   C caught it: a *constant* offset produces *permanent* lip-sync
   error at 1×, not 1–2 s of transient fast-forward. The transience
   is the diagnostic clue — *something* has to correct the offset,
   and the correction is what looks like fast-forward.

3. **"3:2 judder + perceptual misinterpretation."** Tempting because
   the data was so clean. Wrong for the same reason as (1) — we'd
   never measured content rate.

### Root cause

Two interacting bugs:

**1. Anchoring synthetic PTS to the user's seek target.** On `seek(T)`
the fallback decoder reset its synthetic-PTS counter:

```ts
syntheticVideoUs = Math.round(timeSec * 1_000_000); // = T µs
lastEmittedPtsUs = -1;
```

The first frame libav emitted post-seek was typically NOPTS (AVI
demuxer + `mpeg4_unpack_bframes` BSF often emit the
keyframe-after-seek without a packet pts). With `lastEmittedPtsUs =
-1`, the sanitize fallback returned `syntheticVideoUs = T` for that
first NOPTS frame. The actual content of that frame was the
keyframe libav landed on, which is wherever the AVI index pointed —
in our test, **~4.6 s before T**. So `pts=646538` got stamped on
content from ~641.9 s. The label was a unilateral lie about content
position.

**2. Sync-on-NOPTS only, not on every emit.** The
`lastEmittedPtsUs + frameStep` chain (the partial fix from
**2026-04-23**) advanced `lastEmittedPtsUs` only on emit. Every
libav-pts frame post-seek had a *real* content time well before the
synthetic-stamped first frame, so they failed the `_fPts <
lastEmittedPtsUs` regression check and got `REGRESSED-DROP`'d
without updating the counter. Net result: the synthetic counter
crawled forward at ~1 / 3 rate (advancing only on the ~1-in-3 NOPTS
P-frames in MPEG-4's B/P interleave), while real content advanced
at 1×. The gap between synthetic labels and real content closed at
~2/3 rate per emit.

### Why this looked like fast-forward

The decoder runs faster than realtime (WASM MPEG-4 decode is
multiples of source rate on a fast CPU). The renderer paints at the
audio clock's rate, picking each tick's `queue[0]`. Because every
3rd emitted frame got an ENQUEUED synthetic label and 2-in-3 got
REGRESSED-DROP'd, the renderer's painted sequence consisted of
**1-in-3 frames spaced 40 ms apart in label, ~120 ms apart in
content**. Content/wall ratio at the screen ≈ **2.4–3×** for the
duration of the catch-up window (~3 s wall). When the labels caught
up to real content, both synthetic and libav frames started
ENQUEUING and rate returned to 1.0×.

Person C's mechanism explained the duration: 4.6 s of content gap
closing at ~13 ms per wall-frame ≈ 350 wall-frames ≈ 1.5 s of
visible fast-forward, then steady-state.

### Fix

Replace synthetic-counter-anchored-to-seekTarget with a content
clock that *syncs to truth on every valid pts, steps on NOPTS, and
never trusts the user's click as a content reference*:

```ts
// On seek: unanchored.
lastContentUs = -1;

// Per emit:
if (lastContentUs < 0) {
  if (rawUs == null) {
    // Pre-anchor NOPTS — we don't know where decoder landed.
    // Discard outright. (See cold-start keyframe-pin exception below.)
    continue;
  }
  lastContentUs = rawUs; // first valid libav pts = anchor
} else {
  if (rawUs != null) {
    lastContentUs = rawUs;            // sync to truth
  } else {
    lastContentUs += videoFrameStepUs; // extend from last truth
  }
}
label = lastContentUs;
```

This makes labels honest by construction: bounded within one
`frameStep` of real content at all times, regardless of NOPTS
frequency. The existing pre-target drop at the enqueue boundary
(`_fPts < seekTarget - frameStep`) then does its job correctly — it
discards the entire keyframe-to-target preroll because the labels
match the real content positions of those frames.

**Cold-start special case.** At `seekTargetSec === 0`, the first
emitted keyframe is content 0 by container guarantee. Anchor
`lastContentUs = 0` on that frame (pinned to `f.key_frame === 1`,
not to "first NOPTS frame" — the I/P/B reorder is densest at the
stream head and any spacing assumption is wrong). This keeps the
opening I-frame visible instead of getting discarded as
pre-anchor-NOPTS. Strictly branched on `seekTargetSec === 0` so it
can't touch the seek path.

### Verification

The fix had to pass a content-truth check, not a label-rate check
(that was the original trap):

1. Extract ground-truth PNG at the seek target with ffmpeg:
   `ffmpeg -ss 646.538 -i input.avi -frames:v 1 ref_646538.png`.
2. Pause avbridge on the first post-seek paint and pixel-compare.

Pre-fix: avbridge painted content from ~642 s at the moment it
labeled `pts=646538`. Post-fix: avbridge paints content matching
`ref_646538.png` at `pts=646.520` (within one frame tolerance of
the click target). The label-vs-content offset experiment across
the post-seek window (label=646.5 → 647.5 → 648.5 → 649.5) returned
**flat 0 ± frame**, confirming no residual catch-up.

`[DIAG-FRAME]` log post-fix: vidx=0..114 all `PRE-ANCHOR-DROP` or
`PRE-TARGET-DROP` at correct content times (641.96 → 646.52),
vidx=115 first `ENQUEUED` at raw 646.520 ms. Zero `REGRESSED-DROP`
after anchor.

### Generalizable lessons

1. **Name the truth source of every rate metric.** `Σ Δpts / Σ
   Δwall = 1.0002×` looked like definitive proof of source-rate
   playback for half a day. It wasn't — `Δpts` came from synthetic
   labels glued to the audio clock by construction, so the ratio
   was tautologically ~1.0 regardless of what content was on
   screen. **The numerator was the system's own opinion about
   itself.** Any "the data confirms it's working" claim about a
   rate has to identify where the numerator's ground-truth comes
   from. If it's a label the system itself synthesized, it proves
   nothing about content.

2. **If your symptom model can't predict the *duration* of the
   symptom, it's wrong.** "Constant baked-in offset" was a
   plausible-sounding fit for "labels ahead of content," but it
   couldn't account for "1–2 seconds of fast-forward then back to
   normal." Permanent desync at 1× and transient fast-forward are
   structurally different artifacts. When a model fits the *kind*
   of error but not the *time profile*, treat that as the
   load-bearing flaw.

3. **A user's perceptual description is data, not narrative.** "I
   see fast-forwarded video frames... like a second or two of it"
   contained two precise measurements: *rate >1× sustained*, and
   *duration ≈ 1.5 s*. Both were correct. The triage spent an hour
   trying to talk the user out of those measurements because the
   internal data said "1.0× steady." The user was reporting from
   the canvas; we were reporting from a label. The user's source
   was more authoritative.

4. **A unilateral synthetic-anchor reset on seek is a
   timestamp-pipeline lie.** The synthetic fallback is for "I don't
   know yet," not "I'll guess from what the user clicked." Anchor
   only to information derived from the demuxer/decoder. If you
   have no derivation available, *don't emit* — discard until
   anchorable. The user's click position should never function as a
   content reference.

5. **Standard libavcodec recipes exist for a reason.** The canonical
   pattern for NOPTS frames in C is `av_frame_get_best_effort_timestamp()`,
   which folds in `pkt_dts`, `pkt_pos`, and stream heuristics. The
   bridge doesn't expose `best_effort_timestamp` on `LibavFrame`,
   which is what nudged us into the synthetic-fallback path in the
   first place. If a future libav.js variant exposes it, prefer it
   over the sync-on-valid invariant — it'll resolve most NOPTS
   frames without any synthesis at all.

6. **Prior fixes that solved the immediate symptom can mask a
   deeper bug for months.** The 2026-04-23 anchor-to-`lastEmittedPtsUs`
   fix made the 40 % drop rate go away and shipped to users. The
   underlying invariant violation — "synthetic counter, untethered
   from real content" — was still there, just hidden behind a
   smaller value. The transient fast-forward bug had been in every
   shipped version since; nobody reported it because seeks deep
   into long AVIs are uncommon. **When the immediate symptom is
   gone but the design rule that allowed it isn't fixed, expect to
   meet the same bug class again under different cover.**

---

## 2026-05-31 — Fallback A/V desync after seek: calibration includes decode delay + off-by-one-frame

**Affected code:** `src/strategies/fallback/video-renderer.ts`, `src/strategies/fallback/audio-output.ts`
**Triage time:** ~2 hours including a failed detour through audio-PTS rebasing

### Symptom

Playing a 1412 s MPEG-4 + MP3 AVI (`The IT Crowd s03e06`) via the
fallback strategy. Initial playback was in sync. After any seek into
an unbuffered region, the user reported visible lip-sync drift —
mouth movements clearly didn't match the dialog audio. The
`[avbridge:renderer]` debug log on one of their seeks showed:

```
WAIT q=6 headPTS=1311080ms calibAudio=1311037.3ms rawDrift=-1837.2ms calib=-1879.8ms
```

A `calib` of −1879.8 ms means the renderer thinks the audio clock is
~1.88 s ahead of where it actually is in the video PTS domain. Every
frame is painted ~1.9 s late relative to audio.

### Initial hypotheses (and why each failed)

1. **"PTS regression tail from B-frame reorder buffer is corrupting
   calibration."** The 95 `ptsRegressions` in the diag panel looked
   suspicious. But those out-of-order frames are dropped *before*
   they reach the renderer queue — they can't anchor calibration.
   Regressions are a symptom of post-seek B-frame decode, not the
   sync bug.

2. **"Use a smoothed / bounded-delta periodic re-snap instead of the
   stateless 10 s snap."** This produces a **feedback loop** — the
   measured offset already incorporates the current calibration, so
   the bounded delta converges to whatever it started at and drifts
   along with the error. **This is exactly the failure mode the
   2026-04-13 postmortem documents** (hypothesis 3). Reading
   POSTMORTEMS.md first would have saved an hour.

3. **"Rebase the audio media-time anchor to the first decoded chunk's
   PTS so the master clock tracks audio content, not the seek-target
   placeholder."** Plumbed `ptsUs` through `AudioOutput.schedule()`
   and rebased on the first post-reset chunk. Result: calibration
   went from +40 ms to **−688,166,936 ms** on the first seek. The
   audio PTS coming out of libav for mp3-in-AVI was 27,648,000 µs for
   frame #1 — i.e. 27.6 s for a 24 ms-into-the-stream frame.
   `sanitizeFrameTimestamp` returned `frame.pts` in a unit that
   didn't agree with `audioStream.time_base = [3, 125]`. Reverted.

### Root cause

Two separate bugs in the calibration code, both anchored on the
queue head's PTS at first paint:

```ts
ptsCalibrationUs = headTs - rawAudioNowUs;
```

**Bug A — `rawAudioNowUs` includes decode-stall lag.**
`clock.now()` advances with wall-clock time from the moment audio
resumed (`audio.start()`). For native+remux paths first-paint
latency is ~1 rAF tick. For the WASM fallback path on a
high-bitrate file, the first decoded frame can take 1–2 seconds to
land in the queue. By then `clock.now()` has drifted that far
forward from the seek target, and that drift becomes a permanent
video-lag offset.

**Bug B — off-by-one-frame: pre-roll consumes the actual displayed
frame before calibration runs.** The renderer's pre-roll path paints
one frame while audio is still paused (the "poster" while
`waitForBuffer()` accumulates). When audio.start() fires and the
calibration branch runs, `queue[0]` is the *next* frame, one
frameDur after the frame the user is actually looking at. Anchoring
to it bakes a +frameDur offset (40 ms on this 25 fps file) into
calibration permanently.

### Fix

`src/strategies/fallback/video-renderer.ts`:

1. **First snap uses the audio's anchor time, not its `now()`.**
   Added `ClockSource.anchorTime()` returning `mediaTimeOfAnchor` —
   the seek target on post-seek, 0 on cold start. Decode-stall lag
   doesn't leak in:

   ```ts
   if (!this.ptsCalibrated) {
     const anchorUs = (this.clock.anchorTime?.() ?? this.clock.now()) * 1e6;
     const referencePtsUs = this.hasLastPaintedPts ? this.lastPaintedPtsUs : headTs;
     this.ptsCalibrationUs = referencePtsUs - anchorUs;
     ...
   }
   ```

2. **Calibration reference is the pre-rolled frame's PTS, not the
   queue head.** Pre-roll now records `lastPaintedPtsUs` of the
   frame it painted. The first calibration anchors against that —
   the frame the user is actually looking at when audio resumes —
   instead of the next-in-queue frame. Eliminates the +frameDur bias.

3. **Periodic re-snap is unchanged from the 2026-04-13 design** —
   stateless independent snap every 10 s using `headTs - rawAudioNow`.
   Resist the urge to "smooth" it. The postmortem's bound holds:
   ~7 ms/s drift × 10 s = 70 ms max accumulated error, below the
   100 ms lip-sync threshold.

Result on the IT Crowd file: `calib = 0.0 ms` stable across 7 test
seeks (was `40 ms` after fix 1 alone, `−1879 ms` before any fix).

### Generalizable lessons

1. **`clock.now()` is a moving target during cold start and post-seek.**
   Any "what-time-is-it" reference that's read across an
   indeterminate decode-startup gap will contaminate whatever
   formula uses it. Reach for `mediaTimeOfAnchor` (the stable
   reference point of the master clock) when the *intended* time
   matters more than the *elapsed* time.

2. **Pre-roll is a one-frame liability for any logic that runs at
   "first play."** The pre-rolled frame is gone from the queue but
   it's what's actually on screen. Track its PTS if anything
   downstream needs "what frame is currently displayed."

3. **Read the existing postmortems before inventing a new fix in the
   same module.** The 2026-04-13 entry already named the feedback-
   loop trap. I spent an hour re-deriving why a bounded EMA-style
   re-snap fails.

4. **Don't trust `frame.pts` from libav for mp3-in-AVI** (and
   probably other low-bitrate audio in container formats with
   non-standard time bases). The stream's reported `time_base`
   doesn't always describe the units libav returns from the
   audio decoder; `sanitizeFrameTimestamp` will produce a "valid"
   but wildly incorrect µs value. The existing decoder code
   sensibly ignores `frame.pts` for audio and schedules sequentially
   from `mediaTimeOfNext`. Don't undo that.

### Followup the same session: "audio comes first" + the chippy-playback band-aid spiral

After the calibration fix landed, the user reported a smaller sync
error: "the audio comes first." The new `[avbridge:av-anchor]` log
showed why on a seek to 600 s:

```
seek-target=600.000s, first-audio-pkt-pts=597.888s (Δ=-2112.0ms)
```

The video keyframe lands at the seek target (pre-roll PTS = 600.0),
but the demuxer hands back an audio chunk that starts **2.1 s
before** the keyframe. `AudioOutput` schedules samples sequentially
from `mediaTimeOfAnchor`, with no PTS awareness — so it queued
2.1 s of pre-target audio with the anchor at 600. At media-time 600
the user hears content from PTS 597.888 while the video shows PTS
600 — audio leads video by 2.1 s in story-time.

#### Three workarounds that each opened a new hole

1. **Rebase the audio anchor to the first packet's PTS** —
   relabels the media clock without changing what's audible. The
   renderer's calibration then snapped `calib = prerolledPts (600)
   − anchor (597.888) = +2112 ms`, painting video **2.1 s ahead of
   audio playback**. Same desync, opposite direction.

2. **Drop pre-target audio packets at the decoder.** Added an
   `audioTrimUntilSec` that filtered packets with PTS < seek
   target before `decodeAudioBatch`. Fixed the lip-sync but
   produced **chippy playback after seek**: the `waitForBuffer()`
   gate released on its 500 ms "video-only grace" path (audio
   buffer was empty *because* we were dropping packets), then
   `audio.start()` ran with an empty pending queue, then when the
   first post-target packet finally arrived `scheduleNow()` rebased
   the anchor mid-flight — the user saw 1–2 s of fast-forwarding
   video and a jiggling audio clock as each starved chunk landed.

3. **Make the gate trim-aware + bypass the throttle.** Each step
   plugged the next hole: the gate started waiting for trim to
   complete; the decoder's `queueHighWater` throttle blocked the
   pump because the renderer wasn't draining (audio hadn't
   started); bypassing the throttle let frames pile up to the hard
   cap of 64; the queue head ended up several seconds ahead of the
   renderer's eventual painting position and the periodic re-snap
   captured huge `calib` values. Net result: deeper stack of
   contingent fixes, same chippy symptom, +150 lines.

At this point the user asked "should video have this much
workarounds? Perhaps we are doing something wrong." That was the
right question.

#### The actual fix: PTS-based audio scheduling

The architectural smell was that `AudioOutput.schedule()` had no
PTS argument. Every workaround was compensating for that missing
signal. Adding it deletes all three workarounds plus the audio
trim.

```ts
schedule(samples, channels, sampleRate, ptsSec?: number | null): void {
  // ...
  this.scheduleNow(samples, channels, sampleRate, frameCount,
                   hasPts ? ptsSec : null);
}

private scheduleNow(/*…*/, ptsSec: number | null): void {
  let ctxStart: number;
  if (ptsSec != null) {
    ctxStart = ctxTimeAtAnchor + (ptsSec - mediaTimeOfAnchor) / rate;
    // Pre-target / past chunks: silently drop. After a seek this
    // automatically skips packets returned by the keyframe-aligned
    // demuxer position without any external trim.
    if (ctxStart < ctx.currentTime - 0.001) return;
    // …update mediaTimeOfNext for bufferAhead() and continuity…
  } else {
    // Legacy sequential path, unchanged. (No production caller now;
    // kept for codecs where packet→frame mapping isn't 1:1.)
  }
  // …createBufferSource, node.start(ctxStart)…
}
```

The decoder captures `packetPtsSec(pkt, audioTimeBase)` for each
packet *before* `ff_decode_multi` (because the demuxer's packet PTS
is reliable; `frame.pts` after decode is the unit that's wrong for
mp3-in-AVI). For mp3/aac the packet→frame mapping is 1:1, so each
output frame gets its packet's PTS forwarded to
`opts.audio.schedule(samples, channels, rate, pts)`.

What this deletes:
- `audioTrimUntilSec` + the per-batch trim loop in `decoder.ts`
- `DecoderHandles.isAudioTrimActive()` + the trim-aware gate skip
- The 15 s extended timeout for trim
- The `queueHighWater` throttle bypass during trim
- `syntheticAudioUs` counter (audio uses real packet PTS now)
- `sanitizeFrameTimestamp` calls on audio frames

What stays:
- `anchorTime()`-based first-snap calibration in the renderer —
  still useful when first-paint is delayed (slow decoder), because
  `clock.now()` would have drifted from the seek target by then.
- `lastPaintedPtsUs` as the calibration reference — still useful
  because pre-roll consumes the displayed frame before the
  calibration branch runs.

Initial verification on the IT Crowd file across 6 seeks (pre-target
gaps from 26 ms to 10 s): gate satisfies in ~50 ms, `calib=0.0 ms`,
no clock-jiggle.

#### One more bug: "sped-up no audio" after the refactor

The user reported a remaining symptom: after a seek with a large
pre-target gap, video would play at normal speed but silent for a
few seconds before audio kicked in synced. Cause: `bufferAhead()`
in idle state sums the `pendingQueue` durations, but every chunk
the decoder produced during the catch-up was pre-target and would
be dropped by `scheduleNow()`'s ctxStart-in-past test on drain. So
`bufferAhead` reported phantom audio, the gate fired, `audio.start()`
ran, `clock.now()` advanced from wall time, and the renderer
happily painted video against an audio clock that wasn't actually
producing sound.

Fix part 1 — drop pre-target chunks at `schedule()` *entry*:

```ts
if (hasPts && (ptsSec as number) + durationSec / this._rate < this.mediaTimeOfAnchor) {
  return;  // chunk is entirely pre-anchor; won't ever play
}
```

Now `pendingQueue` and `bufferAhead()` reflect only playable audio
— the gate waits for the demuxer to actually reach post-target.

Fix part 2 — suppress video decode during catch-up. With part 1
alone, the gate correctly waits for post-target audio, but the
decoder pump now interleaves slow mpeg4 video decode between audio
batches. The renderer queue fills to its hard cap (60) with frames
at PTSes far ahead of the seek target; when `audio.start()` finally
fires, `clock.now()` starts at the seek target and the queue head
is several seconds ahead — the renderer freezes on the pre-rolled
frame until the clock catches up. (Symptom flipped from "sped-up
no audio" to "frozen video, audio plays.")

The fix is to skip video decode while audio is gating, once the
pre-roll I-frame is in hand:

```ts
const havePreroll = videoFramesDecoded > 0;
const audioReady = opts.audio.bufferAhead() >= 0.04;
if ((!havePreroll || audioReady) && videoDec && videoPackets.length > 0) {
  await decodeVideoBatch(processed, myToken);
}
```

Pump iterations during catch-up become read + audio-decode + drop
only — fast enough that even a 10 s pre-target gap satisfies the
gate in ~100 ms. When the first post-target audio packet lands,
video decode resumes; its next frame is at PTS ≈ first post-target
audio PTS, so playback starts cleanly at the seek target without a
video gap.

Verified on the IT Crowd file across 5 seeks with pre-target gaps
1.2 s to 10 s: gate satisfies in 50–100 ms, `audio=840–1824 ms`
buffered (real playable audio, not phantom), `queueHeadPTS =
prerolledPTS + 40 ms` (exactly one frame past pre-roll — no
forward leap), `calib = 0.0 ms`. No silent video, no frozen video.

#### One more bug after the video-skip: gray + glitchy diff frames

The user reported a final symptom: the seek was instant, but the
first frame on screen was gray and the next second of playback was
a series of "glitchy diff frames" until the next keyframe. The
video-decode-suppression in the previous fix is what caused it —
during catch-up the demuxer is still returning video packets, and
when we skip the `decodeVideoBatch` call those packets never reach
the decoder. When audio finally caught up and video decode resumed,
the next packet was a P/B frame whose reference frames (the
intervening B/P frames between the seek-target I-frame and the
current demuxer position) had never been fed to the decoder.
libav's output for those frames is mostly gray with motion residuals
visible — exactly what the user described — until the next keyframe
arrives and resets the decoder state.

The fix is to **always decode video** to keep the reference-frame
chain intact, and instead apply backpressure at the *enqueue* side:

```ts
// decoder.ts decodeVideoBatch:
const vf = bridge.laFrameToVideoFrame(f, /*…*/);
if (opts.renderer.queueDepth() >= opts.renderer.queueHighWater) {
  vf.close();  // decoder state preserved; frame just not displayed
} else {
  opts.renderer.enqueue(vf);
}
```

The pump's throttle now checks only `audio.bufferAhead() > 2.0` —
no more `queueHighWater` check there, because the discard-on-overflow
in `decodeVideoBatch` is the bound. Throttling the pump on queue
depth would block demuxer reads, which during catch-up also stalls
audio packet processing and reintroduces the gating deadlock.

Last step: raise `queueHighWater` from 30 to 256 so the renderer
queue can hold the entire post-seek catch-up burst. At ~340 KB per
SD frame the peak is ~85 MB; at HD it scales up, but bounded. With
this:

- Decoder consumes packets sequentially: reference-frame state is
  always valid, no garbage frames.
- During catch-up the queue fills to ~10 s of video at PTS T_kf
  onward (well within 256 frames).
- When `audio.start()` fires, the renderer paints from the queue
  head (just past pre-roll) and keeps painting smoothly as audio
  advances at 1× — *no frozen video, no frame jump, no glitch.*

Verified on the IT Crowd file across 4 seeks with pre-target gaps
1.2 s to 10 s: paint rate is 92–98 frames in 4 s wall time (vs the
theoretical 100 at 25 fps), `droppedLate = 0`, `droppedOverflow =
0`. Smooth playback throughout the catch-up window.

#### Generalizable lesson, take three

**Don't skip work to avoid backpressure — apply it at the right
boundary.** Skipping `decodeVideoBatch` made the queue stay small
but broke the decoder's reference-frame contract. Skipping the
*enqueue* gives the same memory bound while keeping the decoder fed
in order. The decoder doesn't care that you discarded the frame; it
only cares that you fed it the packets.

The pump-throttle/enqueue-discard split is also worth remembering:
*throttle the producer when consumers are caught up*, *discard at
the consumer boundary when producers race ahead*. They look similar
but couple different parts of the pipeline.

#### Final bug: sped-up video burst at start of playback

The user reported a final symptom: "sped up video before normal
playback." On the IT Crowd file this didn't reproduce (the file's
keyframe pattern happens to align with arbitrary seek targets), but
on the `bbb-mpeg4-mp3.avi` fixture it did. The mechanism:

- After `av_seek_frame(BACKWARD)` the demuxer lands at the keyframe
  at or before the user's click. For a typical 10 s GOP this can
  be up to 10 s of source content before the target.
- With the queue-overflow-as-backpressure design above, the decoder
  produces frames at PTS `T_kf … T_kf + 10 s` and they all land in
  the queue.
- When `audio.start()` fires the audio media-clock is at `T_click`;
  the first ~50 frames in the queue (those with PTS in
  `[T_click − 80 ms, T_click + ε]`) are all "ready to paint" on
  the first rAF tick. The renderer paints them one per tick at
  60 Hz — for a 25 fps source that's a 2.4× fast-forward burst
  until the queue head catches up to the audio clock.

This is the **frame-accurate seek** problem. Every mature video
player handles it the same way: **decode to display**. The decoder
must still process every packet from the GOP keyframe forward —
those are the reference frames for the post-target P/B decodes —
but pre-target *output* frames are dropped before they ever reach
the renderer. The renderer's first frame is the one at-or-just-
before `T_click`, painted in sync with the audio.

The fix is a single guard in `decodeVideoBatch`, after the
regression filter and before `bridge.laFrameToVideoFrame()`:

```ts
const targetUs = Math.round(seekTargetSec * 1_000_000);
if (_fPts < targetUs - videoFrameStepUs) {
  continue;  // decoded for reference, not displayed
}
```

The one-frame-step tolerance follows the `<video>.currentTime = T`
convention: when source frames are quantized to `N × frameStep`
and the click is arbitrary, display the largest PTS ≤ T. For the
bbb fixture (24 fps, frameStep ≈ 41.7 ms), seeks now show pre-roll
at `T − 41.7 ms` and calib at `−41.7 ms` — exactly the same offset
the browser's native `<video>` shows. No fast-forward burst.

#### Generalizable lesson, take four

**The frame-accurate seek problem is decoder-architecture-level,
not renderer-policy-level.** Trying to fix it in the renderer
(painting only the latest paintable frame, larger drop window,
PTS-based rate limiting) is fighting the symptom — the queue
*shouldn't have* those pre-target frames in the first place. The
discard belongs at the seam between "decoded for reference" and
"emitted for display," which is `decodeVideoBatch`. Most player
codebases name this seam explicitly; we now do too via the
`seekTargetSec`-guarded `continue`.

#### Coda: audio-sync skip vs late-drop in the renderer

Even with decode-to-display, the renderer can still see a transient
"multiple paintable frames in one rAF tick" — most often after a
recalibration step, or when WASM decode briefly catches up to audio
and a few queued frames all satisfy `ts ≤ deadline` at once. The
original logic painted `queue[0]` (the *earliest* paintable),
relying on the next rAF tick to advance to the next one. With
multiple paintable frames in queue, that meant one paint per rAF
tick (~60 Hz) until the queue head matched the audio clock — a
perceptible 2.4× fast-forward burst on 25 fps content.

The fix is the standard audio-sync rule: paint `queue[bestIdx]`,
the *latest* paintable frame, and drop everything before it. Effect:
- In sync (single paintable frame, `bestIdx == 0`): unchanged.
- Audio ahead (multiple paintable, `bestIdx > 0`): the previous
  frame lingers one tick longer, then a single clean jump forward
  to the frame that matches the audio clock.

This is what ffplay's `video_refresh()` does, what VLC's clock
synchronization does, and what the browser's `<video>` does. The
old "drop only if more than 2 frame-durations behind" threshold
made bursts visible whenever the gap was 80 ms or less; the new
"drop everything before `bestIdx`" eliminates that window.

#### Generalizable lessons (revised)

1. **If three contingent workarounds stack to fix one symptom, the
   abstraction is wrong.** Each of the three above was correct in
   isolation. They stacked because the underlying API (`schedule`
   without PTS) couldn't express what the system actually wanted.
   The user's question — "should video have this much workarounds?"
   — saved a fourth.

2. **Sample-scheduled audio NEEDS a PTS argument** for any pipeline
   that supports seeking. Web Audio's `node.start(ctxStart)` is
   already PTS-friendly — `ctxStart = ctxTimeAtAnchor + (pts -
   mediaTimeOfAnchor) / rate` is two lines. Pre-target audio drops
   for free as `ctxStart < ctx.currentTime`. There's no reason not
   to plumb PTS through except inertia.

3. **Don't trust `frame.pts` from libav for audio**; use
   `packetPtsSec(pkt, audioTimeBase)` captured before decode. For
   mp3-in-AVI the post-decode value was 1000× too large
   (`sanitizeFrameTimestamp` returned a "valid" but garbage µs
   value). The packet PTS path is the one that works.

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

> **⚠ SUPERSEDED by 2026-06-01.** The fix below — anchor synthetic to
> `lastEmittedPtsUs + frameStep` — solved the 40% drop rate but turned
> out to be a *partial* fix: it kept synthetic frames monotonic with
> their valid neighbors during steady-state playback, but on post-seek
> the same counter, reset to `seekTarget`, mislabeled every
> keyframe-to-target NOPTS frame as a near-target frame. That produced
> the ~2-second post-seek fast-forward documented in **2026-06-01**.
>
> The current rule is **sync on every valid pts, step on NOPTS**, with
> no fallback to seekTarget. Keep this entry for the diagnostic arc
> (the `nextPTS=15400ms` log line that led to the synthetic-counter
> hypothesis is still instructive) but do not copy the fix.

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
