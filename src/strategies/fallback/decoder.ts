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
import { dbg } from "../../util/debug.js";

/** True when `globalThis.AVBRIDGE_DEBUG` is set. Used to gate verbose
 *  per-packet / per-frame trace lines that are useful for debugging
 *  post-seek pts behavior but unreadable in normal use. */
function isDebug(): boolean {
  return typeof globalThis !== "undefined"
    && !!(globalThis as Record<string, unknown>).AVBRIDGE_DEBUG;
}
import {
  libavFrameToInterleavedFloat32,
  packetPtsSec,
} from "../../util/libav-demux.js";

export interface DecoderHandles {
  destroy(): Promise<void>;
  /** Seek to the given time in seconds. Returns once the new pump has been kicked off. */
  seek(timeSec: number): Promise<void>;
  /**
   * Switch the active audio track. The decoder tears down the current audio
   * decoder, initializes one for the stream whose container id matches
   * `trackId` (== libav `stream.index`), seeks the demuxer to `timeSec`, and
   * restarts the pump. No-op if the track is already active.
   */
  setAudioTrack(trackId: number, timeSec: number): Promise<void>;
  stats(): Record<string, unknown>;
  /**
   * The demuxer's read-ahead frontier in seconds. See
   * `HybridDecoderHandles.bufferedUntilSec` for the full contract —
   * same semantics, same consumer (`<video>.buffered` on canvas
   * strategies).
   */
  bufferedUntilSec(): number;
}

export interface StartDecoderOptions {
  /** Normalized source — either a Blob in memory or a URL we'll stream via Range requests. */
  source: import("../../util/source.js").NormalizedSource;
  filename: string;
  context: MediaContext;
  renderer: VideoRenderer;
  audio: AudioOutput;
  transport?: import("../../types.js").TransportConfig;
}

