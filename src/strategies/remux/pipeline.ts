import type { MediaContext } from "../../types.js";
import { MseSink } from "./mse.js";
import {
  avbridgeVideoToMediabunny,
  avbridgeAudioToMediabunny,
  buildMediabunnySourceFromInput,
} from "../../probe/mediabunny.js";

/**
 * Remux pipeline built against mediabunny's real API.
 *
 * Key design notes:
 *
 * - mediabunny's fMP4 muxer is a streaming muxer that requires monotonically
 *   increasing timestamps. It cannot accept out-of-order packets after a seek.
 *   Therefore, on each seek we create a **fresh** Output + sources + StreamTarget.
 *   The MseSink handles the SourceBuffer reset via `invalidate()`.
 *
 * - Backpressure is enforced at two levels: in the WritableStream write handler
 *   (limits append queue depth and total buffered time) and in the pump loop
 *   (limits buffered-ahead and total buffered time). Without this, long files
 *   dump gigabytes into the SourceBuffer and exhaust memory.
 */
export interface RemuxPipeline {
  start(fromTime?: number, autoPlay?: boolean): Promise<void>;
  seek(time: number, autoPlay?: boolean): Promise<void>;
  /** Update the autoplay intent mid-flight — used when play() arrives after seek() but before the MseSink has been constructed. */
  setAutoPlay(autoPlay: boolean): void;
  /**
   * Switch the active audio track. Tears down the current Output, rebuilds
   * with the new audio source, and resumes pumping at the given time.
   */
  setAudioTrack(trackId: number, timeSec: number, autoPlay: boolean): Promise<void>;
  destroy(): Promise<void>;
  stats(): Record<string, unknown>;
}

