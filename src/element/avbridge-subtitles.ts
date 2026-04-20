/**
 * `<avbridge-subtitles>` — scrollable subtitle timeline panel.
 *
 * Connects to an `<avbridge-player>` or `<avbridge-video>` via the `for`
 * attribute (points to the player's `id`) or auto-detects a sibling.
 * Reads TextTrack cues from the player's inner `<video>`, renders them
 * as a timestamped list, highlights the active cue, and seeks on click.
 *
 * Usage:
 *   <avbridge-player id="player">...</avbridge-player>
 *   <avbridge-subtitles for="player"></avbridge-subtitles>
 */

const HTMLElementCtor: typeof HTMLElement =
  typeof HTMLElement !== "undefined"
    ? HTMLElement
    : (class {} as unknown as typeof HTMLElement);

const STYLES = `
:host {
  display: block;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 14px;
  color: #eee;
  background: #1a1a1a;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.avs-empty {
  padding: 16px;
  opacity: 0.5;
  text-align: center;
  font-size: 13px;
}

.avs-cue {
  display: flex;
  gap: 12px;
  padding: 8px 12px;
  cursor: pointer;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  transition: background 0.1s;
  align-items: flex-start;
}

.avs-cue:hover {
  background: rgba(255, 255, 255, 0.06);
}

.avs-cue.active {
  background: rgba(62, 166, 255, 0.12);
}

.avs-time {
  flex-shrink: 0;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  opacity: 0.5;
  min-width: 48px;
  padding-top: 1px;
}

.avs-cue.active .avs-time {
  opacity: 0.8;
  color: #3ea6ff;
}

.avs-text {
  flex: 1;
  min-width: 0;
  line-height: 1.4;
  word-break: break-word;
}
`;

interface CueEntry {
  start: number;
  end: number;
  text: string;
  el: HTMLDivElement;
}

export class AvbridgeSubtitlesElement extends HTMLElementCtor {
  static readonly observedAttributes = ["for"];

  private _player: HTMLElement | null = null;
  private _cues: CueEntry[] = [];
  private _tickTimer: ReturnType<typeof setInterval> | null = null;
  private _activeCueIndex = -1;
  private _trackChangeListener: (() => void) | null = null;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${STYLES}</style><div class="avs-empty">No subtitles loaded</div>`;
  }

  connectedCallback(): void {
    this._connectPlayer();
    this._startTick();
  }

  disconnectedCallback(): void {
    this._stopTick();
    this._disconnectPlayer();
  }

  attributeChangedCallback(name: string): void {
    if (name === "for") {
      this._disconnectPlayer();
      this._connectPlayer();
    }
  }

  // ── Player connection ──────────────────────────────────────────────────

  private _connectPlayer(): void {
    const forId = this.getAttribute("for");
    if (forId) {
      this._player = document.getElementById(forId);
    } else {
      // Auto-detect sibling avbridge-player or avbridge-video
      this._player =
        this.parentElement?.querySelector("avbridge-player") ??
        this.parentElement?.querySelector("avbridge-video") ??
        null;
    }
    if (!this._player) return;

    // Listen for trackschange to rebuild the cue list when subtitles
    // are added/removed dynamically.
    this._trackChangeListener = () => this._rebuildCues();
    this._player.addEventListener("trackschange", this._trackChangeListener);

    // Initial build (subtitle may already be loaded).
    // Defer so the player has time to bootstrap.
    requestAnimationFrame(() => this._rebuildCues());
  }

  private _disconnectPlayer(): void {
    if (this._player && this._trackChangeListener) {
      this._player.removeEventListener("trackschange", this._trackChangeListener);
    }
    this._player = null;
    this._trackChangeListener = null;
  }

  private _getVideoElement(): HTMLVideoElement | null {
    if (!this._player) return null;
    return (this._player as unknown as { videoElement?: HTMLVideoElement }).videoElement ?? null;
  }

  // ── Cue list ───────────────────────────────────────────────────────────

  private _rebuildCues(): void {
    const video = this._getVideoElement();
    const shadow = this.shadowRoot!;
    this._cues = [];
    this._activeCueIndex = -1;

    if (!video) {
      shadow.innerHTML = `<style>${STYLES}</style><div class="avs-empty">No player connected</div>`;
      return;
    }

    // Find the first subtitle/caption track with cues.
    let track: TextTrack | null = null;
    for (let i = 0; i < video.textTracks.length; i++) {
      const t = video.textTracks[i];
      if ((t.kind === "subtitles" || t.kind === "captions") && t.cues && t.cues.length > 0) {
        track = t;
        break;
      }
    }

    if (!track || !track.cues || track.cues.length === 0) {
      shadow.innerHTML = `<style>${STYLES}</style><div class="avs-empty">No subtitle cues available</div>`;
      // Retry shortly — cues may load async.
      setTimeout(() => {
        if (this._cues.length === 0 && this.isConnected) this._rebuildCues();
      }, 1000);
      return;
    }

    // Build the list.
    const container = document.createElement("div");
    for (let i = 0; i < track.cues.length; i++) {
      const cue = track.cues[i] as VTTCue;
      const el = document.createElement("div");
      el.className = "avs-cue";

      const timeEl = document.createElement("span");
      timeEl.className = "avs-time";
      timeEl.textContent = formatTime(cue.startTime);

      const textEl = document.createElement("span");
      textEl.className = "avs-text";
      textEl.textContent = cue.text.replace(/<[^>]+>/g, "");

      el.appendChild(timeEl);
      el.appendChild(textEl);

      const startTime = cue.startTime;
      el.addEventListener("click", () => {
        if (this._player) {
          (this._player as unknown as { currentTime: number }).currentTime = startTime;
        }
      });

      container.appendChild(el);
      this._cues.push({ start: cue.startTime, end: cue.endTime, text: cue.text, el });
    }

    shadow.innerHTML = `<style>${STYLES}</style>`;
    shadow.appendChild(container);
  }

  // ── Active cue tracking ────────────────────────────────────────────────

  private _startTick(): void {
    if (this._tickTimer) return;
    this._tickTimer = setInterval(() => this._tick(), 250);
  }

  private _stopTick(): void {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  private _tick(): void {
    if (this._cues.length === 0 || !this._player) return;
    const currentTime = (this._player as unknown as { currentTime: number }).currentTime ?? 0;

    let newActive = -1;
    for (let i = 0; i < this._cues.length; i++) {
      const c = this._cues[i];
      if (currentTime >= c.start && currentTime <= c.end) {
        newActive = i;
        break;
      }
    }

    if (newActive === this._activeCueIndex) return;

    // Remove previous highlight.
    if (this._activeCueIndex >= 0 && this._activeCueIndex < this._cues.length) {
      this._cues[this._activeCueIndex].el.classList.remove("active");
    }

    this._activeCueIndex = newActive;

    // Apply new highlight + scroll into view.
    if (newActive >= 0) {
      const cue = this._cues[newActive];
      cue.el.classList.add("active");
      cue.el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
}

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
