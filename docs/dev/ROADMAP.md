# avbridge.js — Roadmap

Current released version: **v2.9.0** (2026-04-16)

## Positioning

**avbridge.js is a browser media compatibility engine** — VLC-style
playback for the browser, with conversion as a second pillar. Not an
editor, not a streaming platform, not a post-production suite.

The shape of the project:

> **Engine first. Player/product second. Advanced enrichment later.**

## Project philosophy

- Play arbitrary local or remote media in the browser, including
  legacy containers and codecs not just modern web-native ones.
- Prefer **native → remux → hybrid → fallback** — remux when possible,
  decode only when necessary.
- Transcode awkward legacy formats into modern formats, one pass.
- Expose a thin web-component surface; the engine stays the real core.
- Minimal configuration — zero-config for bundler consumers, one
  global for script-tag consumers.
- Correctness over features — every strategy must produce correct
  A/V output before gaining new capabilities.

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
  silently dropped.

### v2.5.0 — Legacy transcode breadth

Released 2026-04-14. The "if we can play it, we can convert it" release.

- **rm/rmvb transcode input.** libav software video decode (rv10/20/30/40)
  + libav audio decode (cook, ra_288, sipr, atrac3) → bridge to
  WebCodecs VideoFrame → mediabunny encode+mux. Detection is dynamic:
  `VideoDecoder.isConfigSupported()` gate falls through to software
  decode automatically, so future browsers adding rv40 support would
  silently take the faster path.
- **WebM and MKV output from legacy containers.** All combinations of
  {avi, asf, flv, rm/rmvb} input × {mp4, webm, mkv} output.
- **Shared `libav-demux.ts` helper** now the single source of truth for
  libav pump/timestamp utilities. hybrid/fallback/remux migrated off
  their duplicated copies (-397 lines).

### v2.6.0 — `<avbridge-player>` polish

Released 2026-04-14. Consumer ergonomics upgrade.

- **Typed event overloads** remove the `as unknown as CustomEvent` cast
  tax across both `<avbridge-video>` and `<avbridge-player>`. Native
  HTMLMediaElement events retain their built-in typing.
- **Drag-and-drop file input** on `<avbridge-player>` with visual
  dashed-border feedback.
- **`<track>` children parsing** — light-DOM `<track src srclang>`
  children now appear in the player's subtitle settings menu (they were
  already cloned into the shadow `<video>` for native/remux).
- **HTMLMediaElement parity** — `readyState` and `seekable` now return
  truthful values on canvas strategies. `buffered` + `networkState`
  still deferred.

### v2.7.0 — Cross-browser strategy validation

Released 2026-04-14. No runtime code changes — a confidence release.

- **Playwright-based Tier 4** in the testing model, running across
  Chromium, Firefox, and WebKit. First slice `fixtures.spec.ts`
  validates `probe()` + `classify()` output per fixture per browser
  (15 tests, ~11s).
- **Per-browser expectation matrix** at `tests/browser/_expectations.ts` —
  single source of truth; when browsers evolve, one file changes.
- **Harness page** `demo/tests-harness.html` exposes the avbridge API
  on `window` for `page.evaluate()`. Dev-only.
- **HEVC fixture** `bbb-hevc-aac.mkv` added to the corpus via
  `scripts/generate-fixtures.mjs`.
- **Architectural finding**: `classify()` is deliberately
  browser-independent for most paths. Per-browser divergence lives in
  the runtime escalation layer.

### v2.8.0 — Element feature release

Released 2026-04-15. Shipped three primitive-level element features.

- **`fit` attribute on `<avbridge-video>`** (`contain|cover|fill`,
  reflected property + `fitchange` event). Drives `object-fit` on the
  inner `<video>` and the fallback canvas via a new `--avbridge-fit`
  CSS custom property on the stage wrapper. Proxied through
  `<avbridge-player>`.
