import type {
  Classification,
  DiagnosticsSnapshot,
  MediaContext,
  StrategyName,
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
  private sourceType?: DiagnosticsSnapshot["sourceType"];
  private transport?: DiagnosticsSnapshot["transport"];
  private rangeSupported?: DiagnosticsSnapshot["rangeSupported"];
  private runtime: Record<string, unknown> = {};
  private lastError?: Error;
  private strategyHistory: Array<{ strategy: StrategyName; reason: string; at: number }> = [];

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
    // Source-type detection. For blob inputs we know the transport with
    // certainty. For URL inputs we know the *intended* transport but not
    // whether the server actually honors Range — that's confirmed later by
    // the strategy that fetches the bytes (via {@link recordTransport}).
    const src = ctx.source;
    if (typeof src === "string" || src instanceof URL) {
      this.sourceType = "url";
      this.transport = "http-range";
      // Intentionally NOT setting rangeSupported here. Inferring "true" from
      // input type was misleading: native/remux URL paths rely on the
      // browser's or mediabunny's own Range handling and don't fail-fast on
      // a non-supporting server. Strategies that prove Range support call
      // recordTransport() once they have a confirmed answer.
      this.rangeSupported = undefined;
    } else {
      this.sourceType = "blob";
      this.transport = "memory";
      this.rangeSupported = false;
    }
  }

  /**
   * Called by a strategy once it has a confirmed answer about how the
   * source bytes are actually flowing (e.g. after the libav HTTP block
   * reader's initial Range probe succeeded). Lets diagnostics report the
   * truth instead of an input-type heuristic.
   */
  recordTransport(
    transport: NonNullable<DiagnosticsSnapshot["transport"]>,
    rangeSupported: boolean,
  ): void {
    this.transport = transport;
    this.rangeSupported = rangeSupported;
  }

  recordClassification(c: Classification): void {
    this.strategy = c.strategy;
    this.strategyClass = c.class;
    this.reason = c.reason;
  }

  recordRuntime(stats: Record<string, unknown>): void {
    // Strategies can surface confirmed transport info in their runtime
    // stats under the well-known `_transport` / `_rangeSupported` keys.
    // When present, they're hoisted to the typed fields via
    // recordTransport() and stripped from the generic runtime bag so they
    // don't duplicate.
    const {
      _transport,
      _rangeSupported,
      ...rest
    } = stats as Record<string, unknown> & {
      _transport?: NonNullable<DiagnosticsSnapshot["transport"]>;
      _rangeSupported?: boolean;
    };
    if (_transport != null && typeof _rangeSupported === "boolean") {
      this.recordTransport(_transport, _rangeSupported);
    }
    this.runtime = { ...this.runtime, ...rest };
  }

  recordStrategySwitch(strategy: StrategyName, reason: string): void {
    this.strategy = strategy;
    this.reason = reason;
    this.strategyHistory.push({ strategy, reason, at: Date.now() });
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
      sourceType: this.sourceType,
      transport: this.transport,
      rangeSupported: this.rangeSupported,
      runtime: { ...this.runtime, ...(this.lastError ? { error: this.lastError.message } : {}) },
      strategyHistory: this.strategyHistory.length > 0 ? [...this.strategyHistory] : undefined,
    };
    return Object.freeze(snap);
  }
}
