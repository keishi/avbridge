/**
 * Standalone remux function: repackage media into a modern container without
 * re-encoding. Input can be any format avbridge can probe; output is a
 * finalized downloadable file (MP4, WebM, or MKV).
 *
 * Two internal paths:
 * - **Path A** (mediabunny-readable containers): wraps mediabunny's Conversion
 *   class for MP4/MKV/WebM/OGG/MOV/WAV/MP3/FLAC/ADTS sources.
 * - **Path B** (AVI/ASF/FLV): libav.js demux + mediabunny mux via manual
 *   packet pump. Lazy-loads libav.js — zero cost if unused.
 */

import { probe } from "../probe/index.js";
import {
  avbridgeVideoToMediabunny,
  avbridgeAudioToMediabunny,
  buildMediabunnySourceFromInput,
} from "../probe/mediabunny.js";
import { normalizeSource } from "../util/source.js";
import { prepareLibavInput, type LibavInputHandle } from "../util/libav-http-reader.js";
import type {
  MediaInput,
  MediaContext,
  ConvertOptions,
  ConvertResult,
  OutputFormat,
} from "../types.js";

/** Containers mediabunny can read (and therefore use Conversion for). */
const MEDIABUNNY_CONTAINERS = new Set([
  "mp4", "mov", "mkv", "webm", "ogg", "wav", "mp3", "flac", "adts",
]);

/**
 * Remux a media source into a modern container format without re-encoding.
 *
 * @throws When the source codecs cannot be remuxed (e.g. WMV3 — use `transcode()` instead).
 * @throws When an AVI/ASF/FLV source is provided but libav.js is not installed.
 */
export async function remux(
  source: MediaInput,
  options: ConvertOptions = {},
): Promise<ConvertResult> {
  const outputFormat = options.outputFormat ?? "mp4";
  options.signal?.throwIfAborted();

  // Probe the source
  const ctx = await probe(source);
  options.signal?.throwIfAborted();

  // Validate remux eligibility: all codecs must map to mediabunny output codecs
  validateRemuxEligibility(ctx, options.strict ?? false);

  // Route to the appropriate path
  if (MEDIABUNNY_CONTAINERS.has(ctx.container)) {
    return remuxViaMediAbunny(ctx, outputFormat, options);
  }
  return remuxViaLibav(ctx, outputFormat, options);
}

// ── Eligibility validation ──────────────────────────────────────────────────

/** @internal Exported for testing. */
export function validateRemuxEligibility(ctx: MediaContext, strict: boolean): void {
  const video = ctx.videoTracks[0];
  const audio = ctx.audioTracks[0];

  if (video) {
    const mbCodec = avbridgeVideoToMediabunny(video.codec);
    if (!mbCodec) {
      throw new Error(
        `Cannot remux: video codec "${video.codec}" is not supported for remuxing. ` +
        `Use transcode() to re-encode to a modern codec.`,
      );
    }
  }

  if (audio) {
    const mbCodec = avbridgeAudioToMediabunny(audio.codec);
    if (!mbCodec) {
      throw new Error(
        `Cannot remux: audio codec "${audio.codec}" is not supported for remuxing. ` +
        `Use transcode() to re-encode to a modern codec.`,
      );
    }
  }

  if (strict && video?.codec === "h264" && audio?.codec === "mp3") {
    throw new Error(
      `Cannot remux in strict mode: H.264 + MP3 is a best-effort combination ` +
      `that may produce playback issues in some browsers. ` +
      `Set strict: false to allow, or use transcode() to re-encode audio to AAC.`,
    );
  }

  if (!video && !audio) {
    throw new Error("Cannot remux: source has no video or audio tracks.");
  }
}

// ── Path A: mediabunny Conversion ───────────────────────────────────────────

async function remuxViaMediAbunny(
  ctx: MediaContext,
  outputFormat: OutputFormat,
  options: ConvertOptions,
): Promise<ConvertResult> {
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

  const conversion = await mb.Conversion.init({
    input,
    output,
    showWarnings: false,
  });

  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks
      .map((d) => `${d.track.type} track discarded: ${d.reason}`)
      .join("; ");
    throw new Error(`Cannot remux: mediabunny rejected the conversion. ${reasons}`);
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
    throw new Error("Remux failed: mediabunny produced no output buffer.");
  }

  const mimeType = mimeForFormat(outputFormat);
  const blob = new Blob([target.buffer], { type: mimeType });
  const filename = generateFilename(ctx.name, outputFormat);

  options.onProgress?.({ percent: 100, bytesWritten: blob.size });

  return {
    blob,
    mimeType,
    container: outputFormat,
    videoCodec: ctx.videoTracks[0]?.codec,
    audioCodec: ctx.audioTracks[0]?.codec,
    duration: ctx.duration,
    filename,
  };
}

