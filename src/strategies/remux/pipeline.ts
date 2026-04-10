import type { MediaContext } from "../../types.js";
import { MseSink } from "./mse.js";
import { ubmpVideoToMediabunny, ubmpAudioToMediabunny } from "../../probe/mediabunny.js";

/**
 * Remux pipeline built against mediabunny's real API.
 *
 * Key facts that drive the design:
 *
 * - `Input.getTracks()` returns typed `InputTrack` instances. Use the
 *   `isVideoTrack()` / `isAudioTrack()` type guards rather than treating
 *   tracks as plain objects.
 * - `EncodedVideoPacketSource(codec)` and `EncodedAudioPacketSource(codec)`
 *   take the codec as a **positional** argument, and the codec must be one of
 *   mediabunny's enum strings (`"avc" | "hevc" | "vp9" | "vp8" | "av1"` for
 *   video; `"aac" | "mp3" | "opus" | …` for audio). Passing anything else —
 *   including an object — fails with `Invalid video codec '[object Object]'`.
 * - `EncodedPacketSink(track)` is the way to pull packets; it exposes a
 *   `packets()` async iterator and `getKeyPacket(time)` for seeks.
 * - Each call to `source.add(packet, meta?)` may include a `meta` object on
 *   the first packet that contains the WebCodecs decoder config. We get that
 *   from `track.getDecoderConfig()`.
 * - For streaming output to MSE we need both the init segment (`ftyp`+`moov`)
 *   and the media fragments (`moof`+`mdat`). `BufferTarget` only stores the
 *   final buffer (no callbacks); the right tool is `StreamTarget`, which
 *   takes a `WritableStream<{type:'write', data, position}>`. mediabunny
 *   writes monotonically when `fastStart: 'fragmented'` is set, so we can
 *   forward each chunk straight to MSE in arrival order.
 */
export interface RemuxPipeline {
  start(): Promise<void>;
  seek(time: number): Promise<void>;
  destroy(): Promise<void>;
  stats(): Record<string, unknown>;
}

export async function createRemuxPipeline(
  ctx: MediaContext,
  video: HTMLVideoElement,
): Promise<RemuxPipeline> {
  const mb = await import("mediabunny");

  const videoTrackInfo = ctx.videoTracks[0];
  const audioTrackInfo = ctx.audioTracks[0];
  if (!videoTrackInfo) throw new Error("remux: source has no video track");

  // Map UBMP codec names back to mediabunny's enum strings.
  const mbVideoCodec = ubmpVideoToMediabunny(videoTrackInfo.codec);
  if (!mbVideoCodec) {
    throw new Error(`remux: video codec "${videoTrackInfo.codec}" is not supported by mediabunny output`);
  }
  const mbAudioCodec = audioTrackInfo ? ubmpAudioToMediabunny(audioTrackInfo.codec) : null;

  // Open the input.
  const input = new mb.Input({
    source: new mb.BlobSource(asBlob(ctx.source)),
    formats: mb.ALL_FORMATS,
  });
  const allTracks = await input.getTracks();
  const inputVideo = allTracks.find((t) => t.id === videoTrackInfo.id && t.isVideoTrack());
  const inputAudio = audioTrackInfo
    ? allTracks.find((t) => t.id === audioTrackInfo.id && t.isAudioTrack())
    : null;
  if (!inputVideo || !inputVideo.isVideoTrack()) {
    throw new Error("remux: video track not found in input");
  }
  if (audioTrackInfo && (!inputAudio || !inputAudio.isAudioTrack())) {
    throw new Error("remux: audio track not found in input");
  }

  // Pull WebCodecs decoder configs once — used as `meta` on the first packet
  // we hand to each output source.
  const videoConfig = await inputVideo.getDecoderConfig();
  const audioConfig = inputAudio && inputAudio.isAudioTrack() ? await inputAudio.getDecoderConfig() : null;

  // Set up the streaming target. We'll get monotonic writes here for
  // fragmented mp4. We forward them all to the MSE sink as raw bytes.
  let sink: MseSink | null = null;
  const stats = { videoPackets: 0, audioPackets: 0, bytesWritten: 0, fragments: 0 };

  // We need the precise MIME (with codec strings) before we can construct the
  // MSE source buffer, but `output.getMimeType()` returns once codecs are
  // known. So we delay opening the sink until the first write — by then
  // mediabunny has the init segment ready and `getMimeType()` resolves.
  let mimePromise: Promise<string> | null = null;

  const writable = new WritableStream<{
    type: "write";
    data: Uint8Array<ArrayBuffer>;
    position: number;
  }>({
    write: async (chunk) => {
      if (!sink) {
        const mime = await (mimePromise ??= output.getMimeType());
        sink = new MseSink({ mime, video });
        await sink.ready();
      }
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

  // Build the output sources. Constructors are positional!
  const videoSource = new mb.EncodedVideoPacketSource(mbVideoCodec);
  output.addVideoTrack(videoSource);

  type AudioSourceCtorArg = ConstructorParameters<typeof mb.EncodedAudioPacketSource>[0];
  let audioSource: InstanceType<typeof mb.EncodedAudioPacketSource> | null = null;
  if (mbAudioCodec && inputAudio?.isAudioTrack()) {
    audioSource = new mb.EncodedAudioPacketSource(mbAudioCodec as AudioSourceCtorArg);
    output.addAudioTrack(audioSource);
  }

  // Set up packet sinks (input side).
  const videoSink = new mb.EncodedPacketSink(inputVideo);
  const audioSink = inputAudio?.isAudioTrack() ? new mb.EncodedPacketSink(inputAudio) : null;

  let destroyed = false;
  let pumpToken = 0; // bumped on seeks so old loops bail out
  let started = false;

  async function pumpLoop(token: number, fromTime: number) {
    if (!started) {
      await output.start();
      started = true;
    }

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
      const vTs = !vNext.done ? vNext.value.timestamp : Number.POSITIVE_INFINITY;
      const aTs = !aNext.done ? aNext.value.timestamp : Number.POSITIVE_INFINITY;

      if (!vNext.done && vTs <= aTs) {
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
    async start() {
      pumpLoop(++pumpToken, 0).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[ubmp] remux pipeline failed:", err);
        try { sink?.destroy(); } catch { /* ignore */ }
      });
    },
    async seek(time) {
      sink?.invalidate(time);
      pumpLoop(++pumpToken, time).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[ubmp] remux pipeline reseek failed:", err);
      });
    },
    async destroy() {
      destroyed = true;
      pumpToken++;
      try { await output.cancel(); } catch { /* ignore */ }
      try { await input.dispose(); } catch { /* ignore */ }
      sink?.destroy();
    },
    stats() {
      return { ...stats, decoderType: "remux" };
    },
  };
}

function asBlob(source: unknown): Blob {
  if (source instanceof Blob) return source;
  if (source instanceof ArrayBuffer || source instanceof Uint8Array) return new Blob([source as BlobPart]);
  throw new TypeError("remux: source must be a Blob/File/ArrayBuffer (URL sources are buffered earlier)");
}
