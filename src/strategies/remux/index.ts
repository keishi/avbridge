import type { MediaContext, PlaybackSession } from "../../types.js";
import { createRemuxPipeline, type RemuxPipeline } from "./pipeline.js";

/**
 * Strategy entry: build the remux pipeline, then expose a {@link PlaybackSession}
 * that delegates to the underlying `<video>` element for playback control and
 * to the pipeline for source-side seek invalidation.
 */
export async function createRemuxSession(
  context: MediaContext,
  video: HTMLVideoElement,
): Promise<PlaybackSession> {
  let pipeline: RemuxPipeline;
  try {
    pipeline = await createRemuxPipeline(context, video);
  } catch (err) {
    throw new Error(
      `remux strategy failed to start: ${(err as Error).message}. The container or codec combination is not supported by mediabunny + MSE on this browser.`,
    );
  }
  await pipeline.start();

  return {
    strategy: "remux",
    async play() {
      await video.play();
    },
    pause() {
      video.pause();
    },
    async seek(time) {
      // The <video> seek alone won't work past unbuffered ranges; we have to
      // tell the pipeline to invalidate and re-pump.
      video.currentTime = time;
      await pipeline.seek(time);
    },
    async setAudioTrack(_id) {
      // v1: single-track output. Multi-audio remuxing is post-MVP.
    },
    async setSubtitleTrack(id) {
      const tracks = video.textTracks;
      for (let i = 0; i < tracks.length; i++) {
        tracks[i].mode = i === id ? "showing" : "disabled";
      }
    },
    async destroy() {
      video.pause();
      await pipeline.destroy();
      video.removeAttribute("src");
      video.load();
    },
    getRuntimeStats() {
      return pipeline.stats();
    },
  };
}