// ── Path B: libav.js demux + mediabunny mux (AVI/ASF/FLV) ──────────────────

async function remuxViaLibav(
  ctx: MediaContext,
  outputFormat: OutputFormat,
  options: ConvertOptions,
): Promise<ConvertResult> {
  // Lazy-load libav
  let loadLibav: typeof import("../strategies/fallback/libav-loader.js").loadLibav;
  let pickLibavVariant: typeof import("../strategies/fallback/variant-routing.js").pickLibavVariant;
  try {
    const loader = await import("../strategies/fallback/libav-loader.js");
    const routing = await import("../strategies/fallback/variant-routing.js");
    loadLibav = loader.loadLibav;
    pickLibavVariant = routing.pickLibavVariant;
  } catch {
    throw new Error(
      `Cannot remux ${ctx.container.toUpperCase()} source: libav.js is not available. ` +
      `Install @libav.js/variant-webcodecs and libavjs-webcodecs-bridge, ` +
      `or build the custom avbridge variant with scripts/build-libav.sh.`,
    );
  }

  const variant = pickLibavVariant(ctx);
  const libav = await loadLibav(variant) as unknown as LibavRuntime;

  // For Blob/File inputs, libav reads from an in-memory readahead file.
  // For URL inputs, libav demuxes via HTTP Range requests through the
  // block reader — no full download.
  const normalized = await normalizeSource(ctx.source);
  const filename = ctx.name ?? `remux-input-${Date.now()}`;
  const handle: LibavInputHandle = await prepareLibavInput(libav as unknown as Parameters<typeof prepareLibavInput>[0], filename, normalized);

  try {
    return await doLibavRemux(libav, filename, ctx, outputFormat, options);
  } finally {
    await handle.detach().catch(() => {});
  }
}

