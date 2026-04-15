/**
 * Shared libav demux session. Opens a libav demuxer over a NormalizedSource
 * and provides a linear, cancellable packet pump.
 *
 * Phase 1 API: deliberately minimal. The first consumer is the AVI/ASF/FLV
 * transcode path (src/convert/transcode-libav.ts), which is strictly linear.
 * No seek, no track swapping — those were added to hybrid/fallback's
 * private pumps for playback reasons. When those paths migrate here, the
 * API will grow to cover their needs.
 *
 * The shared timestamp sanitizers (sanitizePacketTimestamp,
 * sanitizeFrameTimestamp) also live here. They were previously duplicated
 * in convert/remux.ts and strategies/hybrid/decoder.ts. The duplicates
 * stay put in Phase 1 with TODO pointers; migration is a follow-up.
 */

import { loadLibav, type LibavVariant } from "../strategies/fallback/libav-loader.js";
import { pickLibavVariant } from "../strategies/fallback/variant-routing.js";
import { prepareLibavInput } from "./libav-http-reader.js";
import type { MediaContext, TransportConfig } from "../types.js";
import type { NormalizedSource } from "./source.js";

// ─────────────────────────────────────────────────────────────────────────
// Structural types (mirror libav.js' shape without dragging in its types)
// ─────────────────────────────────────────────────────────────────────────

export interface LibavStream {
  index: number;
  codec_type: number;
  codec_id: number;
  codecpar: number;
  time_base_num?: number;
  time_base_den?: number;
}

export interface LibavPacket {
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

export interface LibavFrame {
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

