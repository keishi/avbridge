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

  // Don't pump yet — wait for the first play() or seek() to start from the
  // right position. The player's strategy-switch flow calls seek(currentTime)
  // immediately after creation, so pumping from 0 here would be wasted work.
  let started = false;
  let wantPlay = false;

  return {
    strategy: "remux",
    async play() {
      wantPlay = true;
      if (!started) {
        // First play — start the pump. The deferred seek in MseSink will
        // call video.play() once data is available (via autoPlay flag).
        started = true;
        await pipeline.start(video.currentTime || 0, true);
        return;
      }
      await video.play();
    },
    pause() {
      wantPlay = false;
      video.pause();
    },
    async seek(time) {
      if (!started) {
        started = true;
        // autoPlay=true so playback starts as soon as data arrives at
        // the seek target (handles the strategy-switch case where play()
        // is called right after seek()).
        await pipeline.seek(time, wantPlay);
        return;
      }
      const wasPlaying = !video.paused;
      await pipeline.seek(time, wasPlaying || wantPlay);
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
    getCurrentTime() {
      return video.currentTime || 0;
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