async function doLibavRemux(
  libav: LibavRuntime,
  filename: string,
  ctx: MediaContext,
  outputFormat: OutputFormat,
  options: ConvertOptions,
): Promise<ConvertResult> {
  const mb = await import("mediabunny");

  const readPkt = await libav.av_packet_alloc();
  const [fmt_ctx, streams] = await libav.ff_init_demuxer_file(filename);
  const videoStream = streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_VIDEO) ?? null;
  const audioStream = streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_AUDIO) ?? null;

  // Map codecs to mediabunny output
  const videoTrackInfo = ctx.videoTracks[0];
  const audioTrackInfo = ctx.audioTracks[0];
  const mbVideoCodec = videoTrackInfo ? avbridgeVideoToMediabunny(videoTrackInfo.codec) : null;
  const mbAudioCodec = audioTrackInfo ? avbridgeAudioToMediabunny(audioTrackInfo.codec) : null;

  // Set up mediabunny output with BufferTarget
  const target = new mb.BufferTarget();
  const output = new mb.Output({
    format: createOutputFormat(mb, outputFormat),
    target,
  });

  let videoSource: InstanceType<typeof mb.EncodedVideoPacketSource> | null = null;
  let audioSource: InstanceType<typeof mb.EncodedAudioPacketSource> | null = null;

  if (mbVideoCodec && videoStream) {
    videoSource = new mb.EncodedVideoPacketSource(mbVideoCodec);
    output.addVideoTrack(videoSource);
  }
  if (mbAudioCodec && audioStream) {
    type AudioCodecArg = ConstructorParameters<typeof mb.EncodedAudioPacketSource>[0];
    audioSource = new mb.EncodedAudioPacketSource(mbAudioCodec as AudioCodecArg);
    output.addAudioTrack(audioSource);
  }

  await output.start();

  // Timestamp tracking for synthetic timestamps
  const videoFps = videoTrackInfo?.fps && videoTrackInfo.fps > 0 ? videoTrackInfo.fps : 30;
  const videoFrameStepUs = Math.max(1, Math.round(1_000_000 / videoFps));
  let syntheticVideoUs = 0;
  let syntheticAudioUs = 0;

  const videoTimeBase: [number, number] | undefined =
    videoStream?.time_base_num && videoStream?.time_base_den
      ? [videoStream.time_base_num, videoStream.time_base_den]
      : undefined;
  const audioTimeBase: [number, number] | undefined =
    audioStream?.time_base_num && audioStream?.time_base_den
      ? [audioStream.time_base_num, audioStream.time_base_den]
      : undefined;

  let totalPackets = 0;
  const durationUs = ctx.duration ? ctx.duration * 1_000_000 : 0;
  let firstVideoMeta = true;
  let firstAudioMeta = true;

  // Pump loop: read packets from libav, feed to mediabunny output
  while (true) {
    options.signal?.throwIfAborted();

    let readErr: number;
    let packets: Record<number, LibavPacket[]>;
    try {
      [readErr, packets] = await libav.ff_read_frame_multi(fmt_ctx, readPkt, {
        limit: 64 * 1024,
      });
    } catch (err) {
      throw new Error(`libav demux failed: ${(err as Error).message}`);
    }

    const videoPackets = videoStream ? packets[videoStream.index] ?? [] : [];
    const audioPackets = audioStream ? packets[audioStream.index] ?? [] : [];

    // Feed video packets
    if (videoSource) {
      for (const pkt of videoPackets) {
        sanitizePacketTimestamp(pkt, () => {
          const ts = syntheticVideoUs;
          syntheticVideoUs += videoFrameStepUs;
          return ts;
        }, videoTimeBase);

        const mbPacket = libavPacketToMediAbunny(mb, pkt);
        await videoSource.add(
          mbPacket,
          firstVideoMeta ? { decoderConfig: buildVideoDecoderConfig(videoTrackInfo!) } : undefined,
        );
        firstVideoMeta = false;
      }
    }

    // Feed audio packets
    if (audioSource) {
      for (const pkt of audioPackets) {
        sanitizePacketTimestamp(pkt, () => {
          const ts = syntheticAudioUs;
          const sampleRate = audioTrackInfo?.sampleRate ?? 44100;
          syntheticAudioUs += Math.round(1024 * 1_000_000 / sampleRate);
          return ts;
        }, audioTimeBase);

        const mbPacket = libavPacketToMediAbunny(mb, pkt);
        await audioSource.add(
          mbPacket,
          firstAudioMeta ? { decoderConfig: buildAudioDecoderConfig(audioTrackInfo!) } : undefined,
        );
        firstAudioMeta = false;
      }
    }

    totalPackets += videoPackets.length + audioPackets.length;

    // Report progress
    if (options.onProgress && durationUs > 0) {
      const lastVideoTs = videoPackets.length > 0 ? videoPackets[videoPackets.length - 1].pts ?? 0 : 0;
      const lastAudioTs = audioPackets.length > 0 ? audioPackets[audioPackets.length - 1].pts ?? 0 : 0;
      const currentUs = Math.max(lastVideoTs, lastAudioTs);
      const percent = Math.min(99, (currentUs / durationUs) * 100);
      options.onProgress({ percent, bytesWritten: 0 });
    }

    if (readErr === libav.AVERROR_EOF) break;
    if (readErr && readErr !== 0 && readErr !== -libav.EAGAIN) {
      console.warn("[avbridge] remux: ff_read_frame_multi returned", readErr);
      break;
    }
  }

  await output.finalize();

  // Cleanup libav resources
  try { await libav.av_packet_free?.(readPkt); } catch { /* ignore */ }
  try { await libav.avformat_close_input_js(fmt_ctx); } catch { /* ignore */ }

  if (!target.buffer) {
    throw new Error("Remux failed: mediabunny produced no output buffer.");
  }

  const mimeType = mimeForFormat(outputFormat);
  const blob = new Blob([target.buffer], { type: mimeType });
  const outputFilename = generateFilename(ctx.name, outputFormat);

  options.onProgress?.({ percent: 100, bytesWritten: blob.size });

  return {
    blob,
    mimeType,
    container: outputFormat,
    videoCodec: videoTrackInfo?.codec,
    audioCodec: audioTrackInfo?.codec,
    duration: ctx.duration,
    filename: outputFilename,
  };
}

// ── Packet timestamp sanitizer (from hybrid/decoder.ts) ─────────────────────

