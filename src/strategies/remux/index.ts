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
      // seek() may have already started the pump with autoPlay=false
      // (strategy-switch flow calls seek before play). Flip the pipeline's
      // pending autoPlay so the MseSink fires video.play() once buffered
      // data lands, and also attempt an immediate video.play() in case the
      // sink is already wired up. The immediate call can reject when
      // video.src hasn't been set yet — that's fine, the deferred path will
      // catch it.
      pipeline.setAutoPlay(true);
      try {
        await video.play();
      } catch {
        /* sink not ready yet; setAutoPlay will handle playback on first buffered write */
      }
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
    async setAudioTrack(id) {
      if (!context.audioTracks.some((t) => t.id === id)) {
        console.warn("[avbridge] remux: setAudioTrack — unknown track id", id);
        return;
      }
      const wasPlaying = !video.paused;
      const time = video.currentTime || 0;
      // Not yet started? Just note the selection and let play()/seek() drive.
      if (!started) {
        started = true;
        await pipeline.setAudioTrack(id, time, wantPlay || wasPlaying);
        return;
      }
      await pipeline.setAudioTrack(id, time, wasPlaying || wantPlay);
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