- **Top toolbar slots on `<avbridge-player>`** — `<slot name="top-left">`
  and `<slot name="top-right">` inside the auto-hide chrome, so
  consumer buttons (back, title, translate, etc.) fade with the
  controls. Click/dblclick/tap handlers gate on `composedPath()` to
  ignore events from slotted content.
- **Orientation-aware fullscreen on `<avbridge-video>`** — locks
  `screen.orientation` to match the video's intrinsic aspect
  (landscape/portrait) on fullscreen entry, releases on exit. Opt
  out per element with `no-orientation-lock`. iOS/desktop rejections
  swallowed (iOS rotates natively via `webkitEnterFullscreen`).

### v2.8.1 — Cross-browser playback validation

Released 2026-04-15. Second slice of the Playwright Tier 4 matrix.
Bootstrap → play → destroy lifecycle tested across Chromium, Firefox,
WebKit. Surfaced and fixed three real bugs in the process.

- **`tests/browser/playback.spec.ts`** — asserts playback actually
  advances per fixture per browser, plus the runtime-strategy
  expectation (after escalation) matches the matrix.
- **Fixed**: `<avbridge-player>` constructor set attributes on `this`,
  violating the Custom Elements spec and breaking
  `document.createElement`. Attribute writes moved to
  `connectedCallback`.
- **Fixed**: `classify()` now feature-detects MSE codec support
  (`MediaSource.isTypeSupported()` for the remux target mime). Before,
  HEVC MKV on open-source Chromium was classified `remux` even though
  MSE rejected it — playback stalled silently. Degrades to hybrid /
  fallback when MSE says no.
- **Fixed**: fallback strategy now always loads the full `avbridge`
  libav variant. Previously `pickLibavVariant` could pick the thinner
  `webcodecs` variant for HEVC fallback, which has no HEVC software
  decoder. Fallback does full software decode, so there's never a
  reason to pick the thinner variant.
- **Deferred**: Firefox HEVC skip. MSE optimistically reports `hev1.*`
  supported but the decoder can't decode — audio plays, video is
  black. Needs runtime decode-stall detection (buffered but
  `currentTime` not advancing). Skipped in the matrix, tracked as a
  follow-up.

### v2.8.2 — Downstream-driven chrome ergonomics

Released 2026-04-15. Quality-of-life follow-up to v2.8.0's element
feature set, driven by real-consumer feedback.

- **Opt-in Fit entry in the `<avbridge-player>` settings menu.** Set
  `show-fit` on the player and the settings menu gains Contain /
  Cover / Fill entries that write the `fit` attribute. Off by default.
- **`data-visible` on `part="toolbar-top"`** — JS-readable mirror of
  the auto-hide state for slotted toolbar buttons that need it.

### v2.8.3 — `showControls()` public API

Released 2026-04-15. Replaces a workaround consumers were writing
against internal state.

- **`showControls(durationMs?)` on `<avbridge-player>`.** App-level
  API to briefly reveal the auto-hiding chrome (carousel slide
  change, focus handoff). Resets the hide timer on any subsequent
  pointer interaction — no flicker.

### v2.8.5 — Buffered TimeRanges on canvas strategies

Released 2026-04-15. Closes the long-standing "buffered is empty on
hybrid/fallback" gap.

- **`target.buffered` patched** on hybrid + fallback — single
  `[0, frontier]` range synthesized from the demuxer's highest pts.
  Seek-bar buffered indicators fill correctly now.
- **`packetPtsSec` helper** extracted for unit-testable pts
  conversion, plus `bufferedUntilSec()` on both decoder handles.

### v2.8.7 — `contract.spec.ts` + HTMLMediaElement parity fixes

Released 2026-04-16. Third slice of the Tier 4 matrix. Writing it
surfaced four real contract bugs:

- **`volumechange` didn't fire on any strategy** — setter toggled the
  attribute instead of the IDL property. Fixed.
