# avbridge.js — Roadmap

Current released version: **v2.4.0** (2026-04-14)

## Project philosophy

avbridge focuses on:
- Playing arbitrary media files in the browser
- Preferring native playback, falling back gracefully through
  remux → hybrid → software decode
- Minimal configuration — zero-config for bundler consumers,
  one global for script-tag consumers
- Correctness over features — every strategy must produce
  correct A/V output before gaining new capabilities

---

## Released

### v1.0.0 — Core library + conversion

- **API shape** — `createPlayer`, `probe`, `classify`, `remux`,
  `transcode` as standalone tree-shakeable exports. Types locked.
- **Remux** — lossless repackaging to MP4/WebM/MKV via mediabunny.
  AVI/ASF/FLV input via libav fallback path. Strict mode for
  uncertain codec combos.
- **Transcode** — WebCodecs re-encoding with quality presets,
  bitrate overrides, resize, frame rate, codec selection
  (H.264/H.265/VP9/AV1 video, AAC/Opus/FLAC audio).

### v2.0.0 — Web component

- **`<avbridge-video>`** — HTMLMediaElement-compatible custom element
  as `avbridge/element` subpath. Bootstrap token pattern, lifecycle
  invariants, strict entry isolation.

### v2.1.x — Browser bundle + fallback polish

- Pre-bundled `dist/element-browser.js` (mediabunny + bridge inlined).
- `import.meta.url`-based asset resolution (zero config for bundlers,
  `AVBRIDGE_LIBAV_BASE` for script-tag / custom hosting).

### v2.2.0 — RealMedia + debug layer

- RealMedia (.rm/.rmvb) playback: rv10-rv40, cook, ra_144/288, sipr,
  atrac3. Routes to fallback WASM strategy.
- `src/util/debug.ts` runtime-toggleable verbose logging.

### v2.2.1 — Strategy-switch fixes

- Canvas `object-fit: contain`, remux `setAutoPlay`, hybrid/fallback
  `target.paused` patching, fallback-chain filtering, listener cleanup.

---

### v2.3.0 — Production readiness

Released 2026-04-14. The release that makes avbridge.js production-ready
for authenticated remote media, legacy codecs, and end-user embedding.
Deployed to the GitHub Pages demo.

### Production-readiness (originally planned v2.3)

- **Transport configurability** — `requestInit` / `fetchFn` on
  `CreatePlayerOptions`, threaded through probe, subtitles, and the
  libav HTTP reader. Unblocks signed URLs and custom auth.
- **Bitstream fixups** — `mpeg4_unpack_bframes` BSF wired into
  fallback + hybrid; Annex B → AVCC normalization in the libav remux
  path. `bsfApplied` surfaced in diagnostics.
- **Structured errors** — `AvbridgeError` with machine-readable codes
  (`ERR_AVBRIDGE_*`) and human-readable recovery hints. Applied to
  probe, codec, MSE, player-readiness, strategy-exhaustion paths.
- **GitHub Pages demo** — deployed at keishi.github.io/avbridge via
  GitHub Actions. COOP/COEP service worker for SharedArrayBuffer.
  Large-file transcode via `showSaveFilePicker()` + streaming output.

### Codec breadth

- **DTS, TrueHD, Theora decoders** in the custom libav variant.
- **Recognition via libav re-probe** when mediabunny returns unknown
  codecs (DTS in MKV was previously misidentified).
- **Hybrid routing for native video + fallback audio** — e.g. H.264
  + DTS now uses WebCodecs hardware video + libav software audio
  instead of full WASM fallback.
- **Variant picker rewrite** — allowlist-based (webcodecs-compatible
  codecs) instead of denylist, so any non-native codec triggers the
  custom avbridge variant.

### `<avbridge-player>` — controls-bearing element

Shipped ahead of schedule (was slated for v3.0). Subpath export at
`avbridge/player`:

- Play/pause, seek bar, time display, volume/mute, settings menu,
  fullscreen, strategy badge (in Stats for Nerds), loading spinner.
- Settings menu: playback speed, subtitle track, audio track, Stats
  for Nerds toggle.
