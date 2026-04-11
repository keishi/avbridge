/**
 * Standalone transcode function: re-encode media into a modern container with
 * modern codecs. Unlike {@link remux}, this is a lossy operation that decodes
 * and re-encodes the streams.
 *
 * Built on top of mediabunny's `Conversion` class which handles the full
 * decode → encode → mux pipeline. WebCodecs encoders are used when available;
 * mediabunny falls back to other paths internally.
 *
 * Limitations in v1:
 * - Input must be in a mediabunny-readable container (MP4, MKV, WebM, OGG, ...).
 *   AVI/ASF/FLV sources are not yet supported by transcode (use remux + native
 *   playback or wait for v1.1).
 */

import { probe } from "../probe/index.js";
import { buildMediabunnySourceFromInput } from "../probe/mediabunny.js";
import { createOutputFormat, mimeForFormat, generateFilename } from "./remux.js";
import type {
  MediaInput,
  MediaContext,
  TranscodeOptions,
  ConvertResult,
  OutputFormat,
  OutputVideoCodec,
  OutputAudioCodec,
  TranscodeQuality,
} from "../types.js";

/** Containers mediabunny can demux. AVI/ASF/FLV are not in this set. */
const MEDIABUNNY_CONTAINERS = new Set([
  "mp4", "mov", "mkv", "webm", "ogg", "wav", "mp3", "flac", "adts",
]);

/**
 * Transcode a media source into a modern container with modern codecs.
 *
 * Re-encodes both video and audio. Use {@link remux} instead when the source
 * codecs are already modern and only the container needs changing — it's much
 * faster and lossless.
 */
export async function transcode(
  source: MediaInput,
  options: TranscodeOptions = {},
): Promise<ConvertResult> {
  const outputFormat: OutputFormat = options.outputFormat ?? "mp4";
  const videoCodec = options.videoCodec ?? defaultVideoCodec(outputFormat);
  const audioCodec = options.audioCodec ?? defaultAudioCodec(outputFormat);
  const quality = options.quality ?? "medium";

  validateCodecCompatibility(outputFormat, videoCodec, audioCodec);
  options.signal?.throwIfAborted();

  const ctx = await probe(source);
  options.signal?.throwIfAborted();

  if (!MEDIABUNNY_CONTAINERS.has(ctx.container)) {
    throw new Error(
      `Cannot transcode "${ctx.container}" sources in v1. ` +
      `transcode() only supports inputs that mediabunny can read (MP4, MKV, WebM, OGG, MP3, FLAC, WAV, MOV). ` +
      `For AVI/ASF/FLV sources, use the player's playback strategies instead.`,
    );
  }

  return doTranscode(ctx, outputFormat, videoCodec, audioCodec, quality, options);
}

/**
 * One attempt at the full mediabunny conversion. Each attempt allocates
 * fresh `Input` / `Output` / `Conversion` instances because they are all
 * single-use in mediabunny.
 *
 * Returns the muxed `ArrayBuffer` on success. Throws on failure.
 */
async function attemptTranscode(
  ctx: MediaContext,
  outputFormat: OutputFormat,
  videoCodec: OutputVideoCodec,
  audioCodec: OutputAudioCodec,
  quality: TranscodeQuality,
  options: TranscodeOptions,
): Promise<ArrayBuffer> {
  const mb = await import("mediabunny");

  const input = new mb.Input({
    source: await buildMediabunnySourceFromInput(mb, ctx.source),
    formats: mb.ALL_FORMATS,
  });

  const target = new mb.BufferTarget();
  const output = new mb.Output({
    format: createOutputFormat(mb, outputFormat),
    target,
  });

  // Build mediabunny ConversionVideoOptions
  const videoOptions = options.dropVideo
    ? { discard: true as const }
    : {
        codec: avbridgeVideoToMediabunny(videoCodec),
        bitrate: options.videoBitrate ?? qualityToMediabunny(mb, quality),
        forceTranscode: true,
        ...(options.width !== undefined ? { width: options.width } : {}),
        ...(options.height !== undefined ? { height: options.height } : {}),
        ...(options.width !== undefined && options.height !== undefined
          ? { fit: "contain" as const }
          : {}),
        ...(options.frameRate !== undefined ? { frameRate: options.frameRate } : {}),
        ...(options.hardwareAcceleration !== undefined
          ? { hardwareAcceleration: options.hardwareAcceleration }
          : {}),
      };

  const audioOptions = options.dropAudio
    ? { discard: true as const }
    : {
        codec: avbridgeAudioToMediabunny(audioCodec),
        bitrate: options.audioBitrate ?? qualityToMediabunny(mb, quality),
        forceTranscode: true,
      };

  const conversion = await mb.Conversion.init({
    input,
    output,
    video: videoOptions,
    audio: audioOptions,
    showWarnings: false,
  });

  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks
      .map((d) => `${d.track.type} track discarded: ${d.reason}`)
      .join("; ");
    throw new Error(
      `Cannot transcode: mediabunny rejected the conversion. ${reasons || "(no reason given)"}`,
    );
  }

  // Wire progress
  if (options.onProgress) {
    const onProgress = options.onProgress;
    conversion.onProgress = (p) => {
      onProgress({ percent: p * 100, bytesWritten: 0 });
    };
  }

  // Wire cancellation
  let abortHandler: (() => void) | undefined;
  if (options.signal) {
    options.signal.throwIfAborted();
    abortHandler = () => void conversion.cancel();
    options.signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    await conversion.execute();
  } finally {
    if (abortHandler && options.signal) {
      options.signal.removeEventListener("abort", abortHandler);
    }
  }

  if (!target.buffer) {
    throw new Error("Transcode failed: mediabunny produced no output buffer.");
  }
  return target.buffer;
}

