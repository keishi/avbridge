/**
 * Web Audio output for the fallback strategy.
 *
 * Owns the **media-time clock** for fallback playback. Audio is the master:
 * decoded video frames are presented based on what `now()` returns here.
 *
 * State machine:
 *
 *   ┌──────┐  schedule()  ┌──────┐                ┌────────┐
 *   │ idle │ ───────────▶ │ idle │ ── start() ──▶│ playing│
 *   └──────┘  (queues)    └──────┘                └────┬───┘
 *      ▲                                               │
 *      │                                               │ pause()
 *      │                                               ▼
 *      │                                           ┌────────┐
 *      └────────────── reset(t) ─────────────── ── │ paused │
 *                                                  └────────┘
 *
 * - **idle**: AudioContext is suspended (no playback). `schedule()` queues
 *   samples in `pendingQueue`; `now()` returns `mediaTimeOfAnchor`.
 * - **playing**: AudioContext is running. `schedule()` writes directly to
 *   the audio graph at the right time. `now()` advances with `ctx.currentTime`.
 * - **paused**: AudioContext is suspended. `now()` returns the media time
 *   captured at pause. `start()` resumes.
 *
 * Key invariant: between any two `start()` calls, `mediaTimeOfNext` (the
 * media time of the next sample to be scheduled) must equal the media time
 * the playback is at. This is what makes the cold-start race go away — we
 * never schedule audio with a stale wall-clock anchor.
 */

interface PendingChunk {
  samples: Float32Array;
  channels: number;
  sampleRate: number;
  frameCount: number;
  durationSec: number;
  /** Source-domain content PTS in seconds. `null` for legacy callers
   *  that schedule sequentially without PTS information. */
  ptsSec: number | null;
}

/** True when `globalThis.AVBRIDGE_DEBUG` is set. Used to gate [TRACE-AUD]
 *  per-chunk logs that are useful for diagnosing scheduling drift but
 *  unreadable in normal use. */
function isDebug(): boolean {
  return typeof globalThis !== "undefined"
    && !!(globalThis as Record<string, unknown>).AVBRIDGE_DEBUG;
}

export interface ClockSource {
  /** Current media time in seconds. */
  now(): number;
  /** True if media is currently playing (audio scheduler is running). */
  isPlaying(): boolean;
  /**
   * Media time at which the current playback session was anchored — i.e. the
   * seek target after the most recent `reset()`, or 0 on cold start. Used by
   * the video renderer for post-flush PTS calibration: `now()` includes any
   * decode-stall lag accumulated since playback resumed, but the anchor is
   * a stable reference that maps directly to the user's intended position.
   */
  anchorTime(): number;
}

export class AudioOutput implements ClockSource {
  private ctx: AudioContext;
  private gain: GainNode;

  private state: "idle" | "playing" | "paused" = "idle";

  /**
   * Wall-clock fallback mode. When true, this output behaves as if audio
   * is unavailable — `now()` advances from `performance.now()` instead of
   * the audio context, `schedule()` is a no-op, and `bufferAhead()` returns
   * Infinity so the session's `waitForBuffer()` doesn't block on audio.
   *
   * Set by the decoder via {@link setNoAudio} when audio decode init fails.
   * This is what lets video play even when the audio codec isn't supported
   * by the loaded libav variant.
   */
  private noAudio = false;
  /** Wall-clock anchor (ms from `performance.now()`) for noAudio mode. */
  private wallAnchorMs = 0;

  /** Media time at which the next sample will be scheduled. */
  private mediaTimeOfNext = 0;

  /** Anchor: media time `mediaTimeOfAnchor` corresponds to ctx time `ctxTimeAtAnchor`. */
  private mediaTimeOfAnchor = 0;

  /**
   * Ctx time at which the first audible chunk will start playing. `-1`
   * before any chunk has been scheduled successfully (clock is frozen);
   * the actual ctx time once one has. The renderer's `clock.now()` uses
   * this to avoid advancing during the silent-gap window between
   * `audio.start()` and the first chunk that schedules without being
   * dropped — that gap is what produces the "audio-less fast-forward"
   * the user sees post-seek when the gate releases on video-only grace.
   */
  private firstAudibleCtxStart = -1;
  private ctxTimeAtAnchor = 0;

  private pendingQueue: PendingChunk[] = [];

