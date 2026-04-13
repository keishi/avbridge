/**
 * MediaSource Extensions plumbing. Wraps a `MediaSource` + single
 * `SourceBuffer` with an append queue that respects `updateend` backpressure.
 */

import { AvbridgeError, ERR_MSE_NOT_SUPPORTED, ERR_MSE_CODEC_NOT_SUPPORTED } from "../../errors.js";

export interface MseSinkOptions {
  mime: string;
  video: HTMLVideoElement;
  /** Called once the MediaSource is open and ready for appends. */
  onReady?: () => void;
}

export class MseSink {
  private mediaSource: MediaSource;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: ArrayBuffer[] = [];
  private endOfStreamCalled = false;
  private destroyed = false;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private objectUrl: string;

  constructor(private readonly options: MseSinkOptions) {
    if (typeof MediaSource === "undefined") {
      throw new AvbridgeError(
        ERR_MSE_NOT_SUPPORTED,
        "MediaSource Extensions (MSE) are not supported in this environment.",
        "MSE is required for the remux strategy. Use a browser that supports MSE, or try the fallback strategy.",
      );
    }
    if (!MediaSource.isTypeSupported(options.mime)) {
      throw new AvbridgeError(
        ERR_MSE_CODEC_NOT_SUPPORTED,
        `This browser's MSE does not support "${options.mime}".`,
        "The codec combination can't be played via remux in this browser. The player will try the next strategy automatically.",
      );
    }

    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    options.video.src = this.objectUrl;

    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.mediaSource.addEventListener("sourceopen", () => {
      try {
        this.sourceBuffer = this.mediaSource.addSourceBuffer(options.mime);
        this.sourceBuffer.mode = "segments";
        this.sourceBuffer.addEventListener("updateend", () => this.pump());
        this.resolveReady();
        options.onReady?.();
      } catch (err) {
        this.rejectReady(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Queue a chunk of fMP4 bytes (init segment or media segment). */
  append(chunk: ArrayBuffer | Uint8Array): void {
    if (this.destroyed) return;
    const ab = chunk instanceof Uint8Array
      ? (chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer)
      : chunk;
    this.queue.push(ab);
    this.pump();
  }

  private pump(): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating) return;

    // Apply deferred actions once the SourceBuffer has any data. Deferred
    // seek and deferred autoplay are independent — both can fire here, or
    // either alone. Setting `currentTime` before data exists causes the
    // browser to snap back to the nearest buffered range; calling `play()`
    // before data exists puts the video into a stuck waiting state.
    if (sb.buffered.length > 0) {
      if (this.pendingSeekTime !== null) {
        this.options.video.currentTime = this.pendingSeekTime;
        this.pendingSeekTime = null;
      } else if (!this.hasSnappedToFirstBuffered) {
        // First data arrival with no pending seek. If currentTime is
        // outside the first buffered range (typical for MPEG-TS sources
        // whose PTS doesn't start at 0), snap into the buffered range
        // so the video element doesn't wait forever for nonexistent data.
        const v = this.options.video;
        const firstStart = sb.buffered.start(0);
        const firstEnd = sb.buffered.end(0);
        if (v.currentTime < firstStart || v.currentTime > firstEnd) {
          v.currentTime = firstStart;
        }
        this.hasSnappedToFirstBuffered = true;
      }
      if (this.playOnSeek) {
        this.playOnSeek = false;
        this.options.video.play().catch(() => { /* ignore — autoplay may be blocked */ });
      }
    }

    const next = this.queue.shift();
    if (!next) return;
    try {
      sb.appendBuffer(next);
    } catch (err) {
      // QuotaExceededError → evict the oldest few seconds and retry once.
      if ((err as DOMException).name === "QuotaExceededError") {
        this.evict();
        try {
          sb.appendBuffer(next);
          return;
        } catch {
          /* fall through to error */
        }
      }
      this.rejectReady(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private evict(): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.buffered.length === 0) return;
    const start = sb.buffered.start(0);
    const current = this.options.video.currentTime;
    // Drop everything that's at least 10s behind the current position.
    if (current - start > 10) {
      try {
        sb.remove(start, current - 10);
      } catch {
        /* ignore */
      }
    }
  }

  /** Indicate the source is finished. Future seeks past the end will fail. */
  endOfStream(): void {
    if (this.endOfStreamCalled || this.destroyed) return;
    this.endOfStreamCalled = true;
    const tryEnd = () => {
      if (this.queue.length > 0 || this.sourceBuffer?.updating) {
        // Wait for the queue to drain.
        this.sourceBuffer?.addEventListener("updateend", tryEnd, { once: true });
        return;
      }
      try {
        if (this.mediaSource.readyState === "open") {
          this.mediaSource.endOfStream();
        }
      } catch {
        /* ignore */
      }
    };
    tryEnd();
  }

  /** Seconds of media buffered ahead of the current playback position. */
  bufferedAhead(): number {
    const sb = this.sourceBuffer;
    if (!sb || sb.buffered.length === 0) return 0;
    const current = this.options.video.currentTime;
    for (let i = 0; i < sb.buffered.length; i++) {
      if (sb.buffered.start(i) <= current && sb.buffered.end(i) > current) {
        return sb.buffered.end(i) - current;
      }
    }
    return 0;
  }

  /** Total seconds of media buffered across all ranges. */
  totalBuffered(): number {
    const sb = this.sourceBuffer;
    if (!sb || sb.buffered.length === 0) return 0;
    let total = 0;
    for (let i = 0; i < sb.buffered.length; i++) {
      total += sb.buffered.end(i) - sb.buffered.start(i);
    }
    return total;
  }

  /** Number of chunks waiting in the append queue. */
  queueLength(): number {
    return this.queue.length;
  }

  /** Time to seek to once the SourceBuffer has data at this position. */
  private pendingSeekTime: number | null = null;
  /** Whether to resume playback after the deferred seek completes. */
  private playOnSeek = false;
  /**
   * On the very first data arrival, if `currentTime` falls outside the first
   * buffered range, snap it to the start of that range. MPEG-TS sources
   * commonly start their PTS at a non-zero value (e.g. ~1.5s); without this
   * snap, the video element sits at `currentTime=0` waiting forever for
   * data that doesn't exist.
   */
  private hasSnappedToFirstBuffered = false;

  /** Request that playback resumes automatically once the deferred seek fires. */
  setPlayOnSeek(play: boolean): void {
    this.playOnSeek = play;
  }

  /**
   * Discard all buffered media and schedule a deferred seek. The actual
   * `video.currentTime` assignment happens in `pump()` once the SourceBuffer
   * has data at the target position — setting it earlier causes the browser
   * to snap back to the nearest buffered range.
   */
  invalidate(seekTime: number): void {
    const sb = this.sourceBuffer;
    // Clear the pending queue — stale fragments from the old pump position.
    this.queue = [];
    this.pendingSeekTime = seekTime;
    this.hasSnappedToFirstBuffered = true; // explicit seek overrides the auto-snap
    if (!sb || sb.buffered.length === 0) return;
    try {
      const start = sb.buffered.start(0);
      const end = sb.buffered.end(sb.buffered.length - 1);
      sb.remove(start, end);
    } catch {
      /* ignore — sourcebuffer may be in updating state */
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.queue = [];
    try {
      if (this.mediaSource.readyState === "open") this.mediaSource.endOfStream();
    } catch {
      /* ignore */
    }
    URL.revokeObjectURL(this.objectUrl);
  }
}
