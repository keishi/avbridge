/**
 * Static-import wrapper for the libavjs-webcodecs-bridge optional peer dep.
 *
 * The variant itself is **not** imported here — it's loaded via a runtime
 * dynamic import with `/* @vite-ignore *\/` from `libav-loader.ts`, so the
 * variant's `.mjs` file is never touched by Vite's transform pipeline (which
 * would otherwise pre-bundle it and break the `import.meta.url`-based path
 * resolution it uses to find its sibling .wasm files).
 *
 * The bridge has no such issue — it's pure JS and doesn't reference sibling
 * binaries — so a normal static import is fine here.
 *
 * TypeScript resolves `libavjs-webcodecs-bridge` via the `paths` mapping in
 * tsconfig.json which redirects to `src/libav-stubs.d.ts`, sidestepping the
 * polyfill source files that don't typecheck under TS 5.7.
 */
import * as bridge from "libavjs-webcodecs-bridge";

export const libavBridge: BridgeModule = bridge as unknown as BridgeModule;

export interface BridgeModule {
  videoStreamToConfig(libav: unknown, stream: unknown): Promise<VideoDecoderConfig | null>;
  audioStreamToConfig(libav: unknown, stream: unknown): Promise<AudioDecoderConfig | null>;
  packetToEncodedVideoChunk(pkt: unknown, stream: unknown): EncodedVideoChunk;
  packetToEncodedAudioChunk(pkt: unknown, stream: unknown): EncodedAudioChunk;
  libavFrameToVideoFrame?(frame: unknown, stream: unknown): VideoFrame | null;
}
