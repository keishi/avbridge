/**
 * libav.js demux + decode loop for the fallback strategy.
 *
 * Design:
 *
 * - **Always software decode.** The fallback strategy is only entered when
 *   classification has decided no browser decoder will handle the codec set,
 *   so the WebCodecs hardware path is dead weight here. Going through libav
 *   uniformly also avoids brittleness around `EncodedAudioChunk` framing for
 *   codecs like MP3-in-AVI where the browser's AudioDecoder rejects libav's
 *   raw demuxed packets.
 *
 * - **Cancellable pump loop.** Each pump iteration is gated on a token that
 *   `seek()` increments. When the token changes mid-batch, the loop exits
 *   and a fresh one starts at the new position. This is how seek interrupts
 *   the decoder cleanly without having to await an arbitrarily long
 *   `ff_decode_multi` call.
 *
 * - **Synthetic timestamps.** AVI demuxers report `AV_NOPTS_VALUE` for most
 *   packets — they're frame-indexed, not time-indexed. We replace any
 *   invalid pts with a per-stream synthetic counter (frame index × 1e6/fps
 *   for video; sample-accurate for audio) so the bridge's chunk constructor
 *   doesn't overflow int64.
 */

import { loadLibav, type LibavVariant } from "./libav-loader.js";
import { VideoRenderer } from "./video-renderer.js";
import { AudioOutput } from "./audio-output.js";
import type { MediaContext } from "../../types.js";
import { pickLibavVariant } from "./variant-routing.js";

export interface DecoderHandles {
  destroy(): Promise<void>;
  /** Seek to the given time in seconds. Returns once the new pump has been kicked off. */
  seek(timeSec: number): Promise<void>;
  stats(): Record<string, unknown>;
}

export interface StartDecoderOptions {
  blob: Blob;
  filename: string;
  context: MediaContext;
  renderer: VideoRenderer;
  audio: AudioOutput;
}