export async function createRemuxPipeline(
  ctx: MediaContext,
  video: HTMLVideoElement,
): Promise<RemuxPipeline> {
  const mb = await import("mediabunny");

  const videoTrackInfo = ctx.videoTracks[0];
  if (!videoTrackInfo) throw new Error("remux: source has no video track");

  // Map avbridge codec names back to mediabunny's enum strings.
  const mbVideoCodec = avbridgeVideoToMediabunny(videoTrackInfo.codec);
  if (!mbVideoCodec) {
    throw new Error(`remux: video codec "${videoTrackInfo.codec}" is not supported by mediabunny output`);
  }

  // Open the input. URL sources go through mediabunny's UrlSource so the
  // muxer streams via Range requests instead of buffering the whole file.
  const input = new mb.Input({
    source: await buildMediabunnySourceFromInput(mb, ctx.source),
    formats: mb.ALL_FORMATS,
  });
  const allTracks = await input.getTracks();
  const inputVideo = allTracks.find((t) => t.id === videoTrackInfo.id && t.isVideoTrack());
  if (!inputVideo || !inputVideo.isVideoTrack()) {
    throw new Error("remux: video track not found in input");
  }

  // Pull the video WebCodecs decoder config once — used as `meta` on the
  // first packet after every Output rebuild.
  const videoConfig = await inputVideo.getDecoderConfig();

  // Packet sink for video — reused across seeks.
  const videoSink = new mb.EncodedPacketSink(inputVideo);

  // Audio selection is mutable: setAudioTrack() can swap it. The selected
  // audio derived state (input track, codec, sink, config) is rebuilt via
  // rebuildAudio() whenever the id changes.
  type InputAudioTrack = InstanceType<typeof mb.InputAudioTrack>;
  type AudioDecCfg = Awaited<ReturnType<InputAudioTrack["getDecoderConfig"]>>;

  let selectedAudioTrackId: number | null = ctx.audioTracks[0]?.id ?? null;
  let inputAudio: InputAudioTrack | null = null;
  let mbAudioCodec: ReturnType<typeof avbridgeAudioToMediabunny> | null = null;
  let audioSink: InstanceType<typeof mb.EncodedPacketSink> | null = null;
  let audioConfig: AudioDecCfg | null = null;

  async function rebuildAudio(): Promise<void> {
    if (selectedAudioTrackId == null) {
      inputAudio = null;
      mbAudioCodec = null;
      audioSink = null;
      audioConfig = null;
      return;
    }
    const trackInfo = ctx.audioTracks.find((t) => t.id === selectedAudioTrackId);
    if (!trackInfo) {
      throw new Error(`remux: no audio track with id ${selectedAudioTrackId}`);
    }
    const newInput = allTracks.find((t) => t.id === trackInfo.id && t.isAudioTrack());
    if (!newInput || !newInput.isAudioTrack()) {
      throw new Error("remux: audio track not found in input");
    }
    inputAudio = newInput;
    mbAudioCodec = avbridgeAudioToMediabunny(trackInfo.codec);
    audioSink = new mb.EncodedPacketSink(newInput);
    audioConfig = await newInput.getDecoderConfig();
  }

  await rebuildAudio();

  // MSE sink — created lazily on first output write, reused across seeks.
  let sink: MseSink | null = null;
  const stats = { videoPackets: 0, audioPackets: 0, bytesWritten: 0, fragments: 0 };

  let destroyed = false;
  let pumpToken = 0;
  let pendingAutoPlay = false;
  let pendingStartTime = 0;

  // The current Output instance. Recreated on each seek because mediabunny's
  // fMP4 muxer requires monotonically increasing timestamps.
  let currentOutput: InstanceType<typeof mb.Output> | null = null;

  /**
   * Create a fresh mediabunny Output wired to the MSE sink. Called once at
   * start and again on each seek.
   */
  function createOutput() {
    // Cancel the previous output if it exists.
    if (currentOutput) {
      try { void currentOutput.cancel(); } catch { /* ignore */ }
    }

    let mimePromise: Promise<string> | null = null;

    const writable = new WritableStream<{
      type: "write";
      data: Uint8Array<ArrayBuffer>;
      position: number;
    }>({
      write: async (chunk) => {
        if (destroyed) return;
        if (!sink) {
          const mime = await (mimePromise ??= output.getMimeType());
          sink = new MseSink({ mime, video });
          await sink.ready();
          // Apply deferred seek + autoPlay for the initial start.
          if (pendingStartTime > 0) {
            sink.invalidate(pendingStartTime);
          }
          sink.setPlayOnSeek(pendingAutoPlay);
        }
        // Backpressure: wait for the SourceBuffer append queue to drain.
        while (sink && !destroyed && (sink.queueLength() > 10 || sink.bufferedAhead() > 60 || sink.totalBuffered() > 120)) {
          await new Promise((r) => setTimeout(r, 500));
        }
        if (destroyed) return;
        sink.append(chunk.data);
        stats.bytesWritten += chunk.data.byteLength;
        stats.fragments++;
      },
    });

    const target = new mb.StreamTarget(writable);
    const output = new mb.Output({
      format: new mb.Mp4OutputFormat({ fastStart: "fragmented" }),
      target,
    });

    // Build the output sources.
    const videoSource = new mb.EncodedVideoPacketSource(mbVideoCodec!);
    output.addVideoTrack(videoSource);

    type AudioSourceCtorArg = ConstructorParameters<typeof mb.EncodedAudioPacketSource>[0];
    let audioSource: InstanceType<typeof mb.EncodedAudioPacketSource> | null = null;
    if (mbAudioCodec && inputAudio?.isAudioTrack()) {
      audioSource = new mb.EncodedAudioPacketSource(mbAudioCodec as AudioSourceCtorArg);
      output.addAudioTrack(audioSource);
    }

    currentOutput = output;
    return { output, videoSource, audioSource };
  }

  async function pumpLoop(token: number, fromTime: number) {
    const { output, videoSource, audioSource } = createOutput();

    await output.start();


    // Find the starting key packet so we never push partial GOPs.
    const startVideoPacket =
      fromTime > 0
        ? (await videoSink.getKeyPacket(fromTime)) ?? (await videoSink.getFirstPacket())
        : await videoSink.getFirstPacket();
    if (!startVideoPacket) return;

    const startAudioPacket = audioSink
      ? (audioSink && fromTime > 0
          ? (await audioSink.getPacket(fromTime)) ?? (await audioSink.getFirstPacket())
          : await audioSink.getFirstPacket())
      : null;

    const videoIter = videoSink.packets(startVideoPacket);
    const audioIter = audioSink && startAudioPacket ? audioSink.packets(startAudioPacket) : null;

    let vNext = await videoIter.next();
    let aNext = audioIter ? await audioIter.next() : { done: true as const, value: undefined };
    let firstVideo = true;
    let firstAudio = true;

    while (!destroyed && pumpToken === token && (!vNext.done || !aNext.done)) {
      // Backpressure: pause pumping when we've buffered enough.
      while (
        !destroyed &&
        pumpToken === token &&
        sink &&
        (sink.bufferedAhead() > 30 || sink.queueLength() > 20 || sink.totalBuffered() > 90)
      ) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (destroyed || pumpToken !== token) break;

      const vTs = !vNext.done ? vNext.value.timestamp : Number.POSITIVE_INFINITY;
      const aTs = !aNext.done ? aNext.value.timestamp : Number.POSITIVE_INFINITY;

      // Mediabunny's muxer requires the first packet on a fresh Output to
      // be a key packet. We fetched `startVideoPacket` via
      // `videoSink.getKeyPacket(fromTime)` so the first video packet is
      // guaranteed to be a keyframe — but a demuxer can hand us an audio
      // packet with a lower timestamp, which mediabunny rejects with
      // "First packet must be a key packet." Force the first video
      // packet out before we let any audio through.
      const forceVideoFirst = firstVideo && !vNext.done;

      if (!vNext.done && (forceVideoFirst || vTs <= aTs)) {
        await videoSource.add(
          vNext.value,
          firstVideo && videoConfig ? { decoderConfig: videoConfig } : undefined,
        );
        firstVideo = false;
        stats.videoPackets++;
        vNext = await videoIter.next();
      } else if (audioIter && audioSource && !aNext.done) {
        await audioSource.add(
          aNext.value,
          firstAudio && audioConfig ? { decoderConfig: audioConfig } : undefined,
        );
        firstAudio = false;
        stats.audioPackets++;
        aNext = await audioIter.next();
      } else {
        break;
      }
    }

    if (!destroyed && pumpToken === token) {
      await output.finalize();
      sink?.endOfStream();
    }
  }

  return {
    async start(fromTime = 0, autoPlay = false) {
      // Store autoPlay/seekTime so the MseSink (created lazily on first
      // write) can apply the deferred seek and auto-play.
      pendingAutoPlay = autoPlay;
      pendingStartTime = fromTime;
      pumpLoop(++pumpToken, fromTime).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[avbridge] remux pipeline failed:", err);
        try { sink?.destroy(); } catch { /* ignore */ }
      });
    },
    async seek(time, autoPlay = false) {
      if (sink) {
        sink.setPlayOnSeek(autoPlay);
        sink.invalidate(time);
      } else {
        pendingAutoPlay = autoPlay;
        pendingStartTime = time;
      }
      pumpLoop(++pumpToken, time).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[avbridge] remux pipeline reseek failed:", err);
      });
    },
    setAutoPlay(autoPlay) {
      pendingAutoPlay = autoPlay;
      if (sink) sink.setPlayOnSeek(autoPlay);
    },
    async setAudioTrack(trackId, time, autoPlay) {
      if (selectedAudioTrackId === trackId) return;
      if (!ctx.audioTracks.some((t) => t.id === trackId)) {
        console.warn("[avbridge] remux: setAudioTrack — unknown track id", trackId);
        return;
      }
      // Stop the current pump. The next pumpLoop() will build a fresh
      // Output that uses the newly-selected audio source.
      pumpToken++;
      selectedAudioTrackId = trackId;
      await rebuildAudio().catch((err) => {
        console.warn("[avbridge] remux: rebuildAudio failed:", (err as Error).message);
      });
      // Tear down the existing MseSink — the audio codec may have changed,
      // and the SourceBuffer's mime is fixed at construction time. The next
      // createOutput will recompute `getMimeType()` and the write handler
      // will lazily build a new sink.
      if (sink) {
        try { sink.destroy(); } catch { /* ignore */ }
        sink = null;
      }
      pendingAutoPlay = autoPlay;
      pendingStartTime = time;
      pumpLoop(++pumpToken, time).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[avbridge] remux pipeline setAudioTrack pump failed:", err);
      });
    },
    async destroy() {
      destroyed = true;
      pumpToken++;
      try { if (currentOutput) await currentOutput.cancel(); } catch { /* ignore */ }
      try { await input.dispose(); } catch { /* ignore */ }
      sink?.destroy();
    },
    stats() {
      return { ...stats, decoderType: "remux" };
    },
  };
}

