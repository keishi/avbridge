/**
 * MediaSource Extensions plumbing. Wraps a `MediaSource` + single
 * `SourceBuffer` with an append queue that respects `updateend` backpressure.
 */

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
      throw new Error("MSE not supported in this environment");
    }
    if (!MediaSource.isTypeSupported(options.mime)) {
      throw new Error(`MSE does not support MIME "${options.mime}" — cannot remux`);
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

  /** Discard buffered media around a seek target so re-pumping can resume. */
  invalidate(seekTime: number): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.buffered.length === 0) return;
    try {
      const end = sb.buffered.end(sb.buffered.length - 1);
      if (end > seekTime + 0.1) {
        sb.remove(seekTime, end);
      }
    } catch {
      /* ignore — sourcebuffer in updating state */
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
