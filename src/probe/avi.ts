import type {
  AudioCodec,
  AudioTrackInfo,
  ContainerKind,
  MediaContext,
  VideoCodec,
  VideoTrackInfo,
} from "../types.js";
import type { NormalizedSource } from "../util/source.js";
import { loadLibav } from "../strategies/fallback/libav-loader.js";

/**
 * Probe AVI/ASF/FLV (and any other format mediabunny doesn't speak) via
 * libav.js. This module is `import()`-ed only when sniffing identifies one of
 * those containers.
 *
 * Critical: codec identification goes through `libav.avcodec_get_name(id)`
 * which returns the FFmpeg codec name as a string (e.g. "h264", "mpeg4",
 * "wmv3"). The numeric AV_CODEC_ID_* enum is *not* exposed on the libav
 * instance (only AVMEDIA_TYPE_*, AV_PIX_FMT_*, AV_SAMPLE_FMT_* and a handful
 * of others are), so comparing codec_ids against constants does not work.
 */
export async function probeWithLibav(
  source: NormalizedSource,
  sniffed: ContainerKind,
): Promise<MediaContext> {
  // AVI/ASF/FLV demuxers are not in any libav.js npm variant — they live in
  // the custom "ubmp" build produced by `scripts/build-libav.sh`. The loader
  // emits an actionable error if the build hasn't been run yet. Threading
  // is OFF by default in `loadLibav` (see the comment there for why).
  const libav = (await loadLibav("ubmp")) as unknown as LibavInstance;

  const filename = source.name ?? `input.${sniffed === "unknown" ? "bin" : sniffed}`;
  await libav.mkreadaheadfile(filename, source.blob);

  let fmt_ctx: number | undefined;
  let streams: LibavStream[] = [];
  try {
    const result = await libav.ff_init_demuxer_file(filename);
    fmt_ctx = result[0];
    streams = result[1];
  } catch (err) {
    await libav.unlinkreadaheadfile(filename).catch(() => {});
    // Errors thrown across the libav.js worker/pthread boundary aren't
    // always Error instances — they can be plain objects, numbers (errno
    // codes), or strings. Stringify defensively so the user-facing message
    // never has `(undefined)` in it.
    const inner =
      err instanceof Error
        ? err.message
        : typeof err === "object" && err !== null
          ? JSON.stringify(err)
          : String(err);
    // eslint-disable-next-line no-console
    console.error("[ubmp] ff_init_demuxer_file raw error:", err);
    throw new Error(
      `libav.js could not demux ${filename}. The current libav variant likely lacks the required demuxer (e.g. AVI). See vendor/libav/README.md for build instructions. (${inner || "no message — see console for raw error"})`,
    );
  }

  const videoTracks: VideoTrackInfo[] = [];
  const audioTracks: AudioTrackInfo[] = [];

  for (const stream of streams) {
    const codecName = (await safe(() => libav.avcodec_get_name(stream.codec_id))) ?? `unknown(${stream.codec_id})`;
    // codecpar holds width/height/channels/sample_rate/profile/level/extradata
    // for the actual stream. We have to copy it out of WASM memory.
    const codecpar = await safe(() => libav.ff_copyout_codecpar(stream.codecpar));

    if (stream.codec_type === libav.AVMEDIA_TYPE_VIDEO) {
      videoTracks.push({
        id: stream.index,
        codec: ffmpegToUbmpVideo(codecName),
        width: codecpar?.width ?? 0,
        height: codecpar?.height ?? 0,
        fps: framerate(stream),
      });
    } else if (stream.codec_type === libav.AVMEDIA_TYPE_AUDIO) {
      audioTracks.push({
        id: stream.index,
        codec: ffmpegToUbmpAudio(codecName),
        channels: codecpar?.channels ?? codecpar?.ch_layout_nb_channels ?? 0,
        sampleRate: codecpar?.sample_rate ?? 0,
      });
    }
  }

  // We need this duration but cannot reliably get it from the streams alone
  // for AVI; libav.js exposes it via the AVFormatContext duration helper.
  const duration = await safeDuration(libav, fmt_ctx!);

  // Close the demuxer; the strategy will reopen it later if it ends up being
  // chosen. Probing should not pin native resources.
  await libav.avformat_close_input_js(fmt_ctx!).catch(() => {});
  await libav.unlinkreadaheadfile(filename).catch(() => {});

  return {
    source: source.original,
    name: source.name,
    byteLength: source.byteLength,
    container: sniffed === "unknown" ? "unknown" : sniffed,
    videoTracks,
    audioTracks,
    subtitleTracks: [],
    probedBy: "libav",
    duration,
  };
}