  private framesScheduled = 0;
  private destroyed = false;

  /** User-set volume (0..1). Applied to the gain node. */
  private _volume = 1;
  /** User-set muted flag. When true, gain is forced to 0. */
  private _muted = false;
  /** Playback rate. Scales the media clock and each AudioBufferSourceNode's
   *  playbackRate so audio pitches up/down accordingly (same as native
   *  <video>.playbackRate). Default 1. */
  private _rate = 1;

  constructor() {
    this.ctx = new AudioContext();
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
  }

  /** Set volume (0..1). Applied immediately to the gain node. */
  setVolume(v: number): void {
    this._volume = Math.max(0, Math.min(1, v));
    this.applyGain();
  }

  getVolume(): number {
    return this._volume;
  }

  /** Set muted. When true, output is silenced regardless of volume. */
  setMuted(m: boolean): void {
    this._muted = m;
    this.applyGain();
  }

  getMuted(): boolean {
    return this._muted;
  }

  /** Set playback rate. Scales the media clock and pitches audio output
   *  (same as native <video>.playbackRate — speed without pitch correction).
   *  Rebases the anchor so the clock transition is seamless. */
  setPlaybackRate(rate: number): void {
    if (rate === this._rate) return;
    // Rebase anchor at the current media time before changing rate,
    // so the clock doesn't jump.
    const t = this.now();
    this.mediaTimeOfAnchor = t;
    this.ctxTimeAtAnchor = this.ctx.currentTime;
    this.wallAnchorMs = performance.now();
    this._rate = rate;
  }

  getPlaybackRate(): number {
    return this._rate;
  }

  private applyGain(): void {
    const target = this._muted ? 0 : this._volume;
    try { this.gain.gain.value = target; } catch { /* ignore */ }
  }

  /**
   * Switch into wall-clock fallback mode. Called by the decoder when no
   * audio decoder could be initialized for the source. Once set, this
   * output drives playback time from `performance.now()` and ignores
   * any incoming audio samples.
   */
  setNoAudio(): void {
    this.noAudio = true;
  }

  // ── ClockSource ────────────────────────────────────────────────────────

  now(): number {
    if (this.noAudio) {
      if (this.state === "playing") {
        return this.mediaTimeOfAnchor + (performance.now() - this.wallAnchorMs) / 1000 * this._rate;
      }
      return this.mediaTimeOfAnchor;
    }
    if (this.state === "playing") {
      // Freeze the clock until the first audio chunk has actually been
      // scheduled. Without this, when `audio.start()` fires before any
      // post-seek audio packets have made it through the decoder (e.g. the
      // gate's "video-only grace" path released early), `clock.now()`
      // would advance from `mediaTimeOfAnchor` at 1× wall time while the
      // audio scheduler is dropping every chunk that arrives (their
      // PTS-derived `ctxStart` is already in the past). The renderer would
      // paint frames during that silent window — the user perceives that
      // as a "fast-forward burst with no audio." When the first chunk
      // finally arrives and schedules normally, `firstAudibleCtxStart` is
      // set and the clock unfreezes from there in sync with the audible
      // content's PTS.
      if (this.firstAudibleCtxStart < 0) {
        return this.mediaTimeOfAnchor;
      }
      return this.mediaTimeOfAnchor + (this.ctx.currentTime - this.ctxTimeAtAnchor) * this._rate;
    }
    return this.mediaTimeOfAnchor;
  }

  anchorTime(): number {
    return this.mediaTimeOfAnchor;
  }

  isPlaying(): boolean {
    return this.state === "playing";
  }

  // ── Buffering ─────────────────────────────────────────────────────────

  /**
   * How many seconds of audio are buffered ahead of the current playback
   * position. While idle, this counts the pending queue. While playing,
   * it counts how far `mediaTimeOfNext` is ahead of `now()`.
   */
  bufferAhead(): number {
    // In wall-clock mode, no samples are ever scheduled — the buffer is
    // genuinely empty. Callers that want to gate cold-start should check
    // {@link isNoAudio} and skip the audio gate entirely instead.
    if (this.noAudio) return 0;
    if (this.state === "idle") {
      let sec = 0;
      for (const c of this.pendingQueue) sec += c.durationSec;
      return sec;
    }
    return Math.max(0, this.mediaTimeOfNext - this.now());
  }

