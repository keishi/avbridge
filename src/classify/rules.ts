import type {
  AudioCodec,
  AudioTrackInfo,
  Classification,
  ContainerKind,
  MediaContext,
  VideoCodec,
  VideoTrackInfo,
} from "../types.js";
import { mp4MimeFor, mseSupports } from "../util/codec-strings.js";

/**
 * Codecs we know `<video>` and MSE support across modern desktop + Android.
 * The decision to remux instead of decode hinges on this list.
 */
const NATIVE_VIDEO_CODECS = new Set<VideoCodec>(["h264", "h265", "vp8", "vp9", "av1"]);
const NATIVE_AUDIO_CODECS = new Set<AudioCodec>([
  "aac",
  "mp3",
  "opus",
  "vorbis",
  "flac",
]);

/**
 * Codecs no major browser plays, period. These force the WASM fallback.
 */
const FALLBACK_VIDEO_CODECS = new Set<VideoCodec>(["wmv3", "vc1", "mpeg4", "rv40", "mpeg2", "mpeg1", "theora"]);
const FALLBACK_AUDIO_CODECS = new Set<AudioCodec>(["wmav2", "wmapro", "ac3", "eac3"]);

/**
 * Containers `<video>` plays directly. Anything else with otherwise-supported
 * codecs is a remux candidate — IF mediabunny can read the container.
 */
const NATIVE_CONTAINERS = new Set<ContainerKind>([
  "mp4",
  "mov",
  "webm",
  "ogg",
  "wav",
  "mp3",
  "flac",
  "adts",
]);

/**
 * Containers mediabunny can demux. The remux strategy feeds the source through
 * mediabunny → fMP4 → MSE, so the source container must be one mediabunny
 * understands. AVI, ASF, FLV are NOT in this set — mediabunny rejects them
 * with "unsupported or unrecognizable format". Files in those containers with
 * otherwise-native codecs (e.g. AVI + H.264 + MP3) must go to the fallback
 * strategy even though the *codecs* are browser-supported.
 */
const REMUXABLE_CONTAINERS = new Set<ContainerKind>([
  "mp4",
  "mov",
  "mkv",
  "webm",
  "ogg",
  "wav",
  "mp3",
  "flac",
  "adts",
]);

/**
 * Pure classification — no I/O, no async. Test-friendly.
 */
export function classifyContext(ctx: MediaContext): Classification {
  const video = ctx.videoTracks[0];
  const audio = ctx.audioTracks[0];

  // Audio-only files: mediabunny handles all the common ones natively.
  if (!video) {
    if (NATIVE_CONTAINERS.has(ctx.container) && (!audio || NATIVE_AUDIO_CODECS.has(audio.codec))) {
      return {
        class: "NATIVE",
        strategy: "native",
        reason: `audio-only ${ctx.container} with native codec`,
      };
    }
    if (audio && FALLBACK_AUDIO_CODECS.has(audio.codec)) {
      return {
        class: "FALLBACK_REQUIRED",
        strategy: "fallback",
        reason: `audio codec "${audio.codec}" requires WASM decode`,
      };
    }
    if (REMUXABLE_CONTAINERS.has(ctx.container)) {
      return {
        class: "REMUX_CANDIDATE",
        strategy: "remux",
        reason: `audio-only file in non-native container "${ctx.container}"`,
      };
    }
    return {
      class: "FALLBACK_REQUIRED",
      strategy: "fallback",
      reason: `audio-only file in "${ctx.container}" (not remuxable by mediabunny)`,
    };
  }

  // Video paths.
  if (FALLBACK_VIDEO_CODECS.has(video.codec)) {
    return {
      class: "FALLBACK_REQUIRED",
      strategy: "fallback",
      reason: `video codec "${video.codec}" has no browser decoder; WASM fallback required`,
    };
  }
  if (audio && FALLBACK_AUDIO_CODECS.has(audio.codec)) {
    return {
      class: "FALLBACK_REQUIRED",
      strategy: "fallback",
      reason: `audio codec "${audio.codec}" has no browser decoder; WASM fallback required`,
    };
  }

  if (!NATIVE_VIDEO_CODECS.has(video.codec)) {
    return {
      class: "FALLBACK_REQUIRED",
      strategy: "fallback",
      reason: `unknown video codec "${video.codec}", routing to fallback`,
    };
  }

  // Codecs are native. Now decide between NATIVE and REMUX based on the
  // container and codec quirks.
  const isNativeContainer = NATIVE_CONTAINERS.has(ctx.container);

  if (isNativeContainer && isSafeNativeCombo(video, audio)) {
    // Confirm with the browser when we have access to MediaSource.
    const mime = mp4MimeFor(video, audio);
    if (mime && mseSupports(mime)) {
      return {
        class: "NATIVE",
        strategy: "native",
        reason: `${ctx.container} + ${video.codec}${audio ? "/" + audio.codec : ""} plays natively`,
      };
    }
    if (mime == null || typeof MediaSource === "undefined") {
      // No MSE in this environment (e.g. tests) — trust the heuristic.
      return {
        class: "NATIVE",
        strategy: "native",
        reason: `${ctx.container} + ${video.codec}${audio ? "/" + audio.codec : ""} (heuristic native)`,
      };
    }
  }

  if (isNativeContainer && isRiskyNative(video)) {
    return {
      class: "RISKY_NATIVE",
      strategy: "native",
      reason: `${video.codec} ${video.profile ?? ""} ${video.bitDepth ?? 8}-bit may stutter on mobile; will escalate to remux on stall`,
      fallbackStrategy: "remux",
    };
  }

  // Codecs are native but the container isn't. Can we remux?
  // Remuxing goes through mediabunny, which only supports certain containers.
  // AVI/ASF/FLV are NOT in that set — mediabunny rejects them at Input().
  if (REMUXABLE_CONTAINERS.has(ctx.container)) {
    return {
      class: "REMUX_CANDIDATE",
      strategy: "remux",
      reason: `${ctx.container} container with native-supported codecs — remux to fragmented MP4 for reliable playback`,
    };
  }

  // Container is unreadable by mediabunny (AVI, ASF, FLV, etc.) but codecs
  // are browser-supported. The fallback strategy will software-decode these
  // even though hardware decode would be possible in a different container.
  // TODO: a future "libav demux → WebCodecs decode" hybrid path could
  // preserve hardware acceleration for this case.
  return {
    class: "FALLBACK_REQUIRED",
    strategy: "fallback",
    reason: `${ctx.container} container cannot be remuxed by mediabunny; falling back to WASM decode despite native-supported codecs (${video.codec}${audio ? "/" + audio.codec : ""})`,
  };
}

function isSafeNativeCombo(video: VideoTrackInfo, audio?: AudioTrackInfo): boolean {
  if (video.codec === "h264") {
    // 8-bit yuv420p H.264 is the safe combo. Hi10P / 4:2:2 / 4:4:4 are not.
    if (video.bitDepth && video.bitDepth > 8) return false;
    if (video.pixelFormat && !/yuv420p$/.test(video.pixelFormat)) return false;
  }
  if (audio && !NATIVE_AUDIO_CODECS.has(audio.codec)) return false;
  return true;
}

function isRiskyNative(video: VideoTrackInfo): boolean {
  if (video.bitDepth && video.bitDepth > 8) return true;
  if (video.pixelFormat && /yuv4(2[24]|44)/.test(video.pixelFormat)) return true;
  if (video.width > 3840 || video.height > 2160) return true;
  if (video.fps && video.fps > 60) return true;
  return false;
}
