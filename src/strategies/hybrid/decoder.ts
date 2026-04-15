/**
 * Hybrid decoder: libav.js demux + WebCodecs VideoDecoder + libav audio decode.
 *
 * This is the hardware-accelerated path for files in containers mediabunny
 * can't read (AVI, ASF, FLV) but whose codecs ARE browser-supported.
 * libav.js handles demuxing, then:
 *
 * - **Video**: bridge.packetToEncodedVideoChunk → VideoDecoder (hardware)
 * - **Audio**: libav ff_decode_multi (software). Chrome's AudioDecoder
 *   rejects raw MP3 packets from AVI, and audio decode is cheap enough
 *   that software decode is fine.
 *
 * The demux pump loop, seek handling, and synthetic timestamp logic mirror
 * fallback/decoder.ts. The key difference is the video decode path.
 */

import { loadLibav, type LibavVariant } from "../fallback/libav-loader.js";
import { VideoRenderer } from "../fallback/video-renderer.js";
import { AudioOutput } from "../fallback/audio-output.js";
import type { MediaContext } from "../../types.js";
import { dbg } from "../../util/debug.js";
import { pickLibavVariant } from "../fallback/variant-routing.js";
import {
  sanitizePacketTimestamp,
  sanitizeFrameTimestamp,
  libavFrameToInterleavedFloat32,
  packetPtsSec,
} from "../../util/libav-demux.js";

export interface HybridDecoderHandles {
  destroy(): Promise<void>;
  seek(timeSec: number): Promise<void>;
  /** Swap the active audio track — rebuilds the libav audio decoder + reseeks. */
  setAudioTrack(trackId: number, timeSec: number): Promise<void>;
  stats(): Record<string, unknown>;
  onFatalError(handler: (reason: string) => void): void;
  /**
   * The demuxer's read-ahead frontier in seconds — the highest pts
   * observed on any packet handed back from `ff_read_frame_multi`.
   * Monotonically non-decreasing: seeks don't reset it, since the
   * frontier represents "how far we've ever demuxed through this
   * source," which matches what a seek-bar buffered indicator should
   * show. Backs `<video>.buffered` on canvas strategies. Returns 0
   * before any valid pts have been seen (some AVI/FLV sources may
   * never reach this — their `buffered` stays empty).
   */
  bufferedUntilSec(): number;
}

export interface StartHybridDecoderOptions {
  /** Normalized source — either a Blob in memory or a URL we'll stream via Range requests. */
  source: import("../../util/source.js").NormalizedSource;
  filename: string;
  context: MediaContext;
  renderer: VideoRenderer;
  audio: AudioOutput;
  transport?: import("../../types.js").TransportConfig;
}