  /** True if this output is in wall-clock fallback mode (no audio decode). */
  isNoAudio(): boolean {
    return this.noAudio;
  }

  /**
   * Schedule a chunk of decoded samples. Queues internally while idle (cold
   * start or post-seek), schedules directly to the audio graph while playing.
   * In wall-clock mode, samples are silently discarded.
   *
   * `ptsSec` is the chunk's source-domain content PTS in seconds, from
   * the demuxer. When provided, the chunk plays at the ctx-time
   * corresponding to that PTS — so pre-target audio after a seek
   * naturally drops (its computed `ctxStart` falls in the past) and
   * post-target audio plays at its true content time, without any
   * external trim or anchor rebase. When `ptsSec` is null (cold start
   * with no PTS yet, or codecs whose packet→frame mapping isn't 1:1),
   * the chunk is scheduled sequentially after `mediaTimeOfNext` — the
   * pre-refactor behavior.
   */
  schedule(
    samples: Float32Array,
    channels: number,
    sampleRate: number,
    ptsSec?: number | null,
  ): void {
    if (this.destroyed || this.noAudio) return;
    const frameCount = samples.length / channels;
    const durationSec = frameCount / sampleRate;
    const hasPts = ptsSec != null && Number.isFinite(ptsSec);

    // Pre-target gate: a chunk whose entire PTS span is before the
    // current media anchor will be silently dropped by `scheduleNow`
    // (its `ctxStart` falls in the past). We must apply the same drop
    // here in idle/paused state too — otherwise the chunk sits in
    // `pendingQueue`, `bufferAhead()` reports it as buffered audio,
    // `waitForBuffer()`'s gate releases on a phantom audio buffer, and
    // `audio.start()` fires with a queue full of chunks that immediately
    // drop on drain. The user sees post-seek "sped up no audio" while
    // the demuxer slowly chews through pre-target packets — `clock.now()`
    // is advancing on wall time and the renderer paints video against
    // it, but `node.start()` is never being called.
    if (hasPts && (ptsSec as number) + durationSec / this._rate < this.mediaTimeOfAnchor) {
      return;
    }

    if (this.state === "idle" || this.state === "paused") {
      this.pendingQueue.push({
        samples, channels, sampleRate, frameCount, durationSec,
        ptsSec: hasPts ? (ptsSec as number) : null,
      });
      return;
    }

    this.scheduleNow(
      samples, channels, sampleRate, frameCount,
      hasPts ? (ptsSec as number) : null,
    );
  }

