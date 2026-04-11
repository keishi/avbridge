// HandBrake-like converter demo. Shows codec dropdowns at all times — picking
// "Copy" for both video and audio means lossless remux; picking specific
// codecs means transcode (re-encode). The effective mode badge updates live.

import {
  probe,
  classify,
  remux,
  transcode,
  type MediaContext,
  type Classification,
  type ConvertResult,
  type OutputFormat,
  type OutputVideoCodec,
  type OutputAudioCodec,
  type TranscodeQuality,
  type HardwareAccelerationHint,
} from "../src/index.js";

// ── DOM refs ────────────────────────────────────────────────────────────

const fileInput = document.getElementById("file") as HTMLInputElement;
const sourceInfo = document.getElementById("source-info") as HTMLPreElement;

const containerSelect = document.getElementById("container") as HTMLSelectElement;
const videoCodecSelect = document.getElementById("video-codec") as HTMLSelectElement;
const audioCodecSelect = document.getElementById("audio-codec") as HTMLSelectElement;
const qualitySelect = document.getElementById("quality") as HTMLSelectElement;
const videoBitrateInput = document.getElementById("video-bitrate") as HTMLInputElement;
const audioBitrateInput = document.getElementById("audio-bitrate") as HTMLInputElement;
const widthInput = document.getElementById("width") as HTMLInputElement;
const heightInput = document.getElementById("height") as HTMLInputElement;
const fpsInput = document.getElementById("fps") as HTMLInputElement;
const hwAccelSelect = document.getElementById("hw-accel") as HTMLSelectElement;

const modeBadge = document.getElementById("mode-badge")!;
const qualityRow = document.getElementById("quality-row")!;
const resizeRow = document.getElementById("resize-row")!;

const startBtn = document.getElementById("start") as HTMLButtonElement;
const cancelBtn = document.getElementById("cancel") as HTMLButtonElement;
const downloadBtn = document.getElementById("download") as HTMLButtonElement;

const progressBar = document.getElementById("progress-bar")!;
const progressLabel = document.getElementById("progress-label")!;
const statusEl = document.getElementById("status")!;
const errorEl = document.getElementById("error")!;
const resultInfo = document.getElementById("result-info")!;

// ── State ───────────────────────────────────────────────────────────────

let currentFile: File | null = null;
let currentContext: MediaContext | null = null;
let currentClassification: Classification | null = null;
let currentResult: ConvertResult | null = null;
let abortController: AbortController | null = null;

type CodecChoice = "copy" | OutputVideoCodec | OutputAudioCodec;

// ── Helpers ─────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(sec: number | undefined): string {
  if (!sec || !Number.isFinite(sec)) return "?";
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const MODERN_CODECS = new Set([
  "h264", "h265", "vp8", "vp9", "av1",
  "aac", "opus", "flac", "mp3", "vorbis",
]);

function isModernCodec(codec: string | undefined): boolean {
  if (!codec) return true;
  return MODERN_CODECS.has(codec);
}

/** True if the source codec can be copied directly into the target container. */
function canCopy(sourceCodec: string | undefined): boolean {
  if (!sourceCodec) return true;
  return isModernCodec(sourceCodec);
}

/** Decide whether the current settings will run as remux or transcode. */
function getEffectiveMode(): "remux" | "transcode" {
  const v = videoCodecSelect.value;
  const a = audioCodecSelect.value;
  return v === "copy" && a === "copy" ? "remux" : "transcode";
}

function setMode(mode: "remux" | "transcode") {
  modeBadge.textContent = mode;
  modeBadge.className = `badge ${mode}`;
  // Quality + resize options only matter for transcode.
  const showTranscodeOptions = mode === "transcode";
  qualityRow.classList.toggle("hidden", !showTranscodeOptions);
  resizeRow.classList.toggle("hidden", !showTranscodeOptions);
}

/** Codecs allowed in each container. "copy" is always permitted. */
const ALLOWED_VIDEO_CODECS: Record<OutputFormat, Set<string>> = {
  mp4:  new Set(["copy", "h264", "h265", "av1"]),
  webm: new Set(["copy", "vp9", "av1"]),
  mkv:  new Set(["copy", "h264", "h265", "vp9", "av1"]),
};
const ALLOWED_AUDIO_CODECS: Record<OutputFormat, Set<string>> = {
  mp4:  new Set(["copy", "aac", "flac"]),
  webm: new Set(["copy", "opus"]),
  mkv:  new Set(["copy", "aac", "opus", "flac"]),
};

