# UBMP — Universal Browser Media Player

Play arbitrary local media files (AVI, MKV, MP4, WMV, FLV, ...) reliably in the
browser. UBMP probes the file, picks the best playback strategy, and exposes a
single uniform API.

## Strategies

| Strategy | When | How |
|---|---|---|
| **native** | Container + codecs the browser already plays (mp4/h264/aac, webm, mp3, ...) | Hand the source to `<video>` |
| **remux** | Codecs are supported but the container isn't (mkv with H.264/AAC, etc.) | Demux + repackage to fragmented MP4 with [mediabunny](https://mediabunny.dev), feed via Media Source Extensions |
| **fallback** | Codec has no browser decoder (WMV3, MPEG-4 Part 2, DivX, ...) | WASM decode via [libav.js](https://github.com/Yahweasel/libav.js) + [libavjs-webcodecs-bridge](https://github.com/Yahweasel/libavjs-webcodecs-bridge), render to canvas, audio via Web Audio |

UBMP **always prefers native**, **prefers remux over decode**, and uses WASM
decode only when there is no other option.

## Quick start

```ts
import { createPlayer } from "ubmp";

const video = document.querySelector("video")!;
const player = await createPlayer({
  source: file, // File / Blob / URL / ArrayBuffer
  target: video,
});

player.on("strategy", ({ strategy, reason }) => {
  console.log(`[ubmp] using ${strategy}: ${reason}`);
});

await player.play();
```

## Public API

```ts
createPlayer(options): Promise<UnifiedPlayer>

interface UnifiedPlayer {
  play(): Promise<void>;
  pause(): void;
  seek(time: number): Promise<void>;
  setAudioTrack(id: number): Promise<void>;
  setSubtitleTrack(id: number | null): Promise<void>;
  getDuration(): number;
  getCurrentTime(): number;
  on(event, listener): () => void;
  getDiagnostics(): DiagnosticsSnapshot;
  destroy(): Promise<void>;
}
```

## Diagnostics

```ts
player.getDiagnostics();
// {
//   container: "mkv",
//   videoCodec: "h264",
//   audioCodec: "aac",
//   strategy: "remux",
//   strategyClass: "REMUX_CANDIDATE",
//   reason: "mkv container with native-supported codecs — remux to fragmented MP4",
//   width: 1920, height: 1080, fps: 23.976, duration: 5400,
//   probedBy: "mediabunny",
//   runtime: { videoPackets: 12000, audioPackets: 4500, fragmentsAppended: 60, decoderType: "remux" }
// }
```

## Implementation status

### Implemented (v0.1)

- **Probe layer**: container sniffing (magic bytes), mediabunny probe for modern containers, libav.js probe for AVI/ASF/FLV
- **Classification engine**: rules-based routing to native/remux/fallback with RISKY_NATIVE escalation
- **Native strategy**: `<video src>` with object URL, loadedmetadata/error wiring
- **Remux strategy**: mediabunny demux -> fragmented MP4 mux -> MSE SourceBuffer pipeline with backpressure and seek support
- **Fallback strategy**: libav.js software decode with canvas rendering, Web Audio output, wall-clock A/V sync with drift correction
- **Custom libav.js variant**: build script for AVI/WMV3/MPEG-4 Part 2/DivX/VC-1 and 15+ legacy codecs
- **Subtitles**: SRT -> VTT conversion, sidecar discovery, native `<track>` for video strategies, overlay renderer for fallback
- **Plugin system**: strategy registry with `canHandle()`/`execute()` interface
- **Diagnostics**: accumulates probe/classify/runtime stats across the full pipeline
- **Events**: typed emitter with sticky events (strategy, ready, tracks)
- **Demo**: file picker, custom controls (play/pause, seek bar, time display), strategy badge, diagnostics panel
- **Tests**: classification rules, SRT conversion, Annex B parsing, codec strings, container sniffing
- **Headless smoke tests**: Puppeteer-based playback tester (`npm run test:playback`)

### Not yet implemented

- **Multi-audio track selection** in the remux strategy (native and fallback support it)
- **Hybrid libav demux + WebCodecs decode** path for AVI with browser-supported codecs (currently falls back to full software decode)
- **OffscreenCanvas** rendering in a worker for reduced main-thread frame copy overhead
- **`mpeg4_unpack_bframes` BSF** wiring in the decode pipeline (compiled into the custom variant but not yet applied to packets)
- **Automated integration tests** with real media fixtures
- **ASS/SSA subtitles**, HLS/DASH/RTSP, DRM — explicitly out of scope for v1 (see [`DESIGN_DOC.md`](./DESIGN_DOC.md))

## Install

```bash
npm install ubmp
```

### Optional: fallback (WASM) strategy

The fallback strategy is opt-in. Install the libav packages only if you need to
play files with legacy codecs:

```bash
npm install @libav.js/variant-webcodecs libavjs-webcodecs-bridge
```

This handles MKV/WebM/MP4 containers via software decode. For **AVI, WMV3,
MPEG-4 Part 2, DivX**, and other legacy formats, you need a custom libav.js
build — see [`vendor/libav/README.md`](./vendor/libav/README.md) for the recipe.

## Demo

```bash
npm install
npm run demo
```

Open the URL Vite prints, drop a media file, and watch the strategy badge.

### Headless playback test

```bash
npm run demo                 # start dev server in one terminal
node scripts/playback-test.mjs /path/to/media/dir   # in another
```

## Build

```bash
npm run build      # tsup → dist/ (ESM + CJS + d.ts)
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

## Architecture

```
probe(source)          → MediaContext  (container, codecs, tracks, resolution, ...)
classify(MediaContext)  → Classification (strategy, reason, fallbackStrategy?)
strategy.start()       → PlaybackSession (play/pause/seek/destroy)
```

See [`DESIGN_DOC.md`](./DESIGN_DOC.md) for the full design.

## Third-party licenses

UBMP itself is [MIT licensed](./LICENSE). It depends on:

| Library | License | Role |
|---|---|---|
| [mediabunny](https://mediabunny.dev) | MPL-2.0 | Demux/mux for modern containers (remux strategy) |
| [libav.js](https://github.com/Yahweasel/libav.js) | LGPL-2.1 | Demux + decode for legacy codecs (fallback strategy) |
| [libavjs-webcodecs-bridge](https://github.com/Yahweasel/libavjs-webcodecs-bridge) | ISC | AVFrame <-> VideoFrame/AudioData conversion |

**LGPL-2.1 compliance**: The libav.js WASM binary in `vendor/libav/` is built
from source via [`scripts/build-libav.sh`](./scripts/build-libav.sh). The build
script, source repository URL, and version tag are provided so users can rebuild
or modify the library. See [`vendor/libav/README.md`](./vendor/libav/README.md).

**MPL-2.0 compliance**: mediabunny is used as an unmodified npm dependency. Its
source is available at the npm registry.

## License

[MIT](./LICENSE)
