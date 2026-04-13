import type { MediaContext, PlaybackSession, TransportConfig } from "../../types.js";
import { VideoRenderer } from "../fallback/video-renderer.js";
import { AudioOutput } from "../fallback/audio-output.js";
import { startHybridDecoder, type HybridDecoderHandles } from "./decoder.js";

/**
 * Hybrid strategy session.
 *
 * Uses libav.js for demuxing + WebCodecs VideoDecoder for hardware-accelerated
 * video decode + libav.js software decode for audio. Same canvas + Web Audio
 * output as the fallback strategy.
 *
 * Falls back to the pure-WASM fallback strategy if WebCodecs fails (via the
 * onFatalError callback that the player wires to its escalation mechanism).
 */

const READY_AUDIO_BUFFER_SECONDS = 0.3;
const READY_TIMEOUT_SECONDS = 10;

export async function createHybridSession(
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

  let handles: HybridDecoderHandles;
  try {
    handles = await startHybridDecoder({
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

  // Patch <video> element for the unified player layer. `paused` is
  // mirrored from the audio clock so callers that inspect target.paused
  // (notably doSetStrategy capturing wasPlaying) see the real play state
  // — the underlying <video> never has its own src and stays paused.
  Object.defineProperty(target, "currentTime", {
    configurable: true,
    get: () => audio.now(),
    set: (v: number) => { void doSeek(v); },
  });
  Object.defineProperty(target, "paused", {
    configurable: true,
    get: () => !audio.isPlaying(),
  });
  if (ctx.duration && Number.isFinite(ctx.duration)) {
    Object.defineProperty(target, "duration", {
      configurable: true,
      get: () => ctx.duration ?? NaN,
    });
  }

  async function waitForBuffer(): Promise<void> {
    const start = performance.now();
    while (true) {
      const audioReady = audio.isNoAudio() || audio.bufferAhead() >= READY_AUDIO_BUFFER_SECONDS;
      if (audioReady && renderer.hasFrames()) {
        return;
      }
      if ((performance.now() - start) / 1000 > READY_TIMEOUT_SECONDS) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function doSeek(timeSec: number): Promise<void> {
    const wasPlaying = audio.isPlaying();
    await audio.pause().catch(() => {});
    await handles.seek(timeSec).catch((err) =>
      console.warn("[avbridge] hybrid decoder seek failed:", err),
    );
    await audio.reset(timeSec);
    renderer.flush();
    if (wasPlaying) {
      await waitForBuffer();
      await audio.start();
    }
  }

  // Store the fatal error handler so the player can wire escalation
  let fatalErrorHandler: ((reason: string) => void) | null = null;
  handles.onFatalError((reason) => fatalErrorHandler?.(reason));

  return {
    strategy: "hybrid",

    async play() {
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
      // Post-MVP for hybrid strategy
    },

    async setSubtitleTrack(_id) {
      // Post-MVP for hybrid strategy
    },

    getCurrentTime() {
      return audio.now();
    },

    onFatalError(handler: (reason: string) => void) {
      fatalErrorHandler = handler;
    },

    async destroy() {
      await handles.destroy();
      renderer.destroy();
      audio.destroy();
      try {
        delete (target as unknown as Record<string, unknown>).currentTime;
        delete (target as unknown as Record<string, unknown>).duration;
        delete (target as unknown as Record<string, unknown>).paused;
      } catch { /* ignore */ }
    },

    getRuntimeStats() {
      return handles.stats();
    },
  };
}
