import type { MediaContext, PlaybackSession, TransportConfig } from "../../types.js";
import { VideoRenderer } from "./video-renderer.js";
import { AudioOutput } from "./audio-output.js";
import { startDecoder, type DecoderHandles } from "./decoder.js";
import { dbg } from "../../util/debug.js";

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

// Gate for cold-start playback. We want to start playing as soon as
// there's any decoded output — the decoder will keep pumping during
// playback, so more-is-better buffering only helps for fast decoders.
//
// For software-decode-bound content (rv40 / wmv3 / mpeg4 @ 720p+ on
// single-threaded WASM), the decoder may run *slower* than realtime.
// Waiting for a large audio-buffer threshold is actively wrong in that
// case: it will never be reached, so the old gate would sit out its
// full 10-second timeout before playing anything. An aggressive gate
// ships the first frame to the screen fast, at the cost of the audio
// clock racing a little ahead of video in the first few seconds —
// which is the same situation we'd have been in after the timeout
// anyway.
//
// READY_AUDIO_BUFFER_SECONDS: minimum audio queued before start. Set
// low enough that a slow decoder still reaches it before the user
// loses patience; 40 ms ≈ 2 cook packets or ~2 AAC packets.
// READY_TIMEOUT_SECONDS: hard safety. If even 40 ms of audio can't be
// produced in 3 s, give up and play whatever we have.
const READY_AUDIO_BUFFER_SECONDS = 0.04;
const READY_TIMEOUT_SECONDS = 3;

export async function createFallbackSession(
  ctx: MediaContext,
  target: HTMLVideoElement,
  transport?: TransportConfig,
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
      transport,
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
  // Mirror `paused` / `volume` / `muted` from the audio output — the
  // underlying <video> never has its own src, so its native state is
  // meaningless. This lets HTMLMediaElement consumers (<avbridge-player>
  // controls) see the real values and control volume through the audio
  // output's GainNode.
  Object.defineProperty(target, "paused", {
    configurable: true,
    get: () => !audio.isPlaying(),
  });
  Object.defineProperty(target, "volume", {
    configurable: true,
    get: () => audio.getVolume(),
    set: (v: number) => {
      audio.setVolume(v);
      target.dispatchEvent(new Event("volumechange"));
    },
  });
  Object.defineProperty(target, "muted", {
    configurable: true,
    get: () => audio.getMuted(),
    set: (m: boolean) => {
      audio.setMuted(m);
      target.dispatchEvent(new Event("volumechange"));
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
   *
   * The gate has three exit paths in order of preference:
   *
   *   1. **Fully ready** — audio buffer ≥ target AND ≥1 video frame.
   *      The happy path for fast decoders (native + remux never reach
   *      this function; this is fallback only).
   *
   *   2. **Video-ready, audio grace period elapsed** — we have video
   *      frames but the audio scheduler is still empty. RM/AVI
   *      containers commonly deliver a video GOP before their first
   *      audio packet, so "no audio yet" ≠ "no audio coming". We give
   *      the demuxer a 500 ms grace window from first-frame, then
   *      start regardless. Audio will be scheduled at its correct
   *      media time once its packets arrive.
   *
   *   3. **Hard timeout** — after {@link READY_TIMEOUT_SECONDS} seconds
   *      with neither condition met, start anyway and emit an
   *      unconditional diagnostic so the specific underflow is visible.
   *
   * Path #2 is what fixed the "RMVB sits on the play button for 10 s
   * with audio=0ms, frames=N" case — the gate was waiting on audio
   * packets that were several seconds behind in the file stream, and
   * the timeout was the only way out.
   */
  async function waitForBuffer(): Promise<void> {
    const start = performance.now();
    let firstFrameAtMs = 0;
    dbg.info("cold-start",
      `gate entry: want audio ≥ ${READY_AUDIO_BUFFER_SECONDS * 1000}ms + 1 frame`,
    );
    while (true) {
      const audioAhead = audio.isNoAudio() ? Infinity : audio.bufferAhead();
      const audioReady = audio.isNoAudio() || audioAhead >= READY_AUDIO_BUFFER_SECONDS;
      const hasFrames = renderer.hasFrames();
      const nowMs = performance.now();

      if (hasFrames && firstFrameAtMs === 0) firstFrameAtMs = nowMs;

      // Happy path: both ready.
      if (audioReady && hasFrames) {
        dbg.info("cold-start",
          `gate satisfied in ${(nowMs - start).toFixed(0)}ms ` +
          `(audio=${(audioAhead * 1000).toFixed(0)}ms, frames=${renderer.queueDepth()})`,
        );
        return;
      }

      // Grace path: have video, still waiting for audio that's
      // on its way (first 500 ms after first-frame).
      if (
        hasFrames &&
        firstFrameAtMs > 0 &&
        nowMs - firstFrameAtMs >= 500
      ) {
        dbg.info("cold-start",
          `gate released on video-only grace at ${(nowMs - start).toFixed(0)}ms ` +
          `(frames=${renderer.queueDepth()}, audio=${(audioAhead * 1000).toFixed(0)}ms — ` +
          `demuxer hasn't delivered audio packets yet, starting anyway and letting ` +
          `the audio scheduler catch up at its media-time anchor)`,
        );
        return;
      }

      // Hard timeout.
      if ((nowMs - start) / 1000 > READY_TIMEOUT_SECONDS) {
        dbg.diag("cold-start",
          `gate TIMEOUT after ${READY_TIMEOUT_SECONDS}s — ` +
          `audio=${(audioAhead * 1000).toFixed(0)}ms ` +
          `(needed ${READY_AUDIO_BUFFER_SECONDS * 1000}ms), ` +
          `frames=${renderer.queueDepth()} (needed ≥1). ` +
          `Decoder produced nothing in ${READY_TIMEOUT_SECONDS}s — either a corrupt source, ` +
          `a missing codec, or WASM is catastrophically slow on this file. ` +
          `Check getDiagnostics().runtime for decode counters.`,
        );
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
        target.dispatchEvent(new Event("play"));
        target.dispatchEvent(new Event("playing"));
      }
    },

    pause() {
      void audio.pause();
      target.dispatchEvent(new Event("pause"));
    },

    async seek(time) {
      await doSeek(time);
    },

    async setAudioTrack(id) {
      // Verify the id refers to a real track.
      if (!ctx.audioTracks.some((t) => t.id === id)) {
        console.warn("[avbridge] fallback: setAudioTrack — unknown track id", id);
        return;
      }
      const wasPlaying = audio.isPlaying();
      const currentTime = audio.now();
      // Suspend audio, rebuild the decoder + seek, reset audio output, re-gate.
      await audio.pause().catch(() => {});
      await handles.setAudioTrack(id, currentTime).catch((err) =>
        console.warn("[avbridge] fallback: handles.setAudioTrack failed:", err),
      );
      await audio.reset(currentTime);
      renderer.flush();
      if (wasPlaying) {
        await waitForBuffer();
        await audio.start();
      }
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
        delete (target as unknown as Record<string, unknown>).paused;
        delete (target as unknown as Record<string, unknown>).volume;
        delete (target as unknown as Record<string, unknown>).muted;
      } catch { /* ignore */ }
    },

    getRuntimeStats() {
      return handles.stats();
    },
  };
}
