import type { ContainerKind, MediaContext, MediaInput, TransportConfig } from "../types.js";
import { normalizeSource, sniffNormalizedSource } from "../util/source.js";
import { probeWithMediabunny } from "./mediabunny.js";
import { AvbridgeError, ERR_PROBE_FAILED, ERR_PROBE_UNKNOWN_CONTAINER, ERR_LIBAV_NOT_REACHABLE } from "../errors.js";

/** Containers mediabunny can demux. Sniff results outside this set go straight to libav. */
const MEDIABUNNY_CONTAINERS = new Set<ContainerKind>([
  "mp4",
  "mov",
  "mkv",
  "webm",
  "ogg",
  "wav",
  "mp3",
  "flac",
  "adts",
  "mpegts",
]);

/**
 * Probe a source and produce a {@link MediaContext}.
 *
 * Routing:
 * 1. Sniff the magic header. Cheap, deterministic, ignores file extensions.
 * 2. If the container is one mediabunny supports → try mediabunny first
 *    (fast path — it's a single pass of WASM-free JS parsing). If mediabunny
 *    throws (e.g. an assertion on an unsupported sample entry like `mp4v`
 *    for MPEG-4 Part 2 in ISOBMFF, or an exotic MKV codec), fall through to
 *    libav.js which handles the long tail of codecs mediabunny doesn't.
 *    The combined-error case surfaces *both* failures so the user sees
 *    which path each step took.
 * 3. If sniffing identifies AVI/ASF/FLV (or `unknown`) → libav.js directly.
 *    mediabunny can't read those containers at all, so there's no fast path
 *    to try.
 */
export async function probe(
  source: MediaInput,
  transport?: TransportConfig,
): Promise<MediaContext> {
  const normalized = await normalizeSource(source, transport);
  const sniffed = await sniffNormalizedSource(normalized);

  if (MEDIABUNNY_CONTAINERS.has(sniffed)) {
    try {
      const result = await probeWithMediabunny(normalized, sniffed);
      // If mediabunny returned unknown codecs, try libav which recognizes
      // a wider range (DTS, TrueHD, etc.). Only escalate if there ARE
      // tracks with unknown codecs — otherwise mediabunny's result is fine.
      const hasUnknownCodec =
        result.videoTracks.some((t) => t.codec === "unknown") ||
        result.audioTracks.some((t) => t.codec === "unknown");
      if (hasUnknownCodec) {
        try {
          const { probeWithLibav } = await import("./avi.js");
          return await probeWithLibav(normalized, sniffed);
        } catch {
          // libav also failed — return mediabunny's result (unknown codecs
          // are better than no result at all)
          return result;
        }
      }
      return result;
    } catch (mediabunnyErr) {
      // mediabunny rejected the file. Before giving up, try libav — it can
      // demux a much wider range of codec combinations in ISOBMFF/MKV/etc.
      // than mediabunny's pure-JS parser (e.g. mp4v, wmv3-in-asf, flac in
      // an MP4 container). This is "escalation", not "masking": if libav
      // also fails we surface both errors below.
      // eslint-disable-next-line no-console
      console.warn(
        `[avbridge] mediabunny rejected ${sniffed} file, falling back to libav:`,
        (mediabunnyErr as Error).message,
      );
      try {
        const { probeWithLibav } = await import("./avi.js");
        return await probeWithLibav(normalized, sniffed);
      } catch (libavErr) {
        const mbMsg = (mediabunnyErr as Error).message || String(mediabunnyErr);
        const lvMsg = libavErr instanceof Error ? libavErr.message : String(libavErr);
        throw new AvbridgeError(
          ERR_PROBE_FAILED,
          `Failed to probe ${sniffed.toUpperCase()} file. mediabunny: ${mbMsg}. libav: ${lvMsg}.`,
          "The file may be corrupt, truncated, or in an unsupported format. Enable AVBRIDGE_DEBUG for detailed logs.",
        );
      }
    }
  }

  // sniffed === avi | asf | flv | unknown — try libav.
  try {
    const { probeWithLibav } = await import("./avi.js");
    return await probeWithLibav(normalized, sniffed);
  } catch (err) {
    const inner = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error("[avbridge] libav probe failed for", sniffed, "file:", err);
    if (sniffed === "unknown") {
      throw new AvbridgeError(
        ERR_PROBE_UNKNOWN_CONTAINER,
        `Unable to probe source: container format could not be identified. libav fallback: ${inner || "(no details)"}`,
        "The file may be corrupt or in a format avbridge doesn't recognize. Check the file plays in VLC or ffprobe.",
      );
    }
    throw new AvbridgeError(
      ERR_LIBAV_NOT_REACHABLE,
      `${sniffed.toUpperCase()} files require libav.js, which failed to load: ${inner || "(no details)"}`,
      "Install @libav.js/variant-webcodecs, or check that AVBRIDGE_LIBAV_BASE points to the correct path.",
    );
  }
}
