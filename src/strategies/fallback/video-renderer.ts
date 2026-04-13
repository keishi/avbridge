import type { ClockSource } from "./audio-output.js";

/**
 * Renders decoded `VideoFrame`s into a 2D canvas overlaid on the user's
 * `<video>` element. The fallback strategy never assigns a src to the video,
 * so we hide it and put the canvas in its place visually.
 *
 * The renderer has two modes:
 *
 * 1. **Pre-roll** — `clock.isPlaying()` is false. The very first decoded
 *    frame is painted as a "poster" so the user sees something while audio
 *    buffers; subsequent frames stay queued without being dropped.
 *
 * 2. **Synced** — `clock.isPlaying()` is true. On each rAF tick, find the
 *    latest frame whose timestamp ≤ `clock.now() + lookahead` and paint it.
 *    Drop any older frames as "late."
 *
 * The pre-roll behavior is what fixes the cold-start "first minute is all
 * dropped" problem: without it, the wall clock raced ahead while the
 * decoder was still warming up, and every frame was already in the past by
 * the time it landed in the queue.
 */
export class VideoRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private queue: VideoFrame[] = [];
  private rafHandle: number | null = null;
  private destroyed = false;

  private framesPainted = 0;
  private framesDroppedLate = 0;
  private framesDroppedOverflow = 0;
  private prerolled = false;
  /** Wall-clock time of the last paint, in ms (performance.now()). */
  private lastPaintWall = 0;
  /** Minimum ms between paints — paces video at roughly source fps. */
  private paintIntervalMs: number;

  /** Resolves once the first decoded frame has been enqueued. */
  readonly firstFrameReady: Promise<void>;
  private resolveFirstFrame!: () => void;

  /**
   * Post-seek grace: after flush(), don't drop any frames as "late" until
   * we've painted at least this many frames. After a seek, WebCodecs
   * decodes from the nearest keyframe — those frames have PTS values
   * BEFORE the seek target, so they'd all be dropped as "late" without
   * this grace period. We paint them in sequence instead (slight visual
   * catch-up is better than stutter/freeze).
   */
  private postFlushGrace = 0;
  private static readonly POST_FLUSH_GRACE_FRAMES = 30;

  constructor(
    private readonly target: HTMLVideoElement,
    private readonly clock: ClockSource,
    fps = 30,
  ) {
    this.paintIntervalMs = Math.max(1, 1000 / fps);
    this.firstFrameReady = new Promise<void>((resolve) => {
      this.resolveFirstFrame = resolve;
    });

    this.canvas = document.createElement("canvas");
    // object-fit:contain letterboxes the canvas bitmap (sized to
    // frame.displayWidth × displayHeight in paint()) inside the stage so
    // portrait / non-stage-aspect content isn't stretched. Canvas is a
    // replaced element, so object-fit applies.
    this.canvas.style.cssText =
      "position:absolute;left:0;top:0;width:100%;height:100%;background:black;object-fit:contain;";

    // Attach the canvas next to the video. When the video lives inside an
    // `<avbridge-video>` shadow root, `target.parentElement` is the
    // positioned `<div part="stage">` wrapper the element created
    // precisely for this purpose. When the video is used standalone
    // (legacy `createPlayer({ target: videoEl })` path), we fall back to
    // `parentNode` — which handles plain Elements, and also ShadowRoots
    // if someone inserts a bare <video> inside their own shadow DOM
    // without a wrapper.
    const parent: ParentNode | null =
      (target.parentElement as ParentNode | null) ?? target.parentNode;
    if (parent && parent instanceof HTMLElement) {
      if (getComputedStyle(parent).position === "static") {
        parent.style.position = "relative";
      }
    }
    if (parent) {
      parent.insertBefore(this.canvas, target);
    } else {
      // No parent at all — the target is detached. Fall back to appending
      // the canvas to document.body so at least the frames are visible
      // somewhere while the consumer fixes their DOM layout. This is a
      // loud fallback: log a warning so the misuse is obvious.
      // eslint-disable-next-line no-console
      console.warn(
        "[avbridge] fallback renderer: target <video> has no parent; " +
        "appending canvas to document.body as a fallback.",
      );
      document.body.appendChild(this.canvas);
    }
    target.style.visibility = "hidden";

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("video renderer: failed to acquire 2D context");
    this.ctx = ctx;

    this.tick = this.tick.bind(this);
    this.rafHandle = requestAnimationFrame(this.tick);
  }

  /** True once at least one frame has been enqueued. */
  hasFrames(): boolean {
    return this.queue.length > 0 || this.framesPainted > 0;
  }

  /** Current depth of the frame queue. Used by the decoder for backpressure. */
  queueDepth(): number {
    return this.queue.length;
  }

  /**
   * Soft cap for decoder backpressure. The decoder pump throttles when
   * `queueDepth() >= queueHighWater`. Set high enough that normal decode
   * bursts don't trigger the renderer's overflow-drop loop (which runs at
   * every paint), but low enough that the decoder doesn't run unboundedly
   * ahead. The hard cap in `enqueue()` is 64.
   */
  readonly queueHighWater = 30;

  enqueue(frame: VideoFrame): void {
    if (this.destroyed) {
      frame.close();
      return;
    }
    this.queue.push(frame);
    if (this.queue.length === 1 && this.framesPainted === 0) {
      this.resolveFirstFrame();
    }
    // Hard cap. Should rarely trigger because the decoder backs off at
    // queueHighWater (30) and the drift correction trims gently. This is
    // the last-resort defense against runaway producers.
    while (this.queue.length > 60) {
      this.queue.shift()?.close();
      this.framesDroppedOverflow++;
    }
  }

  private tick(): void {
    if (this.destroyed) return;
    this.rafHandle = requestAnimationFrame(this.tick);

    if (this.queue.length === 0) return;

    const playing = this.clock.isPlaying();

    // Pre-roll: paint the very first frame as a poster while audio buffers.
    if (!playing) {
      if (!this.prerolled) {
        const head = this.queue.shift()!;
        this.paint(head);
        head.close();
        this.prerolled = true;
        this.lastPaintWall = performance.now();
      }
      return;
    }

    // Wall-clock-paced painting. Paint one frame every paintIntervalMs
    // of wall time. The interval is reduced by 15% to compensate for rAF
    // quantization at 60Hz — without this, 24fps content rounds to 50ms
    // intervals (20fps effective) and drift correction drops frames to
    // catch up. With the 15% reduction, we hit 33ms intervals (every 2
    // rAFs) which is closer to the target and produces smoother playback.
    const wallNow = performance.now();
    const adjustedInterval = this.paintIntervalMs * 0.85;
    if (wallNow - this.lastPaintWall < adjustedInterval - 2) return;

    if (this.queue.length === 0) return;

    // Coarse drift correction: compare the head frame's timestamp to
    // audio.now() every ~2 sec (every 60 frames). Increased tolerance
    // from 150ms to 300ms so main-thread jank from DTS decode doesn't
    // trigger unnecessary drops. The correction is gentle — one frame
    // per check.
    if (this.framesPainted > 0 && this.framesPainted % 60 === 0) {
      const audioNowUs = this.clock.now() * 1_000_000;
      const headTs = this.queue[0].timestamp ?? 0;
      const driftUs = headTs - audioNowUs;

      if (this.postFlushGrace > 0) {
        this.postFlushGrace--;
      } else if (driftUs < -300_000) {
        // Video behind audio by > 300ms — drop one frame to catch up.
        this.queue.shift()?.close();
        this.framesDroppedLate++;
        if (this.queue.length === 0) return;
      } else if (driftUs > 300_000) {
        // Video ahead of audio by > 300ms — skip this paint cycle.
        return;
      }
    }

    const frame = this.queue.shift()!;
    this.paint(frame);
    frame.close();
    this.lastPaintWall = wallNow;
  }

  private paint(frame: VideoFrame): void {
    if (
      this.canvas.width !== frame.displayWidth ||
      this.canvas.height !== frame.displayHeight
    ) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
    }
    try {
      this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
      this.framesPainted++;
    } catch (err) {
      // Log only once so a structurally broken frame format doesn't spam
      // the console at 60 Hz, but we still find out about it.
      if (this.framesPainted === 0 && this.framesDroppedLate === 0) {
        // eslint-disable-next-line no-console
        console.warn("[avbridge] canvas drawImage failed:", err);
      }
    }
  }

  /** Discard all queued frames. Used by seek to drop stale buffers. */
  flush(): void {
    while (this.queue.length > 0) this.queue.shift()?.close();
    this.prerolled = false;
    this.postFlushGrace = VideoRenderer.POST_FLUSH_GRACE_FRAMES;
  }

  stats(): Record<string, unknown> {
    return {
      framesPainted: this.framesPainted,
      framesDroppedLate: this.framesDroppedLate,
      framesDroppedOverflow: this.framesDroppedOverflow,
      queueDepth: this.queue.length,
    };
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafHandle != null) cancelAnimationFrame(this.rafHandle);
    this.flush();
    this.canvas.remove();
    this.target.style.visibility = "";
  }
}
