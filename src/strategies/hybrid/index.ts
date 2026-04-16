import type { MediaContext, PlaybackSession, TransportConfig } from "../../types.js";
import { VideoRenderer } from "../fallback/video-renderer.js";
import { AudioOutput } from "../fallback/audio-output.js";
import { startHybridDecoder, type HybridDecoderHandles } from "./decoder.js";
import { makeTimeRanges } from "../../util/time-ranges.js";

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

  // Patch <video> element for the unified player layer. The underlying
  // <video> never has its own src; all playback state lives in the audio
  // clock + canvas renderer. We expose that state via property getters
  // so standard HTMLMediaElement consumers (like <avbridge-player>'s
  // controls UI) see the real values.
  Object.defineProperty(target, "currentTime", {
    configurable: true,
    get: () => audio.now(),
    set: (v: number) => { void doSeek(v); },
  });
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
  if (ctx.duration && Number.isFinite(ctx.duration)) {
    Object.defineProperty(target, "duration", {
      configurable: true,
      get: () => ctx.duration ?? NaN,
    });
  }
  // HTMLMediaElement parity surfaces — see fallback/index.ts for rationale.
  Object.defineProperty(target, "readyState", {
    configurable: true,
    get: (): number => {
      if (!renderer.hasFrames()) return 0;
      if (!audio.isPlaying() && audio.bufferAhead() <= 0 && !audio.isNoAudio()) return 1;
      return 2;
    },
  });
  Object.defineProperty(target, "seekable", {
    configurable: true,
    get: () => makeTimeRanges(ctx.duration && Number.isFinite(ctx.duration) && ctx.duration > 0
      ? [[0, ctx.duration]]
      : []),
  });
  Object.defineProperty(target, "buffered", {
    configurable: true,
    get: () => {
      const end = handles.bufferedUntilSec();
      return makeTimeRanges(end > 0 ? [[0, end]] : []);
    },
  });

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
    // HTMLMediaElement contract — see fallback/index.ts for the why.
    target.dispatchEvent(new Event("seeking"));
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
    target.dispatchEvent(new Event("seeked"));
  }

  // HTMLMediaElement contract: `loadedmetadata` once the session is
  // ready. The inner <video> never fires this itself on the hybrid
  // path — it has no src.
  queueMicrotask(() => {
    try { target.dispatchEvent(new Event("loadedmetadata")); } catch { /* element torn down */ }
  });

  // Store the fatal error handler so the player can wire escalation
  let fatalErrorHandler: ((reason: string) => void) | null = null;
  handles.onFatalError((reason) => fatalErrorHandler?.(reason));

  return {
    strategy: "hybrid",

    async play() {
      if (!audio.isPlaying()) {
        await waitForBuffer();
        await audio.start();
        // Dispatch play/playing events so HTMLMediaElement consumers
        // (e.g. <avbridge-player>'s controls UI) update their state.
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
      if (!ctx.audioTracks.some((t) => t.id === id)) {
        console.warn("[avbridge] hybrid: setAudioTrack — unknown track id", id);
        return;
      }
      const wasPlaying = audio.isPlaying();
      const currentTime = audio.now();
      await audio.pause().catch(() => {});
      await handles.setAudioTrack(id, currentTime).catch((err) =>
        console.warn("[avbridge] hybrid: handles.setAudioTrack failed:", err),
      );
      await audio.reset(currentTime);
      renderer.flush();
      if (wasPlaying) {
        await waitForBuffer();
        await audio.start();
      }
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
        delete (target as unknown as Record<string, unknown>).volume;
        delete (target as unknown as Record<string, unknown>).muted;
        delete (target as unknown as Record<string, unknown>).readyState;
        delete (target as unknown as Record<string, unknown>).seekable;
      } catch { /* ignore */ }
    },

    getRuntimeStats() {
      return handles.stats();
    },
  };
}