  private scheduleNow(
    samples: Float32Array,
    channels: number,
    sampleRate: number,
    frameCount: number,
    ptsSec: number | null,
  ): void {
    const durationSec = frameCount / sampleRate;

    // Compute ctxStart. Two paths:
    //
    //   PTS-known: the chunk's content PTS maps to a specific ctx time
    //   via (mediaTimeOfAnchor, ctxTimeAtAnchor). If that ctx time is
    //   already in the past, the chunk represents audio the user should
    //   have heard before now — drop it. After a seek, this is what
    //   *automatically* skips pre-target audio packets returned by a
    //   keyframe-aligned demuxer seek; no manual trim needed.
    //
    //   PTS-unknown (legacy): chain after the last-scheduled sample
    //   via `mediaTimeOfNext`. Same behavior as before the refactor.
    let ctxStart: number;
    if (ptsSec != null) {
      ctxStart = this.ctxTimeAtAnchor + (ptsSec - this.mediaTimeOfAnchor) / this._rate;
      if (isDebug()) {
        // eslint-disable-next-line no-console
        console.log(`[TRACE-AUD] PTS sched #${this.framesScheduled} pts=${ptsSec.toFixed(3)} dur=${durationSec.toFixed(4)} ctxStart=${ctxStart.toFixed(4)} ctxNow=${this.ctx.currentTime.toFixed(4)} anchor=${this.mediaTimeOfAnchor.toFixed(3)} ctxAnchor=${this.ctxTimeAtAnchor.toFixed(4)} mtNext=${this.mediaTimeOfNext.toFixed(3)} rate=${this._rate}`);
      }
      if (ctxStart < this.ctx.currentTime - 0.001) {
        if (isDebug()) {
          // eslint-disable-next-line no-console
          console.log(`[TRACE-AUD] DROP late chunk pts=${ptsSec.toFixed(3)} ctxStart=${ctxStart.toFixed(4)} < ctxNow=${this.ctx.currentTime.toFixed(4)}`);
        }
        return;
      }
      // First chunk to schedule successfully unfreezes `clock.now()`.
      // We rebase the anchor onto this chunk: when ctx reaches `ctxStart`,
      // clock should equal `ptsSec` (so `audioNow` matches audible content
      // PTS exactly when the chunk plays). The renderer's deadline will
      // then advance from there, in lockstep with what's audible.
      if (this.firstAudibleCtxStart < 0) {
        this.firstAudibleCtxStart = ctxStart;
        this.mediaTimeOfAnchor = ptsSec;
        this.ctxTimeAtAnchor = ctxStart;
        if (isDebug()) {
          // eslint-disable-next-line no-console
          console.log(`[TRACE-AUD] UNFREEZE clock — first audible chunk pts=${ptsSec.toFixed(3)} ctxStart=${ctxStart.toFixed(4)} → anchor=${this.mediaTimeOfAnchor.toFixed(3)} ctxAnchor=${this.ctxTimeAtAnchor.toFixed(4)}`);
        }
      }
      const endMediaTime = ptsSec + durationSec / this._rate;
      if (endMediaTime > this.mediaTimeOfNext) {
        this.mediaTimeOfNext = endMediaTime;
      }
    } else {
      ctxStart = this.ctxTimeAtAnchor + (this.mediaTimeOfNext - this.mediaTimeOfAnchor) / this._rate;
      // eslint-disable-next-line no-console
      console.warn(`[TRACE-AUD] LEGACY (no PTS) sched dur=${durationSec.toFixed(4)} ctxStart=${ctxStart.toFixed(4)} ctxNow=${this.ctx.currentTime.toFixed(4)}`);
      if (ctxStart < this.ctx.currentTime) {
        // eslint-disable-next-line no-console
        console.warn(`[TRACE-AUD] REBASE anchor was=${this.mediaTimeOfAnchor.toFixed(3)} ctxAnchor was=${this.ctxTimeAtAnchor.toFixed(4)} → anchor=${this.mediaTimeOfNext.toFixed(3)} ctxAnchor=${this.ctx.currentTime.toFixed(4)}`);
        this.ctxTimeAtAnchor = this.ctx.currentTime;
        this.mediaTimeOfAnchor = this.mediaTimeOfNext;
        ctxStart = this.ctx.currentTime;
      }
      this.mediaTimeOfNext += durationSec;
    }

    const buffer = this.ctx.createBuffer(channels, frameCount, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const channelData = buffer.getChannelData(ch);
      for (let i = 0; i < frameCount; i++) {
        channelData[i] = samples[i * channels + ch];
      }
    }
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gain);
    if (this._rate !== 1) node.playbackRate.value = this._rate;
    node.start(ctxStart);
    this.framesScheduled++;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Start (or resume) playback. On a cold start (or after a reset), drains
   * the pending queue scheduling all queued samples to play starting at
   * `ctx.currentTime + STARTUP_DELAY`. On resume from pause, just re-anchors
   * the media↔ctx time mapping and unsuspends the context.
   */
  async start(): Promise<void> {
    if (this.destroyed || this.state === "playing") return;

    // Wall-clock mode: no audio context involved. Anchor to performance.now()
    // and let `now()` advance from there. The renderer's tick loop will see
    // `isPlaying() === true` and start painting frames.
    if (this.noAudio) {
      this.wallAnchorMs = performance.now();
      this.state = "playing";
      return;
    }

    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }

    // Reconnect the gain node — pause() disconnects it to cut off
    // in-flight audio instantly. Safe to call even if already connected.
    try { this.gain.connect(this.ctx.destination); } catch { /* ignore */ }