- Auto-hide controls (3s), YouTube-style keyboard shortcuts
  (space/k, f, m, j/l, ←/→, ↑/↓, `>`/`<`, Esc).
- Touch gestures: tap-to-toggle-controls, double-tap left/right for
  ±10s with ripple, tap-and-hold for 2x speed.
- Seek bar with linear pointer-to-time mapping (no range-input edge
  clamping). Manual pointer capture for exact click alignment.
- `::part()` hooks on every control for external styling.

### A/V sync + rendering

Documented in `docs/dev/POSTMORTEMS.md`.

- **PTS-based rendering with clock-drift calibration** — video PTS
  and `AudioContext.currentTime` drift ~7ms/s (different clock
  domains). Fixed via periodic re-snap every 10s, keeping max drift
  under 70ms (human lip-sync threshold).
- **Hybrid audio-first pump ordering** + sub-batch yields during
  DTS decode to prevent rAF starvation.
- **Background tab pause/resume** — Chrome throttles rAF/timeouts
  when hidden; we pause cleanly and resume on visibility return.
  Configurable via `backgroundBehavior: "pause" | "continue"`.

### Testing + docs

- **269 unit tests** across 17 files (262 → added visibility state
  machine tests + AudioOutput contract).
- **Three testing tiers documented** in `docs/dev/TESTING.md`:
  unit, browser integration, and strategy-to-element contract.
- **Puppeteer player-controls contract tests** for the hybrid/fallback
  + `<avbridge-player>` integration (catches the class of bug where
  a strategy forgets to preserve HTMLMediaElement events).
- **Rebrand to avbridge.js** across docs and demo, npm package name
  unchanged.

---

### v2.4.0 — Track selection + legacy transcode input

Released 2026-04-14.

- **Multi-audio track selection** across all four strategies. The
  `<avbridge-player>` audio-track menu was cosmetic until this release;
  `setAudioTrack(id)` now rebuilds the audio decoder (fallback/hybrid)
  or the mediabunny Output (remux) and reseeks.
- **AVI/ASF/FLV input support for MP4 transcoding** (Phase 1). New
  libav-demux-backed transcode pipeline (`src/convert/transcode-libav.ts`)
  using shared helper at `src/util/libav-demux.ts`. Single video +
  single audio track, MP4 output only, 8-bit video. Extra tracks
  silently dropped. Phase 2 (WebM output, multi-track, rm/rmvb input,
  10-bit, streaming output) deferred.

---

## v2.5.x — Breadth

Ordered by likely user pain, not implementation difficulty.

### Transcode path Phase 2

- **WebM output from AVI/ASF/FLV** (VP9/Opus encode path).
- **Multi-track output** in the libav transcode path. Depends on the
  bigger multi-track-output roadmap item.
- **rm/rmvb transcode input** once codec coverage through WebCodecs is
  verified (rv40 in particular).
- **10-bit video transcode**. Needs pixel-format conversion before
  feeding `VideoSample`.
- **Streaming output** (`StreamTarget`) from the libav transcode path —
  currently only supported in the mediabunny Conversion path.
- **Migrate hybrid/fallback/remux to `libav-demux.ts`** (mechanical
  follow-up deferred from v2.4 Phase 1).

### `<avbridge-player>` polish

- **Typed `addEventListener` overloads** so consumers don't need
  `as unknown as CustomEvent` casts.
- **Drag-and-drop file input** on the player area.
- **Subtitle `<track>` children** parsing (currently only supports
  `options.subtitles`).

### Buffered ranges for canvas strategies

`<avbridge-video>.buffered` returns empty TimeRanges for hybrid and
fallback. Synthesizing ranges from the decoder's read position
would give consumers meaningful buffer state (and the seek bar's
"buffered" indicator would actually fill). UX, not correctness.

### Subtitle timeline panel

A separate `<avbridge-subtitles>` or similar element showing subtitle
cues as a scrollable list with timestamps — click a cue to jump to
that point. Like YouTube's transcript panel. Needs access to the
subtitle track cues via the player's text track.

---

## v3.0 — Strategic expansion

