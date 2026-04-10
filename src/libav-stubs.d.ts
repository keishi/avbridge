/**
 * Type stubs for the optional libav.js peer dependencies. These are referenced
 * via the `paths` mapping in tsconfig.json so that TypeScript never follows
 * into the actual `node_modules/libavjs-webcodecs-bridge/src/bridge.ts` source
 * (which transitively pulls in `libavjs-webcodecs-polyfill` files that don't
 * type-check under TS 5.7+'s stricter ArrayBuffer typing).
 *
 * Vite resolves the real packages at runtime through its own resolver — it
 * does not honor tsconfig `paths` for module resolution.
 */

declare module "@libav.js/variant-webcodecs" {
  export const LibAV: (opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  const _default: { LibAV: typeof LibAV };
  export default _default;
}

declare module "libavjs-webcodecs-bridge" {
  export function videoStreamToConfig(libav: unknown, stream: unknown): Promise<VideoDecoderConfig | null>;
  export function audioStreamToConfig(libav: unknown, stream: unknown): Promise<AudioDecoderConfig | null>;
  export function packetToEncodedVideoChunk(pkt: unknown, stream: unknown): EncodedVideoChunk;
  export function packetToEncodedAudioChunk(pkt: unknown, stream: unknown): EncodedAudioChunk;
  export function libavFrameToVideoFrame(frame: unknown, stream: unknown): VideoFrame | null;
}