function updateContainerCompatibility() {
  const container = containerSelect.value as OutputFormat;
  const allowedV = ALLOWED_VIDEO_CODECS[container];
  const allowedA = ALLOWED_AUDIO_CODECS[container];

  // Hide options that aren't allowed in this container.
  Array.from(videoCodecSelect.options).forEach((o) => {
    o.hidden = !allowedV.has(o.value);
  });
  Array.from(audioCodecSelect.options).forEach((o) => {
    o.hidden = !allowedA.has(o.value);
  });

  // If the current selection is now hidden, fall back to a sensible default.
  if (!allowedV.has(videoCodecSelect.value)) {
    videoCodecSelect.value = container === "webm" ? "vp9" : "h264";
  }
  if (!allowedA.has(audioCodecSelect.value)) {
    audioCodecSelect.value = container === "webm" ? "opus" : "aac";
  }

  setMode(getEffectiveMode());
}

function setProgress(percent: number) {
  const clamped = Math.max(0, Math.min(100, percent));
  progressBar.style.width = `${clamped}%`;
  progressLabel.textContent = `${clamped.toFixed(0)}%`;
}

function setRunning(running: boolean) {
  startBtn.disabled = running || !currentFile;
  cancelBtn.classList.toggle("hidden", !running);
  if (running) {
    downloadBtn.classList.add("hidden");
    errorEl.textContent = "";
  }
}

/**
 * Pick smart defaults for the codec dropdowns based on the source. If the
 * source codec is modern and compatible with the target container, default
 * to "copy" (remux). Otherwise, pick the best modern codec for the container.
 */
function applySmartDefaults() {
  if (!currentContext) return;
  const v = currentContext.videoTracks[0];
  const a = currentContext.audioTracks[0];
  const container = containerSelect.value as OutputFormat;

  if (v && canCopy(v.codec)) {
    // Check if the codec is allowed in the chosen container
    if (container === "webm" && (v.codec === "h264" || v.codec === "h265")) {
      videoCodecSelect.value = "vp9";
    } else {
      videoCodecSelect.value = "copy";
    }
  } else {
    videoCodecSelect.value = container === "webm" ? "vp9" : "h264";
  }

  if (a && canCopy(a.codec)) {
    if (container === "webm" && a.codec !== "opus" && a.codec !== "vorbis") {
      audioCodecSelect.value = "opus";
    } else {
      audioCodecSelect.value = "copy";
    }
  } else {
    audioCodecSelect.value = container === "webm" ? "opus" : "aac";
  }

  setMode(getEffectiveMode());
}

// ── File picker ─────────────────────────────────────────────────────────

fileInput.addEventListener("change", async () => {
  errorEl.textContent = "";
  currentResult = null;
  downloadBtn.classList.add("hidden");
  setProgress(0);

  const f = fileInput.files?.[0];
  if (!f) {
    currentFile = null;
    sourceInfo.classList.add("hidden");
    startBtn.disabled = true;
    return;
  }
  currentFile = f;
  statusEl.textContent = "Probing…";

  try {
    currentContext = await probe(f);
    currentClassification = classify(currentContext);
  } catch (err) {
    errorEl.textContent = `Probe failed: ${(err as Error).message}`;
    statusEl.textContent = "";
    return;
  }

  const v = currentContext.videoTracks[0];
  const a = currentContext.audioTracks[0];
  const lines = [
    `File:      ${f.name}`,
    `Size:      ${formatBytes(f.size)}`,
    `Container: ${currentContext.container}`,
    `Duration:  ${formatDuration(currentContext.duration)}`,
    v ? `Video:     ${v.codec} ${v.width}×${v.height}${v.fps ? ` @ ${v.fps}fps` : ""}` : "Video:     (none)",
    a ? `Audio:     ${a.codec} ${a.channels}ch ${a.sampleRate}Hz` : "Audio:     (none)",
    `Strategy:  ${currentClassification.strategy} — ${currentClassification.reason}`,
  ];
  sourceInfo.textContent = lines.join("\n");
  sourceInfo.classList.remove("hidden");

  applySmartDefaults();
  startBtn.disabled = false;
  statusEl.textContent = "";
});

