/**
 * `<avbridge-player>` — YouTube-style controls element.
 *
 * Wraps `<avbridge-video>` with a full player UI: play/pause, seek bar,
 * volume, settings menu (speed, subtitles, audio tracks), fullscreen,
 * keyboard shortcuts, touch gestures, and auto-hiding controls.
 *
 * All properties, methods, and events from `<avbridge-video>` are proxied
 * through. Consumers interact with `<avbridge-player>` exclusively.
 */

// Import the class concretely and register — side-effect-only imports
// are tree-shaken by Rollup in production builds.
import { AvbridgeVideoElement } from "./avbridge-video.js";
if (typeof customElements !== "undefined" && !customElements.get("avbridge-video")) {
  customElements.define("avbridge-video", AvbridgeVideoElement);
}
import { PLAYER_STYLES } from "./player-styles.js";
import {
  ICON_PLAY, ICON_PAUSE,
  ICON_VOLUME_UP, ICON_VOLUME_OFF,
  ICON_SETTINGS,
  ICON_FULLSCREEN, ICON_FULLSCREEN_EXIT,
  ICON_REPLAY_10, ICON_FORWARD_10,
} from "./player-icons.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const PLAYBACK_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
const CONTROLS_HIDE_MS = 3000;

type PlayerState = "idle" | "loading" | "playing" | "paused" | "buffering" | "ended" | "error";

// ── Forwarded events ─────────────────────────────────────────────────────

const FORWARDED_EVENTS = [
  "ready", "error", "strategychange", "trackschange", "loadstart", "destroy",
  "play", "playing", "pause", "seeking", "seeked", "volumechange",
  "ratechange", "durationchange", "canplay", "canplaythrough",
  "waiting", "stalled", "emptied", "resize",
  "loadedmetadata", "loadeddata", "timeupdate", "ended", "progress",
] as const;

// ── Observed attributes ──────────────────────────────────────────────────

const PROXY_ATTRIBUTES = [
  "src", "autoplay", "muted", "loop", "preload", "poster",
  "playsinline", "crossorigin", "disableremoteplayback", "preferstrategy",
] as const;

// ═══════════════════════════════════════════════════════════════════════════

export class AvbridgePlayerElement extends HTMLElement {
  static readonly observedAttributes = [...PROXY_ATTRIBUTES];

  // ── Internal DOM refs ──────────────────────────────────────────────────

  private _video!: AvbridgeVideoElement;
  private _playBtn!: HTMLButtonElement;
  private _overlayBtn!: HTMLButtonElement;
  private _seekInput!: HTMLInputElement;
  private _seekProgress!: HTMLDivElement;
  private _seekBuffered!: HTMLDivElement;
  private _seekThumb!: HTMLDivElement;
  private _seekTooltip!: HTMLDivElement;
  private _timeDisplay!: HTMLSpanElement;
  private _volumeBtn!: HTMLButtonElement;
  private _volumeInput!: HTMLInputElement;
  private _settingsBtn!: HTMLButtonElement;
  private _settingsMenu!: HTMLDivElement;
  private _fullscreenBtn!: HTMLButtonElement;
  // Strategy badge removed — visible in Stats for Nerds instead.
  // Spinner is rendered but driven entirely by CSS :host([data-state]) selectors.
  private _speedIndicator!: HTMLDivElement;
  private _rippleLeft!: HTMLDivElement;
  private _rippleRight!: HTMLDivElement;

  // ── State ──────────────────────────────────────────────────────────────

  private _state: PlayerState = "idle";
  private _controlsTimer: ReturnType<typeof setTimeout> | null = null;
  private _settingsOpen = false;
  private _userSeeking = false;
  private _holdTimer: ReturnType<typeof setTimeout> | null = null;
  private _holdSpeedActive = false;
  private _savedPlaybackRate = 1;
  private _lastTapTime = 0;
  private _tapTimer: ReturnType<typeof setTimeout> | null = null;
  private _statsOpen = false;
  private _statsEl!: HTMLDivElement;
  private _statsInterval: ReturnType<typeof setInterval> | null = null;
  private _eventCleanup: (() => void)[] = [];

