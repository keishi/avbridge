import type { AudioTrackInfo, VideoTrackInfo } from "../types.js";

/**
 * Build an RFC 6381 codec string for use with `MediaSource.isTypeSupported`
 * and `<source type=...>`. Returns null when we don't have enough info to
 * compose one — callers should treat that as "ask the browser at runtime via
 * a different channel" rather than guessing.
 */
export function videoCodecString(track: VideoTrackInfo): string | null {
  if (track.codecString) return track.codecString;
  switch (track.codec) {
    case "h264": {
      // avc1.PPCCLL — profile (1B), constraint (1B), level (1B). Default to
      // High Profile @ 4.0 if we don't know — common on real-world content.
      const profileHex = profileToHex(track.profile) ?? "64"; // 0x64 = High
      const constraint = "00";
      const level = ((track.level ?? 40) & 0xff).toString(16).padStart(2, "0");
      return `avc1.${profileHex}${constraint}${level}`;
    }
    case "h265":
      // Default Main Profile @ Level 4.1 (0x5d = 93) — `hvc1.1.6.L93.B0`.
      return "hvc1.1.6.L93.B0";
    case "vp8":
      return "vp8";
    case "vp9":
      return "vp09.00.10.08";
    case "av1":
      return "av01.0.04M.08";
    default:
      return null;
  }
}

function profileToHex(profile?: string): string | null {
  if (!profile) return null;
  const p = profile.toLowerCase();
  if (p.includes("baseline")) return "42";
  if (p.includes("main")) return "4d";
  if (p.includes("high 10")) return "6e";
  if (p.includes("high 4:2:2")) return "7a";
  if (p.includes("high 4:4:4")) return "f4";
  if (p.includes("high")) return "64";
  return null;
}

export function audioCodecString(track: AudioTrackInfo): string | null {
  if (track.codecString) return track.codecString;
  switch (track.codec) {
    case "aac":
      return "mp4a.40.2"; // AAC-LC
    case "mp3":
      return "mp4a.40.34";
    case "opus":
      return "opus";
    case "vorbis":
      return "vorbis";
    case "flac":
      return "flac";
    default:
      return null;
  }
}

/**
 * Compose a `video/mp4; codecs="..."` MIME for MSE. Returns null if either
 * codec string can't be produced — caller should fall back to remux refusal.
 */
export function mp4MimeFor(video: VideoTrackInfo, audio?: AudioTrackInfo): string | null {
  const v = videoCodecString(video);
  if (!v) return null;
  const codecs = audio ? `${v},${audioCodecString(audio) ?? ""}`.replace(/,$/, "") : v;
  return `video/mp4; codecs="${codecs}"`;
}

/**
 * Wrap `MediaSource.isTypeSupported` so it returns false (instead of throwing)
 * in environments without MSE — e.g. jsdom under vitest.
 */
export function mseSupports(mime: string): boolean {
  if (typeof MediaSource === "undefined") return false;
  try {
    return MediaSource.isTypeSupported(mime);
  } catch {
    return false;
  }
}
