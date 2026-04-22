import { TypedEmitter } from "./events.js";
import { probe } from "./probe/index.js";
import { classify } from "./classify/index.js";
import { Diagnostics } from "./diagnostics.js";
import { PluginRegistry } from "./plugins/registry.js";
import { registerBuiltins } from "./plugins/builtin.js";
import { discoverSidecars, attachSubtitleTracks, SubtitleResourceBag } from "./subtitles/index.js";
import { dbg } from "./util/debug.js";
import type {
  Classification,
  CreatePlayerOptions,
  DiagnosticsSnapshot,
  MediaContext,
  PlaybackSession,
  PlayerEventMap,
  PlayerEventName,
  StrategyName,
  TransportConfig,
  Listener,
} from "./types.js";
import { AvbridgeError, ERR_PLAYER_NOT_READY, ERR_ALL_STRATEGIES_EXHAUSTED } from "./errors.js";

/**
 * Decoded-video-frame counter reader. Prefers the standard
 * `getVideoPlaybackQuality().totalVideoFrames` (all evergreen browsers);
 * falls back to the WebKit-prefixed `webkitDecodedFrameCount` for older
 * Safari. Returns 0 for non-video elements or when nothing exposes the
 * count — the caller treats 0 as "no signal" (constant across samples,
 * which is fine).
 */
export function readDecodedFrameCount(target: HTMLMediaElement): number {
  if (typeof HTMLVideoElement === "undefined" || !(target instanceof HTMLVideoElement)) return 0;
  const vq = (target as HTMLVideoElement & { getVideoPlaybackQuality?: () => { totalVideoFrames: number } }).getVideoPlaybackQuality;
  if (typeof vq === "function") {
    try { return vq.call(target).totalVideoFrames; } catch { /* fall through */ }
  }
  const legacy = (target as HTMLVideoElement & { webkitDecodedFrameCount?: number }).webkitDecodedFrameCount;
  return typeof legacy === "number" ? legacy : 0;
}

/**
 * Pure decision function for the stall supervisor. Takes a snapshot of
 * the observable state and returns whether to escalate. Extracted so it
 * can be unit-tested without spinning up a real player / media element.
 *
 * - `time-stall`: `currentTime` hasn't moved for `timeStallThresholdMs`
 *   despite the element being in a state where it should be playing.
 * - `silent-video`: the media has a video track, `currentTime` is
 *   advancing (audio is playing), but the decoder has produced no new
 *   frames for `frameStallThresholdMs`. Catches Firefox-style "MSE
 *   reports codec supported but the decoder can't actually decode it".
 */
