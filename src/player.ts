import { TypedEmitter } from "./events.js";
import { probe } from "./probe/index.js";
import { classify } from "./classify/index.js";
import { Diagnostics } from "./diagnostics.js";
import { PluginRegistry } from "./plugins/registry.js";
import { registerBuiltins } from "./plugins/builtin.js";
import { discoverSidecar, attachSubtitleTracks } from "./subtitles/index.js";
import type {
  CreatePlayerOptions,
  DiagnosticsSnapshot,
  PlaybackSession,
  PlayerEventMap,
  PlayerEventName,
  Listener,
} from "./types.js";

export class UnifiedPlayer {
  private emitter = new TypedEmitter<PlayerEventMap>();
  private session: PlaybackSession | null = null;
  private diag = new Diagnostics();
  private timeupdateInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
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
      // Re-throw with the partial player attached so callers can read
      // diagnostics even after a strategy failure.
      (err as Error & { player?: UnifiedPlayer }).player = player;
      throw err;
    }
    return player;
  }

  private async bootstrap(): Promise<void> {
    try {
      const ctx = await probe(this.options.source);
      this.diag.recordProbe(ctx);

      // Merge sidecar / explicit subtitles into the context before classification
      // so the classification engine and the strategy both see them.
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
      this.diag.recordClassification(decision);

      this.emitter.emitSticky("strategy", {
        strategy: decision.strategy,
        reason: decision.reason,
      });

      // Find a plugin that claims this strategy. Built-ins always cover all
      // three named strategies; user-injected plugins can preempt.
      const plugin = this.registry.findFor(ctx, decision.strategy);
      if (!plugin) {
        throw new Error(`no plugin available for strategy "${decision.strategy}"`);
      }
      this.session = await plugin.execute(ctx, this.options.target);

      // Apply subtitles. Native + remux strategies use <track>; the fallback
      // strategy ignores this and renders subs through its own overlay.
      if (decision.strategy !== "fallback") {
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

  private startTimeupdateLoop(): void {
    // We poll instead of relying on the <video> "timeupdate" event because the
    // fallback strategy may not own a real <video> element.
    this.timeupdateInterval = setInterval(() => {
      const t = this.options.target.currentTime;
      this.emitter.emit("timeupdate", { currentTime: t });
    }, 250);
  }

  on<K extends PlayerEventName>(event: K, fn: Listener<PlayerEventMap[K]>): () => void {
    return this.emitter.on(event, fn);
  }

  off<K extends PlayerEventName>(event: K, fn: Listener<PlayerEventMap[K]>): void {
    this.emitter.off(event, fn);
  }

  async play(): Promise<void> {
    if (!this.session) throw new Error("player not ready");
    await this.session.play();
  }

  pause(): void {
    this.session?.pause();
  }

  async seek(time: number): Promise<void> {
    if (!this.session) throw new Error("player not ready");
    await this.session.seek(time);
  }

  async setAudioTrack(id: number): Promise<void> {
    if (!this.session) throw new Error("player not ready");
    await this.session.setAudioTrack(id);
  }

  async setSubtitleTrack(id: number | null): Promise<void> {
    if (!this.session) throw new Error("player not ready");
    await this.session.setSubtitleTrack(id);
  }

  getDiagnostics(): DiagnosticsSnapshot {
    if (this.session) {
      this.diag.recordRuntime(this.session.getRuntimeStats());
    }
    return this.diag.snapshot();
  }

  /**
   * Total media duration in seconds. Returns the duration discovered at
   * probe time when available; otherwise falls back to the underlying
   * `<video>` element's duration. May be `NaN` for live or unknown sources.
   */
  getDuration(): number {
    const fromDiag = this.diag.snapshot().duration;
    if (typeof fromDiag === "number" && Number.isFinite(fromDiag)) return fromDiag;
    const fromVideo = this.options.target.duration;
    return Number.isFinite(fromVideo) ? fromVideo : NaN;
  }

  /** Current playback position in seconds, sourced from the underlying strategy. */
  getCurrentTime(): number {
    return this.options.target.currentTime || 0;
  }

  async destroy(): Promise<void> {
    if (this.timeupdateInterval) {
      clearInterval(this.timeupdateInterval);
      this.timeupdateInterval = null;
    }
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
