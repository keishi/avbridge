# avbridge.js

[![npm](https://img.shields.io/npm/v/avbridge.svg)](https://www.npmjs.com/package/avbridge)
[![license](https://img.shields.io/npm/l/avbridge.svg)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/keishi/avbridge/ci.yml?branch=main&label=CI)](https://github.com/keishi/avbridge/actions/workflows/ci.yml)

> **VLC-style media playback for the browser. Play and convert arbitrary video files — local or remote.**

A media compatibility layer for the web. Drop in any file — MP4, MKV, AVI,
WMV, FLV, MPEG-TS, DivX, RMVB — and avbridge picks the best path: native
`<video>` playback, mediabunny remux to fragmented MP4, libav.js demux +
WebCodecs hardware decode, or full WASM software decode. Same API for all
of them.

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
RMVB (rv40/cook) → fallback  → libav software decode
```

## Supported formats

avbridge plays anything in this matrix. Files outside it report the
unrecognized codec/container in the classifier diagnostics — open an
issue with a sample so we can route it.

### Containers

| Container | Strategy when codecs are native | Notes |
|---|---|---|
| **MP4 / M4V** | native | Direct `<video src>` |
| **MOV** | native | QuickTime |
| **WebM** | native | VP8/VP9/AV1 + Opus/Vorbis |
| **OGG / OGV** | native | Theora + Vorbis (audio also native) |
| **WAV / MP3 / FLAC / ADTS** | native (audio-only) | |
| **MKV / Matroska** | remux | mediabunny → fMP4 → MSE |
| **MPEG-TS / M2TS / MTS** | remux | HLS-only natively, so always remuxed |
| **AVI / DivX / Xvid** | hybrid | libav demux + WebCodecs decode |
| **ASF / WMV** | hybrid or fallback | libav demux; codec decides decoder |
| **FLV / F4V** | hybrid or fallback | libav demux; codec decides decoder |
| **RM / RMVB** | fallback | libav demux + software decode |
| **3GP / 3G2** | native or remux | Treated as MP4 family |

### Video codecs

| Codec | Strategy | Source |
|---|---|---|
| **H.264 / AVC** (Baseline, Main, High, 4:2:0 8-bit) | native | hardware |
| **H.265 / HEVC** | native (Safari, Edge), remux/hybrid (Chrome via WebCodecs) | hardware |
| **VP8** | native | hardware |
| **VP9** | native | hardware |
| **AV1** | native | hardware |
| **H.264 Hi10 / 4:2:2 / 4:4:4** | remux → fallback on stall | mixed |
| **MPEG-4 Part 2** (DivX, Xvid, MS-MPEG-4 v1/v2/v3) | fallback | libav.js |
| **WMV1 / WMV2 / WMV3** | fallback | libav.js |
| **VC-1** | fallback | libav.js |
| **MPEG-1 / MPEG-2** | fallback | libav.js |
| **Theora** | fallback | libav.js |
| **RealVideo 1/2/3/4** (rv10/20/30/40) | fallback | libav.js |
| **H.263 / H.263+** | fallback | libav.js |
| **Sorenson Video 1/3** (svq1/svq3) | fallback | libav.js |
| **FLV1 (Sorenson Spark)** | fallback | libav.js |
| **VP6 / VP6F** (Flash) | fallback | libav.js |
| **DV / DVCPRO** (camcorder, MiniDV) | fallback | libav.js |
| **Canopus HQ / HQA** (Grass Valley) | fallback | libav.js |
| **Cinepak** | fallback | libav.js |
| **MJPEG** | fallback | libav.js |
| **rawvideo** (uncompressed) | fallback | libav.js |
| **QuickTime Animation (qtrle)** | fallback | libav.js |
| **PNG-in-MOV sequences** | fallback | libav.js |

### Audio codecs

| Codec | Strategy | Notes |
|---|---|---|
| **AAC** (LC, HE) | native | |
| **MP3** | native | |
| **Opus** | native | |
| **Vorbis** | native | |
| **FLAC** | native | |
| **PCM** (s16le, s24le) | native | |
| **AC-3 / E-AC-3 (Dolby Digital)** | hybrid (libav software audio + WebCodecs video) | |
| **DTS / DTS-HD / TrueHD** | hybrid or fallback | |
| **WMA v1 / v2 / Pro** (wmav1/wmav2/wmapro) | fallback | |
| **Cook / RealAudio sipr / atrac3 / ra_144 / ra_288** | fallback | |
| **MP2** | fallback | |
| **ADPCM** (IMA, MS) | fallback | |
| **PCM A-law / μ-law / u8** | fallback | |

### Subtitles

SRT (and SSA/ASS via the parser) — see `<avbridge-player>` track UI.

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
//   transport: "http-range",
//   rangeSupported: true,
//   runtime: { decoderType: "webcodecs-hybrid", videoFramesDecoded: 5432, ... },
//   strategyHistory: [{ strategy: "hybrid", reason: "...", at: 1712764800000 }]
// }
```

### Debug logging

Enable verbose per-stage logging for hard-to-diagnose issues:

```js
// In the browser console, or before avbridge loads:
globalThis.AVBRIDGE_DEBUG = true;
```

The demo pages also accept `?avbridge_debug` in the URL. When enabled,
every decision point emits a `[avbridge:<tag>]` log covering probe,
classify, libav load, bootstrap, strategy execute, and cold-start gate
timings.

The following **unconditional diagnostics** also fire — even without the
flag — when something smells off:

- `[avbridge:bootstrap]` — bootstrap chain took >5 s end-to-end
- `[avbridge:probe]` — probe took >3 s
- `[avbridge:libav-load]` — libav variant load took >5 s (usually a
  misconfigured base path or server MIME type)
- `[avbridge:cold-start]` — fallback cold-start gate timed out or
  released on video-only grace after waiting for audio
- `[avbridge:decode-rate]` — fallback decoder is running under 60% of
  realtime fps for more than 5 seconds (one-shot per session)
- `[avbridge:overflow-drop]` — renderer is dropping more than 10% of
  decoded frames because the decoder is bursting faster than the
  canvas can drain (one-shot per session)

These are designed so "it works on my machine but stutters on your
file" surfaces the specific reason in the console instead of requiring
a live debug session.

## Install

```bash
npm install avbridge
```

That's it. **No optional peers to install, no binaries to build, no static
file path to configure.** Both libav.js variants (the 5 MB webcodecs build
and the 6.5 MB custom avbridge build with AVI/WMV/DivX/rv40 decoders) ship
inside the tarball under `node_modules/avbridge/vendor/libav/` and are
lazy-loaded at runtime only if a file actually needs them.

Packed tarball is **~4 MB**, unpacked **~15 MB** (mostly the two WASM
binaries). If you only ever play native MP4, you never download a single
byte of the libav WASM — the loader is behind a dynamic `import()` that
never fires.

### Two ways to consume

**Bundler (Vite, webpack, Rollup, esbuild):**

```ts
import { createPlayer, remux, transcode, probe, classify } from "avbridge";
// or
import "avbridge/element";  // registers <avbridge-video> custom element
```

The tree-shaking budgets below apply to this path. Your bundler resolves
`mediabunny` and `libavjs-webcodecs-bridge` through normal dependency
resolution. libav.js binaries live at
`node_modules/avbridge/vendor/libav/` — the loader finds them
automatically via `import.meta.url` in the generated chunk.

**Plain `<script type="module">` (no bundler):**

```html
<script type="module"
        src="/node_modules/avbridge/dist/element-browser.js"></script>

<avbridge-video src="/video.mkv" autoplay playsinline></avbridge-video>
```

**Two elements ship.** `<avbridge-video>` is the bare
`HTMLMediaElement`-compatible primitive with zero UI; `<avbridge-player>`
(from `avbridge/player-element`) wraps it with YouTube-style chrome.
Both support:

- `fit="contain|cover|fill"` — how the video fills the element's box
  (maps to `object-fit`; default `contain`). Fires a `fitchange` event.
- `no-orientation-lock` — opt out of the default behavior that locks
  `screen.orientation` to the video's intrinsic aspect on fullscreen
  entry (landscape video → landscape, portrait video → portrait). Safe
  on iOS / desktop — the lock call is swallowed where unsupported.

`<avbridge-player>` also exposes `top-left` and `top-right` slots
inside its auto-hiding top chrome for consumer buttons (back, title,
translate, etc.), and an opt-in `show-fit` attribute that adds a
Contain / Cover / Fill entry to the settings menu:

```html
<avbridge-player src="/video.mkv" fit="cover" show-fit>
  <button slot="top-left">← Back</button>
  <button slot="top-right">Translate</button>
</avbridge-player>
```

The toolbar-top `part` exposes a `data-visible="true|false"`
attribute mirroring the controls auto-hide state — useful if slotted
buttons need to drive JS behavior (focus, announcements) in sync with
the fade, not just CSS opacity.

This is a second tsup entry (`dist/element-browser.js`) that inlines
mediabunny + libavjs-webcodecs-bridge into a single ~1.3 MB file with
zero bare specifiers at runtime. Perfect for self-hosted tools or static
sites that don't want a build step. It loads libav.js from the same
co-located `vendor/libav/` tree.

### Bundle sizes (bundler path)

| Import | Eager (gzip) |
|---|---|
| `srtToVtt` | **0.5 KB** |
| `probe`, `classify` | **2.5 KB** |
| `transcode` | **3 KB** |
| `remux` | **3.7 KB** |
| `createPlayer` | **15 KB** |
| `*` (everything) | **17.5 KB** |
| `avbridge/element` | **17 KB** |

Run `npm run audit:bundle` to verify in your fork.

### Overriding the libav path (advanced)

If you want to host the libav binaries somewhere other than
`node_modules/avbridge/vendor/libav/` — for example a CDN, a custom
libav build, or a patched version — set `AVBRIDGE_LIBAV_BASE` **before**
any avbridge code runs:

```html
<script>globalThis.AVBRIDGE_LIBAV_BASE = "https://cdn.example.com/libav";</script>
<script type="module" src="..."></script>
```

The loader will then fetch `<base>/<variant>/libav-<variant>.mjs` and its
sibling `.wasm` files. This is the documented replaceability hook for
LGPL compliance — see [`NOTICE.md`](./NOTICE.md) and
[`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md).

## Known limitations

- The **fallback strategy** uses WASM software decoding and is CPU-intensive, especially for HD video on mobile devices. The `[avbridge:decode-rate]` diagnostic fires if the decoder falls below 60% of realtime so you know that's what's happening. Codecs with no WebCodecs support (rv40, mpeg4 @ 720p+, wmv3, vc1 at high resolutions) are the usual suspects.
- **Remote URL playback requires HTTP Range requests.** Servers that don't support `Range: bytes=...` will fail fast with a clear error rather than silently downloading the whole file. This applies to all strategies.
- **H.264 + MP3 in MP4** is a best-effort combination that may produce playback issues in some browsers. Use `strict: true` to reject it, or re-encode audio to AAC via `transcode()`.
- libav.js **threading is disabled** due to known runtime bugs in the v6.8.8 pthreads build — decode runs single-threaded with WASM SIMD acceleration.
- `transcode()` only accepts mediabunny-readable inputs (MP4/MKV/WebM/OGG/MOV/MP3/FLAC/WAV). AVI/ASF/FLV/RM transcoding means "play it first, record the output" — not yet plumbed.
- `transcode()` uses **WebCodecs encoders only** — codec availability depends on the browser. AV1 encoding is not yet universal.
- For the **hybrid and fallback strategies**, `<avbridge-video>.buffered` exposes a single synthesized `[0, frontier]` range derived from the demuxer's read progress — enough to drive a seek-bar buffered indicator, but not MSE-fidelity per-range availability (decoded frames are consumed in flight on canvas strategies). Native and remux expose the real per-range `<video>.buffered`.

## Demos

Try it live: **https://keishi.github.io/avbridge/** — player + converter
running against the latest release, served from GitHub Pages with the
COOP/COEP headers needed for SharedArrayBuffer.

Or run locally:

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
