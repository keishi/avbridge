import type { SubtitleTrackInfo } from "../types.js";
import { srtToVtt } from "./srt.js";
import { isVtt } from "./vtt.js";

export { srtToVtt } from "./srt.js";
export { SubtitleOverlay } from "./render.js";

/**
 * Discover sidecar `.srt` / `.vtt` files next to the source. Requires the
 * caller to pass a `FileSystemDirectoryHandle` (e.g. via the File System
 * Access API). Without that handle we can't enumerate sibling files.
 */
export interface DiscoveredSidecar {
  url: string;
  format: "srt" | "vtt";
  language?: string;
}

export async function discoverSidecar(
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
 * Attach `<track>` elements for each subtitle to the player's `<video>`. SRT
 * sources are converted to VTT first via blob URLs because `<track>` only
 * accepts WebVTT.
 */
export async function attachSubtitleTracks(
  video: HTMLVideoElement,
  tracks: SubtitleTrackInfo[],
): Promise<void> {
  // Clear existing dynamically-attached tracks.
  for (const t of Array.from(video.querySelectorAll("track[data-ubmp]"))) {
    t.remove();
  }

  for (const t of tracks) {
    if (!t.sidecarUrl) continue;
    let url = t.sidecarUrl;
    if (t.format === "srt") {
      const res = await fetch(t.sidecarUrl);
      const text = await res.text();
      const vtt = srtToVtt(text);
      const blob = new Blob([vtt], { type: "text/vtt" });
      url = URL.createObjectURL(blob);
    } else if (t.format === "vtt") {
      // Validate quickly so a malformed file fails loudly here.
      const res = await fetch(t.sidecarUrl);
      const text = await res.text();
      if (!isVtt(text)) {
        // eslint-disable-next-line no-console
        console.warn("[ubmp] subtitle missing WEBVTT header:", t.sidecarUrl);
      }
    }
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.src = url;
    track.srclang = t.language ?? "und";
    track.label = t.language ?? `Subtitle ${t.id}`;
    track.dataset.ubmp = "true";
    video.appendChild(track);
  }
}
