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
  /** True once the head frame has been painted as a pre-roll poster
   *  since the last flush. Used to ensure pre-roll paints exactly one
   *  frame (held static) during the post-seek discard window. */
  private prerolled = false;
  /** PTS (µs) of the most recently painted frame. Used as the calibration
   *  reference on the first post-flush snap: the pre-roll path paints one
   *  frame *before* PTS-based playback starts, so the queue head's PTS at
   *  first PTS-based paint is the *next* frame, off by one frameDur from
   *  the actually-displayed frame. Calibrating against the painted frame
   *  instead of the queue head removes that one-frame offset and yields
   *  calib ≈ 0 instead of +frameDur. */
  private lastPaintedPtsUs = 0;
  private hasLastPaintedPts = false;
  /** Audio-clock reading (ms) at the previous paint, for overlay Δaud. */
  private lastPaintAudMs = 0;
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
    // `object-fit` is driven by the `--avbridge-fit` custom property so the
    // `<avbridge-video>` element's `fit` attribute can retarget the canvas
    // without reaching into the fallback strategy. Default is `contain` —
    // letterboxes the canvas bitmap (sized to frame.displayWidth ×
    // displayHeight in paint()) inside the stage so portrait / non-stage-aspect
    // content isn't stretched. Canvas is a replaced element, so object-fit applies.
    this.canvas.style.cssText =
      "position:absolute;left:0;top:0;width:100%;height:100%;background:black;object-fit:var(--avbridge-fit, contain);";

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

  /**
   * True once at least one frame has been enqueued *since the last flush*.
   * Used by `readyState` — initial cold-start reports HAVE_NOTHING until
   * any frame has arrived, and after a seek we want the same semantics
   * (HAVE_NOTHING until post-seek frames arrive), so the cumulative
   * `framesPainted > 0` that used to live here was wrong: it kept the
   * state "true forever" after the first frame ever, so post-seek
   * `waitForBuffer()` would exit immediately with an empty queue and
   * leave video frozen while audio kept going.
   */
  hasFrames(): boolean {
    return this.queue.length > 0 || this.hasEverEnqueuedSinceFlush;
  }

  private hasEverEnqueuedSinceFlush = false;

  /** Current depth of the frame queue. Used by the decoder for backpressure. */
  queueDepth(): number {
    return this.queue.length;
  }

  /**
   * Cap the decoder may fill the queue up to. Used by the decoder's
   * enqueue-side discard logic (it closes new frames instead of pushing
   * them when this is reached). Sized so a long post-seek catch-up
   * fits — the decoder produces frames at PTS T_kf onwards rapidly
   * while the demuxer is chewing through pre-target audio; if the
   * queue can hold the whole post-seek burst, the renderer plays
   * smoothly from pre-roll without a frozen-video gap when audio.start
   * fires. At ~340 KB per SD frame the cap is ~85 MB peak; at HD it's
   * larger but still bounded.
   */
  readonly queueHighWater = 256;

  enqueue(frame: VideoFrame): void {
    if (this.destroyed) {
      frame.close();
      return;
    }
    this.queue.push(frame);
    this.hasEverEnqueuedSinceFlush = true;
    if (this.queue.length === 1 && this.framesPainted === 0) {
      this.resolveFirstFrame();
    }
    // Hard cap. The decoder's enqueue-side discard at `queueHighWater`
    // is the primary defense; this `+8` margin is just safety for a
    // racy producer. Drops the OLDEST frames, which during catch-up
    // would mean losing the frames closest to the seek target — so the
    // decoder should be tuned to never reach this.
    while (this.queue.length > this.queueHighWater + 8) {
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

    // Pre-roll: paint the head frame ONCE as a poster while audio buffers.
    //
    // Safety invariant (load-bearing): with the decoder.ts content-clock
    // fix (POSTMORTEMS 2026-06-01), pre-target frames are discarded at
    // the decoder/enqueue boundary, so queue[0] here is guaranteed to be
    // a near-target frame — never the keyframe-to-target preroll sequence
    // that previously caused the post-seek fast-forward when painted.
    //
    // Paint at most ONE frame and hold it (gate via `prerolled`). Do NOT
    // shift the queue: when audio unfreezes and `playing` becomes true,
    // the regular PTS loop below will paint this same frame again and
    // shift it out. That second paint is a no-op visually (same pixels)
    // so there's no flicker.
    //
    // If the queue is empty (decoder still grinding through the post-seek
    // discard window), just return — last pre-flush frame stays on canvas
    // as the freeze poster, which is the safe fallback.
    if (!playing) {
      if (!this.prerolled && this.queue.length > 0) {
        this.prerolled = true;
        this.paint(this.queue[0]);
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
      //
      // Two cases for the *first* snap after flush:
      //   - Anchor `rawAudioNowUs` against `clock.now()` (default for the
      //     periodic 10s re-snap) drifts with the audio clock — including
      //     decode-stall lag accumulated between `audio.start()` and the
      //     first frame's arrival. On a slow seek where the first frame
      //     lands 1–2s after audio resumed, this captures the lag as a
      //     permanent offset and the video stays that far behind audio.
      //   - For the *first* snap post-flush we instead use the audio's
      //     **anchor time** (`mediaTimeOfAnchor`, == the seek target / 0
      //     on cold start). That gives `headTs − seekTarget` ≈ keyframe
      //     offset (usually < 100ms), independent of decode delay.
      const wallNow = performance.now();
      // First snap after flush/cold-start anchors against the audio's
      // *master-clock reference* (= `mediaTimeOfAnchor`, == the rebased
      // audio first-chunk PTS), NOT `clock.now()`. `clock.now()` includes
      // wall-clock-drifted elapsed time between `audio.start()` and the
      // first paint — on a slow seek where the first frame lands 1-2 s
      // after audio resumed, that decode delay gets baked into the
      // calibration as a permanent video-lag offset. See POSTMORTEMS.md
      // (2026-04-13). The periodic re-snap continues to use `rawAudioNow`
      // as the original design intended — a stateless independent snap
      // every 10 s bounds drift to ~70 ms at the documented ~7 ms/s rate,
      // below the lip-sync perception threshold. Do *not* introduce a
      // smoothed / EMA / bounded-delta variant here: the measured offset
      // includes the current calibration, which produces a feedback loop
      // (postmortem 2026-04-13, hypothesis 3).
      if (!this.ptsCalibrated) {
        const anchorUs = (this.clock.anchorTime?.() ?? this.clock.now()) * 1_000_000;
        // Reference frame for calibration: prefer the pre-rolled frame's
        // PTS over the queue head, since the pre-rolled frame is what the
        // user is *actually looking at* the moment audio starts. The queue
        // head at this point is the NEXT frame (PTS == prerolled + frameDur),
        // and calibrating against it bakes that one-frame offset into the
        // calibration permanently. With the painted-frame reference, calib
        // ≈ 0 when video keyframe lands at the seek target.
        const referencePtsUs = this.hasLastPaintedPts ? this.lastPaintedPtsUs : headTs;
        this.ptsCalibrationUs = referencePtsUs - anchorUs;
        this.ptsCalibrated = true;
        this.lastCalibrationWall = wallNow;
        if (isDebug()) {
          // eslint-disable-next-line no-console
          console.log(
            `[avbridge:renderer] CALIB-FIRST audioAnchor=${(anchorUs / 1000).toFixed(1)}ms ` +
            `prerolledPTS=${this.hasLastPaintedPts ? (this.lastPaintedPtsUs / 1000).toFixed(1) : "n/a"}ms ` +
            `queueHeadPTS=${(headTs / 1000).toFixed(1)}ms ` +
            `rawAudioNow=${(rawAudioNowUs / 1000).toFixed(1)}ms ` +
            `→ calib=${(this.ptsCalibrationUs / 1000).toFixed(1)}ms`,
          );
        }
      } else if (wallNow - this.lastCalibrationWall > 10_000) {
        const oldCalib = this.ptsCalibrationUs;
        this.ptsCalibrationUs = headTs - rawAudioNowUs;
        this.lastCalibrationWall = wallNow;
        if (isDebug()) {
          // eslint-disable-next-line no-console
          console.log(
            `[avbridge:renderer] CALIB-RESNAP ` +
            `headPTS=${(headTs / 1000).toFixed(1)}ms rawAudioNow=${(rawAudioNowUs / 1000).toFixed(1)}ms ` +
            `calib ${(oldCalib / 1000).toFixed(1)}ms → ${(this.ptsCalibrationUs / 1000).toFixed(1)}ms ` +
            `(Δ=${((this.ptsCalibrationUs - oldCalib) / 1000).toFixed(1)}ms after 10s)`,
          );
        }
      }

      const audioNowUs = rawAudioNowUs + this.ptsCalibrationUs;
      // Paint the frame whose PTS is at or just before audioNow. A frame
      // at PTS P should be the displayed frame from the moment audio
      // reaches P, *not* from P − frameDur. The previous code used
      // `deadline = audioNow + frameDur`, which painted frames up to one
      // source-frame ahead of audio — a steady ~40 ms video-leads-audio
      // offset that the user perceived as "fast-forward then normal."
      // With `deadline = audioNow`, paints land exactly at the frame's
      // start of display interval; lip sync matches.
      const deadlineUs = audioNowUs;

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

      // Audio-sync skip: when `bestIdx > 0` there are multiple frames in
      // the queue whose PTS ≤ deadline. Drop everything before `bestIdx`
      // and paint the latest paintable frame. See POSTMORTEMS.md
      // 2026-05-31 coda for the rationale.
      const _relaxDrop =
        (globalThis as { AVBRIDGE_RELAX_DROP?: boolean }).AVBRIDGE_RELAX_DROP === true;
      let dropped = 0;
      const initialBestIdx = bestIdx;
      if (!_relaxDrop) {
        while (bestIdx > 0) {
          this.queue.shift()?.close();
          this.framesDroppedLate++;
          bestIdx--;
          dropped++;
        }
      }
      const paintTs = this.queue[0]?.timestamp ?? 0;
      if (isDebug()) {
        // eslint-disable-next-line no-console
        console.log(`[TRACE] PAINT bestIdx_initial=${initialBestIdx} dropped=${dropped} paintPts=${(paintTs / 1000).toFixed(1)}ms audioNow=${(audioNowUs / 1000).toFixed(1)}ms deadline=${(deadlineUs / 1000).toFixed(1)}ms queueLen=${this.queue.length} wall=${performance.now().toFixed(0)}`);
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

      // Debug overlay (gated on AVBRIDGE_DEBUG). Draws frame info on top
      // of the painted frame so the user can SEE what's actually
      // displayed and at what rate. Three time domains:
      //   pts  — source content time (from frame.timestamp)
      //   aud  — audio media clock (clock.now() × 1000)
      //   wall — performance.now() (monotonic browser clock)
      // Plus the per-paint deltas. If `Δpts > Δwall` sustained across
      // multiple frames, that's real fast-forward; if it alternates
      // 33/50ms on a 25fps source, that's 3:2 pulldown judder. (See
      // POSTMORTEMS 2026-06-01 for why this overlay was load-bearing
      // when diagnosing the post-seek fast-forward.)
      if (isDebug()) {
        const wallNow = performance.now();
        const audNowMs = this.clock.now() * 1000;
        const ptsMs = (frame.timestamp ?? 0) / 1000;
        const dWall = this.lastPaintWall > 0 ? wallNow - this.lastPaintWall : 0;
        const dAud = this.lastPaintAudMs > 0 ? audNowMs - this.lastPaintAudMs : 0;
        const dPts = this.hasLastPaintedPts ? ptsMs - this.lastPaintedPtsUs / 1000 : 0;
        this.ctx.save();
        this.ctx.font = "bold 18px monospace";
        const lines = [
          `#${this.framesPainted + 1}  pts=${ptsMs.toFixed(0)}  aud=${audNowMs.toFixed(0)}  wall=${wallNow.toFixed(0)}`,
          `Δpts=${dPts.toFixed(0)}  Δaud=${dAud.toFixed(0)}  Δwall=${dWall.toFixed(0)}`,
        ];
        const lineHeight = 22;
        const padTop = 6;
        const stripH = padTop + lineHeight * lines.length;
        this.ctx.fillStyle = "rgba(0,0,0,0.7)";
        this.ctx.fillRect(0, 0, this.canvas.width, stripH);
        this.ctx.fillStyle = "#0f0";
        for (let i = 0; i < lines.length; i++) {
          this.ctx.fillText(lines[i], 8, padTop + lineHeight * (i + 1) - 4);
        }
        this.ctx.restore();
      }

      // Record the just-painted frame's PTS so the next paint's overlay
      // Δpts and the next CALIB-RESNAP have a reference. Must run
      // unconditionally — `hasLastPaintedPts`/`lastPaintedPtsUs` are read
      // by the calibration path in tick() too, not just the overlay.
      this.lastPaintedPtsUs = frame.timestamp ?? 0;
      this.hasLastPaintedPts = true;
      this.lastPaintAudMs = this.clock.now() * 1000;

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
    this.hasLastPaintedPts = false; // calibration ref doesn't carry across seek
    this.ptsCalibrated = false; // recalibrate at new seek position
    this.hasEverEnqueuedSinceFlush = false; // so waitForBuffer() waits for post-flush frames
    if (isDebug() && count > 0) {
      // eslint-disable-next-line no-console
      console.log(`[avbridge:renderer] FLUSH discarded=${count} painted=${this.framesPainted} drops=${this.framesDroppedLate}`);
    }
  }

  stats(): Record<string, unknown> {
    // Queue span — the gap between the oldest and newest queued frame's
    // PTS, in ms. If this collapses while audio keeps advancing, the
    // producer has stalled. If it stays wide with stale head, the
    // producer is bursting faster than realtime but the renderer can't
    // catch up.
    let queueSpanMs = 0;
    let queueHeadMs = 0;
    let queueTailMs = 0;
    if (this.queue.length > 0) {
      queueHeadMs = Math.round((this.queue[0].timestamp ?? 0) / 1000);
      queueTailMs = Math.round((this.queue[this.queue.length - 1].timestamp ?? 0) / 1000);
      queueSpanMs = Math.max(0, queueTailMs - queueHeadMs);
    }
    return {
      framesPainted: this.framesPainted,
      framesDroppedLate: this.framesDroppedLate,
      framesDroppedOverflow: this.framesDroppedOverflow,
      queueDepth: this.queue.length,
      queueHeadMs,
      queueTailMs,
      queueSpanMs,
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
