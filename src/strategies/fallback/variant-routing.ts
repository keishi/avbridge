import type { MediaContext, AudioCodec, VideoCodec } from "../../types.js";
import type { LibavVariant } from "./libav-loader.js";

/**
 * Decide which libav.js variant to load for a given media context.
 *
 * - **webcodecs** (~5 MB, npm) — modern formats only, designed for the
 *   WebCodecs bridge. Used when the codec is browser-supported and we just
 *   need libav.js for demuxing or as a parser source.
 *
 * - **avbridge** (custom build, vendor/libav/) — has the AVI/ASF/FLV demuxers
 *   and the legacy decoders (WMV3, MPEG-4 Part 2, VC-1, MS-MPEG4 v1/2/3,
 *   AC-3, WMA*). Required for any of those formats; the npm variants ship
 *   none of them.
 *
 * Rule: pick "avbridge" if either the container or any codec is one only the
 * custom build can handle. Otherwise pick "webcodecs".
 */

const LEGACY_CONTAINERS = new Set(["avi", "asf", "flv"]);

/** Codecs the webcodecs variant can handle (native browser codecs only).
 * Anything not in these sets needs the custom avbridge variant. */
const WEBCODECS_AUDIO = new Set<AudioCodec>(["aac", "mp3", "opus", "vorbis", "flac"]);
const WEBCODECS_VIDEO = new Set<VideoCodec>(["h264", "h265", "vp8", "vp9", "av1"]);

export function pickLibavVariant(ctx: MediaContext): LibavVariant {
  if (LEGACY_CONTAINERS.has(ctx.container)) return "avbridge";
  for (const v of ctx.videoTracks) {
    // Any codec the webcodecs variant can't handle → need avbridge
    if (!WEBCODECS_VIDEO.has(v.codec)) return "avbridge";
  }
  for (const a of ctx.audioTracks) {
    if (!WEBCODECS_AUDIO.has(a.codec)) return "avbridge";
  }
  return "webcodecs";
}