  mkreadaheadfile(name: string, blob: Blob): Promise<void>;
  unlinkreadaheadfile(name: string): Promise<void>;
  ff_init_demuxer_file(name: string): Promise<[number, LibavStream[]]>;
  ff_read_frame_multi(
    fmt_ctx: number,
    pkt: number,
    opts?: { limit?: number },
  ): Promise<[number, Record<number, LibavPacket[]>]>;
  av_packet_alloc(): Promise<number>;
  av_packet_free?(pkt: number): Promise<void>;
  avformat_close_input_js(ctx: number): Promise<void>;
  f64toi64?(val: number): [number, number];
}

// ─────────────────────────────────────────────────────────────────────────
// Session
// ─────────────────────────────────────────────────────────────────────────

export interface LibavDemuxSession {
  readonly libav: LibavRuntime;
  readonly fmtCtx: number;
  readonly streams: LibavStream[];
  readonly videoStream: LibavStream | null;
  readonly audioStream: LibavStream | null;
  /** True when the input is being streamed via HTTP Range requests. */
  readonly transport: "http-range" | "blob";
  /**
   * Linear read-to-EOF pump. Invokes the callbacks for each
   * ff_read_frame_multi batch (audio is handed over before video per
   * batch, matching the audio-first ordering that the hybrid/fallback
   * playback pumps use — see POSTMORTEMS.md entry 1).
   *
   * Honors the AbortSignal between batches. Invokes `onEof` once when
   * the demuxer returns EOF. Does NOT handle seek.
   */
  pump(cb: {
    onVideoPackets?: (pkts: LibavPacket[]) => Promise<void>;
    onAudioPackets?: (pkts: LibavPacket[]) => Promise<void>;
    onEof?: () => Promise<void>;
    signal?: AbortSignal;
  }): Promise<void>;
  destroy(): Promise<void>;
}

export interface OpenLibavDemuxOptions {
  source: NormalizedSource;
  filename: string;
  context: MediaContext;
  transport?: TransportConfig;
  /** Override automatic variant picking. Defaults to pickLibavVariant(context). */
  variant?: LibavVariant;
}

export async function openLibavDemux(opts: OpenLibavDemuxOptions): Promise<LibavDemuxSession> {
  const variant: LibavVariant = opts.variant ?? pickLibavVariant(opts.context);
  const libav = (await loadLibav(variant)) as unknown as LibavRuntime;

  const inputHandle = await prepareLibavInput(
    libav as unknown as Parameters<typeof prepareLibavInput>[0],
    opts.filename,
    opts.source,
    opts.transport,
  );

  const readPkt = await libav.av_packet_alloc();
  const [fmtCtx, streams] = await libav.ff_init_demuxer_file(opts.filename);
  const videoStream = streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_VIDEO) ?? null;
  const audioStream = streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_AUDIO) ?? null;

  let destroyed = false;

  async function pump(cb: Parameters<LibavDemuxSession["pump"]>[0]): Promise<void> {
    while (!destroyed) {
      if (cb.signal?.aborted) return;

      let readErr: number;
      let packets: Record<number, LibavPacket[]>;
      try {
        [readErr, packets] = await libav.ff_read_frame_multi(fmtCtx, readPkt, {
          // 16 KB batch — chosen so each read produces a handful of
          // packets, keeping downstream queues bounded. Same rationale
          // as the hybrid/fallback pumps (see CLAUDE.md note).
          limit: 16 * 1024,
        });
      } catch (err) {
        throw new Error(`libav-demux: ff_read_frame_multi failed: ${(err as Error).message}`);
      }

      if (destroyed || cb.signal?.aborted) return;

      const videoPackets = videoStream ? packets[videoStream.index] : undefined;
      const audioPackets = audioStream ? packets[audioStream.index] : undefined;

      // Audio-first ordering. Audio decode is cheap; video decode can
      // be expensive. Feeding audio first ensures the audio consumer
      // has samples to work with before any long video-decode block.
      if (cb.onAudioPackets && audioPackets && audioPackets.length > 0) {
        await cb.onAudioPackets(audioPackets);
      }
      if (destroyed || cb.signal?.aborted) return;
      if (cb.onVideoPackets && videoPackets && videoPackets.length > 0) {
        await cb.onVideoPackets(videoPackets);
      }

      if (readErr === libav.AVERROR_EOF) {
        if (cb.onEof) await cb.onEof();
        return;
      }
      if (readErr && readErr !== 0 && readErr !== -libav.EAGAIN) {
        throw new Error(`libav-demux: ff_read_frame_multi returned ${readErr}`);
      }
    }
  }

  async function destroy(): Promise<void> {
    destroyed = true;
    try { await libav.av_packet_free?.(readPkt); } catch { /* ignore */ }
    try { await libav.avformat_close_input_js(fmtCtx); } catch { /* ignore */ }
    try { await inputHandle.detach(); } catch { /* ignore */ }
  }

  return {
    libav,
    fmtCtx,
    streams,
    videoStream,
    audioStream,
    transport: inputHandle.transport,
    pump,
    destroy,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Timestamp sanitizers (extracted from convert/remux.ts + hybrid/decoder.ts)
//
// libav can hand us packets/frames with pts = AV_NOPTS_VALUE (encoded as
// ptshi = -2147483648, pts = 0) for inputs whose demuxer can't determine
// presentation times. AVI is the canonical example. Downstream consumers
// that treat pts as int64 overflow and throw.
//
// The sanitizer replaces invalid pts with a synthetic microsecond counter,
// and normalizes valid pts to a 1/1e6 time_base so consumers don't need
// to track the source time_base per packet.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Sanitize a libav packet's timestamp. Mutates `pkt` in place.
 * If the packet has AV_NOPTS_VALUE, replaces pts with `nextUs()`.
 * Otherwise normalizes to µs with time_base = 1/1_000_000.
 */
export function sanitizePacketTimestamp(
  pkt: LibavPacket,
  nextUs: () => number,
  fallbackTimeBase?: [number, number],
): void {
  const lo = pkt.pts ?? 0;
  const hi = pkt.ptshi ?? 0;
  const isInvalid = (hi === -2147483648 && lo === 0) || !Number.isFinite(lo);
  if (isInvalid) {
    const us = nextUs();
    pkt.pts = us;
    pkt.ptshi = 0;
    pkt.time_base_num = 1;
    pkt.time_base_den = 1_000_000;
    return;
  }
  const tb = fallbackTimeBase ?? [1, 1_000_000];
  const pts64 = hi * 0x100000000 + lo;
  const us = Math.round((pts64 * 1_000_000 * tb[0]) / tb[1]);
  if (Number.isFinite(us) && Math.abs(us) <= Number.MAX_SAFE_INTEGER) {
    pkt.pts = us;
    pkt.ptshi = us < 0 ? -1 : 0;
    pkt.time_base_num = 1;
    pkt.time_base_den = 1_000_000;
    return;
  }
  const fallback = nextUs();
  pkt.pts = fallback;
  pkt.ptshi = 0;
  pkt.time_base_num = 1;
  pkt.time_base_den = 1_000_000;
}

/**
 * Convert a raw libav packet's pts to seconds using the given stream
 * time_base, or return `null` if the packet lacks a valid pts. Used by
 * the hybrid + fallback strategies to track the demuxer's read-ahead
 * progress (the signal behind `<video>.buffered` on canvas strategies).
 *
 * Separate from `sanitizePacketTimestamp` — sanitization mutates the
 * packet and happens right before decoder feed; this peeks at the
 * timestamp earlier in the pump so we can track buffered extent without
 * perturbing the decode path.
 */
export function packetPtsSec(
  pkt: Pick<LibavPacket, "pts" | "ptshi">,
  timeBase: [number, number] | undefined,
): number | null {
  const lo = pkt.pts ?? 0;
  const hi = pkt.ptshi ?? 0;
  const isInvalid = (hi === -2147483648 && lo === 0) || !Number.isFinite(lo);
  if (isInvalid) return null;
  const tb = timeBase ?? [1, 1_000_000];
  if (!tb[0] || !tb[1]) return null;
  const pts64 = hi * 0x100000000 + lo;
  const sec = (pts64 * tb[0]) / tb[1];
  return Number.isFinite(sec) ? sec : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Audio frame → interleaved Float32 (extracted from
// strategies/hybrid/decoder.ts + strategies/fallback/decoder.ts).
//
// libav hands us decoded audio frames in whichever sample format the codec
// uses (FLTP, S16P, etc.). Most downstream consumers (Web Audio, WebCodecs
// AudioEncoder) want interleaved Float32. This does the conversion without
// any dependencies.
// ─────────────────────────────────────────────────────────────────────────

const AV_SAMPLE_FMT_U8 = 0;
const AV_SAMPLE_FMT_S16 = 1;
const AV_SAMPLE_FMT_S32 = 2;
const AV_SAMPLE_FMT_FLT = 3;
const AV_SAMPLE_FMT_U8P = 5;
const AV_SAMPLE_FMT_S16P = 6;
const AV_SAMPLE_FMT_S32P = 7;
const AV_SAMPLE_FMT_FLTP = 8;

export interface InterleavedSamples {
  data: Float32Array;
  channels: number;
  sampleRate: number;
}

export function libavFrameToInterleavedFloat32(frame: LibavFrame): InterleavedSamples | null {
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

/**
 * Sanitize a decoded frame's timestamp. Mutates `frame` in place.
 * Returns nothing; callers that want derived metadata (e.g. a
 * VideoFrame timestamp in µs) should read `frame.pts` after calling.
 */
export function sanitizeFrameTimestamp(
  frame: LibavFrame,
  nextUs: () => number,
  fallbackTimeBase?: [number, number],
): void {
  const lo = frame.pts ?? 0;
  const hi = frame.ptshi ?? 0;
  const isInvalid = (hi === -2147483648 && lo === 0) || !Number.isFinite(lo);
  if (isInvalid) {
    const us = nextUs();
    frame.pts = us;
    frame.ptshi = 0;
    return;
  }
  const tb = fallbackTimeBase ?? [1, 1_000_000];
  const pts64 = hi * 0x100000000 + lo;
  const us = Math.round((pts64 * 1_000_000 * tb[0]) / tb[1]);
  if (Number.isFinite(us) && Math.abs(us) <= Number.MAX_SAFE_INTEGER) {
    frame.pts = us;
    frame.ptshi = us < 0 ? -1 : 0;
    return;
  }
  const fallback = nextUs();
  frame.pts = fallback;
  frame.ptshi = 0;
}
