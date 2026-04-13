import type { SubtitleTrackInfo, TransportConfig } from "../types.js";
import { fetchWith } from "../util/transport.js";
import { srtToVtt } from "./srt.js";
import { isVtt } from "./vtt.js";

export { srtToVtt } from "./srt.js";
export { SubtitleOverlay } from "./render.js";

/**
 * Discover sidecar `.srt` / `.vtt` files next to the source. Requires the
 * caller to pass a `FileSystemDirectoryHandle` (e.g. via the File System
 * Access API). Without that handle we can't enumerate sibling files.
 *
 * The returned `url` fields are blob URLs created via `URL.createObjectURL`.
 * They must be revoked by the caller (e.g. via `revokeSubtitleResources()`)
 * when the player tears down or the source changes — otherwise repeated
 * source swaps in a single-page app will leak.
 */
export interface DiscoveredSidecar {
  url: string;
  format: "srt" | "vtt";
  language?: string;
}

export async function discoverSidecars(
  file: File,
  directory: FileSystemDirectoryHandle,
): Promise<DiscoveredSidecar[]> {
  const baseName = file.name.replace(/\.[^.]+$/, "");
  const found: DiscoveredSidecar[] = [];

  // Walk the directory and look for `${baseName}*.srt` / `*.vtt`.
  for await (const [name, handle] of (directory as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
    if (handle.kind !== "file") continue;
    if (!name.startsWith(baseName)) continue;
    const lower = name.toLowerCase();
    let format: "srt" | "vtt" | null = null;
    if (lower.endsWith(".srt")) format = "srt";
    else if (lower.endsWith(".vtt")) format = "vtt";
    if (!format) continue;

    const sidecarFile = await (handle as FileSystemFileHandle).getFile();
    const url = URL.createObjectURL(sidecarFile);

    // Try to extract a language tag (eg. movie.en.srt → "en").
    const langMatch = name.slice(baseName.length).match(/[._-]([a-z]{2,3})(?:[._-]|\.)/i);
    found.push({
      url,
      format,
      language: langMatch?.[1],
    });
  }

  return found;
}

/**
 * Owns every blob URL created during sidecar discovery and SRT→VTT
 * conversion for a single player session. Revoking the bag releases all of
 * them in one shot at teardown.
 */
export class SubtitleResourceBag {
  private urls = new Set<string>();

  /** Track an externally-created blob URL (e.g. from `discoverSidecars`). */
  track(url: string): void {
    this.urls.add(url);
  }

  /** Convenience: create a blob URL and track it in one call. */
  createObjectURL(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    this.urls.add(url);
    return url;
  }

  /** Revoke every tracked URL. Idempotent — safe to call multiple times. */
  revokeAll(): void {
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls.clear();
  }
}

/**
 * Attach `<track>` elements for each subtitle to the player's `<video>`. SRT
 * sources are converted to VTT first via blob URLs because `<track>` only
 * accepts WebVTT.
 *
 * Pass a {@link SubtitleResourceBag} so the player can revoke the generated
 * blob URLs at teardown. Without one, every SRT subtitle leaks a blob URL
 * per attach.
 *
 * Errors during fetch/parse are caught per-track and reported via the
 * `onError` callback (if provided) so a single bad subtitle doesn't break
 * bootstrap. Subtitles are *not* load-bearing for playback.
 */
export async function attachSubtitleTracks(
  video: HTMLVideoElement,
  tracks: SubtitleTrackInfo[],
  bag?: SubtitleResourceBag,
  onError?: (err: Error, track: SubtitleTrackInfo) => void,
  transport?: TransportConfig,
): Promise<void> {
  const doFetch = fetchWith(transport);

  // Clear existing dynamically-attached tracks.
  for (const t of Array.from(video.querySelectorAll("track[data-avbridge]"))) {
    t.remove();
  }

  for (const t of tracks) {
    if (!t.sidecarUrl) continue;
    try {
      let url = t.sidecarUrl;
      if (t.format === "srt") {
        const res = await doFetch(t.sidecarUrl, transport?.requestInit);
        const text = await res.text();
        const vtt = srtToVtt(text);
        const blob = new Blob([vtt], { type: "text/vtt" });
        url = bag ? bag.createObjectURL(blob) : URL.createObjectURL(blob);
      } else if (t.format === "vtt") {
        // Validate quickly so a malformed file fails loudly here.
        const res = await doFetch(t.sidecarUrl, transport?.requestInit);
        const text = await res.text();
        if (!isVtt(text)) {
          // eslint-disable-next-line no-console
          console.warn("[avbridge] subtitle missing WEBVTT header:", t.sidecarUrl);
        }
      }
      const trackEl = document.createElement("track");
      trackEl.kind = "subtitles";
      trackEl.src = url;
      trackEl.srclang = t.language ?? "und";
      trackEl.label = t.language ?? `Subtitle ${t.id}`;
      trackEl.dataset.avbridge = "true";
      video.appendChild(trackEl);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      onError?.(e, t);
    }
  }
}