Core architectural work. Each item is substantial enough to justify
a major version on its own.

### Resilience

The broad vision from `VISION_PLUS.md`: repair modes, degradation
strategies, damaged file recovery. Targeted bitstream fixups
(mpeg4_unpack_bframes, Annex B normalization) are already shipped;
this is the fuller version — repair-mode API, fallback quality
knobs, error-concealing renderer.

### HDR

HDR video playback across strategies:

- **Native / remux**: already works if the browser supports the
  codec (HEVC Main 10, AV1, VP9 Profile 2). No avbridge work needed.
- **Hybrid**: WebCodecs `VideoFrame.colorSpace` carries HDR metadata,
  but the canvas renderer draws to the default sRGB context which
  tone-maps (clamps) HDR content. Needs `canvas.getContext("2d",
  { colorSpace: "display-p3" })` and possibly `configureHighDynamicRange`.
- **Fallback**: libav WASM decodes YUV → the renderer converts to RGB
  assuming SDR. Proper HDR needs PQ (SMPTE ST 2084) / HLG transfer
  curve handling and wide-gamut color conversion.

Browser HDR canvas support is still evolving (Chrome has
`configureHighDynamicRange` behind a flag as of early 2026). Track
browser progress before investing.

### Performance

- OffscreenCanvas / worker rendering (move the canvas paint loop off
  the main thread so DTS decode and rAF stop competing).
- libav.js pthreads (blocked on upstream libav.js bug; single-threaded
  WASM with SIMD for now).
- HTTP reader LRU cache for re-fetches on seeks.

## Candidate features (nice-to-have)

Ideas that don't belong to a specific release — add if a real use
case arrives.

### Subtitle translation

Chrome's built-in Translator API (`self.ai.translator`) can translate
subtitle text to the user's language. Wire as a progressive
enhancement in the `<avbridge-player>` settings menu — detect API
availability and show "Translate to [locale]" when present. No
server required, runs locally in Chrome.

---

## Integration targets

avbridge.js exists to serve real consumers. Roadmap priorities are
motivated by what these integrations need:

- **Browser apps with custom UI** — use `createPlayer()` directly or
  `<avbridge-video>` as a primitive. Drives the "HTMLMediaElement
  contract must hold for all strategies" rule.
- **Local / remote file explorers** — drives transport configurability
  (signed URLs), URL streaming, and robust probe behavior for
  arbitrary files.
- **Embedded player use** — drives `<avbridge-player>`, mobile support,
  keyboard/touch shortcuts, and `::part()` styling hooks.
- **Conversion tools** — drives `remux()` / `transcode()`, streaming
  output for large files, and format breadth.

When evaluating a feature proposal, check which integration target
it serves. If none, it's likely a candidate feature, not a roadmap
item.

---

## Out of scope

- HLS/DASH/RTSP (adaptive streaming protocols — different problem
  domain; consider for v4+)
- DRM / key management
- MediaStream output (real-time capture)
- ASS/SSA subtitles (SRT and VTT only)

---

## Current public API

```ts
// Playback
createPlayer(options: CreatePlayerOptions): Promise<UnifiedPlayer>

// Analysis
probe(source: MediaInput, transport?: TransportConfig): Promise<MediaContext>
classify(context: MediaContext): Classification

// Conversion
remux(source: MediaInput, options?: ConvertOptions): Promise<ConvertResult>
transcode(source: MediaInput, options?: TranscodeOptions): Promise<ConvertResult>

// Utility
srtToVtt(srt: string): string

// Error handling
class AvbridgeError extends Error { code: string; recovery?: string }
```

Three entry points:
- `avbridge` — core library (probe + classify + player + conversion)
- `avbridge/element` — `<avbridge-video>` custom element
- `avbridge/player` — `<avbridge-player>` controls-bearing element

### Demo apps

- **Player** (`demo/index.html`) — `<avbridge-player>` with full
  controls, mobile support, Stats for Nerds.
- **Converter** (`demo/convert.html`) — container/codec/quality/
  bitrate/resize options, streaming output via File System Access API.

Hosted at https://keishi.github.io/avbridge/
