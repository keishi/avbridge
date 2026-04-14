// Test harness for <avbridge-player> controls, driven by
// scripts/player-controls-test.mjs. Exposes an imperative API on
// window.playerHarness so Puppeteer can assert on the shadow DOM
// without encoding every assertion in browser-eval strings.

import { AvbridgePlayerElement } from "../src/player-element.js";
if (!customElements.get("avbridge-player")) {
  customElements.define("avbridge-player", AvbridgePlayerElement);
}

interface PlayerHarness {
  reset(): AvbridgePlayerElement;
  get(): AvbridgePlayerElement | null;
  setSourceFromUrl(url: string): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  /** Force a direct property write (skips controls UI). */
  setVolume(v: number): void;
  setMuted(m: boolean): void;
  /** Simulate a click on a control in the shadow DOM by CSS selector. */
  clickControl(selector: string): void;
  /** Read current shadow-DOM UI state for assertions. */
  uiState(): {
    playButtonIsPlaying: boolean;
    volumeButtonMuted: boolean;
    volumeSliderValue: number;
    timeDisplay: string;
    dataState: string | null;
  };
  /** Read element state. */
  state(): {
    paused: boolean;
    muted: boolean;
    volume: number;
    strategy: string | null;
    currentTime: number;
    duration: number;
  };
  /** Wait until a condition becomes true. */
  waitFor(checkName: string, timeoutMs?: number): Promise<boolean>;
}

let element: AvbridgePlayerElement | null = null;
const containerEl = document.getElementById("container") as HTMLDivElement;

function getShadowRoot(): ShadowRoot | null {
  return element?.shadowRoot ?? null;
}

function iconIsPause(svg: string): boolean {
  // ICON_PAUSE contains two rect-like path segments. A simple way to
  // distinguish from ICON_PLAY is the presence of the characteristic
  // pause path "M6 19h4V5H6".
  return svg.includes("M6 19h4V5H6");
}

function iconIsVolumeOff(svg: string): boolean {
  // ICON_VOLUME_OFF has the distinctive 4.27 3 start coordinate
  return svg.includes("4.27 3");
}

const harness: PlayerHarness = {
  reset() {
    if (element) {
      try { element.remove(); } catch { /* ignore */ }
    }
    element = document.createElement("avbridge-player") as AvbridgePlayerElement;
    containerEl.appendChild(element);
    return element;
  },
  get() { return element; },
  async setSourceFromUrl(url) {
    if (!element) throw new Error("no element");
    const res = await fetch(url);
    const blob = await res.blob();
    (element as unknown as { source: Blob }).source = blob;
  },
  async play() {
    if (!element) throw new Error("no element");
    await element.play();
  },
  pause() {
    if (!element) throw new Error("no element");
    element.pause();
  },
  setVolume(v) {
    if (!element) throw new Error("no element");
    element.volume = v;
  },
  setMuted(m) {
    if (!element) throw new Error("no element");
    element.muted = m;
  },
  clickControl(selector) {
    const root = getShadowRoot();
    if (!root) throw new Error("no shadow root");
    const el = root.querySelector(selector) as HTMLElement | null;
    if (!el) throw new Error(`no element matching ${selector}`);
    el.click();
  },
  uiState() {
    const root = getShadowRoot();
    if (!root) {
      return {
        playButtonIsPlaying: false,
        volumeButtonMuted: false,
        volumeSliderValue: 0,
        timeDisplay: "",
        dataState: null,
      };
    }
    const playBtn = root.querySelector(".avp-play");
    const volBtn = root.querySelector(".avp-volume-btn");
    const volSlider = root.querySelector(".avp-volume-input") as HTMLInputElement | null;
    const timeEl = root.querySelector(".avp-time");
    return {
      playButtonIsPlaying: playBtn ? iconIsPause(playBtn.innerHTML) : false,
      volumeButtonMuted: volBtn ? iconIsVolumeOff(volBtn.innerHTML) : false,
      volumeSliderValue: volSlider ? Number(volSlider.value) : 0,
      timeDisplay: timeEl?.textContent ?? "",
      dataState: element?.dataset.state ?? null,
    };
  },
  state() {
    const el = element;
    if (!el) return { paused: true, muted: false, volume: 1, strategy: null, currentTime: 0, duration: NaN };
    return {
      paused: el.paused,
      muted: el.muted,
      volume: el.volume,
      strategy: el.strategy ?? null,
      currentTime: el.currentTime,
      duration: el.duration,
    };
  },
  waitFor(_checkName, timeoutMs = 10_000) {
    // Not used — Puppeteer uses page.waitForFunction directly
    return new Promise((r) => setTimeout(() => r(false), timeoutMs));
  },
};

declare global {
  interface Window {
    playerHarness: PlayerHarness;
  }
}

window.playerHarness = harness;
