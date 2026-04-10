import type { ContainerKind, MediaContext, MediaSource_ } from "../types.js";
import { normalizeSource, sniffContainer } from "../util/source.js";
import { probeWithMediabunny } from "./mediabunny.js";

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
]);

/**
 * Probe a source and produce a {@link MediaContext}.
 *
 * Routing:
 * 1. Sniff the magic header. Cheap, deterministic, ignores file extensions.
 * 2. If the container is one mediabunny supports → mediabunny. If mediabunny
 *    rejects, surface the real error rather than blindly falling through to
 *    libav (which would mask the real failure with a confusing libav error).
 * 3. If sniffing identifies AVI/ASF/FLV (or `unknown`) → libav.js, lazy-loaded.
 *    `unknown` is included so genuinely unfamiliar files at least get a shot
 *    at the broader libav demuxer set.
 */
export async function probe(source: MediaSource_): Promise<MediaContext> {
  const normalized = await normalizeSource(source);
  const sniffed = await sniffContainer(normalized.blob);

  if (MEDIABUNNY_CONTAINERS.has(sniffed)) {
    try {
      return await probeWithMediabunny(normalized, sniffed);
    } catch (err) {
      throw new Error(
        `mediabunny failed to probe a ${sniffed} file: ${(err as Error).message}`,
      );
    }
  }

  // sniffed === avi | asf | flv | unknown — try libav.
  try {
    const { probeWithLibav } = await import("./avi.js");
    return await probeWithLibav(normalized, sniffed);
  } catch (err) {
    const inner = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error("[ubmp] libav probe failed for", sniffed, "file:", err);
    throw new Error(
      sniffed === "unknown"
        ? `unable to probe source: container could not be identified, and the libav.js fallback also failed: ${inner || "(no message — see browser console for the original error)"}`
        : `${sniffed.toUpperCase()} files require libav.js, which failed to load: ${inner || "(no message — see browser console for the original error)"}`,
    );
  }
}
