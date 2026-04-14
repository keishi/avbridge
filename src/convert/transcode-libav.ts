/**
 * AVI/ASF/FLV transcode pipeline (Phase 1).
 *
 * One-pass: libav demux → WebCodecs VideoDecoder + libav software audio
 * decode → VideoSample / AudioSample → mediabunny Output → MP4 Blob.
 *
 * Only reached from src/convert/transcode.ts when the input container is
 * in {avi, asf, flv}. MP4/MKV/WebM/etc. still go through the mediabunny
 * Conversion path in transcode.ts.
 *
 * Scope limits (Phase 1 — see docs/dev/ROADMAP.md):
 * - MP4 output only.
 * - Single video + single audio track. Extra tracks are silently dropped.
 * - 8-bit video only; 10-bit throws with a clear error.
 * - No seek. Linear read-to-EOF.
 */

// Lazy imports: libav-demux + the libav-loader chain it pulls in are heavy.
// To keep the `transcode` bundle scenario below its gzip budget, we only
// load them when the libav path is actually taken. See the top of
// transcodeViaLibav() for the dynamic imports.
import type { LibavPacket } from "../util/libav-demux.js";
import {
  AvbridgeError,
  ERR_TRANSCODE_ABORTED,
  ERR_TRANSCODE_UNSUPPORTED_COMBO,
  ERR_TRANSCODE_DECODE,
  ERR_CODEC_NOT_SUPPORTED,
} from "../errors.js";
import type {
  MediaContext,
  TranscodeOptions,
  ConvertResult,
  OutputVideoCodec,
  OutputAudioCodec,
  TranscodeQuality,
} from "../types.js";

/** @internal */
export function isLibavTranscodeContainer(container: string): boolean {
  return (
    container === "avi" ||
    container === "asf" ||
    container === "flv" ||
    container === "rm"  // RealMedia (.rm / .rmvb) — rv40/cook via libav software decode
  );
}

