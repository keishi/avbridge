import type {
  Classification,
  DiagnosticsSnapshot,
  MediaContext,
} from "./types.js";

/**
 * Accumulates diagnostic info as the player walks probe → classify → play.
 * `snapshot()` produces an immutable view shaped exactly like the example in
 * design doc §12.
 */
export class Diagnostics {
  private container: DiagnosticsSnapshot["container"] = "unknown";
  private videoCodec?: DiagnosticsSnapshot["videoCodec"];
  private audioCodec?: DiagnosticsSnapshot["audioCodec"];
  private width?: number;
  private height?: number;
  private fps?: number;
  private duration?: number;
  private strategy: DiagnosticsSnapshot["strategy"] = "pending";
  private strategyClass: DiagnosticsSnapshot["strategyClass"] = "pending";
  private reason = "";
  private probedBy?: DiagnosticsSnapshot["probedBy"];
  private runtime: Record<string, unknown> = {};
  private lastError?: Error;

  recordProbe(ctx: MediaContext): void {
    this.container = ctx.container;
    this.probedBy = ctx.probedBy;
    this.duration = ctx.duration;
    const v = ctx.videoTracks[0];
    if (v) {
      this.videoCodec = v.codec;
      this.width = v.width;
      this.height = v.height;
      this.fps = v.fps;
    }
    const a = ctx.audioTracks[0];
    if (a) this.audioCodec = a.codec;
  }

  recordClassification(c: Classification): void {
    this.strategy = c.strategy;
    this.strategyClass = c.class;
    this.reason = c.reason;
  }

  recordRuntime(stats: Record<string, unknown>): void {
    this.runtime = { ...this.runtime, ...stats };
  }

  recordError(err: Error): void {
    this.lastError = err;
  }

  snapshot(): DiagnosticsSnapshot {
    const snap: DiagnosticsSnapshot = {
      container: this.container,
      videoCodec: this.videoCodec,
      audioCodec: this.audioCodec,
      width: this.width,
      height: this.height,
      fps: this.fps,
      duration: this.duration,
      strategy: this.strategy,
      strategyClass: this.strategyClass,
      reason: this.reason,
      probedBy: this.probedBy,
      runtime: { ...this.runtime, ...(this.lastError ? { error: this.lastError.message } : {}) },
    };
    return Object.freeze(snap);
  }
}