export async function startDecoder(opts: StartDecoderOptions): Promise<DecoderHandles> {
  // Fallback always does full software decode. The "webcodecs" libav
  // variant is trimmed to demuxing + WebCodecs-companion use; it lacks
  // software decoders for codecs whose browsers usually handle them
  // (e.g. h265). When we've reached fallback for those codecs, it's
  // precisely because the browser *can't* decode them — so we need
  // the full "avbridge" variant with software decoders. pickLibavVariant
  // is still right for the hybrid strategy (which software-decodes only
  // audio and relies on WebCodecs for video), but not here.
  const variant: LibavVariant = "avbridge";
  void pickLibavVariant; // kept in scope for future opt-in use
  const libav = (await loadLibav(variant)) as unknown as LibavRuntime;
  const bridge = await loadBridge();

  // For URL sources, prepareLibavInput attaches an HTTP block reader so
  // libav demuxes via Range requests. For Blob sources, it falls back to
  // mkreadaheadfile (in-memory). The returned handle owns cleanup.
  const { prepareLibavInput } = await import("../../util/libav-http-reader.js");
  const inputHandle = await prepareLibavInput(libav as unknown as Parameters<typeof prepareLibavInput>[0], opts.filename, opts.source, opts.transport);

  // Pre-allocate one AVPacket for ff_read_frame_multi to reuse.
  const readPkt = await libav.av_packet_alloc();

  const [fmt_ctx, streams] = await libav.ff_init_demuxer_file(opts.filename);
  const videoStream = streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_VIDEO) ?? null;
  // Audio stream is mutable so setAudioTrack() can swap it. Default to the
  // track the context picked first (matches probe ordering). We resolve by
  // container id so the selection survives stream reordering.
  const firstAudioTrackId = opts.context.audioTracks[0]?.id;
  let audioStream: LibavStream | null =
    (firstAudioTrackId != null
      ? streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_AUDIO && s.index === firstAudioTrackId)
      : undefined) ??
    streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_AUDIO) ?? null;

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
      console.error("[avbridge] failed to init video decoder:", err);
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
      console.warn(
        "[avbridge] fallback: audio decoder unavailable — playing video with wall-clock timing:",
        (err as Error).message,
      );
    }
  }

  // No audio decoder? Switch audio output into wall-clock mode so video can
  // play even when the audio codec isn't supported by the loaded libav variant.
  if (!audioDec) {
    opts.audio.setNoAudio();
  }

  if (!videoDec && !audioDec) {
    await inputHandle.detach().catch(() => {});
    const codecs = [
      videoStream ? `video: ${opts.context.videoTracks[0]?.codec ?? "unknown"}` : null,
      audioStream ? `audio: ${opts.context.audioTracks[0]?.codec ?? "unknown"}` : null,
    ].filter(Boolean).join(", ");
    throw new Error(
      `fallback decoder: could not initialize any libav decoders (${codecs}). ` +
      `The "${variant}" libav variant lacks software decoders for these codecs — ` +
      `rebuild with scripts/build-libav.sh including the missing decoder, ` +
      `or use a lighter strategy (native, remux, hybrid) instead.`,
    );
  }

  // ── Bitstream filter for MPEG-4 Part 2 packed B-frames ───────────────
  // Applied unconditionally for mpeg4 video — the BSF is a no-op when
  // the stream doesn't actually have packed B-frames, so false positives
  // are harmless. Without it, DivX files with packed B-frames produce
  // garbled frame ordering.
  let bsfCtx: number | null = null;
  let bsfPkt: number | null = null;
  let bsfRequiredButMissing = false;
  if (videoStream && opts.context.videoTracks[0]?.codec === "mpeg4") {
    try {
      bsfCtx = await libav.av_bsf_list_parse_str_js("mpeg4_unpack_bframes");
      if (bsfCtx != null && bsfCtx >= 0) {
        const parIn = await libav.AVBSFContext_par_in(bsfCtx);
        await libav.avcodec_parameters_copy(parIn, videoStream.codecpar);
        await libav.av_bsf_init(bsfCtx);
        bsfPkt = await libav.av_packet_alloc();
        dbg.info("bsf", "mpeg4_unpack_bframes BSF active");
      } else {
        bsfRequiredButMissing = true;
        bsfCtx = null;
      }
    } catch (err) {
      bsfRequiredButMissing = true;
      bsfCtx = null;
      bsfPkt = null;
      dbg.warn("bsf", `mpeg4_unpack_bframes BSF init failed: ${(err as Error).message}`);
    }
    if (bsfRequiredButMissing) {
      // eslint-disable-next-line no-console
      console.error(
        "[avbridge] MPEG-4 Part 2 (DivX/Xvid) detected but mpeg4_unpack_bframes " +
        "BSF is unavailable in this libav variant. Files with packed B-frames " +
        "will play with incorrect frame ordering (backwards PTS jumps, heavy " +
        "late-drop stuttering). Rebuild the libav variant with the `avbsf` " +
        "fragment included. See docs/dev/POSTMORTEMS.md for details.",
      );
    }
  }

  /** Run video packets through the BSF. Returns original packets if no BSF active. */
  async function applyBSF(packets: LibavPacket[]): Promise<LibavPacket[]> {
    if (!bsfCtx || !bsfPkt) return packets;
    const out: LibavPacket[] = [];
    for (const pkt of packets) {
      await libav.ff_copyin_packet(bsfPkt, pkt);
      const sendErr = await libav.av_bsf_send_packet(bsfCtx, bsfPkt);
      if (sendErr < 0) {
        // BSF rejected — DON'T pass the original through. `ff_copyin_packet`
        // above may have transferred pkt.data's ArrayBuffer into the worker,
        // in which case re-posting the same packet to the decoder fails
        // with DataCloneError on a detached buffer. Skipping the packet is
        // safer; the decoder's error recovery will resync at the next
        // keyframe if this was transient.
        continue;
      }
      while (true) {
        const recvErr = await libav.av_bsf_receive_packet(bsfCtx, bsfPkt);
        if (recvErr < 0) break; // EAGAIN or EOF
        out.push(await libav.ff_copyout_packet(bsfPkt));
      }
    }
    return out;
  }

  /** Flush the BSF (on seek or EOF) to drain any internally buffered packets. */
  async function flushBSF(): Promise<void> {
    if (!bsfCtx || !bsfPkt) return;
    try {
      // `av_bsf_flush` resets the BSF state without putting it in EOF
      // mode. The old approach — sending a NULL packet — is the EOF
      // signal; after that every subsequent `av_bsf_send_packet` fails,
      // which made `applyBSF` fall back to pushing the ORIGINAL packet
      // through (with its buffer already transferred to WASM by
      // `ff_copyin_packet`). That detached buffer then failed to
      // `postMessage` into the decoder worker with DataCloneError on
      // the first post-seek batch.
      if (libav.av_bsf_flush) {
        await libav.av_bsf_flush(bsfCtx);
      } else {
        // Fallback for older libav.js variants without av_bsf_flush:
        // drain any internal packets but DON'T send NULL-EOF.
        while (true) {
          const err = await libav.av_bsf_receive_packet(bsfCtx, bsfPkt);
          if (err < 0) break;
        }
      }
    } catch { /* ignore flush errors */ }
  }

  // ── Mutable state shared across pump loops ───────────────────────────
  let destroyed = false;
  let pumpToken = 0;            // bumped on seek; pump loops bail when token changes
  let pumpRunning: Promise<void> | null = null;

  let packetsRead = 0;
  let videoFramesDecoded = 0;
  let bufferedUntilSec = 0;
  let audioFramesDecoded = 0;

  // Decode-rate watchdog. Samples framesDecoded every second and
  // compares against realtime expected frames for the source fps. If
  // the decoder sustains less than 60% of realtime for more than
  // 5 seconds (counting only time since the first frame emerged),
  // emits a one-shot diagnostic so users know why playback is
  // stuttering instead of guessing. A second one-shot fires if the
  // renderer's overflow-drop rate exceeds 10% of decoded frames —
  // that symptom means the decoder is BURSTING faster than the
  // renderer can drain, which is a different bug from "decoder slow".
  let watchdogFirstFrameMs = 0;
  let watchdogSlowSinceMs = 0;
  let watchdogSlowWarned = false;
  let watchdogOverflowWarned = false;

  // Content clock for video frames. Tracks the last frame's content time
  // in µs. The invariant per emit:
  //   - raw libav pts valid → lastContentUs = raw_pts (sync to truth)
  //   - raw libav pts NOPTS → lastContentUs += frameStep (extend by one frame)
  // This makes synthetic labels always relative to the *immediately
  // preceding* frame's real content, self-correcting at every valid pts.
  // -1 means "unanchored" — pre-anchor NOPTS frames are discarded outright
  // because we don't know where the decoder actually landed. The anchor
  // is established at the first valid raw pts post-seek.
  //
  // This replaced an older "synthetic counter reset to seekTarget on seek"
  // path which stamped NOPTS preroll frames with the user's requested seek
  // time — producing labels 4+ seconds ahead of actual content, dropping
  // every valid-pts frame as a "regression", and surfacing as a ~2s
  // post-seek fast-forward as the slow-advancing synthetic counter slowly
  // converged with real content. See POSTMORTEMS.md (2026-06-01).
  let lastContentUs = -1;
  let firstValidPtsLoggedSinceSeek = false;

  // Diagnostic: first post-seek audio packet's PTS. Logged once per seek
  // so the operator can see the demuxer's actual content alignment vs
  // the user's click. With PTS-based audio scheduling, audio packets
  // with PTS before the seek target *naturally* don't get scheduled
  // (their computed ctxStart falls in the past) — no manual trim needed.
  let seenFirstAudioPacketSinceSeek = false;
  let seekTargetSec = 0;
  // Post-seek diagnostic counters. Capture raw pts/dts/pos for the first
  // ~N packets and frames after each seek so we can tell whether libav
  // hands us a valid pts at seek landing, when (if ever) it becomes
  // valid mid-stream, and whether sanitize's NOPTS fallback is firing.
  let diagPktsLoggedSinceSeek = 0;
  let diagFramesLoggedSinceSeek = 0;
  let diagFrameKeysDumped = false;
  const DIAG_MAX_PKTS = 100;
  const DIAG_MAX_FRAMES = 300;

  // Throughput instrumentation — answers "is the decoder keeping up?".
  // All counters are cumulative since bootstrap (not reset on seek), so
  // the stats panel can compute rolling deltas. Times are wall-ms spent
  // inside the respective libav call; JS↔WASM boundary is inside the
  // worker so this is the real cost the producer pays per batch.
  let videoDecodeMsTotal = 0;
  let audioDecodeMsTotal = 0;
  let videoDecodeBatches = 0;
  let audioDecodeBatches = 0;
  let readMsTotal = 0;
  let readBatches = 0;
  let pumpThrottleMsTotal = 0;
  let pumpThrottleEntries = 0;
  let slowestVideoBatchMs = 0;
  let newestVideoPtsUs = 0; // set by decodeVideoBatch after each emitted frame
  let lastEmittedPtsUs = -1; // previous emitted frame's pts, for monotonicity check
  let ptsRegressions = 0;
  let worstPtsRegressionMs = 0;

  const videoTrackInfo = opts.context.videoTracks.find((t) => t.id === videoStream?.index);
  const videoFps = videoTrackInfo?.fps && videoTrackInfo.fps > 0 ? videoTrackInfo.fps : 30;
  const videoFrameStepUs = Math.max(1, Math.round(1_000_000 / videoFps));

  // ── Pump loop ─────────────────────────────────────────────────────────

  async function pumpLoop(myToken: number): Promise<void> {
    while (!destroyed && myToken === pumpToken) {
      let readErr: number;
      let packets: Record<number, LibavPacket[]>;
      try {
        // Batch size tunes the tradeoff between JS↔WASM call overhead
        // (small = more crossings per second) and queue burstiness
        // (large = decoder hands the renderer big bursts at once that
        // can blow past the renderer's 64-frame hard cap before the
        // per-batch `queueHighWater` throttle runs).
        //
        // We tried 64 KB and saw ~30% overflow drops on RMVB:rv40 at
        // 1024x768 because one decode batch regularly produced >30
        // frames. 16 KB keeps each batch ≈ 4-6 video packets at
        // typical bitrates, so the worst-case queue spike stays under
        // `queueHighWater` and the throttle has a chance to apply
        // backpressure *between* batches rather than within one.
        const _readStart = performance.now();
        [readErr, packets] = await libav.ff_read_frame_multi(fmt_ctx, readPkt, {
          limit: 16 * 1024,
        });
        readMsTotal += performance.now() - _readStart;
        readBatches++;
      } catch (err) {
        console.error("[avbridge] ff_read_frame_multi failed:", err);
        return;
      }

      if (myToken !== pumpToken || destroyed) return;

      const videoPackets = videoStream ? packets[videoStream.index] : undefined;
      const audioPackets = audioStream ? packets[audioStream.index] : undefined;

      // Track demuxer read-ahead for <video>.buffered on this strategy.
      // Peek raw pts before sanitizePacketTimestamp (which would
      // clobber to µs and lose the source-native scale). Monotonic;
      // seeks don't reset.
      if (videoPackets && videoTimeBase) {
        for (const pkt of videoPackets) {
          const sec = packetPtsSec(pkt, videoTimeBase);
          if (sec != null && sec > bufferedUntilSec) bufferedUntilSec = sec;
          // [DIAG-PKT] Raw pre-sanitize packet fields for the first N
          // post-seek video packets. Most important question: does the
          // FIRST packet after av_seek_frame carry a valid pts? If yes,
          // we can anchor synthetic counter to that — cheap & robust.
          // If no, fall back to pkt_pos → AVI index → chunk_idx × frameDur.
          if (isDebug() && diagPktsLoggedSinceSeek < DIAG_MAX_PKTS) {
            const rawHi = (pkt as { ptshi?: number }).ptshi ?? 0;
            const rawLo = pkt.pts ?? 0;
            const isInvalidPts = (rawHi === -2147483648 && rawLo === 0);
            const rawPts64 = isInvalidPts ? null : (rawHi * 0x100000000 + rawLo);
            const rawSec = rawPts64 != null && videoTimeBase
              ? (rawPts64 * videoTimeBase[0]) / videoTimeBase[1]
              : null;
            const pktKeys = diagPktsLoggedSinceSeek === 0
              ? `[keys: ${Object.keys(pkt).join(",")}]`
              : "";
            // eslint-disable-next-line no-console
            console.log(
              `[DIAG-PKT] vidx=${diagPktsLoggedSinceSeek} ` +
              `pts=${isInvalidPts ? "NOPTS" : rawPts64} ` +
              `pts_sec=${rawSec != null ? rawSec.toFixed(3) : "n/a"} ` +
              `ptshi=${rawHi} ptslo=${rawLo} ` +
              `flags=0x${(pkt.flags ?? 0).toString(16)} ` +
              `keyframe=${((pkt.flags ?? 0) & 1) ? "Y" : "N"} ` +
              `stream=${pkt.stream_index} ` +
              `dataLen=${pkt.data?.length ?? 0} ` +
              `seekTarget=${seekTargetSec.toFixed(3)} ` +
              pktKeys,
            );
            diagPktsLoggedSinceSeek++;
          }
        }
      }
      if (audioPackets && audioTimeBase) {
        for (const pkt of audioPackets) {
          const sec = packetPtsSec(pkt, audioTimeBase);
          if (sec != null && sec > bufferedUntilSec) bufferedUntilSec = sec;
        }
        // Diagnostic: log the first post-seek audio packet's PTS. With
        // PTS-based scheduling, packets whose PTS is before the seek
        // target won't be played (AudioOutput skips them silently), so
        // this is informational only — it tells you how far off the
        // demuxer's seek granularity is from the user's click.
        if (!seenFirstAudioPacketSinceSeek && audioPackets.length > 0) {
          const firstSec = packetPtsSec(audioPackets[0], audioTimeBase);
          if (firstSec != null && Number.isFinite(firstSec)) {
            seenFirstAudioPacketSinceSeek = true;
            dbg.info("av-anchor",
              `seek-target=${seekTargetSec.toFixed(3)}s, ` +
              `first-audio-pkt-pts=${firstSec.toFixed(3)}s ` +
              `(Δ=${((firstSec - seekTargetSec) * 1000).toFixed(1)}ms — ` +
              `pre-target packets will be skipped by AudioOutput)`,
            );
          }
        }
      }

      // Decode audio BEFORE video. On software-decode-bound content
      // (rv40/mpeg4/wmv3 @ 720p+) a single video batch can take
      // 200-400 ms of wall time; if the scheduler hasn't been fed
      // during that window, audio output runs dry and the user hears
      // clicks/gaps. Audio is time-critical; video can drop a frame
      // and nobody notices. Audio decode is also typically <1 ms per
      // packet for cook/mp3/aac, so doing it first barely delays
      // video decoding at all.
      if (audioDec && audioPackets && audioPackets.length > 0) {
        await decodeAudioBatch(audioPackets, myToken, /*flush*/ false, audioTimeBase);
      }
      if (myToken !== pumpToken || destroyed) return;
      if (videoDec && videoPackets && videoPackets.length > 0) {
        const processed = await applyBSF(videoPackets);
        await decodeVideoBatch(processed, myToken);
      }

      packetsRead += (videoPackets?.length ?? 0) + (audioPackets?.length ?? 0);

      // ── Decode-rate watchdog ──────────────────────────────────────
      if (videoFramesDecoded > 0) {
        if (watchdogFirstFrameMs === 0) {
          watchdogFirstFrameMs = performance.now();
        }
        const elapsedSinceFirst = (performance.now() - watchdogFirstFrameMs) / 1000;

        // 1. Slow-decode detection (sustained <60% of realtime fps).
        if (elapsedSinceFirst > 1 && !watchdogSlowWarned) {
          const expectedFrames = elapsedSinceFirst * videoFps;
          const ratio = videoFramesDecoded / expectedFrames;
          if (ratio < 0.6) {
            if (watchdogSlowSinceMs === 0) watchdogSlowSinceMs = performance.now();
            if ((performance.now() - watchdogSlowSinceMs) / 1000 > 5) {
              watchdogSlowWarned = true;
              console.warn(
                "[avbridge:decode-rate]",
                `decoder is running slower than realtime: ` +
                `${videoFramesDecoded} frames in ${elapsedSinceFirst.toFixed(1)}s ` +
                `(${(videoFramesDecoded / elapsedSinceFirst).toFixed(1)} fps vs ${videoFps} fps source — ` +
                `${(ratio * 100).toFixed(0)}% of realtime). ` +
                `Playback will stutter. Typical causes: software decode of a codec with no WebCodecs support ` +
                `(rv40, mpeg4 @ 720p+, wmv3), or a resolution too large for single-threaded WASM to keep up with.`,
              );
            }
          } else {
            watchdogSlowSinceMs = 0;
          }
        }

        // 2. Overflow-drop detection (>10% of decoded frames dropped
        //    by the renderer's hard cap). This means the decoder
        //    produces BURSTS — it's fast enough on average but one
        //    batch delivers >30 frames at a time, overflowing before
        //    the queueHighWater throttle can apply backpressure.
        //    Symptom is different from "decoder slow": here the fps
        //    ratio looks fine but the user sees choppy playback.
        if (
          !watchdogOverflowWarned &&
          videoFramesDecoded > 100 // wait for a meaningful sample
        ) {
          const rendererStats = opts.renderer.stats() as { framesDroppedOverflow?: number };
          const overflow = rendererStats.framesDroppedOverflow ?? 0;
          if (overflow / videoFramesDecoded > 0.1) {
            watchdogOverflowWarned = true;
            console.warn(
              "[avbridge:overflow-drop]",
              `renderer is dropping ${overflow}/${videoFramesDecoded} frames ` +
              `(${((overflow / videoFramesDecoded) * 100).toFixed(0)}%) because the decoder ` +
              `is producing bursts faster than the canvas can drain. Symptom: choppy ` +
              `playback despite decoder keeping up on average. Fix would be smaller ` +
              `read batches in the pump loop or a lower queueHighWater cap — see ` +
              `src/strategies/fallback/decoder.ts.`,
            );
          }
        }
      }

      // Throttle: only on audio buffer (mediaTimeOfNext - now() > 2 s).
      // Renderer queue backpressure is enforced at the *enqueue* side in
      // `decodeVideoBatch` — when the queue is at `queueHighWater`, the
      // freshly decoded VideoFrame is closed without being enqueued, so
      // the decoder keeps consuming packets in order. That preserves the
      // reference-frame state needed to decode P/B frames cleanly during
      // post-seek catch-up. Throttling the *pump* on queue depth here
      // would block demuxer reads, which would also stall audio packet
      // processing and starve `audio.bufferAhead()`.
      {
        const _throttleStart = performance.now();
        let _throttled = false;
        while (
          !destroyed &&
          myToken === pumpToken &&
          opts.audio.bufferAhead() > 2.0
        ) {
          _throttled = true;
          await new Promise((r) => setTimeout(r, 50));
        }
        if (_throttled) {
          pumpThrottleMsTotal += performance.now() - _throttleStart;
          pumpThrottleEntries++;
        }
      }

      if (readErr === libav.AVERROR_EOF) {
        if (videoDec) await decodeVideoBatch([], myToken, /*flush*/ true);
        if (audioDec) await decodeAudioBatch([], myToken, /*flush*/ true);
        return;
      }
      if (readErr && readErr !== 0 && readErr !== -libav.EAGAIN) {
        console.warn("[avbridge] ff_read_frame_multi returned", readErr);
        return;
      }
    }
  }

  async function decodeVideoBatch(pkts: LibavPacket[], myToken: number, flush = false) {
    if (!videoDec || destroyed || myToken !== pumpToken) return;
    let frames: LibavFrame[];
    const _t0 = performance.now();
    try {
      frames = await libav.ff_decode_multi(
        videoDec.c,
        videoDec.pkt,
        videoDec.frame,
        pkts,
        flush ? { fin: true, ignoreErrors: true } : { ignoreErrors: true },
      );
    } catch (err) {
      console.error("[avbridge] video decode batch failed:", err);
      return;
    }
    {
      const _dt = performance.now() - _t0;
      videoDecodeMsTotal += _dt;
      videoDecodeBatches++;
      if (_dt > slowestVideoBatchMs) slowestVideoBatchMs = _dt;
    }
    if (myToken !== pumpToken || destroyed) return;

    for (const f of frames) {
      if (myToken !== pumpToken || destroyed) return;
      // [DIAG-FRAME] Capture raw pre-sanitize fields. One-shot key dump
      // on first frame post-seek so we can see which fields libav
      // actually exposes (best_effort_timestamp? pkt_dts? pkt_pos?).
      const _diagShouldLog = isDebug() && diagFramesLoggedSinceSeek < DIAG_MAX_FRAMES;
      const _diagRawHi = f.ptshi ?? 0;
      const _diagRawLo = f.pts ?? 0;
      const _diagInvalid = (_diagRawHi === -2147483648 && _diagRawLo === 0);
      const _diagRawPts64 = _diagInvalid ? null : (_diagRawHi * 0x100000000 + _diagRawLo);
      const _diagRawSec = _diagRawPts64 != null && videoTimeBase
        ? (_diagRawPts64 * videoTimeBase[0]) / videoTimeBase[1]
        : null;
      if (_diagShouldLog && !diagFrameKeysDumped) {
        diagFrameKeysDumped = true;
        const allKeys = Object.keys(f);
        const fieldDump: Record<string, unknown> = {};
        for (const k of allKeys) {
          const v = (f as unknown as Record<string, unknown>)[k];
          // Skip the data buffer; everything else is metadata.
          if (k === "data") continue;
          if (typeof v === "object" && v !== null && "length" in (v as object)) continue;
          fieldDump[k] = v;
        }
        // eslint-disable-next-line no-console
        console.log(`[DIAG-FRAME] FIRST FRAME post-seek — all keys: ${allKeys.join(",")}`);
        // eslint-disable-next-line no-console
        console.log(`[DIAG-FRAME] FIRST FRAME field dump:`, fieldDump);
      }
      // Convert raw libav pts (in stream timebase) to µs, or null if NOPTS.
      let rawUs: number | null = null;
      if (!_diagInvalid && _diagRawPts64 != null) {
        const tb = videoTimeBase ?? [1, 1_000_000];
        const us = Math.round((_diagRawPts64 * 1_000_000 * tb[0]) / tb[1]);
        if (Number.isFinite(us) && Math.abs(us) <= Number.MAX_SAFE_INTEGER) {
          rawUs = us;
        }
      }

      // Forward declare _diagLog so PRE-ANCHOR-DROP can call it.
      // Final pts isn't known until after the anchor/step block, so we pass
      // it as a parameter rather than closing over a `let`.
      const _diagLog = (decision: string, finalPtsUs: number, sanFallback: boolean): void => {
        if (!_diagShouldLog) return;
        const ptsSrc = sanFallback
          ? `SYNTHETIC(${_diagInvalid ? "NOPTS" : "invalid-range"})`
          : "LIBAV";
        // eslint-disable-next-line no-console
        console.log(
          `[DIAG-FRAME] vidx=${diagFramesLoggedSinceSeek} ` +
          `raw_pts=${_diagInvalid ? "NOPTS" : _diagRawPts64} ` +
          `raw_pts_sec=${_diagRawSec != null ? _diagRawSec.toFixed(3) : "n/a"} ` +
          `pts_src=${ptsSrc} ` +
          `final_pts_us=${finalPtsUs} ` +
          `final_pts_sec=${(finalPtsUs / 1_000_000).toFixed(3)} ` +
          `seekTarget=${seekTargetSec.toFixed(3)} ` +
          `offset_to_target_ms=${((finalPtsUs / 1000) - (seekTargetSec * 1000)).toFixed(1)} ` +
          `lastEmittedPts_us=${lastEmittedPtsUs} ` +
          `decision=${decision}`,
        );
        diagFramesLoggedSinceSeek++;
      };

      // Anchor + step invariant.
      //   - Unanchored (post-seek, no valid pts seen yet) AND NOPTS frame
      //     → discard outright. We don't know where the decoder landed, so
      //     stamping a synthetic label would be a lie (this was the source
      //     of the post-seek fast-forward bug).
      //   - First valid raw pts → anchor `lastContentUs` to it. The pipeline
      //     below will then drop this and subsequent frames as pre-target
      //     until content reaches seekTarget.
      //   - Anchored AND valid → sync `lastContentUs` to truth.
      //   - Anchored AND NOPTS → step `lastContentUs += frameStep`.
      let _diagSanFallbackFired = false;
      const seekTargetUs = Math.round(seekTargetSec * 1_000_000);
      if (lastContentUs < 0) {
        if (rawUs == null) {
          // Cold-start keyframe special case. At seekTargetSec === 0 the
          // demuxer guarantees the very first emitted keyframe is content
          // 0 (container start=0.000000). Anchoring there directly avoids
          // discarding the opening I-frame — without this, cold start
          // loses 1-2 frames and the first paint is ~80ms late.
          //
          // STRICTLY gated to seekTarget === 0. The seek path proved
          // correct via the offset-ground-truth experiment (POSTMORTEMS
          // 2026-06-01); this branch must not change its behavior.
          //
          // Why keyframe-pin instead of back-computing from the first
          // valid pts: the I/P/B reorder is densest at the stream head,
          // so `firstValidPts − N × frameStep` is off by however many
          // early B-frames the decoder dropped. The keyframe identity
          // (`f.key_frame === 1`) is the only signal that doesn't depend
          // on frame-spacing assumptions.
          const isColdStartKeyframe =
            seekTargetSec === 0
            && (f as { key_frame?: number }).key_frame === 1;
          if (isColdStartKeyframe) {
            lastContentUs = 0;
            _diagSanFallbackFired = true;
            // Fall through: the frame gets labeled 0 and runs through
            // the regression/pre-target/enqueue pipeline normally.
          } else {
            // Pre-anchor NOPTS: discard. Decoder retains the frame internally
            // as a reference — we just don't expose it to the renderer.
            _diagLog("PRE-ANCHOR-DROP", 0, true);
            continue;
          }
        } else {
          // First valid raw pts post-seek = the anchor.
          lastContentUs = rawUs;
          if (!firstValidPtsLoggedSinceSeek) {
            firstValidPtsLoggedSinceSeek = true;
            if (isDebug()) {
              // eslint-disable-next-line no-console
              console.log(
                `[avbridge:decoder] post-seek anchor established: ` +
                `first valid raw pts = ${(rawUs / 1000).toFixed(1)}ms ` +
                `(seekTarget = ${(seekTargetSec * 1000).toFixed(1)}ms, ` +
                `Δ = ${((rawUs - seekTargetUs) / 1000).toFixed(1)}ms)`,
              );
            }
            // Guard: if the first valid pts is at or beyond the seek
            // target, the pre-anchor NOPTS frames we already discarded
            // may have straddled the target. In normal AVI MPEG-4 seeks,
            // the demuxer lands well before the target (previous
            // keyframe), so this shouldn't happen — log a warning if it
            // does so we know to implement a pkt_pos→AVI-index
            // back-computation path. The cold-start case (seekTarget=0)
            // is handled by the keyframe-pin branch above and shouldn't
            // reach this warning.
            if (rawUs >= seekTargetUs) {
              // eslint-disable-next-line no-console
              console.warn(
                `[avbridge:decoder] first valid raw pts ≥ seek target — ` +
                `pre-anchor NOPTS frames may have straddled the target ` +
                `and been mis-discarded. First painted frame may be late ` +
                `by up to one keyframe interval.`,
              );
            }
          }
        }
      } else {
        if (rawUs != null) {
          lastContentUs = rawUs; // sync to truth on every valid pts
        } else {
          lastContentUs += videoFrameStepUs; // extend from last truth
          _diagSanFallbackFired = true;
        }
      }
      // Write the content label into the frame so the bridge sees it.
      f.pts = lastContentUs;
      f.ptshi = lastContentUs < 0 ? -1 : 0;
      const _fPts = lastContentUs;
      if (_fPts > newestVideoPtsUs) newestVideoPtsUs = _fPts;
      if (lastEmittedPtsUs >= 0 && _fPts < lastEmittedPtsUs) {
        _diagLog("REGRESSED-DROP", _fPts, _diagSanFallbackFired);
        // Decoder emitted a frame with lower PTS than the previous
        // output. Dropping out-of-order frames here is the right move:
        // the renderer's paint loop assumes monotonic queue order and
        // breaks (stale frame stuck at head, newer frames drop as late,
        // paint cadence collapses) if we let them through. Two scenarios
        // produce this in practice:
        //   - Post-seek tail of a B-frame reorder buffer that survives
        //     avcodec_flush_buffers + av_bsf_flush (rare but observed
        //     on mpeg4 after large seeks).
        //   - A BSF that doesn't repair packed B-frames perfectly and
        //     lets a DTS/PTS swap through.
        // The decoder will catch up at the next I-frame.
        ptsRegressions++;
        const regressMs = (lastEmittedPtsUs - _fPts) / 1000;
        if (regressMs > worstPtsRegressionMs) worstPtsRegressionMs = regressMs;
        if (ptsRegressions <= 10) {
          // eslint-disable-next-line no-console
          console.warn(
            `[avbridge:decoder] dropped out-of-order frame #${ptsRegressions}: ` +
            `pts=${(_fPts / 1000).toFixed(1)}ms < previous=${(lastEmittedPtsUs / 1000).toFixed(1)}ms ` +
            `(regression=${regressMs.toFixed(1)}ms). Typically a post-seek B-frame reorder tail.`,
          );
        }
        continue; // skip enqueue
      }
      lastEmittedPtsUs = _fPts;
      // Decode-to-display: after a seek the demuxer lands at the
      // keyframe ≤ click target and the decoder produces frames
      // starting there. Pre-target frames are still DECODED (they're
      // reference frames for later P/B decodes) but they MUST NOT be
      // displayed — otherwise the renderer paints them in a brief
      // fast-forward burst as it catches up to audio (T_click). Drop
      // them at the enqueue boundary; the decoder doesn't care.
      //
      // Tolerance of one frame duration: source frames are quantized
      // (PTS = N × frameStep) but the user's click is arbitrary, so
      // the frame nearest the click is typically a few ms *before* it.
      // Convention (matches `<video>.currentTime = T` and ffplay):
      // display the frame at the largest PTS ≤ T.
      const targetUs = Math.round(seekTargetSec * 1_000_000);
      if (_fPts < targetUs - videoFrameStepUs) {
        _diagLog("PRE-TARGET-DROP", _fPts, _diagSanFallbackFired);
        continue;
      }
      try {
        const vf = bridge.laFrameToVideoFrame(f, { timeBase: [1, 1_000_000] });
        // Renderer-queue backpressure at the enqueue side. Discarding
        // here (rather than throttling the pump on `queueHighWater`)
        // keeps the decoder consuming packets sequentially so its
        // reference-frame state stays intact — essential during
        // post-seek catch-up, when the pump must continue reading
        // packets to advance the demuxer past pre-target audio. Without
        // sequential decode, the next batch's P/B frames decode against
        // a stale reference and produce gray + glitchy output until
        // the next keyframe.
        if (opts.renderer.queueDepth() >= opts.renderer.queueHighWater) {
          vf.close();
          _diagLog("OVERFLOW-DROP", _fPts, _diagSanFallbackFired);
        } else {
          opts.renderer.enqueue(vf);
          _diagLog("ENQUEUED", _fPts, _diagSanFallbackFired);
        }
        videoFramesDecoded++;
      } catch (err) {
        if (videoFramesDecoded === 0) {
          console.warn("[avbridge] laFrameToVideoFrame failed:", err);
        }
        _diagLog("BRIDGE-ERROR", _fPts, _diagSanFallbackFired);
      }
    }
  }

  async function decodeAudioBatch(
    pkts: LibavPacket[],
    myToken: number,
    flush = false,
    tb?: [number, number],
  ) {
    if (!audioDec || destroyed || myToken !== pumpToken) return;
    // Capture the packet-level PTS *before* decoding. libav's reported
    // `frame.pts` after decode is unreliable for mp3-in-AVI (returns a
    // value that doesn't agree with the stream's reported time base —
    // see POSTMORTEMS.md 2026-05-31). The demuxer's packet PTS is
    // reliable, and for mp3/aac the packet→frame mapping is 1:1, so we
    // forward each packet's PTS to the matching output frame. For codecs
    // where the mapping isn't 1:1, the trailing frames fall back to a
    // synthetic running counter — same behavior as before this change.
    const pktPtsSec: (number | null)[] = pkts.map((p) =>
      tb ? packetPtsSec(p, tb) : null,
    );
    let frames: LibavFrame[];
    const _t0 = performance.now();
    try {
      frames = await libav.ff_decode_multi(
        audioDec.c,
        audioDec.pkt,
        audioDec.frame,
        pkts,
        flush ? { fin: true, ignoreErrors: true } : { ignoreErrors: true },
      );
    } catch (err) {
      console.error("[avbridge] audio decode batch failed:", err);
      return;
    }
    audioDecodeMsTotal += performance.now() - _t0;
    audioDecodeBatches++;
    if (myToken !== pumpToken || destroyed) return;

    for (let i = 0; i < frames.length; i++) {
      if (myToken !== pumpToken || destroyed) return;
      const f = frames[i];
      const samples = libavFrameToInterleavedFloat32(f);
      if (samples) {
        const pts = pktPtsSec[i] ?? null;
        if (isDebug()) {
          const dur = samples.data.length / samples.channels / samples.sampleRate;
          // Log every frame — we need to see what happens around seeks.
          // Also surface explicitly when the per-frame PTS is null, which
          // would route the chunk to the LEGACY rebase path in AudioOutput.
          // eslint-disable-next-line no-console
          console.log(`[TRACE-DEC] audio frame #${audioFramesDecoded} pts=${pts != null ? pts.toFixed(4) : "NULL"} dur=${dur.toFixed(4)} samples=${samples.data.length / samples.channels} sr=${samples.sampleRate} ch=${samples.channels} pktsIn=${pkts.length} framesOut=${frames.length}`);
        }
        opts.audio.schedule(samples.data, samples.channels, samples.sampleRate, pts);
        audioFramesDecoded++;
      }
    }
  }

  // Kick off the initial pump.
  pumpToken = 1;
  pumpRunning = pumpLoop(pumpToken).catch((err) =>
    console.error("[avbridge] decoder pump failed:", err),
  );

  return {
    async destroy() {
      destroyed = true;
      pumpToken++;
      try { await pumpRunning; } catch { /* ignore */ }
      try { if (bsfCtx) await libav.av_bsf_free(bsfCtx); } catch { /* ignore */ }
      try { if (bsfPkt) await libav.av_packet_free?.(bsfPkt); } catch { /* ignore */ }
      try { if (videoDec) await libav.ff_free_decoder?.(videoDec.c, videoDec.pkt, videoDec.frame); } catch { /* ignore */ }
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
        console.warn("[avbridge] fallback: setAudioTrack — no stream with id", trackId);
        return;
      }

      // Stop the pump before touching libav state. Same discipline as seek().
      const newToken = ++pumpToken;
      if (pumpRunning) {
        try { await pumpRunning; } catch { /* ignore */ }
      }
      if (destroyed) return;

      // Tear down the old audio decoder and init a fresh one for the new stream.
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
          "[avbridge] fallback: setAudioTrack init failed — falling back to no-audio mode:",
          (err as Error).message,
        );
        audioDec = null;
        opts.audio.setNoAudio();
      }

      audioStream = newStream;

      // Re-seek so packets resume from the user's current position for the
      // new track (and the same video position).
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
        console.warn("[avbridge] fallback: setAudioTrack seek failed:", err);
      }

      // Flush the video decoder too — we just moved the demuxer back to a
      // keyframe boundary.
      try { if (videoDec) await libav.avcodec_flush_buffers?.(videoDec.c); } catch { /* ignore */ }
      await flushBSF();

      lastContentUs = -1;
      lastEmittedPtsUs = -1;
      firstValidPtsLoggedSinceSeek = false;

      pumpRunning = pumpLoop(newToken).catch((err) =>
        console.error("[avbridge] fallback pump failed (post-setAudioTrack):", err),
      );
    },

    async seek(timeSec) {
      if (isDebug()) {
        // eslint-disable-next-line no-console
        console.log(`[SEEK] target=${timeSec.toFixed(3)}s (${(timeSec * 1000).toFixed(0)}ms) wall=${performance.now().toFixed(0)}`);
      }
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
        console.warn("[avbridge] av_seek_frame failed:", err);
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
      await flushBSF();

      // Reset the content clock to "unanchored". The next decode loop
      // will discard NOPTS frames until the first valid libav pts
      // establishes a real anchor, then label every frame relative to
      // truth. Do NOT set anything to seekTarget here — that lie was
      // the post-seek fast-forward bug.
      lastContentUs = -1;
      lastEmittedPtsUs = -1;
      firstValidPtsLoggedSinceSeek = false;
      seenFirstAudioPacketSinceSeek = false;
      seekTargetSec = timeSec;
      diagPktsLoggedSinceSeek = 0;
      diagFramesLoggedSinceSeek = 0;
      diagFrameKeysDumped = false;

      // The renderer & audio output are reset by the fallback session
      // wrapper that called us — see strategies/fallback/index.ts.

      // Start a fresh pump for the new token.
      pumpRunning = pumpLoop(newToken).catch((err) =>
        console.error("[avbridge] decoder pump failed (post-seek):", err),
      );
    },

    bufferedUntilSec() {
      return bufferedUntilSec;
    },

    stats() {
      return {
        decoderType: "libav-wasm",
        packetsRead,
        videoFramesDecoded,
        audioFramesDecoded,
        // Throughput instrumentation — the stats panel turns these into
        // "decode fps actual / realtime target" and shows slowest batch
        // + producer throttle share.
        videoDecodeMsTotal,
        videoDecodeBatches,
        audioDecodeMsTotal,
        audioDecodeBatches,
        readMsTotal,
        readBatches,
        pumpThrottleMsTotal,
        pumpThrottleEntries,
        slowestVideoBatchMs,
        newestVideoPtsMs: Math.round(newestVideoPtsUs / 1000),
        ptsRegressions,
        worstPtsRegressionMs,
        sourceFps: videoFps,
        bsfApplied: bsfCtx ? ["mpeg4_unpack_bframes"] : [],
        bsfMissing: bsfRequiredButMissing ? ["mpeg4_unpack_bframes"] : [],
        // Confirmed transport info: once prepareLibavInput returns
        // successfully, we *know* whether the source is http-range (probe
        // succeeded and returned 206) or in-memory blob. Diagnostics hoists
        // these `_`-prefixed keys to the typed fields.
        _transport: inputHandle.transport === "http-range" ? "http-range" : "memory",
        _rangeSupported: inputHandle.transport === "http-range",
        ...opts.renderer.stats(),
        ...opts.audio.stats(),
      };
    },
  };
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

  // BSF (bitstream filter) methods — used for mpeg4_unpack_bframes
  av_bsf_list_parse_str_js(str: string): Promise<number>;
  AVBSFContext_par_in(ctx: number): Promise<number>;
  avcodec_parameters_copy(dst: number, src: number): Promise<number>;
  av_bsf_init(ctx: number): Promise<number>;
  av_bsf_send_packet(ctx: number, pkt: number): Promise<number>;
  av_bsf_receive_packet(ctx: number, pkt: number): Promise<number>;
  av_bsf_flush?(ctx: number): Promise<void>;
  av_bsf_free(ctx: number): Promise<void>;

  // Packet copy helpers — bridge JS packet objects to/from C-level pointers
  ff_copyin_packet(pktPtr: number, packet: LibavPacket): Promise<void>;
  ff_copyout_packet(pkt: number): Promise<LibavPacket>;
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