function framerate(stream: LibavStream): number | undefined {
  if (typeof stream.avg_frame_rate_num === "number" && stream.avg_frame_rate_den) {
    return stream.avg_frame_rate_num / stream.avg_frame_rate_den;
  }
  if (stream.avg_frame_rate && typeof stream.avg_frame_rate === "object") {
    if (stream.avg_frame_rate.den === 0) return undefined;
    return stream.avg_frame_rate.num / stream.avg_frame_rate.den;
  }
  return undefined;
}

async function safeDuration(libav: LibavInstance, fmt_ctx: number): Promise<number | undefined> {
  try {
    // `AVFormatContext.duration` is an int64 in microseconds (AV_TIME_BASE).
    // libav.js exposes it as a split lo/hi pair the same way it does for
    // packet pts — `AVFormatContext_duration(ctx)` returns the low 32 bits,
    // `AVFormatContext_durationhi(ctx)` returns the high 32 bits. Reading
    // only the low half (the previous bug) gave garbage for any file whose
    // duration > ~35 minutes, and zero for shorter files where the value
    // happened to live in the high half.
    const lo = await libav.AVFormatContext_duration?.(fmt_ctx);
    const hi = await libav.AVFormatContext_durationhi?.(fmt_ctx);
    if (typeof lo !== "number" || typeof hi !== "number") return undefined;

    // AV_NOPTS_VALUE = -2^63 → ptshi = -2147483648, pts = 0. Means "unknown".
    if (hi === -2147483648 && lo === 0) return undefined;

    // Reconstruct the 64-bit value. Prefer libav's helper when available
    // because it correctly handles signed 32-bit two's complement.
    const us =
      typeof libav.i64tof64 === "function"
        ? libav.i64tof64(lo, hi)
        : hi * 0x100000000 + lo + (lo < 0 ? 0x100000000 : 0);

    if (!Number.isFinite(us) || us <= 0) return undefined;
    return us / 1_000_000;
  } catch {
    return undefined;
  }
}

async function safe<T>(fn: () => Promise<T> | T): Promise<T | undefined> {
  try { return await fn(); } catch { return undefined; }
}

/** Map FFmpeg codec names to UBMP video codec identifiers. */
function ffmpegToUbmpVideo(name: string): VideoCodec {
  switch (name) {
    case "h264":   return "h264";
    case "hevc":   return "h265";
    case "vp8":    return "vp8";
    case "vp9":    return "vp9";
    case "av1":    return "av1";
    case "mpeg4":  return "mpeg4";   // MPEG-4 Part 2 / DivX / Xvid
    case "msmpeg4v1":
    case "msmpeg4v2":
    case "msmpeg4v3":                 // a.k.a. DIV3
      return "mpeg4";
    case "wmv1":
    case "wmv2":
    case "wmv3":
      return "wmv3";
    case "vc1":    return "vc1";
    case "mpeg2video": return "mpeg2";
    case "mpeg1video": return "mpeg1";
    case "theora": return "theora";
    case "rv30":
    case "rv40":   return "rv40";
    default:       return name as VideoCodec;
  }
}

function ffmpegToUbmpAudio(name: string): AudioCodec {
  switch (name) {
    case "aac":    return "aac";
    case "mp3":
    case "mp3float":
      return "mp3";
    case "opus":   return "opus";
    case "vorbis": return "vorbis";
    case "flac":   return "flac";
    case "ac3":    return "ac3";
    case "eac3":   return "eac3";
    case "wmav1":
    case "wmav2":  return "wmav2";
    case "wmapro": return "wmapro";
    case "alac":   return "alac";
    default:       return name as AudioCodec;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal structural types for the slice of libav.js we touch.
// ─────────────────────────────────────────────────────────────────────────────

interface LibavStream {
  index: number;
  codec_type: number;
  codec_id: number;
  codecpar: number;
  avg_frame_rate?: { num: number; den: number };
  avg_frame_rate_num?: number;
  avg_frame_rate_den?: number;
}

interface LibavCodecpar {
  width?: number;
  height?: number;
  channels?: number;
  ch_layout_nb_channels?: number;
  sample_rate?: number;
  profile?: number;
  level?: number;
}

interface LibavInstance {
  mkreadaheadfile(name: string, blob: Blob): Promise<void>;
  unlinkreadaheadfile(name: string): Promise<void>;
  ff_init_demuxer_file(name: string): Promise<[number, LibavStream[]]>;
  ff_copyout_codecpar(codecpar: number): Promise<LibavCodecpar>;
  avcodec_get_name(codec_id: number): Promise<string>;
  avformat_close_input_js(ctx: number): Promise<void>;
  AVFormatContext_duration?(ctx: number): Promise<number>;
  AVFormatContext_durationhi?(ctx: number): Promise<number>;
  i64tof64?(lo: number, hi: number): number;

  AVMEDIA_TYPE_VIDEO: number;
  AVMEDIA_TYPE_AUDIO: number;
}
