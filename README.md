# avbridge

[![npm](https://img.shields.io/npm/v/avbridge.svg)](https://www.npmjs.com/package/avbridge)
[![bundle size](https://img.shields.io/bundlephobia/minzip/avbridge?label=gzipped)](https://bundlephobia.com/package/avbridge)
[![license](https://img.shields.io/npm/l/avbridge.svg)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/keishi/avbridge/ci.yml?branch=main&label=CI)](https://github.com/keishi/avbridge/actions/workflows/ci.yml)

> **Play and convert arbitrary video files in the browser. Local files or remote URLs.**

A media compatibility layer for the web. Drop in any file — MP4, MKV, AVI,
WMV, FLV, MPEG-TS, DivX — and avbridge picks the best path: native `<video>`
playback, mediabunny remux to fragmented MP4, libav.js demux + WebCodecs
hardware decode, or full WASM software decode. Same API for all of them.

**Streaming-first.** Remote URLs are read via HTTP Range requests across all
strategies — even AVI/WMV/FLV — so a 4 GB file plays without buffering 4 GB
into RAM. Local files (`File` / `Blob`) work the same way through the same API.

Designed for personal media libraries, local file managers, and
"open anything" web apps — not streaming platforms.

## When should I use avbridge?

- You need to **play arbitrary user-provided video files** in the browser
- You want to **convert media to a browser-friendly format** without a server
- You **don't control the input format** — users may drop AVI, MKV, WMV, anything
- You want **one API** that handles format detection, strategy selection, and fallback automatically

## How it works

Browsers only support a narrow set of containers and codecs. avbridge bridges
that gap with a multi-strategy pipeline:

1. **Native** — hand the file to `<video>` (zero overhead)
2. **Remux** — repackage to fragmented MP4 via MSE (preserves hardware decode)
3. **Hybrid** — libav.js demux + WebCodecs hardware decode (for legacy containers with modern codecs)
4. **Fallback** — full WASM software decode via libav.js (universal, CPU-intensive)

avbridge **always prefers native**, **prefers remux over decode**, and uses WASM
decode only when there is no other option. If a strategy fails or stalls, it
automatically escalates to the next one.

```
MP4 (H.264/AAC)  → native    → direct <video> playback
MKV (H.264/AAC)  → remux     → fragmented MP4 via MSE
MPEG-TS (H.264)  → remux     → fragmented MP4 via MSE
AVI (H.264)      → hybrid    → libav demux + hardware decode
AVI (DivX)       → fallback  → smooth software decode
```

## Quick start

### Playback

```ts
import { createPlayer } from "avbridge";

const video = document.querySelector("video")!;
const player = await createPlayer({
  source: file, // File / Blob / URL / ArrayBuffer
  target: video,
});

player.on("strategy", ({ strategy, reason }) => {
  console.log(`Using ${strategy}: ${reason}`);
});

await player.play();
```

### Remux / export

Convert a file to a modern format without re-encoding:

```ts
import { remux } from "avbridge";

const result = await remux(file, {
  outputFormat: "mp4",       // "mp4" | "webm" | "mkv"
  onProgress: ({ percent }) => console.log(`${percent.toFixed(0)}%`),
});

// result.blob is a downloadable MP4
const url = URL.createObjectURL(result.blob);
const a = document.createElement("a");
a.href = url;
a.download = result.filename ?? "output.mp4";
a.click();
```

### Transcode / re-encode

When the source codecs are legacy (or you want a different modern codec like AV1):

```ts
import { transcode } from "avbridge";

const result = await transcode(file, {
  outputFormat: "mp4",
  videoCodec: "av1",          // h264 | h265 | vp9 | av1
  audioCodec: "opus",         // aac | opus | flac
  quality: "high",            // low | medium | high | very-high
  // Or override quality with explicit bitrate (in bps):
  // videoBitrate: 4_000_000,
  // audioBitrate: 192_000,
  width: 1280,                // optional resize
  height: 720,
  hardwareAcceleration: "prefer-software", // for archival quality
  onProgress: ({ percent }) => console.log(`${percent.toFixed(0)}%`),
});

const url = URL.createObjectURL(result.blob);
```

### Analysis (standalone)

```ts
import { probe, classify } from "avbridge";

const context = await probe(file);
console.log(context.container, context.videoTracks, context.audioTracks);

const decision = classify(context);
console.log(decision.strategy, decision.reason);
```

## Playback API

```ts
createPlayer(options: CreatePlayerOptions): Promise<UnifiedPlayer>

interface UnifiedPlayer {
  play(): Promise<void>;
  pause(): void;
  seek(time: number): Promise<void>;
  setStrategy(strategy): Promise<void>;
  setAudioTrack(id: number): Promise<void>;
  setSubtitleTrack(id: number | null): Promise<void>;
  getDuration(): number;
  getCurrentTime(): number;
  on(event, listener): () => void;
  getDiagnostics(): DiagnosticsSnapshot;
  destroy(): Promise<void>;
}
```

## Conversion API

```ts
remux(source, options?): Promise<ConvertResult>
transcode(source, options?): Promise<ConvertResult>

interface ConvertOptions {
  outputFormat?: "mp4" | "webm" | "mkv";  // default: "mp4"
  signal?: AbortSignal;
  onProgress?: (info: { percent: number; bytesWritten: number }) => void;
  strict?: boolean;  // reject uncertain combos like H.264 + MP3
}

interface TranscodeOptions extends ConvertOptions {
  videoCodec?: "h264" | "h265" | "vp9" | "av1";
  audioCodec?: "aac" | "opus" | "flac";
  quality?: "low" | "medium" | "high" | "very-high";  // default: "medium"
  videoBitrate?: number;       // bits per second; overrides quality
  audioBitrate?: number;       // bits per second; overrides quality
  width?: number;              // resize; height auto-deduced if not set
  height?: number;
  frameRate?: number;          // override frame rate
  dropVideo?: boolean;         // audio-only output
  dropAudio?: boolean;         // silent output
  hardwareAcceleration?: "no-preference" | "prefer-hardware" | "prefer-software";
}

interface ConvertResult {
  blob: Blob;          // downloadable file
  mimeType: string;    // "video/mp4", "video/webm", "video/x-matroska"
  container: string;
  videoCodec?: string;
  audioCodec?: string;
  duration?: number;
  filename?: string;   // suggested download name
}
```

### What `remux()` guarantees

- Outputs a **finalized downloadable file** — not fragmented-for-streaming
- Does **not** decode or re-encode — lossless repackaging only
- Rejects unsupported codecs with a clear error pointing to `transcode()`
- In `strict` mode, rejects uncertain combinations (e.g. H.264 + MP3)

### What `transcode()` does

- Decodes the source and re-encodes via **WebCodecs encoders** (hardware-accelerated when available)
- Mux pipeline is provided by mediabunny — it handles encoder selection, sample sync, and finalization
- Output format is fully configurable: container × video codec × audio codec × quality
- **Automatic retry on encoder init failures** — works around a headless-Chromium-specific
  WebCodecs H.264 first-call init bug. When a retry happens, it's recorded in `result.notes`.
- Use the `hardwareAcceleration` hint to trade speed vs quality:
  - `"prefer-hardware"` — fastest, may produce slightly lower quality at low bitrates
  - `"prefer-software"` — slower, higher quality (recommended for archival)
  - `"no-preference"` — let the browser pick (default)

### Transcode codec compatibility

Which video/audio codec combinations are valid for each output container:

| Container | Video codecs            | Audio codecs       |
|-----------|-------------------------|--------------------|
| **MP4**   | H.264, H.265/HEVC, AV1  | AAC, FLAC          |
| **WebM**  | VP9, AV1                | Opus               |
| **MKV**   | H.264, H.265, VP9, AV1  | AAC, Opus, FLAC    |

Picking an incompatible combo (e.g. WebM + H.264) throws an error before any encoding starts.

> **Browser support note:** transcode availability depends on what the browser's WebCodecs implementation supports. Chrome/Edge have the broadest encoder set; Safari is narrower; Firefox is the most limited. AV1 encoding in particular is not yet universally supported.

## Conversion support

| Input | Best path | Notes |
|---|---|---|
| MP4 (H.264/AAC) | **Native playback** | No conversion needed |
| MKV (H.264/AAC) | **Safe remux** | Repackage to MP4/WebM/MKV losslessly |
| MKV (H.265/Opus) | **Safe remux** | Any modern codec combo |
| MPEG-TS (H.264/AAC) | **Safe remux** | TS demuxed by mediabunny; repackaged to fragmented MP4 |
| MP4 (H.264/AAC) → MP4 AV1 | **Transcode** | Re-encode via WebCodecs `VideoEncoder` |
| MP4 (H.264) → WebM (VP9) | **Transcode** | Container + video codec change requires re-encode |
| AVI (H.264/MP3) | **Best-effort remux** | Requires libav.js for demux; `strict` mode rejects |
| AVI (DivX/Xvid) | **Requires transcode** | Codec has no browser decoder (input not yet supported by `transcode()` in v1) |
| WMV (WMV3) | **Requires transcode** | Codec has no browser decoder (input not yet supported by `transcode()` in v1) |

> **Note:** `transcode()` v1 only accepts inputs in mediabunny-readable containers (MP4, MKV, WebM, OGG, MOV, MP3, FLAC, WAV). Transcoding from AVI/ASF/FLV is planned for v1.1.

## Diagnostics

Every decision avbridge makes is inspectable:

```ts
player.getDiagnostics();
// {
//   container: "avi",
//   videoCodec: "h264",
//   audioCodec: "mp3",
//   strategy: "hybrid",
//   strategyClass: "HYBRID_CANDIDATE",
//   reason: "avi container requires libav demux; codecs are hardware-decodable",
//   width: 1920, height: 1080, duration: 5400,
//   probedBy: "libav",
//   strategyHistory: [{ strategy: "hybrid", reason: "...", at: 1712764800000 }]
// }
```

## Install

```bash
npm install avbridge
```

This gives you the **core package**: probe, classify, native playback, remux,
transcode, and subtitles. No WASM. The full library is ~17 KB gzipped, but
tree-shaking is aggressive — what you actually pay for depends on which
exports you import:

| Import | Eager (gzip) |
|---|---|
| `srtToVtt` | **0.5 KB** |
| `probe`, `classify` | **3 KB** |
| `transcode` | **3.3 KB** |
| `remux` | **4.1 KB** |
| `createPlayer` | **14 KB** |
| `*` (everything) | **17 KB** |

The libav-loader path is split into a lazy chunk (~5 KB extra) that only
loads when a consumer actually invokes the AVI/ASF/FLV remux path.

Run `npm run audit:bundle` to verify these numbers in your fork.

### Optional: fallback / hybrid strategies

For files that need software decode or libav.js demux (AVI, WMV, FLV,
legacy codecs):

```bash
npm install @libav.js/variant-webcodecs libavjs-webcodecs-bridge
```

This handles MKV/WebM/MP4 containers via the hybrid/fallback strategies.

### Optional: AVI, WMV3, DivX, and other legacy formats

For **AVI, WMV3, MPEG-4 Part 2, DivX**, and other legacy formats, you need
a custom libav.js build — see [`vendor/libav/README.md`](./vendor/libav/README.md)
for the build recipe.

### Package boundary summary

| What you need | What to install |
|---|---|
| Playback of MP4/MKV/WebM/**MPEG-TS** + remux/transcode export | `avbridge` (core, no WASM) |
| Fallback/hybrid decode for modern codecs in legacy containers (AVI/ASF/FLV) | + `@libav.js/variant-webcodecs` + `libavjs-webcodecs-bridge` |
| AVI, WMV3, DivX, MPEG-4 Part 2, VC-1 | + custom libav build (`scripts/build-libav.sh`) |

### Serving the libav.js binaries

The optional libav variants ship as `.wasm` + `.mjs` files that need to be
served by your app at a known URL. avbridge looks for them at
`/libav/<variant>/libav-<variant>.mjs` (where `<variant>` is `webcodecs` or
`avbridge`). You can override the base URL with
`globalThis.AVBRIDGE_LIBAV_BASE = "/my-static-path"` before any avbridge
code runs.

#### Vite

Copy the variant binaries into your `public/libav/` directory at build
time. The avbridge demo does this via `scripts/copy-libav.mjs`:

```bash
# In your project, after npm install:
mkdir -p public/libav/webcodecs
cp node_modules/@libav.js/variant-webcodecs/dist/* public/libav/webcodecs/
```

For the custom `avbridge` variant, after running `./scripts/build-libav.sh`
in the avbridge repo, copy `vendor/libav/*` into `public/libav/avbridge/`.

#### Webpack

Use `copy-webpack-plugin` to ship the binaries to your output directory at
the same `libav/<variant>/` path.

#### Plain `<script>` / no bundler

Drop the variant directory anywhere on your origin and set
`globalThis.AVBRIDGE_LIBAV_BASE` to the matching URL before importing
avbridge.

If a libav-backed strategy is selected and the binary isn't reachable,
avbridge throws a clear error mentioning the URL it tried to load. The
core (native + remux for modern containers) doesn't need any of this.

## Known limitations

- The **fallback strategy** uses WASM software decoding and is CPU-intensive, especially for HD video on mobile devices.
- **Remux of AVI/ASF/FLV** requires libav.js — the core package cannot demux these containers.
- **Remote URL playback requires HTTP Range requests.** Servers that don't support `Range: bytes=...` will fail fast with a clear error rather than silently downloading the whole file. This applies to all strategies.
- **H.264 + MP3 in MP4** is a best-effort combination that may produce playback issues in some browsers. Use `strict: true` to reject it, or re-encode audio to AAC via `transcode()`.
- AVI files with **packed B-frames** (some DivX encodes) may have timing issues until the `mpeg4_unpack_bframes` BSF is wired in.
- libav.js **threading is disabled** due to bugs in v6.8.8 — decode runs single-threaded with SIMD acceleration.
- `transcode()` v1 only accepts mediabunny-readable inputs (MP4/MKV/WebM/OGG/MOV/MP3/FLAC/WAV). AVI/ASF/FLV transcoding is planned for v1.1.
- `transcode()` uses **WebCodecs encoders only** — codec availability depends on the browser. AV1 encoding is not yet universal.
- For the **hybrid and fallback strategies**, `<avbridge-video>.buffered` returns an empty `TimeRanges` because the canvas-based renderers don't track buffered ranges yet. Native and remux strategies expose the full `<video>.buffered` set as expected.

## Demos

```bash
npm install
npm run demo
```

Two pages share the dev server:

- **Player** (`/`) — file picker, custom controls, strategy badge, manual
  backend switcher, live diagnostics. Drop a media file and watch the
  strategy chain pick the best path.
- **Converter** (`/convert.html`) — HandBrake-like UI with container/codec/
  quality/bitrate/resize options. Picks remux when codecs already match
  the target, transcode when they don't. Progress bar, cancel, download.

## Build & test

```bash
npm run build         # tsup → dist/ (ESM + CJS + d.ts, code-split lazy chunks)
npm run typecheck     # tsc --noEmit
npm test              # vitest unit tests
npm run audit:bundle  # verify tree-shaking — bundle each public export and check size
npm run fixtures      # regenerate the test fixture corpus from BBB source via ffmpeg

# Browser smoke tests (require `npm run demo` running in another terminal)
npm run test:playback -- tests/fixtures/    # walk the corpus through the player
npm run test:convert                        # exercise the converter via puppeteer
```

## Architecture

```
probe(source)          → MediaContext     (container, codecs, tracks, resolution, ...)
classify(MediaContext)  → Classification  (strategy, reason, fallbackChain)
strategy.start()       → PlaybackSession (play/pause/seek/destroy)
```

If the chosen strategy fails or stalls, the player walks the `fallbackChain`
automatically (unless `autoEscalate: false` is set). Users can also call
`player.setStrategy()` at any time to switch manually.

## Third-party licenses

avbridge itself is [MIT licensed](./LICENSE). It depends on:

| Library | License | Role |
|---|---|---|
| [mediabunny](https://mediabunny.dev) | MPL-2.0 | Demux/mux for modern containers (remux strategy + conversion) |
| [libav.js](https://github.com/Yahweasel/libav.js) | LGPL-2.1 | Demux + decode for legacy codecs (fallback/hybrid strategies) |
| [libavjs-webcodecs-bridge](https://github.com/Yahweasel/libavjs-webcodecs-bridge) | ISC | AVFrame <-> VideoFrame/AudioData conversion |

**LGPL-2.1 compliance**: The libav.js WASM binary in `vendor/libav/` is built
from source via [`scripts/build-libav.sh`](./scripts/build-libav.sh). The build
script, source repository URL, and version tag are provided so users can rebuild
or modify the library. See [`vendor/libav/README.md`](./vendor/libav/README.md).

**MPL-2.0 compliance**: mediabunny is used as an unmodified npm dependency. Its
source is available at the npm registry.

## License

[MIT](./LICENSE)
