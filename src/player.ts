import { TypedEmitter } from "./events.js";
import { probe } from "./probe/index.js";
import { classify } from "./classify/index.js";
import { Diagnostics } from "./diagnostics.js";
import { PluginRegistry } from "./plugins/registry.js";
import { registerBuiltins } from "./plugins/builtin.js";
import { discoverSidecar, attachSubtitleTracks } from "./subtitles/index.js";
import type {
  Classification,
  CreatePlayerOptions,
  DiagnosticsSnapshot,
  MediaContext,
  PlaybackSession,
  PlayerEventMap,
  PlayerEventName,
  StrategyName,
  Listener,
} from "./types.js";

export class UnifiedPlayer {
  private emitter = new TypedEmitter<PlayerEventMap>();
  private session: PlaybackSession | null = null;
  private diag = new Diagnostics();
  private timeupdateInterval: ReturnType<typeof setInterval> | null = null;

  // Saved from bootstrap for strategy switching
  private mediaContext: MediaContext | null = null;
  private classification: Classification | null = null;

  // Stall detection
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private lastProgressTime = 0;
  private lastProgressPosition = -1;
  private errorListener: (() => void) | null = null;

  // Serializes escalation / setStrategy calls
  private switchingPromise: Promise<void> = Promise.resolve();

  /**
   * @internal Use {@link createPlayer} or {@link UnifiedPlayer.create} instead.
   */
  private constructor(
    private readonly options: CreatePlayerOptions,
    private readonly registry: PluginRegistry,
  ) {}

  static async create(options: CreatePlayerOptions): Promise<UnifiedPlayer> {
    const registry = new PluginRegistry();
    registerBuiltins(registry);
    if (options.plugins) {
      for (const p of options.plugins) registry.register(p, /* prepend */ true);
    }
    const player = new UnifiedPlayer(options, registry);
    try {
      await player.bootstrap();
    } catch (err) {
      (err as Error & { player?: UnifiedPlayer }).player = player;
      throw err;
    }
    return player;
  }

  private async bootstrap(): Promise<void> {
    try {
      const ctx = await probe(this.options.source);
      this.diag.recordProbe(ctx);
      this.mediaContext = ctx;

      // Merge sidecar / explicit subtitles
      if (this.options.subtitles) {
        for (const s of this.options.subtitles) {
          ctx.subtitleTracks.push({
            id: ctx.subtitleTracks.length,
            format: s.format ?? (s.url.endsWith(".srt") ? "srt" : "vtt"),
            language: s.language,
            sidecarUrl: s.url,
          });
        }
      }
      if (this.options.directory && this.options.source instanceof File) {
        const found = await discoverSidecar(this.options.source, this.options.directory);
        for (const s of found) {
          ctx.subtitleTracks.push({
            id: ctx.subtitleTracks.length,
            format: s.format,
            language: s.language,
            sidecarUrl: s.url,
          });
        }
      }

      const decision = this.options.forceStrategy
        ? {
            class: "NATIVE" as const,
            strategy: this.options.forceStrategy,
            reason: `forced via options.forceStrategy=${this.options.forceStrategy}`,
          }
        : classify(ctx);
      this.classification = decision;
      this.diag.recordClassification(decision);

      this.emitter.emitSticky("strategy", {
        strategy: decision.strategy,
        reason: decision.reason,
      });

      // Try the primary strategy, falling through the chain on failure
      await this.startSession(decision.strategy, decision.reason);

      // Apply subtitles for non-canvas strategies
      if (this.session!.strategy !== "fallback" && this.session!.strategy !== "hybrid") {
        attachSubtitleTracks(this.options.target, ctx.subtitleTracks);
      }

      this.emitter.emitSticky("tracks", {
        video: ctx.videoTracks,
        audio: ctx.audioTracks,
        subtitle: ctx.subtitleTracks,
      });

      this.startTimeupdateLoop();
      this.options.target.addEventListener("ended", () => this.emitter.emit("ended", undefined));
      this.emitter.emitSticky("ready", undefined);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.diag.recordError(e);
      this.emitter.emit("error", e);
      throw e;
    }
  }

  /**
   * Try to start a session with the given strategy. On failure, walk the
   * fallback chain. Throws only if all strategies are exhausted.
   */
  private async startSession(strategy: StrategyName, reason: string): Promise<void> {
    const plugin = this.registry.findFor(this.mediaContext!, strategy);
    if (!plugin) {
      throw new Error(`no plugin available for strategy "${strategy}"`);
    }

    try {
      this.session = await plugin.execute(this.mediaContext!, this.options.target);
    } catch (err) {
      // Try the fallback chain
      const chain = this.classification?.fallbackChain;
      if (chain && chain.length > 0) {
        const next = chain.shift()!;
        console.warn(`[avbridge] ${strategy} failed (${(err as Error).message}), escalating to ${next}`);
        this.emitter.emit("strategychange", {
          from: strategy,
          to: next,
          reason: `${strategy} failed: ${(err as Error).message}`,
          currentTime: 0,
        });
        this.diag.recordStrategySwitch(next, `${strategy} failed: ${(err as Error).message}`);
        return this.startSession(next, `escalated from ${strategy}`);
      }
      throw err;
    }

    // Wire up fatal error handler for hybrid/fallback escalation
    this.session.onFatalError?.((fatalReason) => {
      void this.escalate(fatalReason);
    });

    // Attach stall supervisor
    this.attachSupervisor();

    // Update sticky strategy event if we ended up on a different strategy
    if (this.session.strategy !== strategy) {
      this.emitter.emitSticky("strategy", {
        strategy: this.session.strategy,
        reason,
      });
    }
  }

