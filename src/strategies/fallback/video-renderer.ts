import type { ClockSource } from "./audio-output.js";
import { SubtitleOverlay } from "../../subtitles/render.js";

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
// Periodic debug log — throttled to once per second so it doesn't
// flood the console at 60Hz rAF rate.
function isDebug(): boolean {
  return typeof globalThis !== "undefined" && !!(globalThis as Record<string, unknown>).AVBRIDGE_DEBUG;
}
let lastDebugLog = 0;

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
  /** Cumulative count of frames skipped because all PTS are in the future. */
  private ticksWaiting = 0;
  /** Cumulative count of ticks where PTS mode painted a frame. */
  private ticksPainted = 0;

  /**
   * Subtitle overlay div attached to the stage wrapper alongside the
   * canvas. Created lazily when subtitle tracks are attached via the
   * target's `<track>` children. Canvas strategies (hybrid, fallback)
   * hide the <video>, so we can't rely on the browser's native cue
   * rendering; we read TextTrack.cues and render into this overlay.
   */
  private subtitleOverlay: SubtitleOverlay | null = null;
  private subtitleTrack: TextTrack | null = null;

  /**
   * Calibration offset (microseconds) between video PTS and audio clock.
   * Video PTS and AudioContext.currentTime can drift ~0.1% relative to
   * each other (different clock domains). Over 45 minutes that's 2.6s.
   * We measure the offset on the first painted frame and update it
   * periodically so the PTS comparison stays calibrated.
   */
  private ptsCalibrationUs = 0;
  private ptsCalibrated = false;
  private lastCalibrationWall = 0;

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

    // Create a subtitle overlay on the same parent as the canvas so cues
    // appear over the rendered video. Shows nothing until a TextTrack
    // gets attached via attachSubtitleTracks.
    const overlayParent = parent instanceof HTMLElement ? parent : document.body;
    this.subtitleOverlay = new SubtitleOverlay(overlayParent);
    // Watch for <track> children on the target <video>. When one is
    // added, grab its TextTrack and poll cues from it each tick.
    this.watchTextTracks(target);

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

  /**
   * Watch the target <video>'s textTracks list. When a track is added,
   * grab it and start polling cues on each render tick. Existing tracks
   * (if any) are picked up immediately.
   */
  private watchTextTracks(target: HTMLVideoElement): void {
    const pick = () => {
      if (this.subtitleTrack) return;
      const tracks = target.textTracks;
      if (isDebug()) {
        // eslint-disable-next-line no-console
        console.log(`[avbridge:subs] watchTextTracks pick() — ${tracks.length} tracks`);
      }
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (isDebug()) {
          // eslint-disable-next-line no-console
          console.log(`[avbridge:subs] track ${i}: kind=${t.kind} mode=${t.mode} cues=${t.cues?.length ?? 0}`);
        }
        if (t.kind === "subtitles" || t.kind === "captions") {
          this.subtitleTrack = t;
          t.mode = "hidden"; // hidden means "cues available via API, don't render"
          if (isDebug()) {
            // eslint-disable-next-line no-console
            console.log(`[avbridge:subs] picked track, mode=hidden`);
          }
          // Listen for cue load completion
          const trackEl = target.querySelector(`track[srclang="${t.language}"]`) as HTMLTrackElement | null;
          if (trackEl) {
            trackEl.addEventListener("load", () => {
              if (isDebug()) {
                // eslint-disable-next-line no-console
                console.log(`[avbridge:subs] track element loaded, cues=${t.cues?.length ?? 0}`);
              }
            });
            trackEl.addEventListener("error", (ev) => {
              // eslint-disable-next-line no-console
              console.warn(`[avbridge:subs] track element error:`, ev);
            });
          }
          break;
        }
      }
    };
    pick();
    if (typeof target.textTracks.addEventListener === "function") {
      target.textTracks.addEventListener("addtrack", (e) => {
        if (isDebug()) {
          // eslint-disable-next-line no-console
          console.log("[avbridge:subs] addtrack event fired");
        }
        void e;
        pick();
      });
    }
  }

  private _loggedCues = false;

  /** Find the active cue (if any) for the given media time. */
  private updateSubtitles(): void {
    if (!this.subtitleOverlay || !this.subtitleTrack) return;
    const cues = this.subtitleTrack.cues;
    if (!cues || cues.length === 0) return;
    if (isDebug() && !this._loggedCues) {
      this._loggedCues = true;
      // eslint-disable-next-line no-console
      console.log(`[avbridge:subs] cues available: ${cues.length}, first start=${cues[0].startTime}, last end=${cues[cues.length-1].endTime}`);
    }
    const t = this.clock.now();
    let activeText = "";
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (t >= c.startTime && t <= c.endTime) {
        const vttCue = c as VTTCue & { text?: string };
        activeText = vttCue.text ?? "";
        break;
      }
    }
    // Strip VTT tags for plain rendering (e.g. <c.en> voice tags)
    this.subtitleOverlay.setText(activeText.replace(/<[^>]+>/g, ""));
  }

  private tick(): void {
    if (this.destroyed) return;
    this.rafHandle = requestAnimationFrame(this.tick);

    this.updateSubtitles();

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
    const rawAudioNowUs = this.clock.now() * 1_000_000;
    const headTs = this.queue[0].timestamp ?? 0;
    const hasPts = headTs > 0 || this.queue.length > 1;

    if (hasPts) {
      // Calibration: video PTS and audio clock (AudioContext.currentTime)
      // live in different clock domains with a fixed offset (different epoch)
      // plus a small rate drift (~7ms/s). We snap the offset on first paint
      // and re-snap every 10 seconds. Between snaps, max drift is ~70ms
      // (under 2 frames at 24fps, below lip-sync perception threshold).
      const wallNow = performance.now();
      if (!this.ptsCalibrated || wallNow - this.lastCalibrationWall > 10_000) {
        this.ptsCalibrationUs = headTs - rawAudioNowUs;
        this.ptsCalibrated = true;
        this.lastCalibrationWall = wallNow;
      }

      const audioNowUs = rawAudioNowUs + this.ptsCalibrationUs;
      const frameDurationUs = this.paintIntervalMs * 1000;
      const deadlineUs = audioNowUs + frameDurationUs;

      let bestIdx = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const ts = this.queue[i].timestamp ?? 0;
        if (ts <= deadlineUs) {
          bestIdx = i;
        } else {
          break;
        }
      }

      if (bestIdx < 0) {
        this.ticksWaiting++;
        if (isDebug()) {
          const now = performance.now();
          if (now - lastDebugLog > 1000) {
            const headPtsMs = (headTs / 1000).toFixed(1);
            const audioMs = (audioNowUs / 1000).toFixed(1);
            const rawDriftMs = ((headTs - rawAudioNowUs) / 1000).toFixed(1);
            const calibMs = (this.ptsCalibrationUs / 1000).toFixed(1);
            // eslint-disable-next-line no-console
            console.log(
              `[avbridge:renderer] WAIT q=${this.queue.length} headPTS=${headPtsMs}ms calibAudio=${audioMs}ms ` +
              `rawDrift=${rawDriftMs}ms calib=${calibMs}ms painted=${this.framesPainted} dropped=${this.framesDroppedLate}`,
            );
            lastDebugLog = now;
          }
        }
        return;
      }

      // Only drop frames that are more than 2 frame-durations behind.
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

      this.ticksPainted++;

      if (isDebug()) {
        const now = performance.now();
        if (now - lastDebugLog > 1000) {
          const paintedTs = (this.queue[0]?.timestamp ?? 0);
          const audioMs = (audioNowUs / 1000).toFixed(1);
          const ptsMs = (paintedTs / 1000).toFixed(1);
          const rawDriftMs = ((paintedTs - rawAudioNowUs) / 1000).toFixed(1);
          const calibMs = (this.ptsCalibrationUs / 1000).toFixed(1);
          // eslint-disable-next-line no-console
          console.log(
            `[avbridge:renderer] PAINT q=${this.queue.length} calibAudio=${audioMs}ms nextPTS=${ptsMs}ms ` +
            `rawDrift=${rawDriftMs}ms calib=${calibMs}ms dropped=${dropped} total_drops=${this.framesDroppedLate} painted=${this.framesPainted}`,
          );
          lastDebugLog = now;
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
    const count = this.queue.length;
    while (this.queue.length > 0) this.queue.shift()?.close();
    this.prerolled = false;
    this.ptsCalibrated = false; // recalibrate at new seek position
    if (isDebug() && count > 0) {
      // eslint-disable-next-line no-console
      console.log(`[avbridge:renderer] FLUSH discarded=${count} painted=${this.framesPainted} drops=${this.framesDroppedLate}`);
    }
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
    if (this.subtitleOverlay) { this.subtitleOverlay.destroy(); this.subtitleOverlay = null; }
    this.subtitleTrack = null;
    this.canvas.remove();
    this.target.style.visibility = "";
  }
}