// ── Codec / container interaction ───────────────────────────────────────

containerSelect.addEventListener("change", updateContainerCompatibility);
videoCodecSelect.addEventListener("change", () => setMode(getEffectiveMode()));
audioCodecSelect.addEventListener("change", () => setMode(getEffectiveMode()));

// Init mode UI on load
setMode("remux");

// ── Conversion ──────────────────────────────────────────────────────────

startBtn.addEventListener("click", async () => {
  if (!currentFile) return;
  errorEl.textContent = "";
  currentResult = null;
  setProgress(0);
  setRunning(true);
  abortController = new AbortController();

  const mode = getEffectiveMode();
  const outputFormat = containerSelect.value as OutputFormat;
  const startTime = performance.now();

  statusEl.textContent = `${mode === "remux" ? "Remuxing" : "Transcoding"} → ${outputFormat.toUpperCase()}…`;

  try {
    let result: ConvertResult;
    if (mode === "remux") {
      result = await remux(currentFile, {
        outputFormat,
        signal: abortController.signal,
        onProgress: ({ percent }) => setProgress(percent),
      });
    } else {
      // For transcode, "copy" on one side means we still re-encode that
      // stream — mediabunny's Conversion can mix encoded passthrough with
      // re-encoded streams via the codec option. We just need to pick a
      // valid codec when the user chose "copy".
      const v = videoCodecSelect.value as CodecChoice;
      const a = audioCodecSelect.value as CodecChoice;
      const sourceVideo = currentContext?.videoTracks[0]?.codec;
      const sourceAudio = currentContext?.audioTracks[0]?.codec;
      const videoBitrateKbps = videoBitrateInput.value ? parseInt(videoBitrateInput.value, 10) : undefined;
      const audioBitrateKbps = audioBitrateInput.value ? parseInt(audioBitrateInput.value, 10) : undefined;
      result = await transcode(currentFile, {
        outputFormat,
        videoCodec: (v === "copy" ? (sourceVideo as OutputVideoCodec) : v) as OutputVideoCodec,
        audioCodec: (a === "copy" ? (sourceAudio as OutputAudioCodec) : a) as OutputAudioCodec,
        quality: qualitySelect.value as TranscodeQuality,
        videoBitrate: videoBitrateKbps ? videoBitrateKbps * 1000 : undefined,
        audioBitrate: audioBitrateKbps ? audioBitrateKbps * 1000 : undefined,
        width: widthInput.value ? parseInt(widthInput.value, 10) : undefined,
        height: heightInput.value ? parseInt(heightInput.value, 10) : undefined,
        frameRate: fpsInput.value ? parseFloat(fpsInput.value) : undefined,
        hardwareAcceleration: hwAccelSelect.value as HardwareAccelerationHint,
        signal: abortController.signal,
        onProgress: ({ percent }) => setProgress(percent),
      });
    }

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
    currentResult = result;
    setProgress(100);
    statusEl.textContent = `Done in ${elapsed}s — ${formatBytes(result.blob.size)}`;
    downloadBtn.classList.remove("hidden");

    resultInfo.textContent = JSON.stringify(
      {
        filename: result.filename,
        mimeType: result.mimeType,
        container: result.container,
        videoCodec: result.videoCodec,
        audioCodec: result.audioCodec,
        duration: result.duration,
        size: formatBytes(result.blob.size),
        elapsedSec: parseFloat(elapsed),
        notes: result.notes,
      },
      null,
      2,
    );
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError" || e.message?.includes("canceled")) {
      statusEl.textContent = "Cancelled.";
    } else {
      errorEl.textContent = e.message;
      statusEl.textContent = "Failed.";
    }
  } finally {
    setRunning(false);
    abortController = null;
  }
});

cancelBtn.addEventListener("click", () => {
  abortController?.abort();
});

downloadBtn.addEventListener("click", () => {
  if (!currentResult) return;
  const url = URL.createObjectURL(currentResult.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = currentResult.filename ?? "output";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