  // ── Escalation ──────────────────────────────────────────────────────────

  private async escalate(reason: string): Promise<void> {
    // Serialize with other switch operations
    this.switchingPromise = this.switchingPromise.then(() =>
      this.doEscalate(reason),
    ).catch((err) => {
      this.emitter.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
    await this.switchingPromise;
  }

  private async doEscalate(reason: string): Promise<void> {
    const chain = this.classification?.fallbackChain;
    if (!chain || chain.length === 0) {
      this.emitter.emit("error", new Error(
        `strategy "${this.session?.strategy}" failed: ${reason} (no fallback available)`,
      ));
      return;
    }

    const currentTime = this.session?.getCurrentTime() ?? 0;
    const wasPlaying = this.session ? !this.options.target.paused : false;
    const fromStrategy = this.session?.strategy ?? "native";
    const nextStrategy = chain.shift()!;

    console.warn(`[avbridge] escalating from ${fromStrategy} to ${nextStrategy}: ${reason}`);

    this.emitter.emit("strategychange", {
      from: fromStrategy,
      to: nextStrategy,
      reason,
      currentTime,
    });
    this.diag.recordStrategySwitch(nextStrategy, reason);

    // Tear down current session
    this.clearSupervisor();
    if (this.session) {
      try { await this.session.destroy(); } catch { /* ignore */ }
      this.session = null;
    }

    // Create new session
    const plugin = this.registry.findFor(this.mediaContext!, nextStrategy);
    if (!plugin) {
      this.emitter.emit("error", new Error(`no plugin for fallback strategy "${nextStrategy}"`));
      return;
    }

    try {
      this.session = await plugin.execute(this.mediaContext!, this.options.target);
    } catch (err) {
      this.emitter.emit("error", err instanceof Error ? err : new Error(String(err)));
      return;
    }

    this.emitter.emitSticky("strategy", {
      strategy: nextStrategy,
      reason: `escalated: ${reason}`,
    });

    // Wire up fatal error handler + supervisor for the new session
    this.session.onFatalError?.((fatalReason) => {
      void this.escalate(fatalReason);
    });
    this.attachSupervisor();

    // Restore position and play state
    try {
      await this.session.seek(currentTime);
      if (wasPlaying) await this.session.play();
    } catch (err) {
      console.warn("[avbridge] failed to restore position after escalation:", err);
    }
  }

  // ── Stall supervision ─────────────────────────────────────────────────

  private attachSupervisor(): void {
    this.clearSupervisor();
    if (this.options.autoEscalate === false) return;
    if (!this.classification?.fallbackChain?.length) return;

    const strategy = this.session?.strategy;
    if (strategy === "native" || strategy === "remux") {
      // Monitor currentTime progress
      this.lastProgressPosition = this.options.target.currentTime;
      this.lastProgressTime = performance.now();

      this.stallTimer = setInterval(() => {
        const t = this.options.target;
        if (t.paused || t.ended || t.readyState < 2) {
          this.lastProgressPosition = t.currentTime;
          this.lastProgressTime = performance.now();
          return;
        }
        if (t.currentTime !== this.lastProgressPosition) {
          this.lastProgressPosition = t.currentTime;
          this.lastProgressTime = performance.now();
          return;
        }
        if (performance.now() - this.lastProgressTime > 5000) {
          void this.escalate(
            `${strategy} strategy stalled for 5s at ${t.currentTime.toFixed(1)}s`,
          );
        }
      }, 1000);

      // Listen for media element errors
      const onError = () => {
        void this.escalate(
          `${strategy} strategy error: ${this.options.target.error?.message ?? "unknown"}`,
        );
      };
      this.options.target.addEventListener("error", onError, { once: true });
      this.errorListener = onError;
    }
    // Hybrid/fallback escalation is handled via onFatalError callback
  }

  private clearSupervisor(): void {
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
    if (this.errorListener) {
      this.options.target.removeEventListener("error", this.errorListener);
      this.errorListener = null;
    }
  }

  // ── Public: manual strategy switch ────────────────────────────────────

  /** Manually switch to a different playback strategy. Preserves current position and play/pause state. Concurrent calls are serialized. */
  async setStrategy(strategy: StrategyName, reason?: string): Promise<void> {
    if (!this.mediaContext) throw new Error("player not ready");
    if (this.session?.strategy === strategy) return;

    this.switchingPromise = this.switchingPromise.then(() =>
      this.doSetStrategy(strategy, reason),
    );
    await this.switchingPromise;
  }

  private async doSetStrategy(strategy: StrategyName, reason?: string): Promise<void> {
    const currentTime = this.session?.getCurrentTime() ?? 0;
    const wasPlaying = this.session ? !this.options.target.paused : false;
    const fromStrategy = this.session?.strategy ?? "native";
    const switchReason = reason ?? `manual switch to ${strategy}`;

    this.emitter.emit("strategychange", {
      from: fromStrategy,
      to: strategy,
      reason: switchReason,
      currentTime,
    });
    this.diag.recordStrategySwitch(strategy, switchReason);

    this.clearSupervisor();
    if (this.session) {
      try { await this.session.destroy(); } catch { /* ignore */ }
      this.session = null;
    }

    const plugin = this.registry.findFor(this.mediaContext!, strategy);
    if (!plugin) throw new Error(`no plugin available for strategy "${strategy}"`);

    this.session = await plugin.execute(this.mediaContext!, this.options.target);

    this.emitter.emitSticky("strategy", {
      strategy,
      reason: switchReason,
    });

    this.session.onFatalError?.((fatalReason) => {
      void this.escalate(fatalReason);
    });
    this.attachSupervisor();

    try {
      await this.session.seek(currentTime);
      if (wasPlaying) await this.session.play();
    } catch (err) {
      console.warn("[avbridge] failed to restore position after strategy switch:", err);
    }
  }

  // ── Timeupdate loop ───────────────────────────────────────────────────

  private startTimeupdateLoop(): void {
    this.timeupdateInterval = setInterval(() => {
      const t = this.session?.getCurrentTime() ?? this.options.target.currentTime;
      this.emitter.emit("timeupdate", { currentTime: t });
    }, 250);
  }

  // ── Public API ────────────────────────────────────────────────────────

  /** Subscribe to a player event. Returns an unsubscribe function. Sticky events (strategy, ready, tracks) replay for late subscribers. */
  on<K extends PlayerEventName>(event: K, fn: Listener<PlayerEventMap[K]>): () => void {
    return this.emitter.on(event, fn);
  }

  /** Remove a previously registered event listener. */
  off<K extends PlayerEventName>(event: K, fn: Listener<PlayerEventMap[K]>): void {
    this.emitter.off(event, fn);
  }

  /** Begin or resume playback. Throws if the player is not ready. */
  async play(): Promise<void> {
    if (!this.session) throw new Error("player not ready");
    await this.session.play();
  }

  /** Pause playback. No-op if the player is not ready or already paused. */
  pause(): void {
    this.session?.pause();
  }

  /** Seek to the given time in seconds. Throws if the player is not ready. */
  async seek(time: number): Promise<void> {
    if (!this.session) throw new Error("player not ready");
    await this.session.seek(time);
  }

  /** Switch the active audio track by track ID. Throws if the player is not ready. */
  async setAudioTrack(id: number): Promise<void> {
    if (!this.session) throw new Error("player not ready");
    await this.session.setAudioTrack(id);
  }

  /** Switch the active subtitle track by track ID, or pass `null` to disable subtitles. */
  async setSubtitleTrack(id: number | null): Promise<void> {
    if (!this.session) throw new Error("player not ready");
    await this.session.setSubtitleTrack(id);
  }

  /** Return a snapshot of current diagnostics: container, codecs, strategy, runtime stats, and strategy history. */
  getDiagnostics(): DiagnosticsSnapshot {
    if (this.session) {
      this.diag.recordRuntime(this.session.getRuntimeStats());
    }
    return this.diag.snapshot();
  }

  /** Return the total duration in seconds, or `NaN` if unknown. */
  getDuration(): number {
    const fromDiag = this.diag.snapshot().duration;
    if (typeof fromDiag === "number" && Number.isFinite(fromDiag)) return fromDiag;
    const fromVideo = this.options.target.duration;
    return Number.isFinite(fromVideo) ? fromVideo : NaN;
  }

  /** Return the current playback position in seconds. */
  getCurrentTime(): number {
    return this.session?.getCurrentTime() ?? this.options.target.currentTime ?? 0;
  }

  /** Tear down the player: stop timers, destroy the active session, remove all event listeners. The player is unusable after this call. */
  async destroy(): Promise<void> {
    if (this.timeupdateInterval) {
      clearInterval(this.timeupdateInterval);
      this.timeupdateInterval = null;
    }
    this.clearSupervisor();
    if (this.session) {
      await this.session.destroy();
      this.session = null;
    }
    this.emitter.removeAll();
  }
}

export async function createPlayer(options: CreatePlayerOptions): Promise<UnifiedPlayer> {
  return UnifiedPlayer.create(options);
}
