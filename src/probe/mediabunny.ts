import type {
  AudioCodec,
  AudioTrackInfo,
  ContainerKind,
  MediaContext,
  VideoCodec,
  VideoTrackInfo,
} from "../types.js";
import type { NormalizedSource } from "../util/source.js";

/**
 * Probe via mediabunny. Built against the real (typed) API exported by
 * `mediabunny.d.ts`:
 *
 * - `Input.getTracks()` returns `InputTrack[]`; each track has `isVideoTrack()`
 *   / `isAudioTrack()` type guards plus a `codec` getter that returns one of
 *   the enum strings (`"avc"|"hevc"|"vp9"|"vp8"|"av1"` for video,
 *   `"aac"|"opus"|...` for audio).
 * - For decoder metadata + codec parameter strings we call
 *   `getDecoderConfig()` and `getCodecParameterString()` on the typed track.
 *
 * The bridging back to avbridge's own codec naming (`h264` instead of mediabunny's
 * `avc`) happens here so the rest of the codebase keeps a single vocabulary.
 */
export async function probeWithMediabunny(
  source: NormalizedSource,
  sniffedContainer: ContainerKind,
): Promise<MediaContext> {
  const mb = await import("mediabunny");
  const input = new mb.Input({
    source: await buildMediabunnySource(mb, source),
    formats: mb.ALL_FORMATS,
  });

  const allTracks = await input.getTracks();
  const duration = await safeNumber(() => input.computeDuration());

  const videoTracks: VideoTrackInfo[] = [];
  const audioTracks: AudioTrackInfo[] = [];

  for (const track of allTracks) {
    if (track.isVideoTrack()) {
      const codecParam = await safe(() => track.getCodecParameterString());
      videoTracks.push({
        id: track.id,
        codec: mediabunnyVideoToAvbridge(track.codec),
        width: track.displayWidth ?? track.codedWidth ?? 0,
        height: track.displayHeight ?? track.codedHeight ?? 0,
        codecString: codecParam ?? undefined,
      });
    } else if (track.isAudioTrack()) {
      const codecParam = await safe(() => track.getCodecParameterString());
      audioTracks.push({
        id: track.id,
        codec: mediabunnyAudioToAvbridge(track.codec),
        channels: track.numberOfChannels ?? 0,
        sampleRate: track.sampleRate ?? 0,
        language: track.languageCode,
        codecString: codecParam ?? undefined,
      });
    }
  }

  const format = await safe(() => input.getFormat());
  const container = resolveContainer(format?.name, sniffedContainer);

  return {
    source: source.original,
    name: source.name,
    byteLength: source.byteLength,
    container,
    videoTracks,
    audioTracks,
    subtitleTracks: [],
    probedBy: "mediabunny",
    duration,
  };
}

/**
 * Build the right mediabunny `Source` for a normalized input. URL sources
 * use `UrlSource` (Range requests, prefetch, parallelism) so we don't
 * buffer the whole file into memory. Blob/File sources use `BlobSource`.
 *
 * Exported so the remux strategy can use the same routing logic.
 */
export async function buildMediabunnySource(
  mb: typeof import("mediabunny"),
  source: NormalizedSource,
): Promise<InstanceType<typeof mb.BlobSource> | InstanceType<typeof mb.UrlSource>> {
  if (source.kind === "url") {
    return new mb.UrlSource(source.url);
  }
  return new mb.BlobSource(source.blob);
}

/**
 * Build a mediabunny `Source` directly from a raw `MediaInput`, bypassing
 * `normalizeSource`. Used by strategies that already have the original
 * input on hand (via `MediaContext.source`) and don't need a sniff window.
 *
 * This is the routing point that decides "stream from URL via Range
 * requests" vs "wrap in-memory bytes as BlobSource". Always prefer
 * `UrlSource` for URL inputs so we don't accidentally buffer the file.
 */
export async function buildMediabunnySourceFromInput(
  mb: typeof import("mediabunny"),
  source: import("../types.js").MediaInput,
): Promise<InstanceType<typeof mb.BlobSource> | InstanceType<typeof mb.UrlSource>> {
  if (typeof source === "string") return new mb.UrlSource(source);
  if (source instanceof URL) return new mb.UrlSource(source.toString());
  if (source instanceof Blob) return new mb.BlobSource(source);
  if (source instanceof ArrayBuffer) return new mb.BlobSource(new Blob([source]));
  if (source instanceof Uint8Array) return new mb.BlobSource(new Blob([source as BlobPart]));
  throw new TypeError("unsupported source type for mediabunny");
}

function resolveContainer(formatName: string | undefined, sniffed: ContainerKind): ContainerKind {
  const name = (formatName ?? "").toLowerCase();
  if (name.includes("matroska") || name.includes("mkv")) return "mkv";
  if (name.includes("webm")) return "webm";
  if (name.includes("mp4") || name.includes("isom")) return "mp4";
  if (name.includes("mov") || name.includes("quicktime")) return "mov";
  if (name.includes("ogg")) return "ogg";
  if (name.includes("wav")) return "wav";
  if (name.includes("flac")) return "flac";
  if (name.includes("mp3")) return "mp3";
  if (name.includes("adts") || name.includes("aac")) return "adts";
  if (name.includes("mpegts") || name.includes("mpeg-ts") || name.includes("transport")) return "mpegts";
  return sniffed;
}

/** Mediabunny video codec → avbridge video codec. */
export function mediabunnyVideoToAvbridge(c: string | null | undefined): VideoCodec {
  switch (c) {
    case "avc":  return "h264";
    case "hevc": return "h265";
    case "vp8":  return "vp8";
    case "vp9":  return "vp9";
    case "av1":  return "av1";
    default:
      // Preserve the original codec string when mediabunny gave us something
      // we don't recognize. The classifier checks `NATIVE_VIDEO_CODECS.has()`
      // and routes anything outside that set through the fallback chain — so
      // returning the unknown name (instead of silently relabeling it as
      // "h264") gets correct routing AND honest diagnostics.
      return c ? (c as VideoCodec) : "unknown";
  }
}

/** avbridge video codec → mediabunny video codec (for output sources). */
export function avbridgeVideoToMediabunny(c: VideoCodec): "avc" | "hevc" | "vp9" | "vp8" | "av1" | null {
  switch (c) {
    case "h264": return "avc";
    case "h265": return "hevc";
    case "vp8":  return "vp8";
    case "vp9":  return "vp9";
    case "av1":  return "av1";
    default:     return null;
  }
}

export function mediabunnyAudioToAvbridge(c: string | null | undefined): AudioCodec {
  switch (c) {
    case "aac":    return "aac";
    case "mp3":    return "mp3";
    case "opus":   return "opus";
    case "vorbis": return "vorbis";
    case "flac":   return "flac";
    case "ac3":    return "ac3";
    case "eac3":   return "eac3";
    default:       return c ? (c as AudioCodec) : "unknown";
  }
}

export function avbridgeAudioToMediabunny(c: AudioCodec): string | null {
  switch (c) {
    case "aac":    return "aac";
    case "mp3":    return "mp3";
    case "opus":   return "opus";
    case "vorbis": return "vorbis";
    case "flac":   return "flac";
    case "ac3":    return "ac3";
    case "eac3":   return "eac3";
    default:       return null;
  }
}

async function safeNumber(fn: () => Promise<number> | number): Promise<number | undefined> {
  try {
    const v = await fn();
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

async function safe<T>(fn: () => Promise<T> | T): Promise<T | undefined> {
  try { return await fn(); } catch { return undefined; }
}
