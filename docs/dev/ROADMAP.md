# avbridge.js — Roadmap

Current released version: **v2.10.0** (2026-04-20)

## Positioning

**avbridge.js is a browser media compatibility engine** — VLC-style
playback for the browser, with conversion as a second pillar. Not an
editor, not a streaming platform, not a post-production suite.

> **Engine first. Player/product second. Advanced enrichment later.**

## Vision status

The original VISION.md goals are **essentially complete**:

- **Universal Playback** — local files, URLs, legacy formats
  (AVI/ASF/FLV/MKV/RM/WMV), mobile + desktop. All shipped.
- **Media Transformation** — remux (lossless) + transcode (lossy) to
  MP4/WebM/MKV. Legacy containers (AVI/ASF/FLV/RM) as transcode input.
  Progress, cancellation, streaming output (mediabunny path). All shipped.
- **Runtime Adaptation** — probe, classify, browser feature detection
  (MSE codec probe, WebCodecs availability), automatic escalation with
  fallback chains, decode-stall watchdog, manual `setStrategy()`. All shipped.
- **Observability** — `getDiagnostics()` with strategy, codecs, switch
  history, runtime metrics. All shipped.

The project significantly exceeded the vision by delivering the **web
component layer** (`<avbridge-video>`, `<avbridge-player>`),
**cross-browser test matrix** (Playwright Tier 4, 42 tests across
Chromium/Firefox/WebKit), and **consumer ergonomics** (bottom-sheet
settings, native `<select>` pickers, content-overlay slot, typed events,
playback rate on all strategies).

VISION_PLUS.md (resilience) is **partially delivered**: bitstream
fixups, decode tolerance, timestamp sanitization, clock recovery,
decode-stall detection are all shipped. The formal resilience-modes API
(`strict`/`normal`/`max`), container repair, and repair diagnostics
remain future work.

---

## Released

### v1.0 — Core library + conversion

- `createPlayer`, `probe`, `classify`, `remux`, `transcode` as
  standalone tree-shakeable exports.

### v2.0–v2.3 — Web component + production readiness

- `<avbridge-video>` HTMLMediaElement-compatible primitive.
- `<avbridge-player>` YouTube-style controls (play/pause, seek,
  volume, settings, fullscreen, keyboard/touch, auto-hide chrome).
- Transport configurability (signed URLs, custom auth).
- Bitstream fixups (mpeg4_unpack_bframes, Annex B → AVCC).
- Structured errors (`AvbridgeError` with codes + recovery hints).
- DTS, TrueHD, Theora, RealMedia codec support.
- Hybrid routing (native video + fallback audio for Blu-ray MKVs).
- A/V sync with PTS-based clock-drift calibration.
- Background tab pause/resume.
- GitHub Pages demo with COOP/COEP service worker.

### v2.4–v2.5 — Track selection + legacy transcode breadth

- Multi-audio track selection across all four strategies.
- AVI/ASF/FLV/RM/RMVB → MP4/WebM/MKV transcode via one-pass
  libav-demux pipeline (WebCodecs or software video decode).
- Shared `libav-demux.ts` helper.

### v2.6 — `<avbridge-player>` polish

- Typed `addEventListener` overloads.
- Drag-and-drop file input.
- `<track>` children parsing for subtitles.
- `readyState` + `seekable` synthesis for canvas strategies.

### v2.7–v2.8 — Cross-browser confidence + element features

- Playwright Tier 4 matrix: `fixtures.spec.ts` + `playback.spec.ts` +
  `contract.spec.ts` — **42 tests across Chromium/Firefox/WebKit**.
- Surfaced + fixed: Custom Elements spec violation in constructor,
  MSE feature-detection gap in classify, wrong libav variant for
  fallback HEVC, volumechange/seeking/seeked/loadedmetadata not
  firing on canvas strategies, seeked unreliable on Firefox/WebKit
  remux.
- `fit` attribute (contain/cover/fill), orientation-aware fullscreen.
- Top toolbar slots (`top-left`, `top-right`).
- `showControls()` public API.
- `buffered` TimeRanges on canvas strategies.
- Decode-stall watchdog (silent-video escalation).

### v2.9 — Player chrome ergonomics

- Content-overlay slot (`<slot name="content-overlay">`).
- Top-left toolbar flex fix.
- Mobile seek bar (44px touch target, scrub tooltip, thumb enlarge).
- Settings menu clipping + tap-highlight fixes.

### v2.10 — Settings overhaul + playback rate

- Bottom-sheet settings UI replacing popup menu.
- Native `<select>` picker per section (renders outside player bounds).
- Consumer extensibility: `addSettingsSection()` / `removeSettingsSection()`.
- `SettingsSectionConfig` type exported.
- `playbackRate` support on hybrid + fallback strategies (AudioOutput
  clock scaling + `AudioBufferSourceNode.playbackRate`).
- Audio pause bleed fix (gain disconnect on pause).
- Active audio/subtitle track display in settings.

---

## Current state

The project has met its **explorer integration requirements**. The
engine is mature, the player surface is consumer-ready, and
cross-browser correctness is validated. What follows is hardening,
breadth, and advanced features — not foundational work.

---

## Near term

### Remaining `<avbridge-player>` gaps

- **PiP passthrough** — wire Picture-in-Picture API (native/remux
  trivially; canvas strategies need OffscreenCanvas or MediaStream
  capture).
- **`networkState`** — transport state machine. Low priority; no
  consumer has asked.

### Cross-browser maintenance

Tier 4 Playwright matrix is complete (42/42 green). Maintenance mode:
update `_expectations.ts` when browsers evolve, add tests for new
fixtures as codec coverage grows.

### Explorer dogfood (ongoing)

Real-app validation via `z-video-player`. Drives the remaining "what's
missing from `<avbridge-player>` for drop-in use" feedback loop.

---

## Medium term

### Transcode Phase 3

- **10-bit video transcode** — pixel-format conversion before encode.
- **Streaming output** (`StreamTarget`) from the libav transcode path.
- **Multi-track output** in transcoded files.

### Subtitle timeline panel

A `<avbridge-subtitles>` element showing cues as a scrollable list
with timestamps — click a cue to jump.

### Subtitle translation

Chrome's Translator API (`self.ai.translator`) for local subtitle
translation. Progressive enhancement in the settings sheet.

---

## Long term (v3.0+)

### Resilience (VISION_PLUS.md)

Formal resilience-modes API (`strict`/`normal`/`max`), container
repair (index reconstruction), repair diagnostics
(`repairsApplied` array), degradation strategies. The targeted
fixups shipped today are the foundation; this is the full layer.

### HDR

HDR playback on hybrid/fallback (canvas `colorSpace: "display-p3"`,
PQ/HLG transfer curves). Native/remux already work if the browser
supports the codec.

### Performance

- OffscreenCanvas / worker rendering.
- libav.js pthreads (blocked on upstream bug).
- HTTP reader LRU cache for seeks.

---

## Out of scope

- HLS/DASH/RTSP (adaptive streaming — different problem domain)
- DRM / key management
- MediaStream output (real-time capture)
- ASS/SSA subtitles (SRT and VTT only)
- Full editor / post-production features

---

## Public API

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
class AvbridgeError extends Error { code: string; recovery?: string }
```

Three entry points:
- `avbridge` — core library
- `avbridge/element` — `<avbridge-video>`
- `avbridge/player` — `<avbridge-player>`

Demo: https://keishi.github.io/avbridge/
