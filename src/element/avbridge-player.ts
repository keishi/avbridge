/**
 * `<avbridge-player>` — reference web component for the avbridge engine.
 *
 * This is a *thin* wrapper around `createPlayer()`. Its purpose is to:
 *
 *   1. Validate the public API by being a real consumer of it.
 *   2. Drive lifecycle correctness in the core via adversarial integration tests.
 *   3. Provide a drop-in player for users who don't want to wire `createPlayer()`
 *      themselves.
 *
 * It is **not** a player UI framework. See `docs/dev/WEB_COMPONENT_SPEC.md`
 * for the full spec, lifecycle invariants, and edge case list.
 *
 * Phase A scope (this file): lifecycle scaffold only — `src` / `source` /
 * `currentTime` / `play` / `pause` / `load` / `destroy` / events. No built-in
 * controls. Shadow DOM contains a single `<video part="video">`.
 */

import { createPlayer, type UnifiedPlayer } from "../player.js";
import type {
  MediaInput,
  StrategyName,
  StrategyClass,
  AudioTrackInfo,
  SubtitleTrackInfo,
  DiagnosticsSnapshot,
} from "../types.js";

/** Strategy preference passed via the `preferstrategy` attribute. */
type PreferredStrategy = "auto" | StrategyName;

const PREFERRED_STRATEGY_VALUES = new Set<PreferredStrategy>([
  "auto",
  "native",
  "remux",
  "hybrid",
  "fallback",
]);

/**
 * `HTMLElement` is a browser-only global. SSR frameworks (Next.js, Astro,
 * Remix, etc.) commonly import library modules on the server to extract
 * types or do tree-shaking, even if the user only ends up using them in
 * the browser. If we extended `HTMLElement` directly, the `class extends`
 * expression would be evaluated at module load time and crash in Node.
 *
 * The fix: in non-browser environments, fall back to an empty stub class.
 * The element is never *constructed* server-side (the registration in
 * `element.ts` is guarded by `typeof customElements !== "undefined"`), so
 * the stub is never instantiated — it just lets the class declaration
 * evaluate cleanly so the module can be imported anywhere.
 */
const HTMLElementCtor: typeof HTMLElement =
  typeof HTMLElement !== "undefined"
    ? HTMLElement
    : (class {} as unknown as typeof HTMLElement);

/**
 * Custom element. Lifecycle correctness is enforced via a monotonically
 * increasing `_bootstrapId`: every async bootstrap captures the ID at start
 * and discards itself if the ID has changed by the time it resolves. This
 * single pattern handles disconnect-during-bootstrap, rapid src reassignment,
 * bootstrap races, and destroy-during-bootstrap.
 */
export class AvbridgePlayerElement extends HTMLElementCtor {
  static readonly observedAttributes = [
    "src",
    "autoplay",
    "muted",
    "loop",
    "preload",
    "diagnostics",
    "preferstrategy",
  ];

  // ── Internal state ─────────────────────────────────────────────────────

  /** The shadow DOM `<video>` element that strategies render into. */
  private _videoEl!: HTMLVideoElement;

  /** Active player session, if any. Cleared on teardown. */
  private _player: UnifiedPlayer | null = null;

  /**
   * Monotonic counter incremented on every (re)bootstrap. Async bootstrap
   * work captures the current ID; if it doesn't match by the time the work
   * resolves, the work is discarded.
   */
  private _bootstrapId = 0;

  /** True after destroy() — element is permanently unusable. */
  private _destroyed = false;

  /** Internal source state. Either string-form (src) OR rich (source). */
  private _src: string | null = null;
  private _source: MediaInput | null = null;

  /**
   * Set when the `source` property setter is in the middle of clearing the
   * `src` attribute as part of mutual exclusion. The attributeChangedCallback
   * checks this flag and skips its normal "clear source" side effect, which
   * would otherwise wipe the value we just set.
   */
  private _suppressSrcAttrCallback = false;

  /** Last-known runtime state surfaced via getters. */
  private _strategy: StrategyName | null = null;
  private _strategyClass: StrategyClass | null = null;
  private _audioTracks: AudioTrackInfo[] = [];
  private _subtitleTracks: SubtitleTrackInfo[] = [];

  /** Strategy preference (does not currently affect routing — reserved). */
  private _preferredStrategy: PreferredStrategy = "auto";