- **`seeking`/`seeked` didn't fire on hybrid/fallback** — the custom
  pump bypassed the native video's native seek events. Fixed.
- **`seeked` unreliable on remux in Firefox + WebKit** — MSE doesn't
  always fire it after `SourceBuffer.remove()`. Remux session now
  dispatches manually.
- **`loadedmetadata` didn't fire on hybrid/fallback** — inner `<video>`
  has no `src`. Fixed.

Tier 4 matrix is now **42/0 green** across Chromium, Firefox, WebKit.

### v2.8.6 — Cross-browser matrix fully green

Released 2026-04-15. Un-skips the last deferred item.

- **Firefox HEVC playback un-skipped.** Original v2.8.1 skip claimed
  Firefox's MSE accepted `hev1.*` but the decoder failed silently.
  Root-cause debug (instrumenting `getVideoPlaybackQuality().totalVideoFrames`)
  showed Firefox actually decodes HEVC cleanly — the test just sampled
  before the remux pipeline's 2.5 s cold-start finished. Fix: per-browser
  `playMs` override of 5000 ms for Firefox HEVC. v2.8.4's watchdog stays
  in place as defense against any future browser that lies about codec
  support.
- **Matrix is 30/0 green** across Chromium, Firefox, WebKit.

### v2.8.4 — Decode-stall detection

Released 2026-04-15. Unblocks the v2.8.1 "Known deferred" Firefox
HEVC skip and hardens remux against any future "MSE lies about codec
support" scenario.

- **Silent-video watchdog** in the stall supervisor: if audio is
  advancing but the decoder's `totalVideoFrames` hasn't moved for 3 s,
  escalate.
- **`fallbackChain` on `REMUX_CANDIDATE`** so escalation has somewhere
  to go (hybrid → fallback) instead of sitting stalled forever.
- **`evaluateDecodeHealth` / `readDecodedFrameCount`** exported for
  unit-testable supervisor logic.

---

## Near term — ergonomics + confidence

Priorities ordered by adoption value, per the project plan.

### Remaining `<avbridge-player>` gaps

Shipped in v2.6.0: typed event overloads, drag-and-drop, `<track>`
children, `readyState` + `seekable` for canvas strategies. Still TODO:

- **`networkState`** — needs a transport state machine spanning probe →
  libav reader → decoder. Out-of-scope until a real use case arrives.
- **PiP passthrough** — wire the browser's native Picture-in-Picture API
  when the underlying strategy's element supports it (native/remux
  trivially; canvas strategies would need OffscreenCanvas or a captured
  MediaStream).

### Cross-browser testing follow-ups

Tier 4 Playwright infrastructure shipped in v2.7.0 with the
strategy-decision slice; `playback.spec.ts` landed in v2.8.1; the
silent-video watchdog landed in v2.8.4; Firefox HEVC unskipped in
v2.8.6 (matrix 30/0 green); `contract.spec.ts` landed in v2.8.7
with four HTMLMediaElement parity fixes (matrix now 42/0 green).
All three originally-planned slices are shipped.

Goal across the whole tier is the same: **avbridge chooses the correct
strategy and degrades correctly on each browser** — not "every browser
supports everything."

### Dogfood in the explorer

Real-app validation via the explorer's `z-video-player`. Guides what's
missing from `<avbridge-video>`/`<avbridge-player>` for drop-in use.

---

## Medium term — polish + breadth

### Transcode Phase 3

- **10-bit video transcode** — pixel-format conversion before encode.
  Adds real complexity; defer until explicitly demanded.
- **Streaming output** (`StreamTarget`) from the libav transcode path —
  currently only supported in the mediabunny Conversion path.
- **Multi-track output** — depends on the multi-track roadmap item
  below; no user has asked yet.

### Subtitle timeline panel

A separate `<avbridge-subtitles>` or similar element showing subtitle
cues as a scrollable list with timestamps — click a cue to jump to
that point.

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