export async function startHybridDecoder(opts: StartHybridDecoderOptions): Promise<HybridDecoderHandles> {
  const variant: LibavVariant = pickLibavVariant(opts.context);
  const libav = (await loadLibav(variant)) as unknown as LibavRuntime;
  const bridge = await loadBridge();

  // For URL sources, prepareLibavInput attaches an HTTP block reader so
  // libav demuxes via Range requests. For Blob sources, it falls back to
  // mkreadaheadfile (in-memory). The returned handle owns cleanup.
  const { prepareLibavInput } = await import("../../util/libav-http-reader.js");
  const inputHandle = await prepareLibavInput(libav as unknown as Parameters<typeof prepareLibavInput>[0], opts.filename, opts.source, opts.transport);

  const readPkt = await libav.av_packet_alloc();
  const [fmt_ctx, streams] = await libav.ff_init_demuxer_file(opts.filename);
  const videoStream = streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_VIDEO) ?? null;
  // Audio stream is mutable (setAudioTrack swaps it). Prefer the id the
  // probe layer listed first so both entry points agree.
  const firstAudioTrackId = opts.context.audioTracks[0]?.id;
  let audioStream: LibavStream | null =
    (firstAudioTrackId != null
      ? streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_AUDIO && s.index === firstAudioTrackId)
      : undefined) ??
    streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_AUDIO) ?? null;

  if (!videoStream && !audioStream) {
    throw new Error("hybrid decoder: file has no decodable streams");
  }

  // ── Fatal error callback ──────────────────────────────────────────────
  let fatalHandler: ((reason: string) => void) | null = null;
  let fatalFired = false;

  function fireFatal(reason: string): void {
    if (fatalFired) return;
    fatalFired = true;
    fatalHandler?.(reason);
  }

  // ── WebCodecs VideoDecoder ────────────────────────────────────────────
  let videoDecoder: VideoDecoder | null = null;
  let videoTimeBase: [number, number] | undefined;

  if (videoStream) {
    try {
      const config = await bridge.videoStreamToConfig(libav, videoStream);
      if (!config) throw new Error("bridge returned null config");

      const supported = await VideoDecoder.isConfigSupported(config);
      if (!supported.supported) throw new Error(`VideoDecoder does not support config: ${JSON.stringify(config)}`);

      videoDecoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
          opts.renderer.enqueue(frame);
          videoFramesDecoded++;
        },
        error: (err: DOMException) => {
          console.error("[avbridge] WebCodecs VideoDecoder error:", err);
          fireFatal(`WebCodecs VideoDecoder error: ${err.message}`);
        },
      });
      videoDecoder.configure(config);

      if (videoStream.time_base_num && videoStream.time_base_den) {
        videoTimeBase = [videoStream.time_base_num, videoStream.time_base_den];
      }
    } catch (err) {
      console.error("[avbridge] hybrid: failed to init WebCodecs VideoDecoder:", err);
      fireFatal(`WebCodecs VideoDecoder init failed: ${(err as Error).message}`);
      // Clean up and throw — the player will escalate to fallback
      await inputHandle.detach().catch(() => {});
      throw err;
    }
  }

  // ── libav software AudioDecoder ───────────────────────────────────────
  let audioDec: SoftDecoder | null = null;
  let audioTimeBase: [number, number] | undefined;

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
      console.warn(
        "[avbridge] hybrid: audio decoder unavailable for this codec — playing video with wall-clock timing:",
        (err as Error).message,
      );
    }
  }

  // No audio decoder? Switch the audio output into wall-clock mode so the
  // video renderer doesn't stall waiting for an audio clock that never starts.
  if (!audioDec) {
    opts.audio.setNoAudio();
  }

  if (!videoDecoder && !audioDec) {
    await inputHandle.detach().catch(() => {});
    throw new Error("hybrid decoder: could not initialize any decoders");
  }

  // ── Bitstream filter for MPEG-4 Part 2 packed B-frames ───────────────
  let bsfCtx: number | null = null;
  let bsfPkt: number | null = null;
  if (videoStream && opts.context.videoTracks[0]?.codec === "mpeg4") {
    try {
      bsfCtx = await libav.av_bsf_list_parse_str_js("mpeg4_unpack_bframes");
      if (bsfCtx != null && bsfCtx >= 0) {
        const parIn = await libav.AVBSFContext_par_in(bsfCtx);
        await libav.avcodec_parameters_copy(parIn, videoStream.codecpar);
        await libav.av_bsf_init(bsfCtx);
        bsfPkt = await libav.av_packet_alloc();
        dbg.info("bsf", "mpeg4_unpack_bframes BSF active (hybrid)");
      } else {
        // eslint-disable-next-line no-console
        console.warn("[avbridge] mpeg4_unpack_bframes BSF not available in hybrid decoder");
        bsfCtx = null;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[avbridge] hybrid: failed to init BSF:", (err as Error).message);
      bsfCtx = null;
      bsfPkt = null;
    }
  }

  async function applyBSF(packets: LibavPacket[]): Promise<LibavPacket[]> {
    if (!bsfCtx || !bsfPkt) return packets;
    const out: LibavPacket[] = [];
    for (const pkt of packets) {
      await libav.ff_copyin_packet(bsfPkt, pkt);
      const sendErr = await libav.av_bsf_send_packet(bsfCtx, bsfPkt);
      if (sendErr < 0) { out.push(pkt); continue; }
      while (true) {
        const recvErr = await libav.av_bsf_receive_packet(bsfCtx, bsfPkt);
        if (recvErr < 0) break;
        out.push(await libav.ff_copyout_packet(bsfPkt));
      }
    }
    return out;
  }

  async function flushBSF(): Promise<void> {
    if (!bsfCtx || !bsfPkt) return;
    try {
      await libav.av_bsf_send_packet(bsfCtx, 0);
      while (true) {
        const err = await libav.av_bsf_receive_packet(bsfCtx, bsfPkt);
        if (err < 0) break;
      }
    } catch { /* ignore */ }
  }

  // ── Mutable state ─────────────────────────────────────────────────────
  let destroyed = false;
  let pumpToken = 0;
  let pumpRunning: Promise<void> | null = null;

  let packetsRead = 0;
  let videoFramesDecoded = 0;
  let audioFramesDecoded = 0;
  let videoChunksFed = 0;
  let bufferedUntilSec = 0;

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
        [readErr, packets] = await libav.ff_read_frame_multi(fmt_ctx, readPkt, {
          limit: 16 * 1024,
        });
      } catch (err) {
        console.error("[avbridge] hybrid ff_read_frame_multi failed:", err);
        return;
      }

      if (myToken !== pumpToken || destroyed) return;

      const videoPackets = videoStream ? packets[videoStream.index] : undefined;
      const audioPackets = audioStream ? packets[audioStream.index] : undefined;

      // Track how far the demuxer has read through the source — the
      // signal behind `<video>.buffered` on this strategy. Peek at raw
      // packet pts using each stream's native time_base (before the
      // sanitizePacketTimestamp call later in the loop, which
      // overwrites to µs). Monotonic: we never walk it backward.
      if (videoPackets && videoTimeBase) {
        for (const pkt of videoPackets) {
          const sec = packetPtsSec(pkt, videoTimeBase);
          if (sec != null && sec > bufferedUntilSec) bufferedUntilSec = sec;
        }
      }
      if (audioPackets && audioTimeBase) {
        for (const pkt of audioPackets) {
          const sec = packetPtsSec(pkt, audioTimeBase);
          if (sec != null && sec > bufferedUntilSec) bufferedUntilSec = sec;
        }
      }

      // Decode audio BEFORE video. Same rationale as fallback decoder
      // (POSTMORTEMS.md entry 1, fix #2): audio decode via libav's
      // ff_decode_multi is a blocking WASM call that prevents rAF from
      // firing. For heavy codecs like DTS, a single batch can take
      // 10-50 ms. Processing audio first ensures the audio scheduler is
      // fed before video decode starts, reducing perceived stutter.
      if (audioDec && audioPackets && audioPackets.length > 0) {
        await decodeAudioBatch(audioPackets, myToken);
      }
      if (myToken !== pumpToken || destroyed) return;

      // Yield to the event loop so the video renderer's rAF callback
      // can fire between the audio decode (blocking) and the video feed
      // (async). Without this, the renderer starves during DTS decode.
      await new Promise((r) => setTimeout(r, 0));
      if (myToken !== pumpToken || destroyed) return;

      // Feed video packets to WebCodecs VideoDecoder (after BSF if applicable)
      if (videoDecoder && videoPackets && videoPackets.length > 0) {
        const processed = await applyBSF(videoPackets);
        for (const pkt of processed) {
          if (myToken !== pumpToken || destroyed) return;
          sanitizePacketTimestamp(pkt, () => {
            const ts = syntheticVideoUs;
            syntheticVideoUs += videoFrameStepUs;
            return ts;
          }, videoTimeBase);
          try {
            const chunk = bridge.packetToEncodedVideoChunk(pkt, videoStream);
            videoDecoder.decode(chunk);
            videoChunksFed++;
          } catch (err) {
            if (videoChunksFed === 0) {
              console.warn("[avbridge] hybrid: packetToEncodedVideoChunk failed:", err);
              fireFatal(`WebCodecs chunk creation failed: ${(err as Error).message}`);
              return;
            }
          }
        }
      }

      packetsRead += (videoPackets?.length ?? 0) + (audioPackets?.length ?? 0);

      // Backpressure: WebCodecs decodeQueueSize + audio buffer + renderer queue
      while (
        !destroyed &&
        myToken === pumpToken &&
        ((videoDecoder && videoDecoder.decodeQueueSize > 10) ||
          opts.audio.bufferAhead() > 2.0 ||
          opts.renderer.queueDepth() >= opts.renderer.queueHighWater)
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }

      if (readErr === libav.AVERROR_EOF) {
        // Flush WebCodecs decoder
        if (videoDecoder && videoDecoder.state === "configured") {
          try { await videoDecoder.flush(); } catch { /* ignore */ }
        }
        // Flush libav audio decoder
        if (audioDec) await decodeAudioBatch([], myToken, true);
        return;
      }
      if (readErr && readErr !== 0 && readErr !== -libav.EAGAIN) {
        console.warn("[avbridge] hybrid ff_read_frame_multi returned", readErr);
        return;
      }
    }
  }

  async function decodeAudioBatch(pkts: LibavPacket[], myToken: number, flush = false) {
    if (!audioDec || destroyed || myToken !== pumpToken) return;

    // For heavy codecs (DTS, AC3), decode in small sub-batches and yield
    // between them so the event loop can run rAF for video painting.
    // Each ff_decode_multi call is a blocking WASM invocation.
    const AUDIO_SUB_BATCH = 4; // packets per sub-batch
    let allFrames: LibavFrame[] = [];

    for (let i = 0; i < pkts.length; i += AUDIO_SUB_BATCH) {
      if (myToken !== pumpToken || destroyed) return;
      const slice = pkts.slice(i, i + AUDIO_SUB_BATCH);
      const isLast = i + AUDIO_SUB_BATCH >= pkts.length;
      try {
        const frames = await libav.ff_decode_multi(
          audioDec.c,
          audioDec.pkt,
          audioDec.frame,
          slice,
          isLast && flush ? { fin: true, ignoreErrors: true } : { ignoreErrors: true },
        );
        allFrames = allFrames.concat(frames);
      } catch (err) {
        console.error("[avbridge] hybrid audio decode failed:", err);
        return;
      }
      // Yield between sub-batches so rAF can fire
      if (!isLast) await new Promise((r) => setTimeout(r, 0));
    }

    // Handle flush-only call (empty pkts array)
    if (pkts.length === 0 && flush) {
      try {
        allFrames = await libav.ff_decode_multi(
          audioDec.c, audioDec.pkt, audioDec.frame, [],
          { fin: true, ignoreErrors: true },
        );
      } catch (err) {
        console.error("[avbridge] hybrid audio flush failed:", err);
        return;
      }
    }

    if (myToken !== pumpToken || destroyed) return;
    const frames = allFrames;

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

  // Kick off initial pump
  pumpToken = 1;
  pumpRunning = pumpLoop(pumpToken).catch((err) =>
    console.error("[avbridge] hybrid pump failed:", err),
  );

  return {
    onFatalError(handler: (reason: string) => void): void {
      fatalHandler = handler;
      // If fatal already fired before handler was attached, fire immediately
      if (fatalFired) handler("WebCodecs decode failed (error occurred before handler attached)");
    },

    async destroy() {
      destroyed = true;
      pumpToken++;
      try { await pumpRunning; } catch { /* ignore */ }
      try { if (bsfCtx) await libav.av_bsf_free(bsfCtx); } catch { /* ignore */ }
      try { if (bsfPkt) await libav.av_packet_free?.(bsfPkt); } catch { /* ignore */ }
      try { if (videoDecoder && videoDecoder.state !== "closed") videoDecoder.close(); } catch { /* ignore */ }
      try { if (audioDec) await libav.ff_free_decoder?.(audioDec.c, audioDec.pkt, audioDec.frame); } catch { /* ignore */ }
      try { await libav.av_packet_free?.(readPkt); } catch { /* ignore */ }
      try { await libav.avformat_close_input_js(fmt_ctx); } catch { /* ignore */ }
      try { await inputHandle.detach(); } catch { /* ignore */ }
    },

    async setAudioTrack(trackId, timeSec) {
      if (audioStream && audioStream.index === trackId) return;
      const newStream = streams.find(
        (s) => s.codec_type === libav.AVMEDIA_TYPE_AUDIO && s.index === trackId,
      );
      if (!newStream) {
        console.warn("[avbridge] hybrid: setAudioTrack — no stream with id", trackId);
        return;
      }

      const newToken = ++pumpToken;
      if (pumpRunning) {
        try { await pumpRunning; } catch { /* ignore */ }
      }
      if (destroyed) return;

      // Tear down old audio decoder, build new one.
      if (audioDec) {
        try { await libav.ff_free_decoder?.(audioDec.c, audioDec.pkt, audioDec.frame); } catch { /* ignore */ }
        audioDec = null;
      }
      try {
        const [, c, pkt, frame] = await libav.ff_init_decoder(newStream.codec_id, {
          codecpar: newStream.codecpar,
        });
        audioDec = { c, pkt, frame };
        audioTimeBase = newStream.time_base_num && newStream.time_base_den
          ? [newStream.time_base_num, newStream.time_base_den]
          : undefined;
      } catch (err) {
        console.warn(
          "[avbridge] hybrid: setAudioTrack init failed — switching to no-audio:",
          (err as Error).message,
        );
        audioDec = null;
        opts.audio.setNoAudio();
      }

      audioStream = newStream;

      // Re-seek demuxer to current time for the new track.
      try {
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
        console.warn("[avbridge] hybrid: setAudioTrack seek failed:", err);
      }

      // Flush video decoder too — demuxer moved back to a keyframe.
      try {
        if (videoDecoder && videoDecoder.state === "configured") {
          await videoDecoder.flush();
        }
      } catch { /* ignore */ }
      await flushBSF();

      syntheticVideoUs = Math.round(timeSec * 1_000_000);
      syntheticAudioUs = Math.round(timeSec * 1_000_000);

      pumpRunning = pumpLoop(newToken).catch((err) =>
        console.error("[avbridge] hybrid pump failed (post-setAudioTrack):", err),
      );
    },

    async seek(timeSec) {
      const newToken = ++pumpToken;
      if (pumpRunning) {
        try { await pumpRunning; } catch { /* ignore */ }
      }
      if (destroyed) return;

      try {
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
        console.warn("[avbridge] hybrid av_seek_frame failed:", err);
      }

      // Flush WebCodecs VideoDecoder
      try {
        if (videoDecoder && videoDecoder.state === "configured") {
          await videoDecoder.flush();
        }
      } catch { /* ignore */ }

      // Flush libav audio decoder
      try {
        if (audioDec) await libav.avcodec_flush_buffers?.(audioDec.c);
      } catch { /* ignore */ }
      await flushBSF();

      syntheticVideoUs = Math.round(timeSec * 1_000_000);
      syntheticAudioUs = Math.round(timeSec * 1_000_000);

      pumpRunning = pumpLoop(newToken).catch((err) =>
        console.error("[avbridge] hybrid pump failed (post-seek):", err),
      );
    },

    bufferedUntilSec() {
      return bufferedUntilSec;
    },

    stats() {
      return {
        decoderType: "webcodecs-hybrid",
        packetsRead,
        videoFramesDecoded,
        videoChunksFed,
        audioFramesDecoded,
        bsfApplied: bsfCtx ? ["mpeg4_unpack_bframes"] : [],
        videoDecodeQueueSize: videoDecoder?.decodeQueueSize ?? 0,
        // Confirmed transport info — see fallback decoder for the pattern.
        _transport: inputHandle.transport === "http-range" ? "http-range" : "memory",
        _rangeSupported: inputHandle.transport === "http-range",
        ...opts.renderer.stats(),
        ...opts.audio.stats(),
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Packet timestamp sanitizer for WebCodecs chunks.
//
// AVI packets often have AV_NOPTS_VALUE. The bridge's packetToEncodedVideoChunk
// uses the packet's pts + time_base. We normalize to microseconds with a 1/1e6
// time_base to avoid overflow.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Bridge loader
// ─────────────────────────────────────────────────────────────────────────────

async function loadBridge(): Promise<BridgeModule> {
  try {
    const wrapper = await import("../fallback/libav-import.js");
    return wrapper.libavBridge as unknown as BridgeModule;
  } catch (err) {
    throw new Error(
      `failed to load libavjs-webcodecs-bridge: ${(err as Error).message}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural types
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
  f64toi64?(val: number): [number, number];

  // BSF methods
  av_bsf_list_parse_str_js(str: string): Promise<number>;
  AVBSFContext_par_in(ctx: number): Promise<number>;
  avcodec_parameters_copy(dst: number, src: number): Promise<number>;
  av_bsf_init(ctx: number): Promise<number>;
  av_bsf_send_packet(ctx: number, pkt: number): Promise<number>;
  av_bsf_receive_packet(ctx: number, pkt: number): Promise<number>;
  av_bsf_free(ctx: number): Promise<void>;
  ff_copyin_packet(pktPtr: number, packet: LibavPacket): Promise<void>;
  ff_copyout_packet(pkt: number): Promise<LibavPacket>;
}

interface BridgeModule {
  videoStreamToConfig(libav: unknown, stream: unknown): Promise<VideoDecoderConfig | null>;
  packetToEncodedVideoChunk(pkt: unknown, stream: unknown): EncodedVideoChunk;
}