export function evaluateDecodeHealth(input: {
  hasVideoTrack: boolean;
  timeAdvanced: boolean;
  framesAdvanced: boolean;
  now: number;
  lastProgressTime: number;
  lastFrameProgressTime: number;
  timeStallThresholdMs?: number;
  frameStallThresholdMs?: number;
}): { escalate: false } | { escalate: true; kind: "time-stall" | "silent-video" } {
  const timeThreshold = input.timeStallThresholdMs ?? 5000;
  const frameThreshold = input.frameStallThresholdMs ?? 3000;
  if (!input.timeAdvanced && input.now - input.lastProgressTime > timeThreshold) {
    return { escalate: true, kind: "time-stall" };
  }
  if (
    input.hasVideoTrack &&
    input.timeAdvanced &&
    !input.framesAdvanced &&
    input.now - input.lastFrameProgressTime > frameThreshold
  ) {
    return { escalate: true, kind: "silent-video" };
  }
  return { escalate: false };
}

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
  /** Last observed `HTMLVideoElement.getVideoPlaybackQuality().totalVideoFrames`
   *  (or `webkitDecodedFrameCount` fallback). Used by the silent-video
   *  watchdog — catches cases where `currentTime` advances (audio plays)
   *  but the decoder produces no frames, e.g. Firefox claiming `hev1.*`
   *  via MSE when the decoder actually can't decode HEVC. */
  private lastVideoFrameCount = 0;
  private lastVideoFrameProgressTime = 0;
  private errorListener: (() => void) | null = null;

  // Bound so we can removeEventListener in destroy(); without this the
  // listener outlives the player and accumulates on elements that swap
  // source (e.g. <avbridge-video>).
  private endedListener: (() => void) | null = null;

  // Background tab handling. userIntent is what the user last asked for
  // (play vs pause) — used to decide whether to auto-resume on visibility
  // return. autoPausedForVisibility tracks whether we paused because the
  // tab was hidden, so we don't resume playback the user deliberately
  // paused (e.g. via media keys while hidden).
  private userIntent: "play" | "pause" = "pause";
  private autoPausedForVisibility = false;
  private visibilityListener: (() => void) | null = null;

  // Serializes escalation / setStrategy calls
  private switchingPromise: Promise<void> = Promise.resolve();

  // Owns blob URLs created during sidecar discovery + SRT->VTT conversion.
  // Revoked at destroy() so repeated source swaps don't leak.
  private subtitleResources = new SubtitleResourceBag();

  // Transport config extracted from CreatePlayerOptions. Threaded to probe,
  // subtitle fetches, and strategy session creators. Not stored on MediaContext
  // because it's runtime config, not media analysis.
  private readonly transport: TransportConfig | undefined;

  /**
   * @internal Use {@link createPlayer} or {@link UnifiedPlayer.create} instead.
   */
  private constructor(
    private readonly options: CreatePlayerOptions,
    private readonly registry: PluginRegistry,
  ) {
    const { requestInit, fetchFn, cacheBytes } = options;
    if (requestInit || fetchFn || cacheBytes !== undefined) {
      this.transport = { requestInit, fetchFn, cacheBytes };
    }
  }

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
    const bootstrapStart = performance.now();
    try {
      dbg.info("bootstrap", "start");
      const ctx = await dbg.timed("probe", "probe", 3000, () => probe(this.options.source, this.transport));
      dbg.info("probe",
        `container=${ctx.container} video=${ctx.videoTracks[0]?.codec ?? "-"} ` +
        `audio=${ctx.audioTracks[0]?.codec ?? "-"} probedBy=${ctx.probedBy}`,
      );
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
        const found = await discoverSidecars(this.options.source, this.options.directory);
        for (const s of found) {
          // Track every blob URL we adopted from discovery so it gets
          // revoked at destroy() — otherwise repeated source changes leak.
          this.subtitleResources.track(s.url);
          ctx.subtitleTracks.push({
            id: ctx.subtitleTracks.length,
            format: s.format,
            language: s.language,
            sidecarUrl: s.url,
          });
        }
      }

      const decision = this.options.initialStrategy
        ? buildInitialDecision(this.options.initialStrategy, ctx)
        : classify(ctx);
      dbg.info("classify",
        `strategy=${decision.strategy} class=${decision.class} reason="${decision.reason}"` +
        (decision.fallbackChain ? ` fallback=${decision.fallbackChain.join("→")}` : ""),
      );
      this.classification = decision;
      this.diag.recordClassification(decision);

      this.emitter.emitSticky("strategy", {
        strategy: decision.strategy,
        reason: decision.reason,
      });

      // Try the primary strategy, falling through the chain on failure
      await this.startSession(decision.strategy, decision.reason);

      // Apply subtitles for all strategies. Native/remux render them via
      // the inner <video>'s native text-track engine. Hybrid/fallback
      // hide the <video> and render cues into the canvas overlay — see
      // each session's SubtitleOverlay wiring. The <track> elements are
      // attached in both cases so cues are parsed by the browser.
      await attachSubtitleTracks(
        this.options.target,
        ctx.subtitleTracks,
        this.subtitleResources,
        (err, track) => {
          // eslint-disable-next-line no-console
          console.warn(`[avbridge] subtitle ${track.id} failed: ${err.message}`);
        },
        this.transport,
      );

      this.emitter.emitSticky("tracks", {
        video: ctx.videoTracks,
        audio: ctx.audioTracks,
        subtitle: ctx.subtitleTracks,
      });

      this.startTimeupdateLoop();
      this.endedListener = () => this.emitter.emit("ended", undefined);
      this.options.target.addEventListener("ended", this.endedListener);

      // Auto-pause on background tab (unless explicitly opted out).
      // Chrome throttles rAF and setTimeout in hidden tabs, so playback
      // degrades anyway — better to pause cleanly and resume on return.
      if (this.options.backgroundBehavior !== "continue" && typeof document !== "undefined") {
        this.visibilityListener = () => this.onVisibilityChange();
        document.addEventListener("visibilitychange", this.visibilityListener);
      }

      this.emitter.emitSticky("ready", undefined);
      const bootstrapElapsed = performance.now() - bootstrapStart;
      dbg.info("bootstrap", `ready in ${bootstrapElapsed.toFixed(0)}ms`);
      if (bootstrapElapsed > 5000) {
        // eslint-disable-next-line no-console
        console.warn(
          "[avbridge:bootstrap]",
          `total bootstrap time ${bootstrapElapsed.toFixed(0)}ms — unusually slow. ` +
          `Enable globalThis.AVBRIDGE_DEBUG for a per-phase breakdown.`,
        );
      }
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
      this.session = await plugin.execute(this.mediaContext!, this.options.target, this.transport);
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

    // Tear down the current session before walking the chain — once we
    // commit to escalating, the existing session is going away regardless
    // of which fallback step succeeds.
    this.clearSupervisor();
    if (this.session) {
      try { await this.session.destroy(); } catch { /* ignore */ }
      this.session = null;
    }

    // Walk every remaining entry in the chain. Previously this method
    // popped exactly one entry and gave up if its plugin failed to start —
    // a recoverable failure in one fallback step blocked later viable
    // strategies (inconsistent with startSession() which already loops).
    const errors: string[] = [];
    while (chain.length > 0) {
      const nextStrategy = chain.shift()!;
      console.warn(`[avbridge] escalating from ${fromStrategy} to ${nextStrategy}: ${reason}`);

      this.emitter.emit("strategychange", {
        from: fromStrategy,
        to: nextStrategy,
        reason,
        currentTime,
      });
      this.diag.recordStrategySwitch(nextStrategy, reason);

      const plugin = this.registry.findFor(this.mediaContext!, nextStrategy);
      if (!plugin) {
        errors.push(`${nextStrategy}: no plugin available`);
        continue;
      }

      try {
        this.session = await plugin.execute(this.mediaContext!, this.options.target, this.transport);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${nextStrategy}: ${msg}`);
        console.warn(`[avbridge] ${nextStrategy} failed during escalation, trying next: ${msg}`);
        continue;
      }

      // Success — finish wiring and restore playback.
      this.emitter.emitSticky("strategy", {
        strategy: nextStrategy,
        reason: `escalated: ${reason}`,
      });
      this.session.onFatalError?.((fatalReason) => {
        void this.escalate(fatalReason);
      });
      this.attachSupervisor();
      try {
        await this.session.seek(currentTime);
        if (wasPlaying) await this.session.play();
      } catch (err) {
        console.warn("[avbridge] failed to restore position after escalation:", err);
      }
      return;
    }

    // Chain exhausted with no working strategy.
    this.emitter.emit("error", new AvbridgeError(
      ERR_ALL_STRATEGIES_EXHAUSTED,
      `All playback strategies failed: ${errors.join("; ")}`,
      "This file may require a codec or container that isn't available in this browser. Try the fallback strategy or check browser codec support.",
    ));
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
      this.lastVideoFrameCount = readDecodedFrameCount(this.options.target);
      this.lastVideoFrameProgressTime = performance.now();

      const hasVideoTrack = (this.mediaContext?.videoTracks.length ?? 0) > 0;

      this.stallTimer = setInterval(() => {
        const t = this.options.target;
        const now = performance.now();
        if (t.paused || t.ended || t.readyState < 2) {
          this.lastProgressPosition = t.currentTime;
          this.lastProgressTime = now;
          this.lastVideoFrameCount = readDecodedFrameCount(t);
          this.lastVideoFrameProgressTime = now;
          return;
        }
        const timeAdvanced = t.currentTime !== this.lastProgressPosition;
        const frames = readDecodedFrameCount(t);
        const framesAdvanced = frames > this.lastVideoFrameCount;

        const health = evaluateDecodeHealth({
          hasVideoTrack,
          timeAdvanced,
          framesAdvanced,
          now,
          lastProgressTime: this.lastProgressTime,
          lastFrameProgressTime: this.lastVideoFrameProgressTime,
        });

        if (timeAdvanced) {
          this.lastProgressPosition = t.currentTime;
          this.lastProgressTime = now;
        }
        if (framesAdvanced) {
          this.lastVideoFrameCount = frames;
          this.lastVideoFrameProgressTime = now;
        }

        if (health.escalate) {
          const reason = health.kind === "time-stall"
            ? `${strategy} strategy stalled for 5s at ${t.currentTime.toFixed(1)}s`
            : `${strategy} strategy: audio is advancing but the video decoder has produced no new frames for 3s — likely a silent codec failure`;
          void this.escalate(reason);
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
    if (!this.mediaContext) throw new AvbridgeError(ERR_PLAYER_NOT_READY, "Player not ready — wait for the 'ready' event before calling playback methods.", "Await the 'ready' event or check player.readyState before calling play/pause/seek.");
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

    this.session = await plugin.execute(this.mediaContext!, this.options.target, this.transport);

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
    if (!this.session) throw new AvbridgeError(ERR_PLAYER_NOT_READY, "Player not ready — wait for the 'ready' event before calling playback methods.", "Await the 'ready' event or check player.readyState before calling play/pause/seek.");
    this.userIntent = "play";
    this.autoPausedForVisibility = false;
    await this.session.play();
  }

  /** Pause playback. No-op if the player is not ready or already paused. */
  pause(): void {
    this.userIntent = "pause";
    this.autoPausedForVisibility = false;
    this.session?.pause();
  }

  /**
   * Handle browser tab visibility changes. On hide: pause if the user
   * had been playing. On show: resume if we were the one who paused.
   * Skips when `backgroundBehavior: "continue"` is set (listener isn't
   * installed in that case).
   */
  private onVisibilityChange(): void {
    if (!this.session) return;
    const action = decideVisibilityAction({
      hidden: document.hidden,
      userIntent: this.userIntent,
      sessionIsPlaying: !this.options.target.paused,
      autoPausedForVisibility: this.autoPausedForVisibility,
    });
    if (action === "pause") {
      this.autoPausedForVisibility = true;
      dbg.info("visibility", "tab hidden — auto-paused");
      this.session.pause();
    } else if (action === "resume") {
      this.autoPausedForVisibility = false;
      dbg.info("visibility", "tab visible — auto-resuming");
      void this.session.play().catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[avbridge] auto-resume after tab return failed:", err);
      });
    }
  }

  /** Seek to the given time in seconds. Throws if the player is not ready. */
  async seek(time: number): Promise<void> {
    if (!this.session) throw new AvbridgeError(ERR_PLAYER_NOT_READY, "Player not ready — wait for the 'ready' event before calling playback methods.", "Await the 'ready' event or check player.readyState before calling play/pause/seek.");
    await this.session.seek(time);
  }

  /** Switch the active audio track by track ID. Throws if the player is not ready. */
  async setAudioTrack(id: number): Promise<void> {
    if (!this.session) throw new AvbridgeError(ERR_PLAYER_NOT_READY, "Player not ready — wait for the 'ready' event before calling playback methods.", "Await the 'ready' event or check player.readyState before calling play/pause/seek.");
    await this.session.setAudioTrack(id);
  }

  /** Switch the active subtitle track by track ID, or pass `null` to disable subtitles. */
  async setSubtitleTrack(id: number | null): Promise<void> {
    if (!this.session) throw new AvbridgeError(ERR_PLAYER_NOT_READY, "Player not ready — wait for the 'ready' event before calling playback methods.", "Await the 'ready' event or check player.readyState before calling play/pause/seek.");
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
    if (this.endedListener) {
      this.options.target.removeEventListener("ended", this.endedListener);
      this.endedListener = null;
    }
    if (this.visibilityListener) {
      document.removeEventListener("visibilitychange", this.visibilityListener);
      this.visibilityListener = null;
    }
    if (this.session) {
      await this.session.destroy();
      this.session = null;
    }
    // Revoke every blob URL we created for sidecar discovery / SRT->VTT
    // conversion. This is the cleanup leg of the leak fix.
    this.subtitleResources.revokeAll();
    this.emitter.removeAll();
  }
}

export async function createPlayer(options: CreatePlayerOptions): Promise<UnifiedPlayer> {
  return UnifiedPlayer.create(options);
}

/**
 * Pure decision function for visibility-change handling. Separated from
 * the class method so it can be unit-tested without a full player
 * instance.
 *
 * @internal — exported for unit tests; not part of the public API.
 */
export function decideVisibilityAction(state: {
  hidden: boolean;
  userIntent: "play" | "pause";
  sessionIsPlaying: boolean;
  autoPausedForVisibility: boolean;
}): "pause" | "resume" | "noop" {
  if (state.hidden) {
    // Tab hidden: pause if user had been playing and session is active
    if (state.userIntent === "play" && state.sessionIsPlaying) return "pause";
    return "noop";
  }
  // Tab visible: resume only if we're the one who paused
  if (state.autoPausedForVisibility) return "resume";
  return "noop";
}

/**
 * Build a synthetic classification for an explicit `initialStrategy` override.
 * The `class` is derived from the chosen strategy so diagnostics and any
 * downstream consumer of `strategyClass` see the real strategy. The fallback
 * chain is inherited from the natural classification but must never contain
 * `initial` itself — otherwise `startSession` would retry the strategy that
 * just failed before escalating.
 *
 * @internal — exported for unit tests; not part of the public API.
 */
export function buildInitialDecision(
  initial: StrategyName,
  ctx: MediaContext,
): Classification {
  const natural = classify(ctx);
  const cls = strategyToClass(initial, natural);
  const inherited = natural.fallbackChain ?? defaultFallbackChain(initial);
  const fallbackChain = inherited.filter((s) => s !== initial);
  return {
    class: cls,
    strategy: initial,
    reason: `initial strategy "${initial}" requested via options.initialStrategy`,
    fallbackChain,
  };
}

function strategyToClass(
  strategy: StrategyName,
  natural: Classification,
): Classification["class"] {
  // If the natural classification picked the same strategy, use its class.
  if (natural.strategy === strategy) return natural.class;
  switch (strategy) {
    case "native":   return "NATIVE";
    case "remux":    return "REMUX_CANDIDATE";
    case "hybrid":   return "HYBRID_CANDIDATE";
    case "fallback": return "FALLBACK_REQUIRED";
  }
}

function defaultFallbackChain(strategy: StrategyName): StrategyName[] {
  switch (strategy) {
    case "native":   return ["remux", "hybrid", "fallback"];
    case "remux":    return ["hybrid", "fallback"];
    case "hybrid":   return ["fallback"];
    case "fallback": return [];
  }
}
