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
}

export interface ClockSource {
  /** Current media time in seconds. */
  now(): number;
  /** True if media is currently playing (audio scheduler is running). */
  isPlaying(): boolean;
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
  private ctxTimeAtAnchor = 0;

  private pendingQueue: PendingChunk[] = [];

  private framesScheduled = 0;
  private destroyed = false;

  constructor() {
    this.ctx = new AudioContext();
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
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
        return this.mediaTimeOfAnchor + (performance.now() - this.wallAnchorMs) / 1000;
      }
      return this.mediaTimeOfAnchor;
    }
    if (this.state === "playing") {
      return this.mediaTimeOfAnchor + (this.ctx.currentTime - this.ctxTimeAtAnchor);
    }
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
   */
  schedule(samples: Float32Array, channels: number, sampleRate: number): void {
    if (this.destroyed || this.noAudio) return;
    const frameCount = samples.length / channels;
    const durationSec = frameCount / sampleRate;

    if (this.state === "idle" || this.state === "paused") {
      this.pendingQueue.push({ samples, channels, sampleRate, frameCount, durationSec });
      return;
    }

    this.scheduleNow(samples, channels, sampleRate, frameCount);
  }

  private scheduleNow(
    samples: Float32Array,
    channels: number,
    sampleRate: number,
    frameCount: number,
  ): void {
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

    // Convert media time → ctx time using the anchor.
    const ctxStart = this.ctxTimeAtAnchor + (this.mediaTimeOfNext - this.mediaTimeOfAnchor);
    const safeStart = Math.max(ctxStart, this.ctx.currentTime);
    node.start(safeStart);

    this.mediaTimeOfNext += frameCount / sampleRate;
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

    if (this.state === "paused") {
      // Resume: media time should continue from where we paused. ctx.currentTime
      // is preserved across suspend/resume, so re-anchoring it to "now" with
      // the same mediaTimeOfAnchor gives a continuous clock.
      this.ctxTimeAtAnchor = this.ctx.currentTime;
      this.state = "playing";
      // Drain anything that was scheduled while paused.
      const drain = this.pendingQueue;
      this.pendingQueue = [];
      for (const c of drain) {
        this.scheduleNow(c.samples, c.channels, c.sampleRate, c.frameCount);
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

    const drain = this.pendingQueue;
    this.pendingQueue = [];
    for (const c of drain) {
      this.scheduleNow(c.samples, c.channels, c.sampleRate, c.frameCount);
    }
  }

  /** Pause playback. Suspends the audio context. */
  async pause(): Promise<void> {
    if (this.state !== "playing") return;
    this.mediaTimeOfAnchor = this.now();
    this.state = "paused";
    if (this.noAudio) return;
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

    this.pendingQueue = [];
    this.mediaTimeOfAnchor = newMediaTime;
    this.mediaTimeOfNext = newMediaTime;
    this.ctxTimeAtAnchor = this.ctx.currentTime;
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
