import type { MediaContext, AudioCodec, VideoCodec } from "../../types.js";
import type { LibavVariant } from "./libav-loader.js";

/**
 * Decide which libav.js variant to load for a given media context.
 *
 * - **webcodecs** (~5 MB, npm) — modern formats only, designed for the
 *   WebCodecs bridge. Used when the codec is browser-supported and we just
 *   need libav.js for demuxing or as a parser source.
 *
 * - **ubmp** (custom build, vendor/libav/) — has the AVI/ASF/FLV demuxers
 *   and the legacy decoders (WMV3, MPEG-4 Part 2, VC-1, MS-MPEG4 v1/2/3,
 *   AC-3, WMA*). Required for any of those formats; the npm variants ship
 *   none of them.
 *
 * Rule: pick "ubmp" if either the container or any codec is one only the
 * custom build can handle. Otherwise pick "webcodecs".
 */

const LEGACY_CONTAINERS = new Set(["avi", "asf", "flv"]);

const LEGACY_VIDEO_CODECS = new Set<VideoCodec>([
  "wmv3",
  "vc1",
  "mpeg4", // MPEG-4 Part 2 / DivX / Xvid
  "rv40",
  "mpeg2",
  "mpeg1",
  "theora",
]);

const LEGACY_AUDIO_CODECS = new Set<AudioCodec>(["wmav2", "wmapro", "ac3", "eac3"]);

export function pickLibavVariant(ctx: MediaContext): LibavVariant {
  if (LEGACY_CONTAINERS.has(ctx.container)) return "ubmp";
  for (const v of ctx.videoTracks) {
    if (LEGACY_VIDEO_CODECS.has(v.codec)) return "ubmp";
  }
  for (const a of ctx.audioTracks) {
    if (LEGACY_AUDIO_CODECS.has(a.codec)) return "ubmp";
  }
  return "webcodecs";
}