function sanitizePacketTimestamp(
  pkt: LibavPacket,
  nextUs: () => number,
  fallbackTimeBase?: [number, number],
): void {
  const lo = pkt.pts ?? 0;
  const hi = pkt.ptshi ?? 0;
  const isInvalid = (hi === -2147483648 && lo === 0) || !Number.isFinite(lo);
  if (isInvalid) {
    const us = nextUs();
    pkt.pts = us;
    pkt.ptshi = 0;
    pkt.time_base_num = 1;
    pkt.time_base_den = 1_000_000;
    return;
  }
  const tb = fallbackTimeBase ?? [1, 1_000_000];
  const pts64 = hi * 0x100000000 + lo;
  const us = Math.round((pts64 * 1_000_000 * tb[0]) / tb[1]);
  if (Number.isFinite(us) && Math.abs(us) <= Number.MAX_SAFE_INTEGER) {
    pkt.pts = us;
    pkt.ptshi = us < 0 ? -1 : 0;
    pkt.time_base_num = 1;
    pkt.time_base_den = 1_000_000;
    return;
  }
  const fallback = nextUs();
  pkt.pts = fallback;
  pkt.ptshi = 0;
  pkt.time_base_num = 1;
  pkt.time_base_den = 1_000_000;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** @internal Exported for use by transcode(). */
export function createOutputFormat(
  mb: typeof import("mediabunny"),
  format: OutputFormat,
) {
  switch (format) {
    case "mp4": return new mb.Mp4OutputFormat({ fastStart: "in-memory" });
    case "webm": return new mb.WebMOutputFormat();
    case "mkv": return new mb.MkvOutputFormat();
    default: return new mb.Mp4OutputFormat({ fastStart: "in-memory" });
  }
}

/** @internal Exported for testing. */
export function mimeForFormat(format: OutputFormat): string {
  switch (format) {
    case "mp4":  return "video/mp4";
    case "webm": return "video/webm";
    case "mkv":  return "video/x-matroska";
    default:     return "application/octet-stream";
  }
}

/** @internal Exported for testing. */
export function generateFilename(originalName: string | undefined, format: OutputFormat): string {
  const ext = format === "mkv" ? "mkv" : format;
  if (!originalName) return `output.${ext}`;
  const base = originalName.replace(/\.[^.]+$/, "");
  return `${base}.${ext}`;
}

/** Sequence counter for decode-order numbering in mediabunny packets. */
let _seqCounter = 0;

/**
 * Convert a libav packet to a mediabunny EncodedPacket.
 * Timestamps from libav are in microseconds (after sanitization); mediabunny wants seconds.
 */
function libavPacketToMediAbunny(
  mb: typeof import("mediabunny"),
  pkt: LibavPacket,
): InstanceType<typeof mb.EncodedPacket> {
  const KEY_FRAME_FLAG = 0x0001;
  const timestampSec = (pkt.pts ?? 0) / 1_000_000;
  const durationSec = (pkt.duration ?? 0) / 1_000_000;
  const type = (pkt.flags & KEY_FRAME_FLAG) ? "key" as const : "delta" as const;
  return new mb.EncodedPacket(pkt.data, type, timestampSec, durationSec, _seqCounter++);
}

function buildVideoDecoderConfig(track: { codec: string; width: number; height: number; codecString?: string }) {
  return {
    codec: track.codecString ?? track.codec,
    codedWidth: track.width,
    codedHeight: track.height,
  };
}

function buildAudioDecoderConfig(track: { codec: string; channels: number; sampleRate: number; codecString?: string }) {
  return {
    codec: track.codecString ?? track.codec,
    numberOfChannels: track.channels,
    sampleRate: track.sampleRate,
  };
}

// ── Structural types ────────────────────────────────────────────────────────

interface LibavPacket {
  data: Uint8Array;
  pts: number;
  ptshi?: number;
  duration?: number;
  durationhi?: number;
  flags: number;
  stream_index: number;
  time_base_num?: number;
  time_base_den?: number;
}

interface LibavStream {
  index: number;
  codec_type: number;
  codec_id: number;
  codecpar: number;
  time_base_num?: number;
  time_base_den?: number;
}

interface LibavRuntime {
  AVMEDIA_TYPE_VIDEO: number;
  AVMEDIA_TYPE_AUDIO: number;
  AVERROR_EOF: number;
  EAGAIN: number;

  mkreadaheadfile(name: string, blob: Blob): Promise<void>;
  unlinkreadaheadfile(name: string): Promise<void>;
  ff_init_demuxer_file(name: string): Promise<[number, LibavStream[]]>;
  ff_read_frame_multi(
    fmt_ctx: number,
    pkt: number,
    opts?: { limit?: number },
  ): Promise<[number, Record<number, LibavPacket[]>]>;
  av_packet_alloc(): Promise<number>;
  av_packet_free?(pkt: number): Promise<void>;
  avformat_close_input_js(ctx: number): Promise<void>;
}