    if (this.state === "paused") {
      if (isDebug()) {
        // eslint-disable-next-line no-console
        console.log(`[TRACE-AUD] START(resume) anchor=${this.mediaTimeOfAnchor.toFixed(3)} ctxAnchor=${this.ctxTimeAtAnchor.toFixed(4)} → ctxAnchor=${this.ctx.currentTime.toFixed(4)} ctxNow=${this.ctx.currentTime.toFixed(4)} pendingCount=${this.pendingQueue.length}`);
      }
      // Resume: media time should continue from where we paused. ctx.currentTime
      // is preserved across suspend/resume, so re-anchoring it to "now" with
      // the same mediaTimeOfAnchor gives a continuous clock.
      this.ctxTimeAtAnchor = this.ctx.currentTime;
      this.state = "playing";
      // Drain anything that was scheduled while paused.
      const drain = this.pendingQueue;
      this.pendingQueue = [];
      for (const c of drain) {
        this.scheduleNow(c.samples, c.channels, c.sampleRate, c.frameCount, c.ptsSec);
      }
      return;
    }

    // Cold start (or post-seek). Anchor: the first sample we scheduled lands
    // at ctxTimeAtAnchor (a tiny bit in the future), and that ctx time
    // corresponds to media time mediaTimeOfAnchor.
    const STARTUP_DELAY = 0.05;
    this.ctxTimeAtAnchor = this.ctx.currentTime + STARTUP_DELAY;
    this.mediaTimeOfNext = this.mediaTimeOfAnchor;
    this.state = "playing";
    if (isDebug()) {
      // eslint-disable-next-line no-console
      console.log(`[TRACE-AUD] START(cold) anchor=${this.mediaTimeOfAnchor.toFixed(3)} ctxAnchor=${this.ctxTimeAtAnchor.toFixed(4)} mtNext=${this.mediaTimeOfNext.toFixed(3)} ctxNow=${this.ctx.currentTime.toFixed(4)} pendingCount=${this.pendingQueue.length}`);
    }

    const drain = this.pendingQueue;
    this.pendingQueue = [];
    for (const c of drain) {
      this.scheduleNow(c.samples, c.channels, c.sampleRate, c.frameCount, c.ptsSec);
    }
  }

  /** Pause playback. Suspends the audio context. */
  async pause(): Promise<void> {
    if (this.state !== "playing") return;
    this.mediaTimeOfAnchor = this.now();
    this.state = "paused";
    if (this.noAudio) return;
    // Disconnect the gain node immediately so any in-flight scheduled
    // buffers are silenced instantly. ctx.suspend() is async and
    // already-started AudioBufferSourceNodes keep playing until the
    // context actually suspends — without the disconnect, audio bleeds
    // through for ~200ms after pause().
    try { this.gain.disconnect(); } catch { /* ignore */ }
    if (this.ctx.state === "running") {
      await this.ctx.suspend();
    }
  }

  /**
   * Reset to a new media time. Discards all queued and scheduled audio,
   * disconnects the gain node so any in-flight scheduled buffers are cut
   * off, and returns to the idle state. Used by `seek()`.
   *
   * After reset, callers should re-buffer audio (the decoder will start
   * supplying new samples) and then call `start()` to resume playback.
   */
  async reset(newMediaTime: number): Promise<void> {
    if (isDebug()) {
      // eslint-disable-next-line no-console
      console.log(`[TRACE-AUD] RESET to=${newMediaTime.toFixed(3)} prev_anchor=${this.mediaTimeOfAnchor.toFixed(3)} prev_mtNext=${this.mediaTimeOfNext.toFixed(3)} prev_ctxAnchor=${this.ctxTimeAtAnchor.toFixed(4)} ctxNow=${this.ctx.currentTime.toFixed(4)} state=${this.state}`);
    }
    if (this.noAudio) {
      this.pendingQueue = [];
      this.mediaTimeOfAnchor = newMediaTime;
      this.wallAnchorMs = performance.now();
      this.state = "idle";
      return;
    }

    try { this.gain.disconnect(); } catch { /* ignore */ }
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    this.applyGain();

    this.pendingQueue = [];
    this.mediaTimeOfAnchor = newMediaTime;
    this.mediaTimeOfNext = newMediaTime;
    this.ctxTimeAtAnchor = this.ctx.currentTime;
    this.firstAudibleCtxStart = -1;
    this.state = "idle";

    if (this.ctx.state === "running") {
      await this.ctx.suspend();
    }
  }

  stats(): Record<string, unknown> {
    return {
      framesScheduled: this.framesScheduled,
      bufferAhead: this.bufferAhead(),
      audioState: this.state,
      clockMode: this.noAudio ? "wall" : "audio",
    };
  }

  destroy(): void {
    this.destroyed = true;
    try { this.ctx.close(); } catch { /* ignore */ }
  }
}