  // ── Constructor ────────────────────────────────────────────────────────

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${PLAYER_STYLES}</style>${this._template()}`;

    // Grab refs
    this._video = shadow.querySelector("avbridge-video") as AvbridgeVideoElement;
    this._playBtn = shadow.querySelector(".avp-play") as HTMLButtonElement;
    this._overlayBtn = shadow.querySelector(".avp-overlay-btn") as HTMLButtonElement;
    this._seekInput = shadow.querySelector(".avp-seek-input") as HTMLInputElement;
    this._seekProgress = shadow.querySelector(".avp-seek-progress") as HTMLDivElement;
    this._seekBuffered = shadow.querySelector(".avp-seek-buffered") as HTMLDivElement;
    this._seekThumb = shadow.querySelector(".avp-seek-thumb") as HTMLDivElement;
    this._seekTooltip = shadow.querySelector(".avp-seek-tooltip") as HTMLDivElement;
    this._timeDisplay = shadow.querySelector(".avp-time") as HTMLSpanElement;
    this._volumeBtn = shadow.querySelector(".avp-volume-btn") as HTMLButtonElement;
    this._volumeInput = shadow.querySelector(".avp-volume-input") as HTMLInputElement;
    this._settingsBtn = shadow.querySelector(".avp-settings-btn") as HTMLButtonElement;
    this._settingsMenu = shadow.querySelector(".avp-settings") as HTMLDivElement;
    this._fullscreenBtn = shadow.querySelector(".avp-fullscreen") as HTMLButtonElement;
    // Badge removed from controls bar — strategy visible in Stats for Nerds.
    // Spinner is rendered in shadow DOM, driven by CSS :host([data-state]).
    this._speedIndicator = shadow.querySelector(".avp-speed-indicator") as HTMLDivElement;
    this._statsEl = shadow.querySelector(".avp-stats") as HTMLDivElement;
    this._rippleLeft = shadow.querySelector(".avp-ripple-left") as HTMLDivElement;
    this._rippleRight = shadow.querySelector(".avp-ripple-right") as HTMLDivElement;

    this._bindEvents();
  }

  private _template(): string {
    return `
<div part="container" class="avp">
  <avbridge-video part="video"></avbridge-video>
  <div part="overlay" class="avp-overlay">
    <button class="avp-overlay-btn" aria-label="Play">${ICON_PLAY}</button>
    <div class="avp-spinner"></div>
  </div>
  <div class="avp-speed-indicator">2x</div>
  <div class="avp-stats" part="stats-panel"></div>
  <div class="avp-ripple avp-ripple-left">${ICON_REPLAY_10}</div>
  <div class="avp-ripple avp-ripple-right">${ICON_FORWARD_10}</div>
  <div part="controls" class="avp-controls">
    <div class="avp-seek" part="seek-bar">
      <div class="avp-seek-track">
        <div class="avp-seek-buffered"></div>
        <div class="avp-seek-progress"></div>
      </div>
      <div class="avp-seek-thumb"></div>
      <div class="avp-seek-tooltip">0:00</div>
      <input class="avp-seek-input" type="range" min="0" max="0" step="any" value="0" aria-label="Seek">
    </div>
    <div class="avp-bottom">
      <button class="avp-btn avp-play" part="play-button" aria-label="Play">${ICON_PLAY}</button>
      <div class="avp-volume">
        <button class="avp-btn avp-volume-btn" part="volume-button" aria-label="Mute">${ICON_VOLUME_UP}</button>
        <div class="avp-volume-slider">
          <input class="avp-volume-input" part="volume-slider" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">
        </div>
      </div>
      <span class="avp-time" part="time-display">0:00 / 0:00</span>
      <span class="avp-spacer"></span>
      <button class="avp-btn avp-settings-btn" part="settings-button" aria-label="Settings">${ICON_SETTINGS}</button>
      <button class="avp-btn avp-fullscreen" part="fullscreen-button" aria-label="Fullscreen">${ICON_FULLSCREEN}</button>
    </div>
    <div class="avp-settings" part="settings-menu"></div>
  </div>
</div>`;
  }

  // ── Event wiring ───────────────────────────────────────────────────────

  private _bindEvents(): void {
    const on = <K extends keyof HTMLElementEventMap>(
      el: EventTarget, event: K | string, fn: (e: Event) => void, opts?: AddEventListenerOptions,
    ) => {
      el.addEventListener(event, fn, opts);
      this._eventCleanup.push(() => el.removeEventListener(event, fn, opts));
    };

    // Forward events from inner video
    for (const name of FORWARDED_EVENTS) {
      on(this._video, name, (e) => {
        const detail = (e as CustomEvent).detail;
        this.dispatchEvent(
          detail !== undefined
            ? new CustomEvent(name, { detail, bubbles: e.bubbles, composed: true })
            : new Event(name, { bubbles: e.bubbles }),
        );
      });
    }

    // State tracking
    on(this._video, "loadstart", () => this._setState("loading"));
    on(this._video, "ready", () => {
      this._setState(this._video.paused ? "paused" : "playing");
      this._seekInput.max = String(this._video.duration || 0);
      this._updateTime();
      this._buildSettingsMenu();
    });
    on(this._video, "play", () => this._setState("playing"));
    on(this._video, "playing", () => this._setState("playing"));
    on(this._video, "pause", () => this._setState("paused"));
    on(this._video, "waiting", () => this._setState("buffering"));
    on(this._video, "ended", () => this._setState("ended"));
    on(this._video, "error", () => this._setState("error"));
    on(this._video, "timeupdate", () => this._updateTime());
    on(this._video, "volumechange", () => this._updateVolume());
    // Strategy changes are visible in Stats for Nerds.
    on(this._video, "trackschange", () => this._buildSettingsMenu());
    on(this._video, "durationchange", () => {
      this._seekInput.max = String(this._video.duration || 0);
    });

    // Play / pause
    on(this._playBtn, "click", (e) => { e.stopPropagation(); this._togglePlay(); });
    on(this._overlayBtn, "click", (e) => { e.stopPropagation(); this._togglePlay(); });

    // Seek bar
    on(this._seekInput, "input", () => this._onSeekInput());
    on(this._seekInput, "pointerdown", () => { this._userSeeking = true; });
    on(this._seekInput, "change", () => this._onSeekCommit());
    on(this._seekInput, "pointermove", (e) => this._onSeekHover(e as PointerEvent));

    // Volume
    on(this._volumeBtn, "click", (e) => { e.stopPropagation(); this._toggleMute(); });
    on(this._volumeInput, "input", () => {
      const vol = Number(this._volumeInput.value);
      this._video.volume = vol;
      this._video.videoElement.volume = vol;
      this._video.muted = false;
      this._video.videoElement.muted = false;
      this._updateVolume();
    });

    // Settings
    on(this._settingsBtn, "click", (e) => { e.stopPropagation(); this._toggleSettings(); });

    // Fullscreen
    on(this._fullscreenBtn, "click", (e) => { e.stopPropagation(); this._toggleFullscreen(); });
    on(document, "fullscreenchange", () => this._updateFullscreenIcon());

    // Click / tap on video area — uses a delayed-tap pattern (like YouTube)
    // to distinguish single-tap (play/pause) from double-tap (seek ±10s).
    // On mouse: single click → play/pause, dblclick → fullscreen.
    // On touch: single tap (after 250ms) → play/pause, double tap → seek.
    const container = this.shadowRoot!.querySelector(".avp")!;
    on(container, "click", (e) => this._onContainerClick(e as MouseEvent));
    on(container, "dblclick", (e) => this._onContainerDblClick(e as MouseEvent));

    // Dismiss settings menu on click outside (inside or outside the player)
    on(container, "click", (e) => {
      if (this._settingsOpen &&
          !(e.target as HTMLElement).closest?.(".avp-settings-btn, .avp-settings")) {
        this._closeSettings();
      }
    });
    // Also dismiss if user clicks outside the player element entirely
    on(document, "click", (e) => {
      if (this._settingsOpen && !this.contains(e.target as Node)) {
        this._closeSettings();
      }
    });

    // Auto-hide controls
    on(container, "pointermove", () => this._showControls());
    on(container, "pointerleave", () => this._scheduleHide());

    // Touch gestures: hold for 2x speed
    on(container, "pointerdown", (e) => this._onPointerDown(e as PointerEvent));
    on(container, "pointerup", (e) => this._onPointerUp(e as PointerEvent));
    on(container, "pointercancel", () => this._cancelHold());

    // Keyboard
    on(this, "keydown", (e) => this._onKeydown(e as KeyboardEvent));

    // Make focusable for keyboard events
    if (!this.hasAttribute("tabindex")) {
      this.setAttribute("tabindex", "0");
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  connectedCallback(): void {
    this._setState("idle");
  }

  disconnectedCallback(): void {
    this._clearTimers();
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    // Proxy attributes down to inner avbridge-video
    if (!this._video) return;
    if (value == null) this._video.removeAttribute(name);
    else this._video.setAttribute(name, value);
  }

  // ── State management ───────────────────────────────────────────────────

  private _setState(state: PlayerState): void {
    this._state = state;
    this.dataset.state = state;

    // Update play/pause icons
    const playing = state === "playing" || state === "buffering";
    this._playBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    this._playBtn.ariaLabel = playing ? "Pause" : "Play";
    this._overlayBtn.innerHTML = ICON_PLAY;

    // Auto-hide logic
    if (playing) this._scheduleHide();
    else this._showControls();
  }

  // ── Controls: play/pause ───────────────────────────────────────────────

  private _togglePlay(): void {
    if (this._state === "idle" || this._state === "error") return;
    if (this._video.paused) void this._video.play();
    else this._video.pause();
  }

  // ── Controls: seek ─────────────────────────────────────────────────────

  private _onSeekInput(): void {
    const t = Number(this._seekInput.value);
    this._updateSeekVisuals(t);
    this._timeDisplay.textContent = `${formatTime(t)} / ${formatTime(this._video.duration)}`;
  }

  private _onSeekCommit(): void {
    this._video.currentTime = Number(this._seekInput.value);
    this._userSeeking = false;
  }

  private _onSeekHover(e: PointerEvent): void {
    const rect = this._seekInput.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const t = frac * (this._video.duration || 0);
    this._seekTooltip.textContent = formatTime(t);
    this._seekTooltip.style.left = `${frac * 100}%`;
  }

  private _updateSeekVisuals(t: number): void {
    const dur = this._video.duration || 0;
    const pct = dur > 0 ? (t / dur) * 100 : 0;
    this._seekProgress.style.width = `${pct}%`;
    this._seekThumb.style.left = `${pct}%`;
  }

  // ── Controls: time ─────────────────────────────────────────────────────

  private _updateTime(): void {
    if (this._userSeeking) return;
    const t = this._video.currentTime;
    const d = this._video.duration;
    this._seekInput.value = String(t);
    this._updateSeekVisuals(t);
    this._timeDisplay.textContent = `${formatTime(t)} / ${formatTime(d)}`;

    // Buffered ranges
    try {
      const buf = this._video.buffered;
      if (buf && buf.length > 0 && d > 0) {
        const end = buf.end(buf.length - 1);
        this._seekBuffered.style.width = `${(end / d) * 100}%`;
      }
    } catch { /* ignore */ }
  }

  // ── Controls: volume ───────────────────────────────────────────────────

  private _toggleMute(): void {
    // Set both the element attribute AND the inner <video> property directly,
    // because avbridge-video's attribute-based muted toggling can diverge
    // from the <video> property on a running element.
    const newMuted = !this._video.muted;
    this._video.muted = newMuted;
    this._video.videoElement.muted = newMuted;
    this._updateVolume();
  }

  private _updateVolume(): void {
    const muted = this._video.muted || this._video.videoElement.muted || this._video.volume === 0;
    this._volumeBtn.innerHTML = muted ? ICON_VOLUME_OFF : ICON_VOLUME_UP;
    this._volumeInput.value = muted ? "0" : String(this._video.volume);
  }

  // ── Controls: settings ─────────────────────────────────────────────────

  private _toggleSettings(): void {
    this._settingsOpen = !this._settingsOpen;
    this._settingsMenu.classList.toggle("open", this._settingsOpen);
    if (this._settingsOpen) this._showControls();
  }

  private _closeSettings(): void {
    this._settingsOpen = false;
    this._settingsMenu.classList.remove("open");
  }

  private _buildSettingsMenu(): void {
    const sections: string[] = [];

    // Playback speed
    const currentRate = this._video.playbackRate ?? 1;
    let speedItems = "";
    for (const spd of PLAYBACK_SPEEDS) {
      const active = Math.abs(spd - currentRate) < 0.01;
      const label = spd === 1 ? "Normal" : `${spd}x`;
      speedItems += `<div class="avp-settings-item${active ? " active" : ""}" data-speed="${spd}">${label}</div>`;
    }
    sections.push(`<div class="avp-settings-section"><div class="avp-settings-label">Speed</div>${speedItems}</div>`);

    // Subtitle tracks
    const subs = this._video.subtitleTracks ?? [];
    if (subs.length > 0) {
      let subItems = `<div class="avp-settings-item" data-subtitle="-1">Off</div>`;
      for (const t of subs) {
        subItems += `<div class="avp-settings-item" data-subtitle="${t.id}">${t.language ?? `Track ${t.id}`}</div>`;
      }
      sections.push(`<div class="avp-settings-section"><div class="avp-settings-label">Subtitles</div>${subItems}</div>`);
    }

    // Audio tracks
    const audios = this._video.audioTracks ?? [];
    if (audios.length > 1) {
      let audioItems = "";
      for (const t of audios) {
        audioItems += `<div class="avp-settings-item" data-audio="${t.id}">${t.language ?? `Track ${t.id}`}</div>`;
      }
      sections.push(`<div class="avp-settings-section"><div class="avp-settings-label">Audio</div>${audioItems}</div>`);
    }

    // Stats for nerds
    sections.push(`<div class="avp-settings-section"><div class="avp-settings-item" data-stats>Stats for nerds</div></div>`);

    this._settingsMenu.innerHTML = sections.join("");

    // Bind click handlers
    for (const item of this._settingsMenu.querySelectorAll("[data-speed]")) {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        this._video.playbackRate = Number((item as HTMLElement).dataset.speed);
        this._buildSettingsMenu();
      });
    }
    for (const item of this._settingsMenu.querySelectorAll("[data-subtitle]")) {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = Number((item as HTMLElement).dataset.subtitle);
        void this._video.setSubtitleTrack(id >= 0 ? id : null);
        this._closeSettings();
      });
    }
    for (const item of this._settingsMenu.querySelectorAll("[data-audio]")) {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        void this._video.setAudioTrack(Number((item as HTMLElement).dataset.audio));
        this._closeSettings();
      });
    }
    const statsItem = this._settingsMenu.querySelector("[data-stats]");
    if (statsItem) {
      statsItem.addEventListener("click", (e) => {
        e.stopPropagation();
        this._toggleStats();
        this._closeSettings();
      });
    }
  }

  // ── Stats for nerds ────────────────────────────────────────────────────

  private _toggleStats(): void {
    this._statsOpen = !this._statsOpen;
    this._statsEl.classList.toggle("open", this._statsOpen);
    if (this._statsOpen) {
      this._updateStats();
      this._statsInterval = setInterval(() => this._updateStats(), 1000);
    } else {
      if (this._statsInterval) { clearInterval(this._statsInterval); this._statsInterval = null; }
    }
  }

  private _updateStats(): void {
    const d = this._video.getDiagnostics() as Record<string, unknown> | null;
    if (!d) { this._statsEl.textContent = "No diagnostics"; return; }
    const rt = (d.runtime ?? {}) as Record<string, unknown>;
    const lines: string[] = [
      `Container: ${d.container ?? "?"}`,
      `Video: ${d.videoCodec ?? "?"} ${d.width ?? "?"}×${d.height ?? "?"}`,
      `Audio: ${d.audioCodec ?? "none"}`,
      `Strategy: ${d.strategy ?? "?"}  Class: ${d.strategyClass ?? "?"}`,
      `Transport: ${d.transport ?? "?"} Range: ${d.rangeSupported ?? "?"}`,
      `Duration: ${typeof d.duration === "number" ? d.duration.toFixed(1) + "s" : "?"}`,
    ];
    if (rt.framesDecoded != null) lines.push(`Frames: ${rt.framesDecoded} decoded, ${rt.framesDropped ?? 0} dropped`);
    if (rt.framesPainted != null) lines.push(`Painted: ${rt.framesPainted} Late: ${rt.framesDroppedLate ?? 0} Overflow: ${rt.framesDroppedOverflow ?? 0}`);
    if (rt.videoFramesDecoded != null) lines.push(`Video decoded: ${rt.videoFramesDecoded} Chunks fed: ${rt.videoChunksFed ?? "?"}`);
    if (rt.audioFramesDecoded != null) lines.push(`Audio decoded: ${rt.audioFramesDecoded}`);
    if (rt.packetsRead != null) lines.push(`Packets read: ${rt.packetsRead}`);
    if (rt.bsfApplied && (rt.bsfApplied as string[]).length > 0) lines.push(`BSF: ${(rt.bsfApplied as string[]).join(", ")}`);
    if (rt.audioState != null) lines.push(`Audio state: ${rt.audioState} Clock: ${rt.clockMode ?? "?"}`);
    if (d.probedBy) lines.push(`Probed by: ${d.probedBy}`);
    this._statsEl.textContent = lines.join("\n");
  }

  // ── Controls: fullscreen ───────────────────────────────────────────────

  private _toggleFullscreen(): void {
    if (document.fullscreenElement === this) {
      void document.exitFullscreen();
    } else {
      void this.requestFullscreen();
    }
  }

  private _updateFullscreenIcon(): void {
    const fs = document.fullscreenElement === this;
    this._fullscreenBtn.innerHTML = fs ? ICON_FULLSCREEN_EXIT : ICON_FULLSCREEN;
  }

  // ── Controls: auto-hide ────────────────────────────────────────────────

  private _showControls(): void {
    this.removeAttribute("data-controls-hidden");
    this._scheduleHide();
  }

  private _scheduleHide(): void {
    if (this._controlsTimer) clearTimeout(this._controlsTimer);
    if (this._state !== "playing" && this._state !== "buffering") return;
    if (this._settingsOpen) return;
    this._controlsTimer = setTimeout(() => {
      if (this._state === "playing") {
        this.setAttribute("data-controls-hidden", "");
      }
    }, CONTROLS_HIDE_MS);
  }

  // Strategy is visible in Stats for Nerds, no badge in controls bar.

  // ── Click / tap handling (YouTube delayed-tap pattern) ──────────────────
  //
  // Problem: single click toggles play, double click toggles fullscreen (or
  // seek on touch). Firing play on the first click causes a play→pause
  // glitch on every double-click. YouTube solves this by delaying the
  // single-click action by ~250ms; if a second click arrives in that window
  // it's treated as a double-click and the single-click action is cancelled.

  /** Track whether the last interaction was touch so click handler can skip. */
  private _lastPointerTypeWasTouch = false;

  private _onContainerClick(e: MouseEvent): void {
    // Ignore clicks on controls
    if ((e.target as HTMLElement).closest?.(".avp-controls, .avp-settings, .avp-overlay-btn")) return;

    // Touch taps are handled by _onPointerUp (show/hide controls + double-tap).
    // The browser fires a synthetic click after touchend — skip it.
    if (this._lastPointerTypeWasTouch) {
      this._lastPointerTypeWasTouch = false;
      return;
    }

    // Mouse: delay single-click to let dblclick cancel it
    if (this._tapTimer) { clearTimeout(this._tapTimer); this._tapTimer = null; }
    this._tapTimer = setTimeout(() => {
      this._tapTimer = null;
      this._togglePlay();
    }, 250);
  }

  private _onContainerDblClick(e: MouseEvent): void {
    if ((e.target as HTMLElement).closest?.(".avp-controls, .avp-settings")) return;
    // Cancel the pending single-click play/pause
    if (this._tapTimer) { clearTimeout(this._tapTimer); this._tapTimer = null; }
    this._toggleFullscreen();
  }

  // ── Touch gestures ─────────────────────────────────────────────────────

  private _onPointerDown(e: PointerEvent): void {
    if (e.pointerType !== "touch") return;
    // Tap-and-hold for 2x speed
    this._holdTimer = setTimeout(() => {
      this._holdSpeedActive = true;
      this._savedPlaybackRate = this._video.playbackRate;
      this._video.playbackRate = 2;
      this._speedIndicator.classList.add("active");
    }, 500);
  }

  private _onPointerUp(e: PointerEvent): void {
    this._cancelHold();
    if (e.pointerType !== "touch") return;
    this._lastPointerTypeWasTouch = true;

    // Ignore touches on controls — buttons have their own handlers
    if ((e.target as HTMLElement).closest?.(".avp-controls, .avp-settings, .avp-overlay-btn")) return;

    // Double-tap detection
    const now = Date.now();
    if (now - this._lastTapTime < 300) {
      // Double tap — cancel pending single tap and seek
      if (this._tapTimer) { clearTimeout(this._tapTimer); this._tapTimer = null; }
      const rect = this.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < rect.width / 3) {
        this._doDoubleTap("left");
      } else if (x > (rect.width * 2) / 3) {
        this._doDoubleTap("right");
      } else {
        this._toggleFullscreen();
      }
      this._lastTapTime = 0;
      return;
    }
    // Single tap on touch — toggle controls visibility (NOT play/pause).
    // YouTube mobile: tap shows/hides controls. Play button toggles playback.
    this._lastTapTime = now;
    this._tapTimer = setTimeout(() => {
      this._tapTimer = null;
      if (this.hasAttribute("data-controls-hidden")) {
        this._showControls();
      } else {
        this.setAttribute("data-controls-hidden", "");
      }
    }, 250);
  }

  private _cancelHold(): void {
    if (this._holdTimer) {
      clearTimeout(this._holdTimer);
      this._holdTimer = null;
    }
    if (this._holdSpeedActive) {
      this._holdSpeedActive = false;
      this._video.playbackRate = this._savedPlaybackRate;
      this._speedIndicator.classList.remove("active");
    }
  }

  private _doDoubleTap(side: "left" | "right"): void {
    const ripple = side === "left" ? this._rippleLeft : this._rippleRight;
    ripple.classList.remove("active");
    // Force reflow to restart animation
    void ripple.offsetWidth;
    ripple.classList.add("active");

    const delta = side === "left" ? -10 : 10;
    this._video.currentTime = Math.max(0, this._video.currentTime + delta);
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────

  private _onKeydown(e: KeyboardEvent): void {
    // Don't intercept if the user is typing in an input
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    switch (e.key) {
      case " ":
      case "k":
        e.preventDefault();
        this._togglePlay();
        break;
      case "f":
        e.preventDefault();
        this._toggleFullscreen();
        break;
      case "m":
        e.preventDefault();
        this._toggleMute();
        break;
      case "ArrowLeft":
      case "j":
        e.preventDefault();
        this._video.currentTime = Math.max(0, this._video.currentTime - 5);
        break;
      case "ArrowRight":
      case "l":
        e.preventDefault();
        this._video.currentTime = Math.min(this._video.duration || 0, this._video.currentTime + 5);
        break;
      case "ArrowUp":
        e.preventDefault();
        this._video.volume = Math.min(1, this._video.volume + 0.1);
        break;
      case "ArrowDown":
        e.preventDefault();
        this._video.volume = Math.max(0, this._video.volume - 0.1);
        break;
      case ">":
        e.preventDefault();
        this._video.playbackRate = Math.min(2, this._video.playbackRate + 0.25);
        this._buildSettingsMenu();
        break;
      case "<":
        e.preventDefault();
        this._video.playbackRate = Math.max(0.25, this._video.playbackRate - 0.25);
        this._buildSettingsMenu();
        break;
      case "Escape":
        if (this._settingsOpen) {
          e.preventDefault();
          this._closeSettings();
        }
        break;
    }
    this._showControls();
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  private _clearTimers(): void {
    if (this._controlsTimer) { clearTimeout(this._controlsTimer); this._controlsTimer = null; }
    if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null; }
    if (this._tapTimer) { clearTimeout(this._tapTimer); this._tapTimer = null; }
    if (this._statsInterval) { clearInterval(this._statsInterval); this._statsInterval = null; }
  }

  // ── Property proxies ───────────────────────────────────────────────────

  get src(): string { return this._video.src ?? ""; }
  set src(v: string) { this._video.src = v; }

  get source(): unknown { return this._video.source; }
  set source(v: unknown) { (this._video as unknown as { source: unknown }).source = v; }

  get currentTime(): number { return this._video.currentTime; }
  set currentTime(v: number) { this._video.currentTime = v; }

  get duration(): number { return this._video.duration; }
  get paused(): boolean { return this._video.paused; }
  get ended(): boolean { return this._video.ended; }
  get readyState(): number { return this._video.readyState; }

  get volume(): number { return this._video.volume; }
  set volume(v: number) { this._video.volume = v; this._updateVolume(); }

  get muted(): boolean { return this._video.muted; }
  set muted(v: boolean) { this._video.muted = v; this._updateVolume(); }

  get playbackRate(): number { return this._video.playbackRate; }
  set playbackRate(v: number) { this._video.playbackRate = v; }

  get autoplay(): boolean { return this._video.autoplay; }
  set autoplay(v: boolean) { this._video.autoplay = v; }

  get loop(): boolean { return this._video.loop; }
  set loop(v: boolean) { this._video.loop = v; }

  get videoWidth(): number { return this._video.videoWidth; }
  get videoHeight(): number { return this._video.videoHeight; }
  get buffered(): TimeRanges { return this._video.buffered; }
  get played(): TimeRanges { return this._video.played; }
  get seekable(): TimeRanges { return this._video.seekable; }

  get strategy(): string | undefined { return this._video.strategy ?? undefined; }
  get strategyClass(): string | undefined { return this._video.strategyClass ?? undefined; }
  get audioTracks(): unknown[] { return this._video.audioTracks ?? []; }
  get subtitleTracks(): unknown[] { return this._video.subtitleTracks ?? []; }
  get player(): unknown { return this._video.player; }
  get videoElement(): HTMLVideoElement { return this._video.videoElement; }

  // ── Method proxies ─────────────────────────────────────────────────────

  async play(): Promise<void> { return this._video.play(); }
  pause(): void { this._video.pause(); }
  async load(): Promise<void> { return this._video.load(); }
  async destroy(): Promise<void> {
    this._clearTimers();
    for (const fn of this._eventCleanup) fn();
    this._eventCleanup = [];
    return this._video.destroy();
  }
  async setAudioTrack(id: number): Promise<void> { return this._video.setAudioTrack(id); }
  async setSubtitleTrack(id: number | null): Promise<void> { return this._video.setSubtitleTrack(id); }
  getDiagnostics(): unknown { return this._video.getDiagnostics(); }
  canPlayType(mime: string): string { return this._video.canPlayType(mime); }
}
