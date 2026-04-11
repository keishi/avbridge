# avbridge 1.0.0

## Short version (paste into GitHub release / Twitter / HN comment)

> **avbridge 1.0** — play and convert arbitrary video files in the browser.
> Local files or remote URLs. AVI, MKV, MP4, WMV, FLV, MPEG-TS, DivX, HEVC, AV1.
> One API for native playback, remuxing, hybrid hardware decode, and full
> WASM software fallback. HTTP Range streaming across every strategy — a
> 4 GB remote AVI plays without buffering 4 GB into RAM. ~17 KB gzipped
> for the full library; ~3 KB if you only import `remux()`.

---

## Long version (GitHub release body)

### What is avbridge?

A media compatibility layer for the web. Drop in any file — MP4, MKV, AVI,
WMV, FLV, MPEG-TS, DivX — and avbridge picks the best path:

- **Native** — direct `<video>` playback (zero overhead)
- **Remux** — mediabunny demux → fragmented MP4 → MSE
- **Hybrid** — libav.js demux + WebCodecs hardware decode
- **Fallback** — full WASM software decode via libav.js

If a strategy fails or stalls, the player automatically escalates to the next
one. Same `createPlayer({ source, target })` API for all of them.

### What's new in 1.0

- **`createPlayer()`** — universal browser media player with automatic
  strategy selection, runtime fallback escalation, manual `setStrategy()`,
  typed events, diagnostics, and subtitle support.
- **`remux()`** — repackage from any avbridge-readable container into a
  finalized downloadable MP4 / WebM / MKV. Lossless. Supports `signal`,
  `onProgress`, and `strict` mode.
- **`transcode()`** — re-encode via WebCodecs. Configurable container,
  video codec (H.264 / H.265 / VP9 / AV1), audio codec (AAC / Opus / FLAC),
  quality preset, explicit bitrate, resize, frame rate, drop-tracks, and
  hardware-acceleration hint.
- **`<avbridge-player>` web component** — drop-in custom element with
  the same engine underneath. Subpath import: `import "avbridge/element"`.
- **HTTP Range streaming for URL sources across all four strategies** —
  including AVI / WMV / FLV via libav.js's block reader interface. No
  full-file buffering. Servers without Range support fail fast with a
  clear error.
- **MPEG-TS support** via mediabunny — covers a huge slice of real-world
  "fallback" video inventories.
- **Tree-shaking enforced** — `import { remux } from "avbridge"` is 4 KB
  gzipped (vs. 17 KB for the full library). The libav-loader / fallback /
  hybrid paths are code-split into lazy chunks that only load when used.
- **Auto-retry on WebCodecs encoder init failures** — works around a known
  headless Chromium first-call init bug for the H.264 encoder. Production
  Chrome doesn't hit this; the retry path is silent in real browsers.
- **Player + Converter demos** in the repo (`demo/index.html`,
  `demo/convert.html`).

### Design philosophy

- **Native first, decode last.** Always prefer the browser's own decoder.
- **Remux over decode.** Fix the container before reaching for a software decoder.
- **No silent buffering.** URL inputs stream via Range requests; servers
  without Range support fail fast.
- **The element is a quality harness, not a UI framework.** It exists to
  validate the core API by being a real consumer of it. Resist the urge
  to add controls, theming, or plugins to the element layer.

### Bundle sizes

| Import | Eager (gzipped) |
|---|---|
| `srtToVtt` | 0.5 KB |
| `probe + classify` | 2.4 KB |
| `transcode` | 2.8 KB |
| `remux` | 3.6 KB |
| `createPlayer` | 14 KB |
| Full library (`*`) | 17 KB |
| `avbridge/element` | 15.5 KB |

The libav.js loader and AVI demuxer code is split into lazy chunks that only
load when a consumer actually invokes the AVI/ASF/FLV path.

### Test coverage

- 84 unit tests
- 5/5 playback fixtures (native, remux MKV, remux MPEG-TS, hybrid AVI,
  fallback DivX)
- 4/4 conversion smoke tests
- 5/5 element lifecycle tests (Puppeteer)
- 4/4 URL streaming tests (every strategy verified to use Range requests)
- 8/8 bundle audit scenarios (including `core-no-element` strict isolation)

### Known limitations

- The fallback strategy uses WASM software decoding and is CPU-intensive on
  HD video on mobile.
- Remux of AVI/ASF/FLV requires the optional libav.js packages (or a
  custom build for legacy codecs).
- Remote URL playback requires HTTP Range requests (no fallback to full
  download — by design).
- `transcode()` v1 only accepts mediabunny-readable inputs. AVI/ASF/FLV
  transcoding is planned for v1.1.
- WebCodecs encoder availability depends on the browser. AV1 encoding is
  not yet universal.

### Get it

```bash
npm install avbridge
```

```ts
import { createPlayer } from "avbridge";

const player = await createPlayer({
  source: file,         // File / Blob / URL string
  target: video,
});

await player.play();
```

Full API + bundle size table + codec compatibility tables in the
[README](./README.md).

### Thanks

This wouldn't exist without:

- [mediabunny](https://mediabunny.dev) by Vanilagy — modern container demux/mux + WebCodecs glue
- [libav.js](https://github.com/Yahweasel/libav.js) by Yahweasel — FFmpeg in the browser
- [libavjs-webcodecs-bridge](https://github.com/Yahweasel/libavjs-webcodecs-bridge) — AVFrame ↔ VideoFrame conversion

---

## Tweet-length

> avbridge 1.0 — drop any video file into the browser and it plays. AVI, MKV,
> WMV, FLV, MPEG-TS, DivX, HEVC, AV1. Local files or remote URLs (HTTP Range
> streaming for everything). 17 KB gzipped. Same API plays + remuxes + transcodes.
> npm install avbridge

## HN title suggestions

- "Show HN: Avbridge — play any video file in the browser, including AVI/WMV/DivX"
- "Show HN: A 17 KB browser media engine that streams remote AVI/WMV via HTTP Range"
- "Show HN: Avbridge — VLC-style "play anything" for the web, with HTTP Range streaming"
