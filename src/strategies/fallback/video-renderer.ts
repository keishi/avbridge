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

    // PTS-based painting: find the latest frame whose presentation time
    // has arrived (timestamp ≤ audio clock), paint it, and discard any
    // older frames. This produces correct cadence at any display refresh
    // rate and any source fps — no 3:2 pulldown artifacts.
    //
    // Fallback: if frame timestamps are unreliable (all zero, synthetic),
    // fall back to wall-clock pacing as before.
    const audioNowUs = this.clock.now() * 1_000_000;
    const headTs = this.queue[0].timestamp ?? 0;
    const hasPts = headTs > 0 || this.queue.length > 1;

    if (hasPts) {
      // PTS mode: find the latest frame that should be displayed now.
      //
      // When the main thread blocks (DTS decode), rAF doesn't fire for
      // 10-50ms. By the time we run, the audio clock has advanced and
      // several frames may be "past." Dropping them all causes stutter.
      //
      // Instead: only drop frames that are MORE than one frame-duration
      // behind the audio clock. Frames within one frame-duration are
      // considered "on time" — the main-thread jank isn't the renderer's
      // fault and dropping doesn't help the user.
      const frameDurationUs = this.paintIntervalMs * 1000;
      const deadlineUs = audioNowUs + frameDurationUs; // one frame of slack

      let bestIdx = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const ts = this.queue[i].timestamp ?? 0;
        if (ts <= deadlineUs) {
          bestIdx = i;
        } else {
          break;
        }
      }

      if (bestIdx < 0) return; // all frames in the future — wait

      // Only drop frames that are more than 2 frame-durations behind.
      // This tolerates main-thread jank without unnecessary drops.
      const dropThresholdUs = audioNowUs - frameDurationUs * 2;
      let dropped = 0;
      while (bestIdx > 0) {
        const ts = this.queue[0].timestamp ?? 0;
        if (ts < dropThresholdUs) {
          this.queue.shift()?.close();
          this.framesDroppedLate++;
          bestIdx--;
          dropped++;
        } else {
          break;
        }
      }

      const frame = this.queue.shift()!;
      this.paint(frame);
      frame.close();
      this.lastPaintWall = performance.now();
      return;
    }

    // Wall-clock fallback: used when timestamps are unreliable (all zero).
    const wallNow = performance.now();
    if (wallNow - this.lastPaintWall < this.paintIntervalMs - 2) return;

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
