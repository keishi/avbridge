/**
 * `<avbridge-video>` — `HTMLMediaElement`-compatible primitive backed by the
 * avbridge engine. Drop-in replacement for a `<video>` element with no
 * built-in UI.
 *
 * Purpose:
 *
 *   1. Validate the public API by being a real consumer of `createPlayer()`.
 *   2. Drive lifecycle correctness in the core via adversarial integration tests.
 *   3. Give consumers a `<video>`-compatible primitive they can wrap with
 *      their own UI.
 *
 * **It is not a player UI framework.** For YouTube-style chrome (seek
 * bar, play/pause, settings menu, fullscreen, auto-hiding controls) use
 * `<avbridge-player>` — it wraps this element with a full UI. See
 * `docs/dev/WEB_COMPONENT_SPEC.md` for the full spec, lifecycle invariants,
 * and edge case list.
 */

import { createPlayer, type UnifiedPlayer } from "../player.js";
import type {
  MediaInput,
  StrategyName,
  StrategyClass,
  AudioTrackInfo,
  SubtitleTrackInfo,
  DiagnosticsSnapshot,
  AvbridgeVideoElementEventMap,
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

/** Fit mode — how the video fills the element's box. Mirrors CSS object-fit. */
type FitMode = "contain" | "cover" | "fill";
const FIT_VALUES = new Set<FitMode>(["contain", "cover", "fill"]);
const DEFAULT_FIT: FitMode = "contain";

/**
 * Standard `HTMLMediaElement` events we forward from the inner `<video>`
 * to the wrapper element so consumers can `el.addEventListener("loadedmetadata", ...)`
 * exactly like they would with a real `<video>`. The element also dispatches
 * its own custom events (`strategychange`, `ready`, `error`, etc.) — those
 * are NOT in this list because they're avbridge-specific.
 *
 * Note: `progress` and `timeupdate` are deliberately NOT forwarded here.
 * `progress` is dispatched by the constructor with our own `{ buffered }`
 * detail. `timeupdate` is dispatched by the player layer (so it works for
 * canvas-rendered fallback playback too, where the inner <video> never
 * fires its own timeupdate).
 */
const FORWARDED_VIDEO_EVENTS = [
  "loadstart",
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "canplaythrough",
  "play",
  "playing",
  "pause",
  "seeking",
  "seeked",
  "volumechange",
  "ratechange",
  "durationchange",
  "waiting",
  "stalled",
  "emptied",
  "resize",
  "error",
] as const;

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
export class AvbridgeVideoElement extends HTMLElementCtor {
  static readonly observedAttributes = [
    "src",
    "autoplay",
    "muted",
    "loop",
    "preload",
    "poster",
    "playsinline",
    "crossorigin",
    "disableremoteplayback",
    "diagnostics",
    "preferstrategy",
    "fit",
    "no-orientation-lock",
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
  /** Subtitle tracks reported by the active UnifiedPlayer (options.subtitles
   *  + embedded container tracks + programmatic addSubtitle calls). */
  private _subtitleTracks: SubtitleTrackInfo[] = [];
  /** Subtitle tracks derived from light-DOM `<track>` children. Maintained
   *  by _syncTextTracks on every mutation. Merged into the public
   *  `subtitleTracks` getter so the player's settings menu sees them. */
  private _htmlTrackInfo: SubtitleTrackInfo[] = [];

  /**
   * External subtitle list forwarded to `createPlayer()` on the next
   * bootstrap. Setting this after bootstrap queues it for the next
   * source change; consumers that need to swap subtitles mid-playback
   * should set `source` to reload.
   */
  private _subtitles: Array<{ url: string; language?: string; format?: "vtt" | "srt" }> | null = null;

  /**
   * Initial strategy preference. `"auto"` means "let the classifier decide";
   * any other value is passed to `createPlayer({ initialStrategy })` and
   * skips classification on the next bootstrap. Note that this only affects
   * the *initial* pick — runtime fallback escalation still applies, so a
   * preference of `"native"` may still escalate to remux/hybrid/fallback if
   * native fails.
   */
  private _preferredStrategy: PreferredStrategy = "auto";

  /** Current fit mode. Applied to the inner `<video>` via object-fit, and
   *  to the fallback canvas via the `--avbridge-fit` CSS custom property on
   *  the stage wrapper (see `src/strategies/fallback/video-renderer.ts`). */
  private _fit: FitMode = DEFAULT_FIT;
  /** The stage wrapper — the element the canvas attaches into, and where
   *  the `--avbridge-fit` CSS custom property lives. */
  private _stageEl!: HTMLDivElement;

  /** Set if currentTime was assigned before the player was ready. */
  private _pendingSeek: number | null = null;
  /** Set if play() was called before the player was ready. */
  private _pendingPlay = false;

  /** MutationObserver tracking light-DOM `<track>` children. */
  private _trackObserver: MutationObserver | null = null;

  /** Document-level fullscreenchange handler — installed while connected so
   *  the element can lock/unlock screen orientation to match the video's
   *  intrinsic aspect. */
  private _fullscreenChangeHandler: (() => void) | null = null;
  /** True if we successfully called screen.orientation.lock() on the last
   *  fullscreen entry. Used to know whether to unlock on exit. */
  private _orientationLocked = false;

  // ── Construction & lifecycle ───────────────────────────────────────────

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });

    // A positioned wrapper inside the shadow root. The fallback strategy
    // overlays a canvas on top of the <video> via `target.parentNode` —
    // that only works if the parent is a real Element with layout. Without
    // this wrapper, `target.parentElement` would be null (ShadowRoot is
    // not an Element) and the canvas would never attach to the DOM.
    const stage = document.createElement("div");
    stage.setAttribute("part", "stage");
    stage.style.cssText = `position:relative;width:100%;height:100%;display:block;--avbridge-fit:${DEFAULT_FIT};`;
    root.appendChild(stage);
    this._stageEl = stage;

    this._videoEl = document.createElement("video");
    this._videoEl.setAttribute("part", "video");
    this._videoEl.style.cssText = `width:100%;height:100%;display:block;background:#000;object-fit:var(--avbridge-fit, ${DEFAULT_FIT});`;
    this._videoEl.playsInline = true;
    stage.appendChild(this._videoEl);

    // Forward the underlying <video>'s `progress` event so consumers can
    // observe buffered-range updates without reaching into the shadow DOM.
    // This works for native + remux (real video element with buffered
    // ranges) and is a no-op for hybrid/fallback (canvas-rendered, no
    // buffered ranges yet).
    this._videoEl.addEventListener("progress", () => {
      if (this._destroyed) return;
      this._dispatch("progress", { buffered: this._videoEl.buffered });
    });

    // Forward all standard HTMLMediaElement events from the inner <video>
    // so consumers can use the element as a drop-in <video> replacement.
    // Each event is re-dispatched on the wrapper element with no detail —
    // listeners that need state should read it from the element directly.
    for (const eventName of FORWARDED_VIDEO_EVENTS) {
      this._videoEl.addEventListener(eventName, () => {
        if (this._destroyed) return;
        this.dispatchEvent(new Event(eventName, { bubbles: false }));
      });
    }
  }

  connectedCallback(): void {
    if (this._destroyed) return;
    // Pick up any <track> children that were declared in HTML before the
    // element upgraded, and watch for future additions/removals.
    this._syncTextTracks();
    if (!this._trackObserver) {
      this._trackObserver = new MutationObserver(() => this._syncTextTracks());
      this._trackObserver.observe(this, { childList: true, subtree: false });
    }
    if (!this._fullscreenChangeHandler) {
      this._fullscreenChangeHandler = () => this._onFullscreenChange();
      document.addEventListener("fullscreenchange", this._fullscreenChangeHandler);
    }
    // Connection is the trigger for bootstrap. If we have a pending source
    // (set before connect), kick off bootstrap now.
    const source = this._activeSource();
    if (source != null) {
      void this._bootstrap(source);
    }
  }

  disconnectedCallback(): void {
    if (this._destroyed) return;
    if (this._trackObserver) {
      this._trackObserver.disconnect();
      this._trackObserver = null;
    }
    if (this._fullscreenChangeHandler) {
      document.removeEventListener("fullscreenchange", this._fullscreenChangeHandler);
      this._fullscreenChangeHandler = null;
    }
    // If we were fullscreen via some ancestor and got disconnected, release
    // any orientation lock we had taken.
    this._releaseOrientationLock();
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
      case "playsinline":
      case "disableremoteplayback":
        // Reflect onto the underlying <video> element.
        if (newValue == null) this._videoEl.removeAttribute(name);
        else this._videoEl.setAttribute(name, newValue);
        break;
      case "preload":
      case "poster":
      case "crossorigin":
        if (newValue == null) this._videoEl.removeAttribute(name);
        else this._videoEl.setAttribute(name, newValue);
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
      case "fit": {
        const next: FitMode = newValue && FIT_VALUES.has(newValue as FitMode)
          ? (newValue as FitMode)
          : DEFAULT_FIT;
        if (next === this._fit) break;
        this._fit = next;
        this._stageEl.style.setProperty("--avbridge-fit", next);
        this._dispatch("fitchange", { fit: next });
        break;
      }
    }
  }

  // ── Source handling ────────────────────────────────────────────────────

  /** Returns the currently-active source (src or source), whichever is set. */
  private _activeSource(): MediaInput | null {
    if (this._source != null) return this._source;
    if (this._src != null) return this._src;
    return null;
  }

  /**
   * Mirror light-DOM `<track>` children into the shadow `<video>` so that
   * the browser's native text-track machinery picks them up. Called on
   * connect, on every mutation of light-DOM children, and once after each
   * source change so newly-set tracks survive a fresh `<video>`.
   *
   * Strategy: clone the children. We don't move them because the user's
   * code may still hold references to the originals (e.g. to set `default`).
   * The shadow copies are throwaway — we wipe them on every sync.
   */
  private _syncTextTracks(): void {
    // Remove existing shadow tracks.
    const existing = this._videoEl.querySelectorAll("track");
    for (const t of Array.from(existing)) t.remove();
    // Clone every <track> light-DOM child into the shadow video, and
    // rebuild the HTML-derived subtitle info list so the `<avbridge-player>`
    // settings menu can render them alongside options-sourced tracks.
    // HTML tracks are assigned high, stable IDs (10000+index) to avoid
    // colliding with container-embedded ids (typically < 32).
    this._htmlTrackInfo = [];
    let htmlIdx = 0;
    for (const child of Array.from(this.children)) {
      if (child.tagName === "TRACK") {
        const track = child as HTMLTrackElement;
        const clone = track.cloneNode(true) as HTMLTrackElement;
        this._videoEl.appendChild(clone);
        const src = track.getAttribute("src") ?? undefined;
        const format = src?.toLowerCase().endsWith(".srt") ? "srt" : "vtt";
        this._htmlTrackInfo.push({
          id: 10000 + htmlIdx,
          format,
          language: track.srclang || track.getAttribute("label") || undefined,
          sidecarUrl: src,
        });
        htmlIdx++;
      }
    }
    this._dispatch("trackschange", {
      audioTracks: this._audioTracks,
      subtitleTracks: this.subtitleTracks,
    });
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
        // Honor the consumer's preferred initial strategy. "auto" means
        // "let the classifier decide" — the createPlayer call simply doesn't
        // pass initialStrategy in that case.
        ...(this._preferredStrategy !== "auto"
          ? { initialStrategy: this._preferredStrategy }
          : {}),
        ...(this._subtitles ? { subtitles: this._subtitles } : {}),
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

    // Resync any light-DOM <track> children into the (possibly fresh) shadow
    // <video>. Strategies that swap or reset the inner video state would
    // otherwise lose the tracks the user declared in HTML.
    this._syncTextTracks();

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

  get fit(): FitMode {
    return this._fit;
  }

  set fit(value: FitMode) {
    if (!FIT_VALUES.has(value)) return;
    this.setAttribute("fit", value);
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
   * `<video>.buffered` `TimeRanges` API.
   *
   * - **Native / remux:** pass-through to the real `<video>.buffered`
   *   (reflects the browser's SourceBuffer / progressive-download state).
   * - **Hybrid / fallback:** a single `[0, frontier]` range synthesized
   *   from the demuxer's read progress — "how far libav has ever pumped
   *   packets through." Monotonic; does not shrink on seek. This is an
   *   approximation, not MSE-fidelity: decoded frames on canvas strategies
   *   are consumed in flight, so we can't report per-range availability
   *   the way MSE does. Enough for a seek-bar buffered indicator.
   */
  get buffered(): TimeRanges {
    return this._videoEl.buffered;
  }

  // ── HTMLMediaElement parity ───────────────────────────────────────────
  // Mirror the standard <video> surface so consumers can drop the element
  // in as a <video> replacement. Each property is a thin passthrough to the
  // shadow `<video>`.

  get poster(): string {
    return this._videoEl.poster;
  }
  set poster(value: string) {
    if (value == null || value === "") this.removeAttribute("poster");
    else this.setAttribute("poster", value);
  }

  get volume(): number {
    return this._videoEl.volume;
  }
  set volume(value: number) {
    this._videoEl.volume = value;
  }

  get playbackRate(): number {
    return this._videoEl.playbackRate;
  }
  set playbackRate(value: number) {
    this._videoEl.playbackRate = value;
  }

  get videoWidth(): number {
    return this._videoEl.videoWidth;
  }

  get videoHeight(): number {
    return this._videoEl.videoHeight;
  }

  get played(): TimeRanges {
    return this._videoEl.played;
  }

  get seekable(): TimeRanges {
    return this._videoEl.seekable;
  }

  get crossOrigin(): string | null {
    return this._videoEl.crossOrigin;
  }
  set crossOrigin(value: string | null) {
    if (value == null) this.removeAttribute("crossorigin");
    else this.setAttribute("crossorigin", value);
  }

  get disableRemotePlayback(): boolean {
    return this._videoEl.disableRemotePlayback;
  }
  set disableRemotePlayback(value: boolean) {
    if (value) this.setAttribute("disableremoteplayback", "");
    else this.removeAttribute("disableremoteplayback");
  }

  /**
   * Native `HTMLMediaElement.canPlayType()` passthrough. Note that this
   * answers about the *browser's* native support, not avbridge's full
   * capabilities — avbridge can play many formats this method returns ""
   * for, by routing them to the remux/hybrid/fallback strategies.
   */
  canPlayType(mimeType: string): CanPlayTypeResult {
    return this._videoEl.canPlayType(mimeType);
  }

  /**
   * **Escape hatch.** The underlying shadow-DOM `<video>` element.
   *
   * Use for native browser APIs the wrapper doesn't expose:
   * - `el.videoElement.requestPictureInPicture()`
   * - `el.videoElement.audioTracks` (browser native, not avbridge's track list)
   * - direct integration with libraries that need a real HTMLVideoElement
   *
   * **Caveat:** When the active strategy is `"fallback"` or `"hybrid"`,
   * frames are rendered to a canvas overlay, not into this `<video>`.
   * APIs that depend on the actual pixels (Picture-in-Picture, captureStream)
   * will not show the playing content in those modes. Check `el.strategy`
   * before using such APIs.
   */
  get videoElement(): HTMLVideoElement {
    return this._videoEl;
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
    // Merge player-sourced tracks with light-DOM `<track>` children.
    // Both sources coexist: options.subtitles + embedded-in-container
    // tracks contribute to _subtitleTracks; HTML `<track>` children
    // contribute _htmlTrackInfo with ids in the 10000+ range.
    return this._htmlTrackInfo.length === 0
      ? this._subtitleTracks
      : [...this._subtitleTracks, ...this._htmlTrackInfo];
  }

  /**
   * External subtitle files to attach when the source loads. Takes effect
   * on the next bootstrap — set before assigning `source`, or reload via
   * `load()` after changing. For dynamic post-bootstrap addition, use
   * `addSubtitle()` instead.
   *
   * @example
   * el.subtitles = [{ url: "/en.srt", format: "srt", language: "en" }];
   * el.src = "/movie.mp4";
   */
  get subtitles(): Array<{ url: string; language?: string; format?: "vtt" | "srt" }> | null {
    return this._subtitles;
  }

  set subtitles(value: Array<{ url: string; language?: string; format?: "vtt" | "srt" }> | null) {
    this._subtitles = value;
  }

  /**
   * Attach a subtitle track to the current playback without rebuilding
   * the player. Works while the element is playing — converts SRT to
   * VTT if needed, adds a `<track>` to the inner `<video>`. Canvas
   * strategies pick up the new track via their textTracks watcher.
   */
  async addSubtitle(subtitle: { url: string; language?: string; format?: "vtt" | "srt" }): Promise<void> {
    const { attachSubtitleTracks } = await import("../subtitles/index.js");
    const format = subtitle.format ?? (subtitle.url.endsWith(".srt") ? "srt" : "vtt");
    const track = {
      id: this._subtitleTracks.length,
      format,
      language: subtitle.language,
      sidecarUrl: subtitle.url,
    };
    this._subtitleTracks.push(track);
    await attachSubtitleTracks(
      this._videoEl,
      this._subtitleTracks,
      undefined,
      (err, t) => {
        // eslint-disable-next-line no-console
        console.warn(`[avbridge] subtitle ${t.id} failed: ${err.message}`);
      },
    );
  }

  /**
   * Disable the automatic `screen.orientation.lock()` that runs on
   * fullscreen entry. Set when you want to honor the device's native
   * auto-rotate instead of matching the video's intrinsic orientation.
   */
  get noOrientationLock(): boolean {
    return this.hasAttribute("no-orientation-lock");
  }

  set noOrientationLock(value: boolean) {
    if (value) this.setAttribute("no-orientation-lock", "");
    else this.removeAttribute("no-orientation-lock");
  }

  // ── Fullscreen orientation lock ────────────────────────────────────────

  /** Called whenever `document.fullscreenchange` fires. If this element (or
   *  any of its ancestors) is now fullscreen, derive the target orientation
   *  from the video's intrinsic size and call `screen.orientation.lock()`.
   *  On exit, release the lock we took. iOS Safari rejects `lock()` — we
   *  swallow the rejection so nothing breaks on that path. */
  private _onFullscreenChange(): void {
    if (this._destroyed) return;
    const fsEl = document.fullscreenElement;
    const nowFullscreen = fsEl != null && this._isInsideOrEquals(fsEl);
    if (nowFullscreen && !this._orientationLocked) {
      if (this.noOrientationLock) return;
      const target = this._desiredOrientation();
      if (!target) return; // square or unknown — don't lock
      void this._lockOrientation(target);
    } else if (!nowFullscreen && this._orientationLocked) {
      this._releaseOrientationLock();
    }
  }

  /** Walk composed-tree ancestors to see if `target` is this element or
   *  any ancestor across shadow boundaries. `Node.contains()` can't cross
   *  shadow roots, so when `<avbridge-player>` (the fullscreen element)
   *  hosts this `<avbridge-video>` inside its shadow DOM, `contains()`
   *  returns false. */
  private _isInsideOrEquals(target: Element): boolean {
    let node: Node | null = this;
    while (node) {
      if (node === target) return true;
      const parent: Node | null = node.parentNode;
      if (parent instanceof ShadowRoot) node = parent.host;
      else node = parent;
    }
    return false;
  }

  /** Derive "landscape" / "portrait" from the intrinsic video dimensions.
   *  Returns null when dimensions aren't known yet or the video is square.
   *  Uses `videoWidth` / `videoHeight` from the inner `<video>`, which the
   *  browser sets to the display-aspect-corrected size (so anamorphic
   *  content is judged by its display aspect, not pixel aspect). */
  private _desiredOrientation(): "landscape" | "portrait" | null {
    const w = this._videoEl.videoWidth;
    const h = this._videoEl.videoHeight;
    if (!w || !h) return null;
    if (w === h) return null;
    return w > h ? "landscape" : "portrait";
  }

  /** Attempt to lock screen orientation. Swallows rejections — iOS Safari
   *  doesn't implement `lock()`, and desktop / non-fullscreen contexts will
   *  reject too. Records success so we know whether to unlock on exit. */
  private async _lockOrientation(target: "landscape" | "portrait"): Promise<void> {
    const so = (screen as Screen & {
      orientation?: ScreenOrientation & { lock?: (o: string) => Promise<void> };
    }).orientation;
    if (!so || typeof so.lock !== "function") return;
    try {
      await so.lock(target);
      this._orientationLocked = true;
    } catch {
      // iOS Safari, desktop, or user denied — ignore.
    }
  }

  private _releaseOrientationLock(): void {
    if (!this._orientationLocked) return;
    this._orientationLocked = false;
    const so = screen.orientation as ScreenOrientation | undefined;
    if (so && typeof so.unlock === "function") {
      try { so.unlock(); } catch { /* ignore */ }
    }
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

  // ── Typed addEventListener / removeEventListener overloads ────────────
  // Consumers using avbridge-specific events get a typed CustomEvent
  // payload; standard HTMLMediaElement events retain their native types.

  override addEventListener<K extends keyof AvbridgeVideoElementEventMap>(
    type: K,
    listener: (this: AvbridgeVideoElement, ev: AvbridgeVideoElementEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener<K extends keyof HTMLElementEventMap>(
    type: K,
    listener: (this: AvbridgeVideoElement, ev: HTMLElementEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener, options);
  }

  override removeEventListener<K extends keyof AvbridgeVideoElementEventMap>(
    type: K,
    listener: (this: AvbridgeVideoElement, ev: AvbridgeVideoElementEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener<K extends keyof HTMLElementEventMap>(
    type: K,
    listener: (this: AvbridgeVideoElement, ev: HTMLElementEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    super.removeEventListener(type, listener, options);
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
    "avbridge-video": AvbridgeVideoElement;
  }
}
