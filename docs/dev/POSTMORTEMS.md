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
