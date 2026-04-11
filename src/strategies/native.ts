import type { MediaContext, PlaybackSession } from "../types.js";

/**
 * Simplest strategy: hand the source to the browser. Works for any
 * MP4/WebM/MP3/etc. that the user agent already plays.
 *
 * The only complexity is that the source might be a `File`/`Blob` (use
 * `URL.createObjectURL`), an `ArrayBuffer`/`Uint8Array` (wrap in a Blob first),
 * or a string URL (assign directly).
 */
export async function createNativeSession(
  context: MediaContext,
  video: HTMLVideoElement,
): Promise<PlaybackSession> {
  const { url, revoke } = sourceToVideoUrl(context.source);
  video.src = url;

  // Wait for metadata so the player resolves only once playback is actually
  // ready. We expose errors via the player's "error" event, not by throwing
  // here, because failure here often means we should escalate to remux.
  await new Promise<void>((resolve, reject) => {
    const onMeta = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`<video> failed to load: ${video.error?.message ?? "unknown"}`));
    };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("error", onError);
  });

  let stats = { framesDecoded: 0, framesDropped: 0 };

  return {
    strategy: "native",
    async play() {
      await video.play();
    },
    pause() {
      video.pause();
    },
    async seek(time) {
      video.currentTime = time;
    },
    async setAudioTrack(id) {
      // HTMLMediaElement.audioTracks is not exposed in all browsers, so we
      // try-catch and no-op if not available.
      const tracks = (video as unknown as { audioTracks?: { length: number; [i: number]: { id: string; enabled: boolean } } }).audioTracks;
      if (!tracks) return;
      for (let i = 0; i < tracks.length; i++) {
        tracks[i].enabled = tracks[i].id === String(id) || i === id;
      }
    },
    async setSubtitleTrack(id) {
      const tracks = video.textTracks;
      for (let i = 0; i < tracks.length; i++) {
        tracks[i].mode = i === id ? "showing" : "disabled";
      }
    },
    async destroy() {
      video.pause();
      video.removeAttribute("src");
      video.load();
      revoke?.();
    },
    getCurrentTime() {
      return video.currentTime || 0;
    },
    getRuntimeStats() {
      // getVideoPlaybackQuality is the standard hook; not all UAs implement it.
      const q = (video as unknown as { getVideoPlaybackQuality?: () => VideoPlaybackQuality }).getVideoPlaybackQuality?.();
      if (q) {
        stats = {
          framesDecoded: q.totalVideoFrames,
          framesDropped: q.droppedVideoFrames,
        };
      }
      return { ...stats, decoderType: "native" };
    },
  };
}

function sourceToVideoUrl(source: unknown): { url: string; revoke?: () => void } {
  if (source instanceof Blob) {
    const url = URL.createObjectURL(source);
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }
  if (source instanceof ArrayBuffer || source instanceof Uint8Array) {
    const blob = new Blob([source as BlobPart]);
    const url = URL.createObjectURL(blob);
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }
  if (typeof source === "string") return { url: source };
  if (source instanceof URL) return { url: source.toString() };
  throw new TypeError("native strategy: unsupported source type");
}

interface VideoPlaybackQuality {
  totalVideoFrames: number;
  droppedVideoFrames: number;
}
