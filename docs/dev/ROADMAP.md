# avbridge — Roadmap

Current release: **v2.2.1** (2026-04-12)

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

## Completed

### v1.0.0 — Core library + conversion

- **API shape** — `createPlayer`, `probe`, `classify`, `remux`,
  `transcode` as standalone tree-shakeable exports. Types locked.
- **Remux** — lossless repackaging to MP4/WebM/MKV via mediabunny.
  AVI/ASF/FLV input via libav fallback path. Strict mode for
  uncertain codec combos.
- **Transcode** — WebCodecs re-encoding with quality presets,
  bitrate overrides, resize, frame rate, codec selection
  (H.264/H.265/VP9/AV1 video, AAC/Opus/FLAC audio).
- **RC pass** — test corpus (5 playback fixtures, 4 conversion smoke
  tests), bundle audit, README, CHANGELOG.

### v2.0.0 — Web component + element rename

- **`<avbridge-video>`** — HTMLMediaElement-compatible custom element
  as `avbridge/element` subpath. Bootstrap token pattern, lifecycle
  invariants, strict entry isolation. `<avbridge-player>` reserved
  for future controls-bearing element.

### v2.1.x — Browser bundle + fallback improvements

- Browser-direct `dist/element-browser.js` with mediabunny +
  libavjs-webcodecs-bridge inlined.
- Fallback canvas, remux reseek, mp4v probe, demo libav path
  resolution.
- `import.meta.url`-based asset resolution — zero config for
  bundler consumers, `AVBRIDGE_LIBAV_BASE` override for
  script-tag / custom hosting.

### v2.2.0 — RealMedia + debug layer

- RealMedia (.rm/.rmvb) playback: rv10-rv40, cook, ra_144/288, sipr,
  atrac3. Routes to fallback WASM strategy.
- `.RMF` magic byte sniffing, `"rm"` ContainerKind.
- `src/util/debug.ts` runtime-toggleable verbose logging +
  unconditional watchdog diagnostics.

### v2.2.1 — Strategy-switch fixes

- Canvas renderer `object-fit: contain` for non-stage-aspect content.
- Remux `setAutoPlay()` so play state survives seek-then-play ordering
  during strategy switch.
- Hybrid/fallback patch `target.paused` from audio clock so
  `doSetStrategy` captures real play state.
- `buildInitialDecision` filters initial strategy out of inherited
  fallback chain.
- `destroy()` removes the `ended` listener attached in `bootstrap()`.

---

## v2.3.0 — Production readiness

High-impact, low-risk. Focused on unblocking real-world integrations.

### Transport configurability

**Priority: Critical — required for production use.**

`probe()`, subtitle fetches, and the libav HTTP reader all use bare
`fetch()`. This breaks signed URLs, auth flows, and any CDN that
requires custom headers. Affects all strategies.

- Add `requestInit?: RequestInit` and/or `fetchFn?: typeof fetch` to
  `CreatePlayerOptions`.
- Thread through `normalizeSource()`, subtitle fetches, and
  `attachLibavHttpReader()` (which already accepts `requestInit`
  internally but doesn't surface it).
- Minor version bump (new public API surface).

### Bitstream fixups (targeted resilience)

**Priority: High — low effort, high ROI.**

The BSF is already compiled into the custom libav variant; this is
wiring work, not new capability.

- Wire `mpeg4_unpack_bframes` BSF for packed B-frame DivX files.
- H.264 Annex B / AVCC normalization where needed.
- Surface applied fixups in diagnostics
  (`repairsApplied: ["mpeg4_unpack_bframes"]`).
- The broad resilience vision (repair modes, degradation strategies,
  damaged file recovery) stays in a future major version.

### Diagnostics UX

**Priority: Medium.**

The debug layer and diagnostics snapshot exist, but failures surface
as raw error messages or silent fallbacks. Users need to understand
*why* something didn't play.

- Human-readable failure messages ("codec not supported by this
  browser", "range requests required for this file size", "libav
  failed to load — check AVBRIDGE_LIBAV_BASE").
- Standardized error codes on emitted errors.
- Mapping from diagnostics state to UI-friendly status strings.

### Hosted demo on GitHub Pages

**Priority: Medium.**

Publish the player + converter demos to `keishi.github.io/avbridge/`
so users can try avbridge without cloning the repo. Requires a build
step for `demo/` and a GitHub Actions workflow to deploy on push.

---

## v2.4.x — Breadth

### AVI/ASF/FLV transcode input

`transcode()` currently only accepts mediabunny-readable containers
(MP4/MKV/WebM/OGG/MOV/MP3/FLAC/WAV). Completing the "any format in,
modern format out" promise requires wiring the libav demux → WebCodecs
encode path.

### Multi-audio track selection

- Remux strategy is single-track output (`setAudioTrack` is a no-op).
- Hybrid/fallback don't expose track selection.
- `setAudioTrack(id)` API exists on PlaybackSession but only native
  strategy implements it.
- Common in anime, movies, and rips — users expect switching.

### Buffered ranges for canvas strategies

`<avbridge-video>.buffered` returns empty TimeRanges for hybrid and
fallback. Synthesizing ranges from the decoder's read position would
give consumers meaningful buffer state. UX improvement, not
correctness.

---

## v3.0 — Future

### `<avbridge-video>` Phase B

Deferred until the bare element is battle-tested.

- Built-in controls UI (play/pause, seek, time, volume) under the
  reserved `<avbridge-player>` tag.
- Diagnostics panel.
- `<track>` children + audio/subtitle track menus.
- Drag-and-drop file input.
- `::part()` styling hooks.
- Typed `addEventListener` overloads so consumers don't need
  `as unknown as CustomEvent` casts.

### Resilience layer

The broad vision from VISION_PLUS.md: repair modes, degradation
strategies, damaged file recovery. A project of its own.

### Performance

- OffscreenCanvas / worker rendering.
- libav.js pthreads (blocked on upstream bug; single-threaded WASM
  with SIMD for now).
- HTTP reader LRU cache for re-fetches on seeks.

---

## Out of scope

- HLS/DASH/RTSP (adaptive streaming protocols)
- DRM / key management
- MediaStream output (real-time capture)
- Streaming output (`ReadableStream`) from remux/transcode
- ASS/SSA subtitles

---

## Current public API

```ts
// Playback
createPlayer(options: CreatePlayerOptions): Promise<UnifiedPlayer>

// Analysis (standalone, no player needed)
probe(source: MediaInput): Promise<MediaContext>
classify(context: MediaContext): Classification

// Conversion (standalone, no player needed)
remux(source: MediaInput, options?: ConvertOptions): Promise<ConvertResult>
transcode(source: MediaInput, options?: TranscodeOptions): Promise<ConvertResult>

// Utility
srtToVtt(srt: string): string
```

Two entry points:
- `avbridge` — core library (probe + classify + player + conversion)
- `avbridge/element` — `<avbridge-video>` custom element (includes core)

### Demo apps

- **Player** (`demo/index.html`): file picker, custom controls, strategy
  badge, manual backend switcher, diagnostics panel.
- **Converter** (`demo/convert.html`): HandBrake-like UI with
  container/codec/quality/bitrate/resize options, progress, cancel.