  /** Set if currentTime was assigned before the player was ready. */
  private _pendingSeek: number | null = null;
  /** Set if play() was called before the player was ready. */
  private _pendingPlay = false;

  // ── Construction & lifecycle ───────────────────────────────────────────

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    this._videoEl = document.createElement("video");
    this._videoEl.setAttribute("part", "video");
    this._videoEl.style.cssText = "width:100%;height:100%;display:block;background:#000;";
    this._videoEl.playsInline = true;
    root.appendChild(this._videoEl);

    // Forward the underlying <video>'s `progress` event so consumers can
    // observe buffered-range updates without reaching into the shadow DOM.
    // This works for native + remux (real video element with buffered
    // ranges) and is a no-op for hybrid/fallback (canvas-rendered, no
    // buffered ranges yet).
    this._videoEl.addEventListener("progress", () => {
      if (this._destroyed) return;
      this._dispatch("progress", { buffered: this._videoEl.buffered });
    });
  }

  connectedCallback(): void {
    if (this._destroyed) return;
    // Connection is the trigger for bootstrap. If we have a pending source
    // (set before connect), kick off bootstrap now.
    const source = this._activeSource();
    if (source != null) {
      void this._bootstrap(source);
    }
  }

  disconnectedCallback(): void {
    if (this._destroyed) return;
    // Bump the bootstrap token so any in-flight async work is invalidated
    // before we tear down. _teardown() also bumps but we want the bump to
    // happen synchronously here so any awaited promise that resolves
    // between `disconnect` and `_teardown` sees the new ID.
    this._bootstrapId++;
    void this._teardown();
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    if (this._destroyed) return;
    switch (name) {
      case "src":
        if (this._suppressSrcAttrCallback) break;
        this._setSrcInternal(newValue);
        break;
      case "autoplay":
      case "muted":
      case "loop":
        // Reflect onto the underlying <video> element.
        if (newValue == null) this._videoEl.removeAttribute(name);
        else this._videoEl.setAttribute(name, newValue);
        break;
      case "preload":
        if (newValue == null) this._videoEl.removeAttribute("preload");
        else this._videoEl.setAttribute("preload", newValue);
        break;
      case "diagnostics":
        // Phase A: no UI. Property is observable for users via getDiagnostics().
        break;
      case "preferstrategy":
        if (newValue && PREFERRED_STRATEGY_VALUES.has(newValue as PreferredStrategy)) {
          this._preferredStrategy = newValue as PreferredStrategy;
        } else {
          this._preferredStrategy = "auto";
        }
        break;
    }
  }

  // ── Source handling ────────────────────────────────────────────────────

  /** Returns the currently-active source (src or source), whichever is set. */
  private _activeSource(): MediaInput | null {
    if (this._source != null) return this._source;
    if (this._src != null) return this._src;
    return null;
  }

  /** Internal src setter — separate from the property setter so the
   * attributeChangedCallback can use it without re-entering reflection. */
  private _setSrcInternal(value: string | null): void {
    // Same-value reassignment: no-op (#11 in the lifecycle list).
    if (value === this._src && this._source == null) return;
    this._src = value;
    this._source = null;
    this._onSourceChanged();
  }

  /** Called whenever the active source changes (src or source). */
  private _onSourceChanged(): void {
    if (this._destroyed) return;
    const source = this._activeSource();
    if (source == null) {
      // Null transition: tear down and stay idle.
      this._bootstrapId++;
      void this._teardown();
      return;
    }
    // Only bootstrap if we're connected to the DOM.
    if (this.isConnected) {
      void this._bootstrap(source);
    }
  }

  // ── Bootstrap (the only place a UnifiedPlayer is created) ──────────────

  private async _bootstrap(source: MediaInput): Promise<void> {
    if (this._destroyed) return;
    const id = ++this._bootstrapId;

    // Tear down any existing player before starting a new one. Pass the
    // bootstrap id we just claimed so teardown doesn't bump it again
    // (which would invalidate ourselves).
    await this._teardown(id);
    if (id !== this._bootstrapId || this._destroyed) return;

    this._dispatch("loadstart", {});

    let player: UnifiedPlayer;
    try {
      player = await createPlayer({
        source,
        target: this._videoEl,
      });
    } catch (err) {
      // Stale or destroyed — silently abandon.
      if (id !== this._bootstrapId || this._destroyed) return;
      this._dispatchError(err);
      return;
    }

    // Race check: if anything happened during the await above, bail.
    if (id !== this._bootstrapId || this._destroyed || !this.isConnected) {
      try { await player.destroy(); } catch { /* ignore */ }
      return;
    }

    this._player = player;

    // Wire events. The unsubscribe handles are not stored individually
    // because destroy() will tear down the whole session anyway.
    player.on("strategy", ({ strategy, reason }) => {
      // strategy event fires on initial classification AND any escalation.
      const cls = player.getDiagnostics().strategyClass;
      this._strategy = strategy;
      this._strategyClass = cls === "pending" ? null : cls;
      this._dispatch("strategychange", {
        strategy,
        strategyClass: this._strategyClass,
        reason,
        diagnostics: player.getDiagnostics(),
      });
    });

    player.on("strategychange", ({ from, to, reason, currentTime }) => {
      this._dispatch("strategychange", {
        from,
        strategy: to,
        strategyClass: player.getDiagnostics().strategyClass === "pending" ? null : player.getDiagnostics().strategyClass,
        reason,
        currentTime,
        diagnostics: player.getDiagnostics(),
      });
    });

    player.on("tracks", ({ video: _v, audio, subtitle }) => {
      this._audioTracks = audio;
      this._subtitleTracks = subtitle;
      this._dispatch("trackschange", {
        audioTracks: audio,
        subtitleTracks: subtitle,
      });
    });

    player.on("error", (err: Error) => {
      this._dispatchError(err);
    });

    player.on("timeupdate", ({ currentTime }) => {
      this._dispatch("timeupdate", { currentTime });
    });

    player.on("ended", () => {
      this._dispatch("ended", {});
    });

    player.on("ready", () => {
      this._dispatch("ready", { diagnostics: player.getDiagnostics() });
      // Apply any pending seek that was set before the player existed.
      if (this._pendingSeek != null) {
        const t = this._pendingSeek;
        this._pendingSeek = null;
        void player.seek(t).catch(() => { /* ignore */ });
      }
      // Honor any pending play() that was queued before bootstrap finished.
      if (this._pendingPlay) {
        this._pendingPlay = false;
        void player.play().catch(() => { /* ignore — autoplay may be blocked */ });
      } else if (this.autoplay) {
        void player.play().catch(() => { /* ignore */ });
      }
    });
  }

  /**
   * Tear down the active player and reset runtime state. Idempotent.
   * If `currentBootstrapId` is provided, the bootstrap counter is NOT
   * incremented (used by `_bootstrap()` to avoid invalidating itself).
   */
  private async _teardown(currentBootstrapId?: number): Promise<void> {
    if (currentBootstrapId == null) {
      // External callers (disconnect, destroy, source change) should bump
      // the counter so any in-flight bootstrap is invalidated. The internal
      // _bootstrap() call passes its own ID and we skip the bump.
      this._bootstrapId++;
    }
    const player = this._player;
    this._player = null;
    this._strategy = null;
    this._strategyClass = null;
    this._audioTracks = [];
    this._subtitleTracks = [];
    if (player) {
      try { await player.destroy(); } catch { /* ignore */ }
    }
  }

  // ── Public properties ──────────────────────────────────────────────────

  get src(): string | null {
    return this._src;
  }

  set src(value: string | null) {
    if (value == null) {
      this.removeAttribute("src");
    } else {
      this.setAttribute("src", value);
    }
    // attributeChangedCallback handles the rest.
  }

  get source(): MediaInput | null {
    return this._source;
  }

  set source(value: MediaInput | null) {
    // Same-value reassignment for rich values is identity-based.
    if (value === this._source && this._src == null) return;
    this._source = value;
    if (value != null) {
      // Setting source clears src. Suppress the attribute callback so
      // removing the src attribute doesn't wipe the source we just set.
      this._src = null;
      if (this.hasAttribute("src")) {
        this._suppressSrcAttrCallback = true;
        try {
          this.removeAttribute("src");
        } finally {
          this._suppressSrcAttrCallback = false;
        }
      }
    }
    this._onSourceChanged();
  }

  get autoplay(): boolean {
    return this.hasAttribute("autoplay");
  }

  set autoplay(value: boolean) {
    if (value) this.setAttribute("autoplay", "");
    else this.removeAttribute("autoplay");
  }

  get muted(): boolean {
    return this.hasAttribute("muted");
  }

  set muted(value: boolean) {
    if (value) this.setAttribute("muted", "");
    else this.removeAttribute("muted");
  }

  get loop(): boolean {
    return this.hasAttribute("loop");
  }

  set loop(value: boolean) {
    if (value) this.setAttribute("loop", "");
    else this.removeAttribute("loop");
  }

  get preload(): "none" | "metadata" | "auto" {
    const v = this.getAttribute("preload");
    return v === "none" || v === "metadata" || v === "auto" ? v : "auto";
  }

  set preload(value: "none" | "metadata" | "auto") {
    this.setAttribute("preload", value);
  }

  get diagnostics(): boolean {
    return this.hasAttribute("diagnostics");
  }

  set diagnostics(value: boolean) {
    if (value) this.setAttribute("diagnostics", "");
    else this.removeAttribute("diagnostics");
  }

  get preferredStrategy(): PreferredStrategy {
    return this._preferredStrategy;
  }

  set preferredStrategy(value: PreferredStrategy) {
    if (PREFERRED_STRATEGY_VALUES.has(value)) {
      this.setAttribute("preferstrategy", value);
    }
  }

  get currentTime(): number {
    return this._player?.getCurrentTime() ?? 0;
  }

  set currentTime(value: number) {
    if (this._player) {
      void this._player.seek(value).catch(() => { /* ignore */ });
    } else {
      // Defer to the next bootstrap. The `ready` handler applies it.
      this._pendingSeek = value;
    }
  }

  get duration(): number {
    return this._player?.getDuration() ?? NaN;
  }

  get paused(): boolean {
    return this._videoEl.paused;
  }

  get ended(): boolean {
    return this._videoEl.ended;
  }

  get readyState(): number {
    return this._videoEl.readyState;
  }

  /**
   * Buffered time ranges for the active source. Mirrors the standard
   * `<video>.buffered` `TimeRanges` API. For the native and remux strategies
   * this reflects the underlying SourceBuffer / progressive download state.
   * For the hybrid and fallback (canvas-rendered) strategies it currently
   * returns an empty TimeRanges; v1.1 will synthesize a coarse range from
   * the decoder's read position.
   */
  get buffered(): TimeRanges {
    return this._videoEl.buffered;
  }

  get strategy(): StrategyName | null {
    return this._strategy;
  }

  get strategyClass(): StrategyClass | null {
    return this._strategyClass;
  }

  get player(): UnifiedPlayer | null {
    return this._player;
  }

  get audioTracks(): AudioTrackInfo[] {
    return this._audioTracks;
  }

  get subtitleTracks(): SubtitleTrackInfo[] {
    return this._subtitleTracks;
  }

  // ── Public methods ─────────────────────────────────────────────────────

  /** Force a (re-)bootstrap if a source is currently set. */
  async load(): Promise<void> {
    if (this._destroyed) return;
    const source = this._activeSource();
    if (source == null) return;
    await this._bootstrap(source);
  }

  /**
   * Begin or resume playback. If the player isn't ready yet, the call is
   * queued and applied once `ready` fires.
   */
  async play(): Promise<void> {
    if (this._destroyed) return;
    if (this._player) {
      await this._player.play();
    } else {
      this._pendingPlay = true;
    }
  }

  pause(): void {
    if (this._destroyed) return;
    this._pendingPlay = false;
    this._player?.pause();
  }

  /**
   * Tear down the element permanently. After destroy(), the element ignores
   * all method calls and attribute changes.
   */
  async destroy(): Promise<void> {
    if (this._destroyed) return;
    this._destroyed = true;
    await this._teardown();
    this._dispatch("destroy", {});
  }

  async setAudioTrack(id: number): Promise<void> {
    if (this._destroyed || !this._player) return;
    await this._player.setAudioTrack(id);
  }

  async setSubtitleTrack(id: number | null): Promise<void> {
    if (this._destroyed || !this._player) return;
    await this._player.setSubtitleTrack(id);
  }

  getDiagnostics(): DiagnosticsSnapshot | null {
    return this._player?.getDiagnostics() ?? null;
  }

  // ── Event helpers ──────────────────────────────────────────────────────

  private _dispatch<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: false }));
  }

  private _dispatchError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this._dispatch("error", { error, diagnostics: this._player?.getDiagnostics() ?? null });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "avbridge-player": AvbridgePlayerElement;
  }
}
