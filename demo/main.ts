// During dev, the demo imports from the source tree directly. The vite alias
// in `vite.config.ts` rewrites bare `ubmp` imports to the same path; we use
// the relative form here so the TS type-checker (which doesn't read vite
// config) is happy.
import { createPlayer, type UnifiedPlayer } from "../src/index.js";

const fileInput = document.getElementById("file") as HTMLInputElement;
const subInput = document.getElementById("subs") as HTMLInputElement;
const video = document.getElementById("video") as HTMLVideoElement;
const badge = document.getElementById("badge")!;
const diag = document.getElementById("diagnostics")!;
const errorEl = document.getElementById("error")!;

const playPauseBtn = document.getElementById("playPause") as HTMLButtonElement;
const seekBar = document.getElementById("seek") as HTMLInputElement;
const timeLabel = document.getElementById("time")!;

let current: UnifiedPlayer | null = null;
let pendingSub: { url: string; format: "srt" | "vtt" } | null = null;

// State the controls need to know about.
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
  // Restore the strategy badge text/colour. setBufferingUI() temporarily
  // overwrites both, so we have to reset them once playback is actually
  // running (or paused) — otherwise the badge stays stuck on
  // "fallback · buffering…".
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
}

function updateTimeLabel(currentTime: number) {
  timeLabel.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
}

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

  if (current) {
    await current.destroy();
    current = null;
  }

  // Reset controls UI
  playPauseBtn.disabled = true;
  seekBar.disabled = true;
  seekBar.value = "0";
  seekBar.max = "0";
  duration = 0;
  setPlayingUI(false);
  updateTimeLabel(0);

  badge.textContent = "loading…";
  badge.className = "badge";

  try {
    current = await createPlayer({
      source: file,
      target: video,
      subtitles: pendingSub ? [pendingSub] : undefined,
    });

    current.on("strategy", ({ strategy: s, reason }) => {
      setStrategyUI(s);
      console.log("[ubmp] strategy:", s, "—", reason);
    });

    current.on("error", (err) => {
      errorEl.textContent = err.message;
    });

    current.on("ready", () => {
      duration = current!.getDuration();
      if (Number.isFinite(duration) && duration > 0) {
        seekBar.max = String(duration);
        seekBar.disabled = false;
      }
      playPauseBtn.disabled = false;
      diag.textContent = JSON.stringify(current!.getDiagnostics(), null, 2);
      updateTimeLabel(0);
    });

    current.on("timeupdate", ({ currentTime }) => {
      if (!userIsScrubbing) {
        seekBar.value = String(currentTime);
        updateTimeLabel(currentTime);
      }
    });

    current.on("ended", () => {
      setPlayingUI(false);
    });

    setInterval(() => {
      if (current) diag.textContent = JSON.stringify(current.getDiagnostics(), null, 2);
    }, 1000);

    // Auto-play. The file picker change event counts as a user gesture, so
    // browsers will allow audio.
    setBufferingUI();
    await current.play();
    setPlayingUI(true);
  } catch (err) {
    errorEl.textContent = (err as Error).message;
    badge.textContent = "error";
    badge.className = "badge";
    const partial = (err as Error & { player?: UnifiedPlayer }).player;
    if (partial) {
      diag.textContent = JSON.stringify(partial.getDiagnostics(), null, 2);
    }
  }
});

// ── Custom controls ──────────────────────────────────────────────────────

playPauseBtn.addEventListener("click", async () => {
  if (!current) return;
  try {
    if (isPlaying) {
      current.pause();
      setPlayingUI(false);
    } else {
      setBufferingUI();
      await current.play();
      setPlayingUI(true);
    }
  } catch (err) {
    errorEl.textContent = (err as Error).message;
  }
});

// Track when the user is actively scrubbing so timeupdate events don't
// fight the slider position.
seekBar.addEventListener("pointerdown", () => { userIsScrubbing = true; });
seekBar.addEventListener("pointerup",   () => { userIsScrubbing = false; });
seekBar.addEventListener("input", () => {
  // Live preview of the time label as the user drags.
  updateTimeLabel(parseFloat(seekBar.value));
});
seekBar.addEventListener("change", async () => {
  if (!current) return;
  const t = parseFloat(seekBar.value);
  try {
    setBufferingUI();
    await current.seek(t);
    if (isPlaying) setPlayingUI(true);
    else setStrategyUI(strategy);
    updateTimeLabel(t);
  } catch (err) {
    errorEl.textContent = (err as Error).message;
  } finally {
    userIsScrubbing = false;
  }
});

// Spacebar toggles play/pause when the page (not an input) has focus.
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && document.activeElement?.tagName !== "INPUT") {
    e.preventDefault();
    playPauseBtn.click();
  }
});