export async function startDecoder(opts: StartDecoderOptions): Promise<DecoderHandles> {
  const variant: LibavVariant = pickLibavVariant(opts.context);
  const libav = (await loadLibav(variant)) as unknown as LibavRuntime;
  const bridge = await loadBridge();

  await libav.mkreadaheadfile(opts.filename, opts.blob);

  // Pre-allocate one AVPacket for ff_read_frame_multi to reuse.
  const readPkt = await libav.av_packet_alloc();

  const [fmt_ctx, streams] = await libav.ff_init_demuxer_file(opts.filename);
  const videoStream = streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_VIDEO) ?? null;
  const audioStream = streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_AUDIO) ?? null;

  if (!videoStream && !audioStream) {
    throw new Error("fallback decoder: file has no decodable streams");
  }

  // ── Set up software decoders ─────────────────────────────────────────
  let videoDec: SoftDecoder | null = null;
  let audioDec: SoftDecoder | null = null;
  let videoTimeBase: [number, number] | undefined;
  let audioTimeBase: [number, number] | undefined;

  if (videoStream) {
    try {
      const [, c, pkt, frame] = await libav.ff_init_decoder(videoStream.codec_id, {
        codecpar: videoStream.codecpar,
      });
      videoDec = { c, pkt, frame };
      if (videoStream.time_base_num && videoStream.time_base_den) {
        videoTimeBase = [videoStream.time_base_num, videoStream.time_base_den];
      }
    } catch (err) {
      console.error("[ubmp] failed to init video decoder:", err);
    }
  }

  if (audioStream) {
    try {
      const [, c, pkt, frame] = await libav.ff_init_decoder(audioStream.codec_id, {
        codecpar: audioStream.codecpar,
      });
      audioDec = { c, pkt, frame };
      if (audioStream.time_base_num && audioStream.time_base_den) {
        audioTimeBase = [audioStream.time_base_num, audioStream.time_base_den];
      }
    } catch (err) {
      console.error("[ubmp] failed to init audio decoder:", err);
    }
  }

  if (!videoDec && !audioDec) {
    await libav.unlinkreadaheadfile(opts.filename).catch(() => {});
    throw new Error("fallback decoder: could not initialize any libav decoders for this file");
  }

  // ── Mutable state shared across pump loops ───────────────────────────
  let destroyed = false;
  let pumpToken = 0;            // bumped on seek; pump loops bail when token changes
  let pumpRunning: Promise<void> | null = null;

  let packetsRead = 0;
  let videoFramesDecoded = 0;
  let audioFramesDecoded = 0;

  // Synthetic timestamp counters. Reset on seek.
  let syntheticVideoUs = 0;
  let syntheticAudioUs = 0;

  const videoTrackInfo = opts.context.videoTracks.find((t) => t.id === videoStream?.index);
  const videoFps = videoTrackInfo?.fps && videoTrackInfo.fps > 0 ? videoTrackInfo.fps : 30;
  const videoFrameStepUs = Math.max(1, Math.round(1_000_000 / videoFps));

  // ── Pump loop ─────────────────────────────────────────────────────────

  async function pumpLoop(myToken: number): Promise<void> {
    while (!destroyed && myToken === pumpToken) {
      let readErr: number;
      let packets: Record<number, LibavPacket[]>;
      try {
        // Smaller batch = fewer frames per decode round = less queue burst.
        // 16 KB ≈ 4 video packets + ~12 audio packets at typical DivX
        // bitrates. The renderer drains ~1 frame per 33ms rAF tick, so
        // keeping bursts ≤ 4-6 frames prevents queue overflow.
        [readErr, packets] = await libav.ff_read_frame_multi(fmt_ctx, readPkt, {
          limit: 16 * 1024,
        });
      } catch (err) {
        console.error("[ubmp] ff_read_frame_multi failed:", err);
        return;
      }

      if (myToken !== pumpToken || destroyed) return;

      const videoPackets = videoStream ? packets[videoStream.index] : undefined;
      const audioPackets = audioStream ? packets[audioStream.index] : undefined;

      if (videoDec && videoPackets && videoPackets.length > 0) {
        await decodeVideoBatch(videoPackets, myToken);
      }
      if (myToken !== pumpToken || destroyed) return;
      if (audioDec && audioPackets && audioPackets.length > 0) {
        await decodeAudioBatch(audioPackets, myToken);
      }

      packetsRead += (videoPackets?.length ?? 0) + (audioPackets?.length ?? 0);

      // Throttle: don't run too far ahead of playback. Two backpressure
      // signals:
      //   - Audio buffer (mediaTimeOfNext - now()) > 2 sec — we have
      //     plenty of audio scheduled.
      //   - Renderer queue depth >= queueHighWater — the canvas can't
      //     drain fast enough. Without this, fast software decode of
      //     small frames piles up in the renderer and overflows.
      while (
        !destroyed &&
        myToken === pumpToken &&
        (opts.audio.bufferAhead() > 2.0 ||
          opts.renderer.queueDepth() >= opts.renderer.queueHighWater)
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }

      if (readErr === libav.AVERROR_EOF) {
        if (videoDec) await decodeVideoBatch([], myToken, /*flush*/ true);
        if (audioDec) await decodeAudioBatch([], myToken, /*flush*/ true);
        return;
      }
      if (readErr && readErr !== 0 && readErr !== -libav.EAGAIN) {
        console.warn("[ubmp] ff_read_frame_multi returned", readErr);
        return;
      }
    }
  }

  async function decodeVideoBatch(pkts: LibavPacket[], myToken: number, flush = false) {
    if (!videoDec || destroyed || myToken !== pumpToken) return;
    let frames: LibavFrame[];
    try {
      frames = await libav.ff_decode_multi(
        videoDec.c,
        videoDec.pkt,
        videoDec.frame,
        pkts,
        flush ? { fin: true, ignoreErrors: true } : { ignoreErrors: true },
      );
    } catch (err) {
      console.error("[ubmp] video decode batch failed:", err);
      return;
    }
    if (myToken !== pumpToken || destroyed) return;

    for (const f of frames) {
      if (myToken !== pumpToken || destroyed) return;
      const bridgeOpts = sanitizeFrameTimestamp(
        f,
        () => {
          const ts = syntheticVideoUs;
          syntheticVideoUs += videoFrameStepUs;
          return ts;
        },
        videoTimeBase,
      );
      try {
        const vf = bridge.laFrameToVideoFrame(f, bridgeOpts);
        opts.renderer.enqueue(vf);
        videoFramesDecoded++;
      } catch (err) {
        if (videoFramesDecoded === 0) {
          console.warn("[ubmp] laFrameToVideoFrame failed:", err);
        }
      }
    }
  }

  async function decodeAudioBatch(pkts: LibavPacket[], myToken: number, flush = false) {
    if (!audioDec || destroyed || myToken !== pumpToken) return;
    let frames: LibavFrame[];
    try {
      frames = await libav.ff_decode_multi(
        audioDec.c,
        audioDec.pkt,
        audioDec.frame,
        pkts,
        flush ? { fin: true, ignoreErrors: true } : { ignoreErrors: true },
      );
    } catch (err) {
      console.error("[ubmp] audio decode batch failed:", err);
      return;
    }
    if (myToken !== pumpToken || destroyed) return;

    for (const f of frames) {
      if (myToken !== pumpToken || destroyed) return;
      sanitizeFrameTimestamp(
        f,
        () => {
          const ts = syntheticAudioUs;
          const samples = f.nb_samples ?? 1024;
          const sampleRate = f.sample_rate ?? 44100;
          syntheticAudioUs += Math.round((samples * 1_000_000) / sampleRate);
          return ts;
        },
        audioTimeBase,
      );
      const samples = libavFrameToInterleavedFloat32(f);
      if (samples) {
        opts.audio.schedule(samples.data, samples.channels, samples.sampleRate);
        audioFramesDecoded++;
      }
    }
  }

  // Kick off the initial pump.
  pumpToken = 1;
  pumpRunning = pumpLoop(pumpToken).catch((err) =>
    console.error("[ubmp] decoder pump failed:", err),
  );

  return {
    async destroy() {
      destroyed = true;
      pumpToken++;
      try { await pumpRunning; } catch { /* ignore */ }
      try { if (videoDec) await libav.ff_free_decoder?.(videoDec.c, videoDec.pkt, videoDec.frame); } catch { /* ignore */ }
      try { if (audioDec) await libav.ff_free_decoder?.(audioDec.c, audioDec.pkt, audioDec.frame); } catch { /* ignore */ }
      try { await libav.av_packet_free?.(readPkt); } catch { /* ignore */ }
      try { await libav.avformat_close_input_js(fmt_ctx); } catch { /* ignore */ }
      try { await libav.unlinkreadaheadfile(opts.filename); } catch { /* ignore */ }
    },

    async seek(timeSec) {
      // Cancel the current pump and wait for it to actually exit before
      // we start moving file pointers around — concurrent ff_decode_multi
      // and av_seek_frame on the same context would be a recipe for memory
      // corruption inside libav.
      const newToken = ++pumpToken;
      if (pumpRunning) {
        try { await pumpRunning; } catch { /* ignore */ }
      }
      if (destroyed) return;

      try {
        // libav.js's `av_seek_frame` takes the timestamp as a *split*
        // (lo, hi) int64 pair, NOT a single number. The function signature
        // is: av_seek_frame(s, stream_index, tsLo, tsHi, flags). Passing a
        // single number put AVSEEK_FLAG_BACKWARD (1) into tsHi, which
        // produced a bogus int64 = 4.29e9 + tsLo ≈ 73 min for any small
        // seek target — seeking past EOF and stalling the pump.
        const tsUs = Math.floor(timeSec * 1_000_000);
        const [tsLo, tsHi] = libav.f64toi64
          ? libav.f64toi64(tsUs)
          : [tsUs | 0, Math.floor(tsUs / 0x100000000)];
        await libav.av_seek_frame(
          fmt_ctx,
          -1,
          tsLo,
          tsHi,
          libav.AVSEEK_FLAG_BACKWARD ?? 0,
        );
      } catch (err) {
        console.warn("[ubmp] av_seek_frame failed:", err);
      }

      // Reset the decoder state. After the previous pump exited via the
      // EOF path it called ff_decode_multi with `fin: true`, which sends a
      // NULL packet to the decoder and puts it in drain mode — meaning all
      // subsequent decode calls return EOF. `avcodec_flush_buffers` clears
      // that state so a fresh stream of post-seek packets is accepted.
      // Also clears any internal frame reordering buffer, which is what we
      // want anyway since we just changed positions.
      try {
        if (videoDec) await libav.avcodec_flush_buffers?.(videoDec.c);
      } catch { /* ignore */ }
      try {
        if (audioDec) await libav.avcodec_flush_buffers?.(audioDec.c);
      } catch { /* ignore */ }

      // Reset synthetic timestamp counters to the seek target so newly
      // decoded frames start at the right media time.
      syntheticVideoUs = Math.round(timeSec * 1_000_000);
      syntheticAudioUs = Math.round(timeSec * 1_000_000);

      // The renderer & audio output are reset by the fallback session
      // wrapper that called us — see strategies/fallback/index.ts.

      // Start a fresh pump for the new token.
      pumpRunning = pumpLoop(newToken).catch((err) =>
        console.error("[ubmp] decoder pump failed (post-seek):", err),
      );
    },

    stats() {
      return {
        decoderType: "libav-wasm",
        packetsRead,
        videoFramesDecoded,
        audioFramesDecoded,
        ...opts.renderer.stats(),
        ...opts.audio.stats(),
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame timestamp sanitizer.
//
// libav can hand back decoded frames with `pts = AV_NOPTS_VALUE` (encoded as
// ptshi = -2147483648, pts = 0) for inputs whose demuxer can't determine
// presentation times. AVI is the canonical example. The bridge's
// `laFrameToVideoFrame` then multiplies pts × 1e6 × tbNum / tbDen and
// overflows int64, throwing "Value is outside the 'long long' value range".
//
// Fix: replace any invalid pts with a synthetic microsecond counter, force
// the frame's pts/ptshi to that value, and tell the bridge to use a 1/1e6
// timebase so it does an identity conversion.
// ─────────────────────────────────────────────────────────────────────────────

interface BridgeOpts {
  timeBase?: [number, number];
  transfer?: boolean;
}

function sanitizeFrameTimestamp(
  frame: LibavFrame,
  nextUs: () => number,
  fallbackTimeBase?: [number, number],
): BridgeOpts {
  const lo = frame.pts ?? 0;
  const hi = frame.ptshi ?? 0;
  const isInvalid = (hi === -2147483648 && lo === 0) || !Number.isFinite(lo);
  if (isInvalid) {
    const us = nextUs();
    frame.pts = us;
    frame.ptshi = 0;
    return { timeBase: [1, 1_000_000] };
  }
  const tb = fallbackTimeBase ?? [1, 1_000_000];
  const pts64 = hi * 0x100000000 + lo;
  const us = Math.round((pts64 * 1_000_000 * tb[0]) / tb[1]);
  if (Number.isFinite(us) && Math.abs(us) <= Number.MAX_SAFE_INTEGER) {
    frame.pts = us;
    frame.ptshi = us < 0 ? -1 : 0;
    return { timeBase: [1, 1_000_000] };
  }
  const fallback = nextUs();
  frame.pts = fallback;
  frame.ptshi = 0;
  return { timeBase: [1, 1_000_000] };
}

// ─────────────────────────────────────────────────────────────────────────────
// libav decoded `Frame` → interleaved Float32Array (the format AudioOutput
// schedules).
// ─────────────────────────────────────────────────────────────────────────────

const AV_SAMPLE_FMT_U8 = 0;
const AV_SAMPLE_FMT_S16 = 1;
const AV_SAMPLE_FMT_S32 = 2;
const AV_SAMPLE_FMT_FLT = 3;
const AV_SAMPLE_FMT_U8P = 5;
const AV_SAMPLE_FMT_S16P = 6;
const AV_SAMPLE_FMT_S32P = 7;
const AV_SAMPLE_FMT_FLTP = 8;

interface InterleavedSamples {
  data: Float32Array;
  channels: number;
  sampleRate: number;
}

function libavFrameToInterleavedFloat32(frame: LibavFrame): InterleavedSamples | null {
  const channels = frame.channels ?? frame.ch_layout_nb_channels ?? 1;
  const sampleRate = frame.sample_rate ?? 44100;
  const nbSamples = frame.nb_samples ?? 0;
  if (nbSamples === 0) return null;

  const out = new Float32Array(nbSamples * channels);

  switch (frame.format) {
    case AV_SAMPLE_FMT_FLTP: {
      const planes = ensurePlanes(frame.data, channels);
      for (let ch = 0; ch < channels; ch++) {
        const plane = asFloat32(planes[ch]);
        for (let i = 0; i < nbSamples; i++) out[i * channels + ch] = plane[i];
      }
      return { data: out, channels, sampleRate };
    }
    case AV_SAMPLE_FMT_FLT: {
      const flat = asFloat32(frame.data);
      for (let i = 0; i < nbSamples * channels; i++) out[i] = flat[i];
      return { data: out, channels, sampleRate };
    }
    case AV_SAMPLE_FMT_S16P: {
      const planes = ensurePlanes(frame.data, channels);
      for (let ch = 0; ch < channels; ch++) {
        const plane = asInt16(planes[ch]);
        for (let i = 0; i < nbSamples; i++) out[i * channels + ch] = plane[i] / 32768;
      }
      return { data: out, channels, sampleRate };
    }
    case AV_SAMPLE_FMT_S16: {
      const flat = asInt16(frame.data);
      for (let i = 0; i < nbSamples * channels; i++) out[i] = flat[i] / 32768;
      return { data: out, channels, sampleRate };
    }
    case AV_SAMPLE_FMT_S32P: {
      const planes = ensurePlanes(frame.data, channels);
      for (let ch = 0; ch < channels; ch++) {
        const plane = asInt32(planes[ch]);
        for (let i = 0; i < nbSamples; i++) out[i * channels + ch] = plane[i] / 2147483648;
      }
      return { data: out, channels, sampleRate };
    }
    case AV_SAMPLE_FMT_S32: {
      const flat = asInt32(frame.data);
      for (let i = 0; i < nbSamples * channels; i++) out[i] = flat[i] / 2147483648;
      return { data: out, channels, sampleRate };
    }
    case AV_SAMPLE_FMT_U8P: {
      const planes = ensurePlanes(frame.data, channels);
      for (let ch = 0; ch < channels; ch++) {
        const plane = asUint8(planes[ch]);
        for (let i = 0; i < nbSamples; i++) out[i * channels + ch] = (plane[i] - 128) / 128;
      }
      return { data: out, channels, sampleRate };
    }
    case AV_SAMPLE_FMT_U8: {
      const flat = asUint8(frame.data);
      for (let i = 0; i < nbSamples * channels; i++) out[i] = (flat[i] - 128) / 128;
      return { data: out, channels, sampleRate };
    }
    default:
      if (!(globalThis as { __ubmpLoggedSampleFmt?: number }).__ubmpLoggedSampleFmt) {
        (globalThis as { __ubmpLoggedSampleFmt?: number }).__ubmpLoggedSampleFmt = frame.format;
        console.warn(`[ubmp] unsupported audio sample format from libav: ${frame.format}`);
      }
      return null;
  }
}

function ensurePlanes(data: unknown, channels: number): unknown[] {
  if (Array.isArray(data)) return data;
  const arr = data as { length: number; subarray?: (a: number, b: number) => unknown };
  const len = arr.length;
  const perChannel = Math.floor(len / channels);
  const planes: unknown[] = [];
  for (let ch = 0; ch < channels; ch++) {
    planes.push(arr.subarray ? arr.subarray(ch * perChannel, (ch + 1) * perChannel) : arr);
  }
  return planes;
}

function asFloat32(x: unknown): Float32Array {
  if (x instanceof Float32Array) return x;
  const ta = x as { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
  return new Float32Array(ta.buffer, ta.byteOffset, ta.byteLength / 4);
}
function asInt16(x: unknown): Int16Array {
  if (x instanceof Int16Array) return x;
  const ta = x as { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
  return new Int16Array(ta.buffer, ta.byteOffset, ta.byteLength / 2);
}
function asInt32(x: unknown): Int32Array {
  if (x instanceof Int32Array) return x;
  const ta = x as { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
  return new Int32Array(ta.buffer, ta.byteOffset, ta.byteLength / 4);
}
function asUint8(x: unknown): Uint8Array {
  if (x instanceof Uint8Array) return x;
  const ta = x as { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
  return new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridge loader (lazy via the static-import wrapper).
// ─────────────────────────────────────────────────────────────────────────────

async function loadBridge(): Promise<BridgeModule> {
  try {
    const wrapper = await import("./libav-import.js");
    return wrapper.libavBridge as unknown as BridgeModule;
  } catch (err) {
    throw new Error(
      `failed to load libavjs-webcodecs-bridge — install the optional peer deps with: ` +
        `npm i libavjs-webcodecs-bridge @libav.js/variant-webcodecs. ` +
        `(${(err as Error).message})`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural types.
// ─────────────────────────────────────────────────────────────────────────────

interface SoftDecoder {
  c: number;
  pkt: number;
  frame: number;
}

interface LibavStream {
  index: number;
  codec_type: number;
  codec_id: number;
  codecpar: number;
  time_base_num?: number;
  time_base_den?: number;
}

interface LibavPacket {
  data: Uint8Array;
  pts: number;
  ptshi?: number;
  duration?: number;
  durationhi?: number;
  flags: number;
  stream_index: number;
  time_base_num?: number;
  time_base_den?: number;
}

interface LibavFrame {
  data: unknown;
  format: number;
  channels?: number;
  ch_layout_nb_channels?: number;
  sample_rate?: number;
  nb_samples?: number;
  pts?: number;
  ptshi?: number;
  width?: number;
  height?: number;
}

interface LibavRuntime {
  AVMEDIA_TYPE_VIDEO: number;
  AVMEDIA_TYPE_AUDIO: number;
  AVERROR_EOF: number;
  EAGAIN: number;
  AVSEEK_FLAG_BACKWARD?: number;

  mkreadaheadfile(name: string, blob: Blob): Promise<void>;
  unlinkreadaheadfile(name: string): Promise<void>;
  ff_init_demuxer_file(name: string): Promise<[number, LibavStream[]]>;
  ff_read_frame_multi(
    fmt_ctx: number,
    pkt: number,
    opts?: { limit?: number },
  ): Promise<[number, Record<number, LibavPacket[]>]>;
  ff_init_decoder(
    codec: number | string,
    config?: { codecpar?: number; time_base?: [number, number] },
  ): Promise<[number, number, number, number]>;
  ff_decode_multi(
    c: number,
    pkt: number,
    frame: number,
    packets: LibavPacket[],
    opts?: { fin?: boolean; ignoreErrors?: boolean },
  ): Promise<LibavFrame[]>;
  ff_free_decoder?(c: number, pkt: number, frame: number): Promise<void>;
  av_packet_alloc(): Promise<number>;
  av_packet_free?(pkt: number): Promise<void>;
  av_seek_frame(
    fmt_ctx: number,
    stream: number,
    tsLo: number,
    tsHi: number,
    flags: number,
  ): Promise<number>;
  avcodec_flush_buffers?(c: number): Promise<void>;
  avformat_close_input_js(ctx: number): Promise<void>;
  /** Sync helper exposed by libav.js: split a JS number into (lo, hi) int64. */
  f64toi64?(val: number): [number, number];
}

interface BridgeModule {
  laFrameToVideoFrame(
    frame: LibavFrame,
    opts?: { VideoFrame?: unknown; timeBase?: [number, number]; transfer?: boolean },
  ): VideoFrame;
  laFrameToAudioData(
    frame: LibavFrame,
    opts?: { AudioData?: unknown; timeBase?: [number, number] },
  ): AudioData;
}
