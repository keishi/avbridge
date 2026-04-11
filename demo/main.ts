// Player demo — uses the <avbridge-player> reference component instead of
// wiring createPlayer() directly. The component owns the lifecycle, so this
// file is mostly UI glue.
//
// We also import { srtToVtt } via the core entry to demonstrate that the
// core and the element entry coexist cleanly.

import "../src/element.js";
import type { AvbridgePlayerElement } from "../src/element/avbridge-player.js";
import type { StrategyName } from "../src/index.js";

const fileInput = document.getElementById("file") as HTMLInputElement;
const subInput = document.getElementById("subs") as HTMLInputElement;
const player = document.getElementById("player") as AvbridgePlayerElement;
const badge = document.getElementById("badge")!;
const diag = document.getElementById("diagnostics")!;
const errorEl = document.getElementById("error")!;

const playPauseBtn = document.getElementById("playPause") as HTMLButtonElement;
const seekBar = document.getElementById("seek") as HTMLInputElement;
const timeLabel = document.getElementById("time")!;
const strategySwitcher = document.getElementById("strategy-switcher")!;
const stratBtns = document.querySelectorAll<HTMLButtonElement>(".strat-btn");

let pendingSub: { url: string; format: "srt" | "vtt" } | null = null;
let isPlaying = false;
let duration = 0;
let userIsScrubbing = false;
let strategy: string = "";

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

function setPlayingUI(playing: boolean) {
  isPlaying = playing;
  playPauseBtn.textContent = playing ? "⏸" : "▶";
  if (strategy) {
    badge.textContent = strategy;
    badge.className = `badge ${strategy}`;
  }
}

function setBufferingUI() {
  badge.classList.add("buffering");
  badge.textContent = `${strategy} · buffering…`;
}

function setStrategyUI(s: string) {
  strategy = s;
  badge.textContent = s;
  badge.className = `badge ${s}`;
  stratBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.strategy === s);
  });
}

function updateTimeLabel(currentTime: number) {
  timeLabel.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
}

// ── Element event wiring ─────────────────────────────────────────────────

player.addEventListener("strategychange", (e) => {
  const detail = (e as CustomEvent).detail;
  setStrategyUI(detail.strategy);
  console.log("[demo] strategychange:", detail.strategy, "—", detail.reason);
});

player.addEventListener("trackschange", (e) => {
  console.log("[demo] trackschange:", (e as CustomEvent).detail);
});

player.addEventListener("error", (e) => {
  const detail = (e as unknown as CustomEvent).detail;
  errorEl.textContent = detail.error?.message ?? String(detail.error);
});

player.addEventListener("ready", () => {
  duration = player.duration;
  if (Number.isFinite(duration) && duration > 0) {
    seekBar.max = String(duration);
    seekBar.disabled = false;
  }
  playPauseBtn.disabled = false;
  strategySwitcher.style.display = "";
  diag.textContent = JSON.stringify(player.getDiagnostics(), null, 2);
  updateTimeLabel(0);
});

player.addEventListener("timeupdate", (e) => {
  if (userIsScrubbing) return;
  const t = (e as CustomEvent).detail.currentTime;
  seekBar.value = String(t);
  updateTimeLabel(t);
});

player.addEventListener("ended", () => {
  setPlayingUI(false);
});

setInterval(() => {
  const d = player.getDiagnostics();
  if (d) diag.textContent = JSON.stringify(d, null, 2);
}, 1000);

// ── File picker ──────────────────────────────────────────────────────────

subInput.addEventListener("change", () => {
  const f = subInput.files?.[0];
  if (!f) {
    pendingSub = null;
    return;
  }
  pendingSub = {
    url: URL.createObjectURL(f),
    format: f.name.toLowerCase().endsWith(".srt") ? "srt" : "vtt",
  };
});

fileInput.addEventListener("change", async () => {
  errorEl.textContent = "";
  const file = fileInput.files?.[0];
  if (!file) return;

  // Reset UI for the new source.
  playPauseBtn.disabled = true;
  seekBar.disabled = true;
  seekBar.value = "0";
  seekBar.max = "0";
  duration = 0;
  setPlayingUI(false);
  updateTimeLabel(0);
  strategySwitcher.style.display = "none";
  badge.textContent = "loading…";
  badge.className = "badge";

  try {
    // Setting `source` triggers a fresh bootstrap inside the element.
    // The element's lifecycle handles teardown of any previous player.
    player.source = file;
    setBufferingUI();
    await player.play();
    setPlayingUI(true);
    if (pendingSub) {
      // Subtitle support via the element is post-Phase-A. For now, escape
      // hatch through the underlying player.
      // TODO(phase-b): el.addTextTrack(...)
      const p = player.player;
      if (p) {
        // Attach as native <track> element via the underlying <video> in
        // the shadow root for the demo's purposes.
        console.log("[demo] subtitle handoff is post-Phase-A; ignoring", pendingSub);
      }
    }
  } catch (err) {
    errorEl.textContent = (err as Error).message;
    badge.textContent = "error";
    badge.className = "badge";
    const d = player.getDiagnostics();
    if (d) diag.textContent = JSON.stringify(d, null, 2);
  }
});

// ── Custom controls ──────────────────────────────────────────────────────

playPauseBtn.addEventListener("click", async () => {
  try {
    if (isPlaying) {
      player.pause();
      setPlayingUI(false);
    } else {
      setBufferingUI();
      await player.play();
      setPlayingUI(true);
    }
  } catch (err) {
    errorEl.textContent = (err as Error).message;
  }
});

seekBar.addEventListener("pointerdown", () => { userIsScrubbing = true; });
seekBar.addEventListener("pointerup", () => { userIsScrubbing = false; });
seekBar.addEventListener("input", () => {
  updateTimeLabel(parseFloat(seekBar.value));
});
seekBar.addEventListener("change", async () => {
  const t = parseFloat(seekBar.value);
  try {
    setBufferingUI();
    // Assigning currentTime on the element seeks the underlying player.
    player.currentTime = t;
    if (isPlaying) setPlayingUI(true);
    else setStrategyUI(strategy);
    updateTimeLabel(t);
  } catch (err) {
    errorEl.textContent = (err as Error).message;
  } finally {
    userIsScrubbing = false;
  }
});

window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && document.activeElement?.tagName !== "INPUT") {
    e.preventDefault();
    playPauseBtn.click();
  }
});

// ── Strategy switcher (escape hatch via el.player) ───────────────────────

stratBtns.forEach((btn) => {
  btn.addEventListener("click", async () => {
    const target = btn.dataset.strategy as StrategyName;
    if (target === strategy) return;
    // The component intentionally doesn't expose setStrategy() at the top
    // level — strategy switching is a power-user concern. We use the
    // documented escape hatch: el.player gives full access to the
    // underlying UnifiedPlayer.
    const p = player.player;
    if (!p) return;
    try {
      setBufferingUI();
      await p.setStrategy(target);
      setPlayingUI(isPlaying);
    } catch (err) {
      errorEl.textContent = (err as Error).message;
    }
  });
});