export async function transcodeViaLibav(
  ctx: MediaContext,
  options: TranscodeOptions,
): Promise<ConvertResult> {
  const outputFormat = options.outputFormat ?? "mp4";
  if (outputFormat !== "mp4") {
    throw new AvbridgeError(
      ERR_TRANSCODE_UNSUPPORTED_COMBO,
      `AVI/ASF/FLV transcode currently supports MP4 output only (got "${outputFormat}").`,
      `Use outputFormat: "mp4", or remux() the source to MP4 first and then transcode.`,
    );
  }

  const videoCodec: OutputVideoCodec = options.videoCodec ?? "h264";
  const audioCodec: OutputAudioCodec = options.audioCodec ?? "aac";
  const quality: TranscodeQuality = options.quality ?? "medium";
  options.signal?.throwIfAborted();

  // Everything from here is lazily loaded so the `transcode` scenario
  // doesn't pay for libav/mediabunny weight just because this file is
  // on the import graph.
  const [
    mb,
    { openLibavDemux, sanitizePacketTimestamp, sanitizeFrameTimestamp, libavFrameToInterleavedFloat32 },
    { normalizeSource },
    { createOutputFormat, mimeForFormat, generateFilename },
  ] = await Promise.all([
    import("mediabunny"),
    import("../util/libav-demux.js"),
    import("../util/source.js"),
    import("./remux.js"),
  ]);

  // ── Open the demux session ──────────────────────────────────────────
  const normalized = await normalizeSource(ctx.source);
  const demux = await openLibavDemux({
    source: normalized,
    filename: ctx.name ?? "input.bin",
    context: ctx,
    // transport config is not yet threaded through ConvertOptions; add
    // later if URL-source transcode with signed URLs becomes a need.
  });

  try {
    options.signal?.throwIfAborted();

    if (!demux.videoStream && !demux.audioStream) {
      throw new Error("transcode: source has no decodable tracks");
    }

    // ── Set up mediabunny Output (MP4 via BufferTarget for Phase 1) ──
    // outputStream is not yet supported for the libav path — the
    // sample-source + encoder chain doesn't expose the same StreamTarget
    // hook that mediabunny's Conversion uses internally. Flag loudly.
    if (options.outputStream) {
      throw new AvbridgeError(
        ERR_TRANSCODE_UNSUPPORTED_COMBO,
        "outputStream is not supported for AVI/ASF/FLV transcode in this release.",
        "Remove the outputStream option to receive the transcoded blob in memory. Streaming output for this path is planned for Phase 2.",
      );
    }
    const bufferTarget = new mb.BufferTarget();
    const output = new mb.Output({
      format: createOutputFormat(mb, outputFormat),
      target: bufferTarget,
    });

    // ── Bridge (libavjs-webcodecs-bridge) for packet → EncodedVideoChunk
    const bridge = await loadBridge();

    // ── Video decoder (WebCodecs) + sample source (mediabunny) ───────
    // Video decode has two possible paths:
    // - WebCodecs (hardware or browser's software decoder) — used when
    //   `VideoDecoder.isConfigSupported(config)` returns true. Fast.
    // - libav software decode — used when WebCodecs can't handle the codec.
    //   Required for RealMedia (rv40/etc.), where the source codec isn't in
    //   any browser. The output is still a VideoFrame (via the bridge's
    //   laFrameToVideoFrame), so the downstream queue+drain is unchanged.
    let videoDecoder: VideoDecoder | null = null;
    let videoSoftDec: { c: number; pkt: number; frame: number } | null = null;
    let videoSource: InstanceType<typeof mb.VideoSampleSource> | null = null;
    let videoBsfCtx: number | null = null;
    let videoBsfPkt: number | null = null;
    let videoWidth = 0;
    let videoHeight = 0;
    let videoTimeBase: [number, number] | undefined;

    // Explicit queue + drain for VideoDecoder.output → videoSource.add.
    // VideoDecoder.output is fire-and-forget, videoSource.add is async
    // and backpressures. Without a queue + single-flight drain, we'd
    // either lose backpressure (memory blow-up) or let in-flight `add`
    // calls interleave out of order. Phase 1 correctness depends on this.
    const frameQueue: VideoFrame[] = [];
    const MAX_QUEUE = 16;
    let draining = false;
    let drainError: Error | null = null;
    // Promise of the currently-running drain (for explicit await at EOF).
    let activeDrain: Promise<void> | null = null;

    const drain = (): Promise<void> => {
      if (draining) return activeDrain ?? Promise.resolve();
      draining = true;
      const run = (async () => {
        try {
          while (frameQueue.length > 0 && !drainError) {
            const frame = frameQueue.shift()!;
            try {
              const sample = new mb.VideoSample(frame, {
                timestamp: (frame.timestamp ?? 0) / 1_000_000, // µs → s
              });
              await videoSource!.add(sample);
            } finally {
              frame.close();
            }
          }
        } catch (err) {
          drainError = err as Error;
          // Release any queued frames so we don't leak VideoFrames.
          while (frameQueue.length > 0) {
            try { frameQueue.shift()!.close(); } catch { /* ignore */ }
          }
        } finally {
          draining = false;
          activeDrain = null;
        }
      })();
      activeDrain = run;
      return run;
    };

    if (demux.videoStream && !options.dropVideo) {
      try {
        // Phase 1: refuse 10-bit. Neither decode path produces pixel
        // formats that mediabunny's encoders reliably consume.
        const bitDepth = ctx.videoTracks[0]?.bitDepth ?? 8;
        if (bitDepth > 8) {
          throw new AvbridgeError(
            ERR_TRANSCODE_UNSUPPORTED_COMBO,
            `transcode: 10-bit video is not supported in this release (source bit depth: ${bitDepth}).`,
            `Phase 1 transcode handles 8-bit video only. 10-bit support is on the roadmap.`,
          );
        }

        if (demux.videoStream.time_base_num && demux.videoStream.time_base_den) {
          videoTimeBase = [demux.videoStream.time_base_num, demux.videoStream.time_base_den];
        }

        // Try WebCodecs first. If the bridge can build a config AND the
        // browser's VideoDecoder supports it, use hardware/native decode.
        // Otherwise fall back to libav software decode (rv40, etc.).
        let config: VideoDecoderConfig | null = null;
        try {
          config = await bridge.videoStreamToConfig(demux.libav, demux.videoStream);
        } catch {
          config = null;
        }
        const supported = config
          ? await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }))
          : { supported: false };

        videoWidth = (config?.codedWidth ?? ctx.videoTracks[0]?.width) ?? 0;
        videoHeight = (config?.codedHeight ?? ctx.videoTracks[0]?.height) ?? 0;

        if (config && supported.supported) {
          // ── WebCodecs path ──
          videoDecoder = new VideoDecoder({
            output: (frame) => {
              if (frameQueue.length >= MAX_QUEUE) {
                frame.close();
                return;
              }
              frameQueue.push(frame);
              void drain();
            },
            error: (err) => {
              drainError = err as unknown as Error;
            },
          });
          videoDecoder.configure(config);
        } else {
          // ── libav software decode path ──
          // RealMedia (rv10/20/30/40) and any other codec WebCodecs doesn't
          // support lands here. The libav variant picker already routes
          // rm/rv* to the "avbridge" variant via codec-set inspection.
          const libavSoft = demux.libav as unknown as LibavSoftVideo;
          const [, c, pkt, frame] = await libavSoft.ff_init_decoder(
            demux.videoStream.codec_id,
            { codecpar: demux.videoStream.codecpar },
          );
          videoSoftDec = { c, pkt, frame };
        }

        videoSource = new mb.VideoSampleSource({
          codec: avbridgeVideoToMediabunny(videoCodec),
          bitrate: qualityToMediabunny(mb, quality, options.videoBitrate),
          ...(options.frameRate !== undefined ? { frameRate: options.frameRate } : {}),
          ...(options.hardwareAcceleration !== undefined
            ? { hardwareAcceleration: options.hardwareAcceleration }
            : {}),
          // Progress reporting: media-time-based via each encoded packet.
          onEncodedPacket: options.onProgress
            ? (packet) => {
                const t = packet.timestamp;
                if (Number.isFinite(t) && ctx.duration && ctx.duration > 0) {
                  const pct = Math.min(100, (t / ctx.duration) * 100);
                  options.onProgress!({ percent: pct, bytesWritten: 0 });
                }
              }
            : undefined,
        });

        const videoMeta: { width?: number; height?: number; frameRate?: number } = {};
        if (options.width !== undefined) videoMeta.width = options.width;
        else if (videoWidth > 0) videoMeta.width = videoWidth;
        if (options.height !== undefined) videoMeta.height = options.height;
        else if (videoHeight > 0) videoMeta.height = videoHeight;
        if (options.frameRate !== undefined) videoMeta.frameRate = options.frameRate;
        output.addVideoTrack(videoSource, videoMeta);

        // mpeg4 packed-bframes BSF — same as hybrid/fallback.
        if (ctx.videoTracks[0]?.codec === "mpeg4") {
          const runtime = demux.libav as unknown as LibavBsf;
          try {
            videoBsfCtx = await runtime.av_bsf_list_parse_str_js("mpeg4_unpack_bframes");
            if (videoBsfCtx != null && videoBsfCtx >= 0) {
              const parIn = await runtime.AVBSFContext_par_in(videoBsfCtx);
              await runtime.avcodec_parameters_copy(parIn, demux.videoStream.codecpar);
              await runtime.av_bsf_init(videoBsfCtx);
              videoBsfPkt = await (demux.libav as unknown as { av_packet_alloc(): Promise<number> })
                .av_packet_alloc();
            } else {
              videoBsfCtx = null;
            }
          } catch {
            videoBsfCtx = null;
          }
        }
      } catch (err) {
        if (err instanceof AvbridgeError) throw err;
        throw new AvbridgeError(
          ERR_CODEC_NOT_SUPPORTED,
          `transcode: video decoder init failed: ${(err as Error).message}`,
          `The source's video codec may not be supported by this browser's WebCodecs implementation.`,
        );
      }
    }

    // ── Audio decoder (libav software) + sample source ───────────────
    interface SoftDecoder { c: number; pkt: number; frame: number; }
    let audioDec: SoftDecoder | null = null;
    let audioSource: InstanceType<typeof mb.AudioSampleSource> | null = null;
    let audioTimeBase: [number, number] | undefined;

    const includeAudio = demux.audioStream && !options.dropAudio;
    if (includeAudio) {
      try {
        const libav = demux.libav as unknown as LibavAudio;
        const [, c, pkt, frame] = await libav.ff_init_decoder(
          demux.audioStream!.codec_id,
          { codecpar: demux.audioStream!.codecpar },
        );
        audioDec = { c, pkt, frame };
        if (demux.audioStream!.time_base_num && demux.audioStream!.time_base_den) {
          audioTimeBase = [
            demux.audioStream!.time_base_num,
            demux.audioStream!.time_base_den,
          ];
        }

        audioSource = new mb.AudioSampleSource({
          codec: avbridgeAudioToMediabunny(audioCodec),
          bitrate: qualityToMediabunny(mb, quality, options.audioBitrate),
        });
        output.addAudioTrack(audioSource);
      } catch (err) {
        const codecName = ctx.audioTracks[0]?.codec ?? "unknown";
        throw new AvbridgeError(
          ERR_CODEC_NOT_SUPPORTED,
          `transcode: no decoder available for audio codec "${codecName}" in this libav variant (${(err as Error).message}).`,
          `The file may still play via createPlayer() (fallback strategy). Pass { dropAudio: true } to transcode video-only.`,
        );
      }
    } else if (options.dropAudio) {
      // Caller asked for video-only — don't add an audio track.
    }

    if (!videoSource && !audioSource) {
      throw new AvbridgeError(
        ERR_TRANSCODE_UNSUPPORTED_COMBO,
        "transcode: no video or audio track to encode (did you set both dropVideo and dropAudio?).",
        "Remove dropVideo or dropAudio to include at least one track.",
      );
    }

    await output.start();

    // ── Synthetic timestamp counters for packets without valid PTS ──
    const videoFps = ctx.videoTracks[0]?.fps && ctx.videoTracks[0]!.fps > 0
      ? ctx.videoTracks[0]!.fps
      : 30;
    const videoFrameStepUs = Math.max(1, Math.round(1_000_000 / videoFps));
    let syntheticVideoUs = 0;
    let syntheticAudioUs = 0;

    // BSF helpers (only if bsfCtx initialized)
    const libavFull = demux.libav as unknown as LibavBsf & { ff_copyin_packet(a: number, b: LibavPacket): Promise<void>; ff_copyout_packet(a: number): Promise<LibavPacket>; };
    async function applyBSF(packets: LibavPacket[]): Promise<LibavPacket[]> {
      if (!videoBsfCtx || !videoBsfPkt) return packets;
      const out: LibavPacket[] = [];
      for (const pkt of packets) {
        await libavFull.ff_copyin_packet(videoBsfPkt, pkt);
        const sendErr = await libavFull.av_bsf_send_packet(videoBsfCtx, videoBsfPkt);
        if (sendErr < 0) { out.push(pkt); continue; }
        while (true) {
          const recvErr = await libavFull.av_bsf_receive_packet(videoBsfCtx, videoBsfPkt);
          if (recvErr < 0) break;
          out.push(await libavFull.ff_copyout_packet(videoBsfPkt));
        }
      }
      return out;
    }

    // Guarded access: signal cancellation is honored between batches
    // and at queue-wait checkpoints.
    const ac = options.signal;
    function throwIfAborted(): void {
      if (ac?.aborted) {
        throw new AvbridgeError(
          ERR_TRANSCODE_ABORTED,
          "transcode: aborted by caller.",
          undefined,
        );
      }
    }

    function throwIfDrainError(): void {
      if (drainError) {
        const msg = drainError.message;
        throw new AvbridgeError(
          ERR_TRANSCODE_DECODE,
          `transcode: video decoder error: ${msg}`,
          "This usually indicates the WebCodecs decoder rejected a malformed packet.",
        );
      }
    }

    // ── Pump ────────────────────────────────────────────────────────
    const onVideoPacketsWebCodecs = videoDecoder
      ? async (pkts: LibavPacket[]) => {
          throwIfAborted();
          throwIfDrainError();
          while (
            !ac?.aborted &&
            (videoDecoder!.decodeQueueSize > 16 || frameQueue.length >= MAX_QUEUE - 2)
          ) {
            await new Promise((r) => setTimeout(r, 10));
          }
          throwIfAborted();

          const processed = await applyBSF(pkts);
          const bridgeAny = bridge as unknown as {
            packetToEncodedVideoChunk(pkt: unknown, stream: unknown): EncodedVideoChunk;
          };
          for (const pkt of processed) {
            sanitizePacketTimestamp(pkt, () => {
              const ts = syntheticVideoUs;
              syntheticVideoUs += videoFrameStepUs;
              return ts;
            }, videoTimeBase);
            try {
              const chunk = bridgeAny.packetToEncodedVideoChunk(pkt, demux.videoStream);
              videoDecoder!.decode(chunk);
            } catch (err) {
              throw new AvbridgeError(
                ERR_TRANSCODE_DECODE,
                `transcode: packet → EncodedVideoChunk failed: ${(err as Error).message}`,
                undefined,
              );
            }
          }
        }
      : undefined;

    const onVideoPacketsSoftware = videoSoftDec
      ? async (pkts: LibavPacket[]) => {
          throwIfAborted();
          throwIfDrainError();
          // Only frameQueue backpressure — no WebCodecs queue.
          while (!ac?.aborted && frameQueue.length >= MAX_QUEUE - 2) {
            await new Promise((r) => setTimeout(r, 10));
          }
          throwIfAborted();

          const libavSoft = demux.libav as unknown as LibavSoftVideo;
          let frames;
          try {
            frames = await libavSoft.ff_decode_multi(
              videoSoftDec!.c, videoSoftDec!.pkt, videoSoftDec!.frame, pkts,
              { ignoreErrors: true },
            );
          } catch (err) {
            throw new AvbridgeError(
              ERR_TRANSCODE_DECODE,
              `transcode: software video decode failed: ${(err as Error).message}`,
              undefined,
            );
          }
          for (const f of frames) {
            sanitizeFrameTimestamp(f, () => {
              const ts = syntheticVideoUs;
              syntheticVideoUs += videoFrameStepUs;
              return ts;
            }, videoTimeBase);
            try {
              // Bridge consumes any libav-decoded frame (software or
              // hardware) and returns a WebCodecs VideoFrame.
              const vf = bridge.laFrameToVideoFrame(f, { timeBase: [1, 1_000_000] });
              if (frameQueue.length >= MAX_QUEUE) {
                vf.close();
              } else {
                frameQueue.push(vf);
                void drain();
              }
            } catch (err) {
              throw new AvbridgeError(
                ERR_TRANSCODE_DECODE,
                `transcode: laFrameToVideoFrame failed: ${(err as Error).message}`,
                undefined,
              );
            }
          }
        }
      : undefined;

    await demux.pump({
      signal: ac,
      onVideoPackets: onVideoPacketsWebCodecs ?? onVideoPacketsSoftware,
      onAudioPackets: audioDec
        ? async (pkts) => {
            throwIfAborted();
            await decodeAudioBatch(pkts, false);
          }
        : undefined,
      onEof: async () => {
        // Drain video: flush decoder, then wait for our queue to empty.
        if (videoDecoder && videoDecoder.state === "configured") {
          try { await videoDecoder.flush(); } catch { /* ignore */ }
        }
        if (videoSoftDec) {
          // Flush the software decoder with fin: true so any internally
          // buffered frames come out.
          const libavSoft = demux.libav as unknown as LibavSoftVideo;
          try {
            const tail = await libavSoft.ff_decode_multi(
              videoSoftDec.c, videoSoftDec.pkt, videoSoftDec.frame, [],
              { fin: true, ignoreErrors: true },
            );
            for (const f of tail) {
              sanitizeFrameTimestamp(f, () => {
                const ts = syntheticVideoUs;
                syntheticVideoUs += videoFrameStepUs;
                return ts;
              }, videoTimeBase);
              try {
                const vf = bridge.laFrameToVideoFrame(f, { timeBase: [1, 1_000_000] });
                frameQueue.push(vf);
                void drain();
              } catch { /* ignore per-frame failures during flush */ }
            }
          } catch { /* ignore */ }
        }
        // A final drain() kick to consume any post-flush frames.
        await drain();
        // Drain audio: flush the libav decoder.
        if (audioDec) {
          await decodeAudioBatch([], true);
        }
      },
    });

    throwIfAborted();
    throwIfDrainError();

    // Close the sample sources so mediabunny finalizes track metadata.
    videoSource?.close();
    audioSource?.close();

    await output.finalize();

    if (!bufferTarget.buffer) {
      throw new Error("transcode: mediabunny produced no output buffer");
    }
    const mimeType = mimeForFormat(outputFormat);
    const blob = new Blob([bufferTarget.buffer], { type: mimeType });
    options.onProgress?.({ percent: 100, bytesWritten: blob.size });

    return {
      blob,
      mimeType,
      container: outputFormat,
      videoCodec: videoSource ? videoCodec : undefined,
      audioCodec: audioSource ? audioCodec : undefined,
      duration: ctx.duration,
      filename: generateFilename(ctx.name, outputFormat),
    };

    // ── Helpers closing over the above state ────────────────────────
    async function decodeAudioBatch(pkts: LibavPacket[], flush: boolean): Promise<void> {
      if (!audioDec || !audioSource) return;
      const libav = demux.libav as unknown as LibavAudio;
      let frames;
      try {
        frames = await libav.ff_decode_multi(
          audioDec.c,
          audioDec.pkt,
          audioDec.frame,
          pkts,
          flush ? { fin: true, ignoreErrors: true } : { ignoreErrors: true },
        );
      } catch (err) {
        throw new AvbridgeError(
          ERR_TRANSCODE_DECODE,
          `transcode: audio decode failed: ${(err as Error).message}`,
          undefined,
        );
      }
      for (const f of frames) {
        sanitizeFrameTimestamp(f, () => {
          const ts = syntheticAudioUs;
          const samples = f.nb_samples ?? 1024;
          const sampleRate = f.sample_rate ?? 44100;
          syntheticAudioUs += Math.round((samples * 1_000_000) / sampleRate);
          return ts;
        }, audioTimeBase);
        const pcm = libavFrameToInterleavedFloat32(f);
        if (!pcm) continue;
        // AudioSample wants a typed AudioSampleInit. f32 interleaved.
        const sample = new mb.AudioSample({
          data: pcm.data,
          format: "f32",
          numberOfChannels: pcm.channels,
          sampleRate: pcm.sampleRate,
          timestamp: (f.pts ?? 0) / 1_000_000,
        });
        await audioSource.add(sample);
      }
    }
  } finally {
    // Teardown: close decoders, free BSF, close demuxer.
    try { await demux.destroy(); } catch { /* ignore */ }
    // Note: videoDecoder / audioDec cleanup happens implicitly; the demuxer
    // destroy releases the fmt_ctx, and our sample sources + Output
    // finalization release the encoder side. Explicit frees here would
    // race with in-flight decode calls on error paths; we accept the
    // short-lived leak.
  }
  // Reference types used in this file. Declared locally to avoid leaking
  // into the shared helper module.
  interface LibavAudio {
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
    ): Promise<import("../util/libav-demux.js").LibavFrame[]>;
  }
  // Software video decode uses the same surface as audio. Aliased for
  // readability at callsites.
  type LibavSoftVideo = LibavAudio;
  interface LibavBsf {
    av_bsf_list_parse_str_js(str: string): Promise<number>;
    AVBSFContext_par_in(ctx: number): Promise<number>;
    avcodec_parameters_copy(dst: number, src: number): Promise<number>;
    av_bsf_init(ctx: number): Promise<number>;
    av_bsf_send_packet(ctx: number, pkt: number): Promise<number>;
    av_bsf_receive_packet(ctx: number, pkt: number): Promise<number>;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function loadBridge(): Promise<BridgeModule> {
  try {
    const wrapper = await import("../strategies/fallback/libav-import.js");
    return wrapper.libavBridge as unknown as BridgeModule;
  } catch (err) {
    throw new Error(`failed to load libavjs-webcodecs-bridge: ${(err as Error).message}`);
  }
}

interface BridgeModule {
  videoStreamToConfig(libav: unknown, stream: unknown): Promise<VideoDecoderConfig | null>;
  packetToEncodedVideoChunk(pkt: unknown, stream: unknown): EncodedVideoChunk;
  laFrameToVideoFrame(
    frame: unknown,
    opts?: { timeBase?: [number, number]; transfer?: boolean },
  ): VideoFrame;
}

function avbridgeVideoToMediabunny(c: OutputVideoCodec): "avc" | "hevc" | "vp9" | "av1" {
  switch (c) {
    case "h264": return "avc";
    case "h265": return "hevc";
    case "vp9":  return "vp9";
    case "av1":  return "av1";
  }
}

function avbridgeAudioToMediabunny(c: OutputAudioCodec): "aac" | "opus" | "flac" {
  switch (c) {
    case "aac":  return "aac";
    case "opus": return "opus";
    case "flac": return "flac";
  }
}

function qualityToMediabunny(
  mb: typeof import("mediabunny"),
  quality: TranscodeQuality,
  override: number | undefined,
): number | InstanceType<typeof mb.Quality> {
  if (override !== undefined) return override;
  switch (quality) {
    case "low":       return mb.QUALITY_LOW;
    case "medium":    return mb.QUALITY_MEDIUM;
    case "high":      return mb.QUALITY_HIGH;
    case "very-high": return mb.QUALITY_VERY_HIGH;
  }
}