/**
 * Detect the "Encoding error" failure pattern that headless Chromium's
 * H.264 WebCodecs encoder hits on its first call per page. The encoder
 * is fully usable on the second attempt, so we retry once.
 *
 * See <https://issues.chromium.org/> — this is a known first-call init
 * issue in the OS-backed encoder pipeline (VideoToolbox on macOS).
 */
function isLikelyEncoderInitError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  // The exact strings WebCodecs / mediabunny surface for encoder failures.
  return (
    lower.includes("encoding error") ||
    lower.includes("encoder") ||
    lower.includes("encode failed")
  );
}

function describeError(err: unknown): string {
  if (!err) return "(unknown)";
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Maximum encoder retry attempts. Headless Chromium's H.264 WebCodecs
 * encoder hits a first-call init failure and *usually* recovers on the
 * second attempt — but in rare cases the second attempt also fails. Two
 * extra attempts (3 total) is enough to make the smoke test reliable
 * without masking real bugs.
 */
const MAX_ENCODER_RETRIES = 2;

async function doTranscode(
  ctx: MediaContext,
  outputFormat: OutputFormat,
  videoCodec: OutputVideoCodec,
  audioCodec: OutputAudioCodec,
  quality: TranscodeQuality,
  options: TranscodeOptions,
): Promise<ConvertResult> {
  const notes: string[] = [];
  let buffer: ArrayBuffer | null = null;
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_ENCODER_RETRIES; attempt++) {
    try {
      buffer = await attemptTranscode(ctx, outputFormat, videoCodec, audioCodec, quality, options);
      if (attempt > 0) {
        notes.push(
          `Encoder failed ${attempt} time${attempt === 1 ? "" : "s"} before succeeding ` +
          `(known headless Chromium WebCodecs encoder init issue): ${describeError(lastError)}`,
        );
      }
      break;
    } catch (err) {
      lastError = err;
      // Don't retry on user cancellation or permanent setup errors.
      if (options.signal?.aborted) throw err;
      if (!isLikelyEncoderInitError(err)) throw err;
      if (attempt === MAX_ENCODER_RETRIES) throw err;
      // Small backoff between attempts.
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }

  if (!buffer) {
    throw new Error("Transcode failed: no buffer produced (this should be unreachable).");
  }

  const mimeType = mimeForFormat(outputFormat);
  const blob = new Blob([buffer], { type: mimeType });
  const filename = generateFilename(ctx.name, outputFormat);

  options.onProgress?.({ percent: 100, bytesWritten: blob.size });

  return {
    blob,
    mimeType,
    container: outputFormat,
    videoCodec: options.dropVideo ? undefined : videoCodec,
    audioCodec: options.dropAudio ? undefined : audioCodec,
    duration: ctx.duration,
    filename,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** @internal Exported for testing. */
export function defaultVideoCodec(format: OutputFormat): OutputVideoCodec {
  switch (format) {
    case "webm": return "vp9";
    case "mp4":
    case "mkv":
    default:     return "h264";
  }
}

/** @internal Exported for testing. */
export function defaultAudioCodec(format: OutputFormat): OutputAudioCodec {
  switch (format) {
    case "webm": return "opus";
    case "mp4":
    case "mkv":
    default:     return "aac";
  }
}

/** @internal Exported for testing. */
export function validateCodecCompatibility(
  format: OutputFormat,
  videoCodec: OutputVideoCodec,
  audioCodec: OutputAudioCodec,
): void {
  // WebM only allows VP8/VP9/AV1 video and Opus/Vorbis audio.
  if (format === "webm") {
    if (videoCodec !== "vp9" && videoCodec !== "av1") {
      throw new Error(
        `WebM does not support video codec "${videoCodec}". Use "vp9" or "av1", or change outputFormat to "mp4" or "mkv".`,
      );
    }
    if (audioCodec !== "opus") {
      throw new Error(
        `WebM does not support audio codec "${audioCodec}". Use "opus", or change outputFormat to "mp4" or "mkv".`,
      );
    }
  }
}

function avbridgeVideoToMediabunny(c: OutputVideoCodec): "avc" | "hevc" | "vp9" | "av1" {
  switch (c) {
    case "h264": return "avc";
    case "h265": return "hevc";
    case "vp9":  return "vp9";
    case "av1":  return "av1";
  }
}

function avbridgeAudioToMediabunny(c: OutputAudioCodec): "aac" | "opus" | "flac" {
  switch (c) {
    case "aac":  return "aac";
    case "opus": return "opus";
    case "flac": return "flac";
  }
}

function qualityToMediabunny(
  mb: typeof import("mediabunny"),
  quality: TranscodeQuality,
): InstanceType<typeof mb.Quality> {
  switch (quality) {
    case "low":       return mb.QUALITY_LOW;
    case "medium":    return mb.QUALITY_MEDIUM;
    case "high":      return mb.QUALITY_HIGH;
    case "very-high": return mb.QUALITY_VERY_HIGH;
  }
}
