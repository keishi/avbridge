import type { MediaContext, PlaybackSession } from "../../types.js";
import { VideoRenderer } from "./video-renderer.js";
import { AudioOutput } from "./audio-output.js";
import { startDecoder, type DecoderHandles } from "./decoder.js";

/**
 * Fallback strategy session.
 *
 * Owns the orchestration between the libav decoder, the audio scheduler,
 * and the canvas renderer. Three things make this non-trivial:
 *
 * 1. **Cold-start ready gate.** When `play()` is called, we wait until the
 *    audio scheduler has buffered enough audio (≥ 300 ms) AND the renderer
 *    has at least one decoded video frame, before actually telling the
 *    audio context to start. Without this gate, audio and the wall clock
 *    race ahead of the still-warming-up software decoder, and every video
 *    frame lands "in the past" and gets dropped.
 *
 * 2. **Pause / resume.** The audio context is suspended on pause and
 *    resumed on play. The media-time anchor is preserved across the
 *    suspend so the clock is continuous.
 *
 * 3. **Seek.** Pauses the audio scheduler, asks the decoder to cancel its
 *    current pump and `av_seek_frame` to the target, resets the audio
 *    output's media-time anchor to the seek target, flushes the renderer
 *    queue, then re-enters the ready gate. If we were playing before the
 *    seek, we automatically resume once the buffer fills.
 *
 * The unified player API on top of this just sees `play() / pause() /
 * seek(t)` — none of the buffering choreography leaks out.
 */

const READY_AUDIO_BUFFER_SECONDS = 0.3;
const READY_TIMEOUT_SECONDS = 10;

export async function createFallbackSession(
  ctx: MediaContext,
  target: HTMLVideoElement,
): Promise<PlaybackSession> {
  // Normalize the source so URL inputs go through the libav HTTP block
  // reader instead of being buffered into memory.
  const { normalizeSource } = await import("../../util/source.js");
  const source = await normalizeSource(ctx.source);

  const fps = ctx.videoTracks[0]?.fps ?? 30;
  const audio = new AudioOutput();
  const renderer = new VideoRenderer(target, audio, fps);

  let handles: DecoderHandles;
  try {
    handles = await startDecoder({
      source,
      filename: ctx.name ?? "input.bin",
      context: ctx,
      renderer,
      audio,
    });
  } catch (err) {
    audio.destroy();
    renderer.destroy();
    throw err;
  }

  // Patch the <video> element so the unified player layer (which polls
  // `target.currentTime` for `timeupdate` events and lets users assign to
  // it for seeks) gets the right values from the fallback strategy.
  Object.defineProperty(target, "currentTime", {
    configurable: true,
    get: () => audio.now(),
    set: (v: number) => {
      // Fire-and-forget — the user is expected to await player.seek() if
      // they want to know when the seek completes.
      void doSeek(v);
    },
  });
  // Mirror duration so the demo's controls can use target.duration too.
  if (ctx.duration && Number.isFinite(ctx.duration)) {
    Object.defineProperty(target, "duration", {
      configurable: true,
      get: () => ctx.duration ?? NaN,
    });
  }

  /**
   * Wait until the decoder has produced enough buffered output to start
   * playback smoothly. Returns early on timeout so we don't hang forever
   * if the decoder is producing nothing (e.g. immediately past EOF after
   * a seek to the end).
   */
  async function waitForBuffer(): Promise<void> {
    const start = performance.now();
    while (true) {
      const audioReady = audio.isNoAudio() || audio.bufferAhead() >= READY_AUDIO_BUFFER_SECONDS;
      if (audioReady && renderer.hasFrames()) {
        return;
      }
      if ((performance.now() - start) / 1000 > READY_TIMEOUT_SECONDS) {
        // Give up waiting; play whatever we have.
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function doSeek(timeSec: number): Promise<void> {
    const wasPlaying = audio.isPlaying();
    // 1. Stop audio (suspend ctx + capture media time).
    await audio.pause().catch(() => {});
    // 2. Tell the decoder to cancel its pump and seek the demuxer.
    await handles.seek(timeSec).catch((err) =>
      console.warn("[avbridge] decoder seek failed:", err),
    );
    // 3. Reset audio + renderer to the new media time. New samples from
    //    the decoder will queue against this anchor.
    await audio.reset(timeSec);
    renderer.flush();
    // 4. If we were playing, wait for the buffer to fill again and then
    //    resume. If we were paused, leave it paused at the new position.
    if (wasPlaying) {
      await waitForBuffer();
      await audio.start();
    }
  }

  return {
    strategy: "fallback",

    async play() {
      // Either a cold start (very first play() call) or a resume from
      // pause. AudioOutput.start() handles both.
      if (!audio.isPlaying()) {
        await waitForBuffer();
        await audio.start();
      }
    },

    pause() {
      void audio.pause();
    },

    async seek(time) {
      await doSeek(time);
    },

    async setAudioTrack(_id) {
      // Multi-track audio is post-MVP for the fallback strategy.
    },

    async setSubtitleTrack(_id) {
      // Subtitle overlay support is post-MVP for the fallback strategy.
    },

    getCurrentTime() {
      return audio.now();
    },
    async destroy() {
      await handles.destroy();
      renderer.destroy();
      audio.destroy();
      try {
        delete (target as unknown as Record<string, unknown>).currentTime;
        delete (target as unknown as Record<string, unknown>).duration;
      } catch { /* ignore */ }
    },

    getRuntimeStats() {
      return handles.stats();
    },
  };
}
