// Test harness for the avbridge-video lifecycle tests in
// scripts/element-test.mjs. Imports the element entry (registering the
// custom element) and exposes a small imperative API on window.harness so
// the Puppeteer driver can manipulate elements without re-implementing
// every test scenario in browser-eval strings.

import "../src/element.js";
import type { AvbridgeVideoElement } from "../src/element/avbridge-video.js";

interface EventLogEntry {
  type: string;
  detail: unknown;
  at: number;
}

interface Harness {
  /** Replace the active element with a fresh one. Returns the new element. */
  reset(): AvbridgeVideoElement;
  /** Get the current element. */
  get(): AvbridgeVideoElement | null;
  /** Set src on the current element. */
  setSrc(src: string | null): void;
  /** Set source on the current element from a fetched URL. */
  setSourceFromUrl(url: string): Promise<void>;
  /** Append the current element to a different container. */
  moveTo(parentId: string): void;
  /** Detach the current element. */
  detach(): void;
  /** Reattach the current element. */
  reattach(parentId?: string): void;
  /** Read the event log accumulated since the last reset. */
  events(): EventLogEntry[];
  /** Wait for an event of the given name (resolves with the entry). */
  waitForEvent(name: string, timeoutMs?: number): Promise<EventLogEntry | null>;
  /** Read element state for assertions. */
  state(): {
    src: string | null;
    hasSource: boolean;
    isConnected: boolean;
    strategy: string | null;
    paused: boolean;
    currentTime: number;
    duration: number;
    readyState: number;
    hasPlayer: boolean;
  };
}

let element: AvbridgeVideoElement | null = null;
let log: EventLogEntry[] = [];

const containerEl = document.getElementById("container") as HTMLDivElement;

const TRACKED_EVENTS = ["loadstart", "ready", "error", "strategychange", "trackschange", "destroy"];

function attachLogger(el: AvbridgeVideoElement): void {
  for (const name of TRACKED_EVENTS) {
    el.addEventListener(name, (e) => {
      log.push({
        type: name,
        detail: (e as CustomEvent).detail,
        at: performance.now(),
      });
    });
  }
}

const harness: Harness = {
  reset() {
    if (element) {
      try { element.remove(); } catch { /* ignore */ }
    }
    log = [];
    element = document.createElement("avbridge-video") as AvbridgeVideoElement;
    attachLogger(element);
    containerEl.appendChild(element);
    return element;
  },
  get() {
    return element;
  },
  setSrc(src) {
    if (!element) throw new Error("no element");
    if (src == null) element.src = null;
    else element.src = src;
  },
  async setSourceFromUrl(url) {
    if (!element) throw new Error("no element");
    const res = await fetch(url);
    const blob = await res.blob();
    element.source = blob;
  },
  moveTo(parentId) {
    if (!element) throw new Error("no element");
    const target = document.getElementById(parentId);
    if (!target) throw new Error(`no parent ${parentId}`);
    target.appendChild(element);
  },
  detach() {
    if (!element) return;
    element.remove();
  },
  reattach(parentId = "container") {
    if (!element) return;
    const target = document.getElementById(parentId);
    if (!target) throw new Error(`no parent ${parentId}`);
    target.appendChild(element);
  },
  events() {
    return [...log];
  },
  waitForEvent(name, timeoutMs = 10_000) {
    return new Promise((resolve) => {
      // Check existing log first.
      const existing = log.find((e) => e.type === name);
      if (existing) return resolve(existing);
      const start = performance.now();
      const tick = () => {
        const found = log.find((e) => e.type === name && e.at >= start);
        if (found) return resolve(found);
        if (performance.now() - start > timeoutMs) return resolve(null);
        setTimeout(tick, 50);
      };
      tick();
    });
  },
  state() {
    const el = element;
    if (!el) {
      return {
        src: null,
        hasSource: false,
        isConnected: false,
        strategy: null,
        paused: true,
        currentTime: 0,
        duration: NaN,
        readyState: 0,
        hasPlayer: false,
      };
    }
    return {
      src: el.src,
      hasSource: el.source != null,
      isConnected: el.isConnected,
      strategy: el.strategy,
      paused: el.paused,
      currentTime: el.currentTime,
      duration: el.duration,
      readyState: el.readyState,
      hasPlayer: el.player != null,
    };
  },
};

declare global {
  interface Window {
    harness: Harness;
  }
}

window.harness = harness;
