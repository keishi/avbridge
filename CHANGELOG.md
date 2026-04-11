# Changelog

All notable changes to **avbridge** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0]

### Added

- **RealMedia playback support** (`.rm`, `.rmvb`). The custom `avbridge`
  libav variant now includes the `rm` demuxer and every RealVideo /
  RealAudio decoder family:
  - Video: `rv10`, `rv20`, `rv30`, `rv40`
  - Audio: `cook`, `ra_144`, `ra_288`, `sipr`, `atrac3`
  These codecs have no browser decoder, so classification routes them
  to the fallback WASM strategy. The custom variant grows by a few
  hundred KB of WASM; the webcodecs variant is unchanged.
- **Sniff layer recognizes `.RMF` magic bytes** and returns the new
  `"rm"` `ContainerKind`. Probing for a `.rm` or `.rmvb` file goes
  through libav directly (mediabunny doesn't handle RealMedia).
- **File-picker accept list** in `demo/index.html` and
  `demo/convert.html` now includes `.rm` and `.rmvb`.

### Changed

- **`VideoCodec`** gained `rv10`, `rv20`, `rv30` (existing `rv40` kept).
- **`AudioCodec`** gained `cook`, `ra_144`, `ra_288`, `sipr`, `atrac3`.
- **`ContainerKind`** gained `rm`.
- **Classifier** (`src/classify/rules.ts`) — all new RV/RA codecs added
  to `FALLBACK_VIDEO_CODECS` / `FALLBACK_AUDIO_CODECS`.

### Fallback strategy performance tuning

These are general-purpose improvements motivated by RealMedia testing
but also benefit MPEG-4 Part 2 (DivX/Xvid), WMV3, and other
software-decoded content:

- **Cold-start pre-roll gate lowered 300 ms → 40 ms, timeout 10 s → 3 s.**
  The gate used to wait for 300 ms of buffered audio before starting
  playback. On software-decode-bound content (rv40, mpeg4 @ 720p+),
  the decoder produces output slower than realtime, so 300 ms is
  unreachable — the gate would sit out its 10 s timeout before the
  first frame appeared, which the user experienced as a silent 10-
  second hang after clicking Play. The gate now starts on 40 ms
  audio + first frame, and the safety timeout is 3 s. A diagnostic
  warning fires loudly if the timeout is ever hit.
- **Decoder read batch size raised 16 KB → 64 KB.** Fewer JS↔WASM
  `ff_read_frame_multi` / `ff_decode_multi` round trips per unit of
  video, which measurably speeds up software decode on slow devices.
  Queue burstiness is unchanged because the existing
  `queueHighWater = 30` backpressure still applies.

### Debug + self-diagnosis layer

New: **`src/util/debug.ts`** — a runtime-toggleable verbose logging
channel, plus unconditional warnings for suspicious conditions. The
goal is that subtle issues self-identify in the console instead of
requiring 10 minutes of reading diagnostics JSON.

- Set `globalThis.AVBRIDGE_DEBUG = true` (or append `?avbridge_debug`
  to a demo page URL) to enable verbose logging. Every log is
  prefixed `[avbridge:<tag>]` so you can filter.
- When debug is **off**, the following conditions still emit an
  unconditional `console.warn`:
  - **`[avbridge:cold-start] gate TIMEOUT…`** — the fallback
    strategy's `waitForBuffer` hit its 3 s timeout with a
    specific underflow (e.g. "audio=0 ms, frames=0"). This used to
    silently hang playback for 10 seconds.
  - **`[avbridge:decode-rate] decoder is running slower than
    realtime…`** — watchdog in the fallback pump loop; fires once
    per stall when framesDecoded/s stays below 60% of source fps
    for ≥5 s after the first frame. Tells you the exact fps
    ratio and names the likely cause.
  - **`[avbridge:bootstrap] total bootstrap time <N>ms — unusually
    slow…`** — bootstrap took >5 s end-to-end.
  - **`[avbridge:probe] probe took <N>ms (>3000ms expected)…`** —
    slow probe (usually a slow Range request or libav cold-start).
  - **`[avbridge:libav-load] load "<variant>" took <N>ms
    (>5000ms expected)…`** — slow WASM download or wrong base
    path.

### Known limitations

- **rv40 / rv30 at 720p+ may still stutter** on modest CPUs. Single-
  threaded WASM software decode of RealVideo's motion compensation is
  fundamentally slower than realtime on many files. libav.js pthreads
  and a WebGL YUV→RGBA upload path are both plausible follow-ups but
  not in 2.2.0. For reference: a 1024×768 rv40 file plays at roughly
  0.5-2× realtime on an M-series Mac depending on the bitrate. The
  new `[avbridge:decode-rate]` watchdog flags this condition in the
  console so the symptom is never a silent stutter.

### Tests

- New sniff test for `.RMF` magic bytes (`tests/sniff.test.ts`).
- Two new classify tests for RealMedia routing (rv40+cook, rv30+ra_288).
- Test count: 115 → **118**.

## [2.1.2]

### Fixed

- **Fallback strategy video now visible inside `<avbridge-video>`.** The
  fallback renderer attaches its canvas overlay via `target.parentElement`,
  but when the `<video>` lives inside a `ShadowRoot` (as it does in the
  custom element), `parentElement` is `null` because `ShadowRoot` is not
  an `Element`. The canvas silently never got attached to the DOM, so
  frames were decoded and "painted" (the stats counters incremented) but
  nothing was ever visible — just audio. Fixed by wrapping the shadow
  `<video>` in a positioned `<div part="stage">` and hardening the
  renderer's parent lookup to use `parentNode` as a fallback with a loud
  warning if no parent exists at all.

- **Remux strategy reseek no longer fails with "First packet must be a
  key packet".** When `setStrategy("remux")` is invoked mid-playback, the
  pipeline recreates mediabunny's `Output` (required because mediabunny's
  fMP4 muxer is one-shot streaming). The pump's packet race could then
  emit an audio packet first on the fresh muxer, which mediabunny rejects
  because the first packet of any muxer run must be a key packet. The
  pump now forces the first video packet — which we fetch via
  `getKeyPacket()` and is guaranteed to be a keyframe — out before any
  audio.

- **`mp4v`-in-MP4 files now fall through to libav probing.** mediabunny's
  MP4 demuxer asserts on files whose video sample entry type isn't one
  it recognizes (`mp4v` for MPEG-4 Part 2 / DivX / Xvid packaged in
  ISOBMFF is the common case). Previously the probe rethrew the
  assertion and gave up. The probe now escalates to libav when
  mediabunny fails on any mediabunny-targeted container (mp4, mkv,
  webm, …), which handles the long tail of codec combinations
  mediabunny's pure-JS parser doesn't cover. If libav also fails, both
  errors are surfaced together.

- **Demo dev server serves libav binaries via a Vite middleware plugin**
  instead of `demo/public/libav/`. Recent Vite versions refuse to let
  source code `import()` files out of `public/`, which broke the libav
  loader's dynamic import. `serveVendorLibav()` in `vite.config.ts` now
  streams files directly out of `vendor/libav/` at the same `/libav/*`
  URL, bypassing the restriction. `scripts/copy-libav.mjs` is
  simplified — it no longer mirrors to the demo's public tree.

## [2.1.1]

### Fixed

- **`dist/element-browser.js` no longer has a bare `libavjs-webcodecs-bridge`
  import.** 2.1.0 inlined mediabunny into the browser bundle but left
  `libavjs-webcodecs-bridge` external, so direct
  `<script type="module">` consumers hit
  `Failed to resolve module specifier "libavjs-webcodecs-bridge"` on load.
  The browser entry now inlines it via `noExternal`. Only the actual
  libav.js WASM variants stay external, and those are loaded via URL
  dynamic imports relative to `import.meta.url`, not bare specifiers.

## [2.1.0]

### Added

- **Bundled libav.js binaries.** `npm install avbridge` now ships both
  the `webcodecs` and the custom `avbridge` libav variants under
  `vendor/libav/<variant>/`. Consumers no longer need to install
  `@libav.js/variant-webcodecs` separately, and there's no more "run
  `./scripts/build-libav.sh` for AVI support" friction — both variants
  are in the tarball. Packed tarball: **4.0 MB**, unpacked: **15 MB**.
  Unused asm.js fallbacks and threaded builds are pruned at build time
  to keep the size manageable.

- **Pre-bundled browser entry: `avbridge/element-browser`.** A new
  single-file output (`dist/element-browser.js`) intended for direct
  `<script type="module">` consumption without a bundler. mediabunny is
  inlined into the bundle; mediabunny's `node:fs/promises` Node branch
  is aliased to a stub at build time. libav.js stays external and
  lazy-loads from `../vendor/libav/` relative to the module's own URL
  via `import.meta.url`. The usual `dist/index.js` and `dist/element.js`
  entries are unchanged for bundler consumers.

- **`THIRD_PARTY_LICENSES.md` and `NOTICE.md`** — full LGPL-2.1
  compliance paperwork for the bundled libav.js binaries. Attribution,
  upstream pointers, replaceability hook documentation, and source
  availability via the reproducible `scripts/build-libav.sh`.

### Changed

- **`libavBaseUrl()` now resolves relative to `import.meta.url`** by
  default. When avbridge is installed under `node_modules/avbridge/`,
  the loader automatically finds libav at
  `node_modules/avbridge/vendor/libav/<variant>/` with zero
  configuration. The `AVBRIDGE_LIBAV_BASE` override is still the
  documented escape hatch (and also the LGPL replaceability hook).

- **`libav-loader` now preflights variant URLs** with a `bytes=0-0`
  Range request before invoking dynamic import. A missing file now
  throws a clear "libav.js \"<variant>\" variant not reachable at
  <url>" error in <100 ms instead of hanging inside WASM
  instantiation.

- **`@libav.js/variant-webcodecs` and `libavjs-webcodecs-bridge`
  promoted from `optionalDependencies` to `dependencies`.** Consumers
  no longer need a separate install step. Only `@libav.js/types` stays
  optional (it's types-only, no runtime code).

### Removed

- Nothing. The new browser entry is additive; the classic entries are
  byte-for-byte identical to 2.0.0 except for the loader's default
  path resolution.

### Breaking changes

- **`createPlayer({ forceStrategy })` renamed to `{ initialStrategy }`.**
  The old name implied a hard force, but the player has always walked the
  fallback chain on failure regardless. The new name matches the actual
  semantics: the named strategy is the *initial* pick, and escalation still
  applies if it fails. **Migration:** rename the option key. Behavior is
  unchanged for consumers who passed a strategy that successfully started.

- **`discoverSidecar()` renamed to `discoverSidecars()`.** The function
  always returned an array; the singular name was misleading. **Migration:**
  rename the import. No semantic change.

- **`<avbridge-player>` was renamed to `<avbridge-video>`.** The element is
  semantically an `HTMLMediaElement`-compatible primitive — it has no UI,
  no controls, and is intended as a drop-in replacement for `<video>`. The
  old name oversold what it does. The new name matches the contract.
  - The class export is now `AvbridgeVideoElement` (was `AvbridgePlayerElement`).
  - The source file is `src/element/avbridge-video.ts`.
  - The subpath import is unchanged: `import "avbridge/element"` still
    registers the element. It now registers `<avbridge-video>` instead of
    `<avbridge-player>`.
  - **Migration**: rename every `<avbridge-player>` tag, every
    `AvbridgePlayerElement` reference, and any CSS selectors targeting the
    old tag. There is no compatibility shim — `<avbridge-player>` is **not**
    registered in 2.0 because the name is reserved for the future
    controls-bearing element.

### Reserved

- **`<avbridge-player>` is reserved** for a future controls-bearing element
  that ships built-in player UI (seek bar, play/pause, subtitle/audio menus,
  drag-and-drop, etc.). It does not exist yet. Importing `avbridge/element`
  registers only `<avbridge-video>`.

### Fixed

- **Unknown video/audio codecs no longer silently relabel as `h264`/`aac`.**
  `mediabunnyVideoToAvbridge()` and `mediabunnyAudioToAvbridge()` used to
  default unknown inputs to the most common codec name, which sent
  unsupported media down the native/remux path and produced opaque "playback
  failed" errors. They now preserve the original codec string (or return
  `"unknown"` for `null`/`undefined`), and the classifier routes anything
  outside `NATIVE_VIDEO_CODECS` / `NATIVE_AUDIO_CODECS` to fallback as
  intended. Reported in CODE_REVIEW finding #1.

- **Strategy escalation now walks the entire fallback chain.** Previously,
  if an intermediate fallback step failed to start, `doEscalate()` emitted
  an error and gave up — even when later viable strategies remained in the
  chain. This was inconsistent with the initial bootstrap path
  (`startSession`), which already recurses. Escalation now loops until a
  strategy starts or the chain is exhausted, and the final error message
  lists every attempted strategy with its individual failure reason.
  Reported in CODE_REVIEW finding #4.

- **`initialStrategy` now reports the correct `strategyClass` in
  diagnostics.** The old `forceStrategy` path hard-coded
  `class: "NATIVE"` regardless of the picked strategy, so any downstream
  logic that trusted `strategyClass` got the wrong answer for forced
  remux/hybrid/fallback runs. The class is now derived from the actual
  picked strategy. Reported in CODE_REVIEW finding #2.

- **`<avbridge-video>`'s `preferredStrategy` is now wired through to
  `createPlayer({ initialStrategy })`.** It was previously inert — settable
  but ignored at bootstrap. Reported in CODE_REVIEW finding #7.

- **Subtitle attachment is awaited during bootstrap and per-track failures
  are caught.** `attachSubtitleTracks()` was previously called without
  `await`, so fetch/parse errors became unhandled rejections and `ready`
  could fire before subtitle tracks existed. The call is now awaited, and
  individual track failures are caught via an `onError` callback so a
  single bad sidecar doesn't break bootstrap. The player logs them via
  `console.warn`; promoting that to a typed `subtitleerror` event on the
  player is a follow-up. Subtitles are not load-bearing for playback.
  Reported in CODE_REVIEW finding #3.

- **Subtitle blob URLs are now revoked at player teardown.** Sidecar
  discovery and SRT→VTT conversion both created blob URLs that were never
  revoked, leaking memory across repeated source swaps in long-lived SPAs.
  A new `SubtitleResourceBag` owns every URL the player creates and
  releases them in `destroy()`. Reported in CODE_REVIEW finding #5.

- **Diagnostics no longer claim `rangeSupported: true` for URL inputs by
  default.** The old code inferred Range support from the input type
  (`typeof src === "string" → rangeSupported: true`), but the native and
  remux URL paths rely on the browser's or mediabunny's own Range handling
  and don't fail-fast on a non-supporting server, so the claim could be a
  lie. The field is now `undefined` until a strategy actively confirms it
  via the new `Diagnostics.recordTransport()` hook. Reported in
  CODE_REVIEW finding #6.

## [1.1.0]

### Added

- **`<avbridge-player>` is now a true `<video>` drop-in.** The element gained
  the missing slice of the `HTMLMediaElement` surface so existing code that
  reaches for a `<video>` can swap to `<avbridge-player>` with no behavioural
  changes:
  - **Properties**: `poster`, `volume`, `playbackRate`, `videoWidth`,
    `videoHeight`, `played`, `seekable`, `crossOrigin`, `disableRemotePlayback`.
  - **Method**: `canPlayType(mimeType)` — passes through to the underlying
    `<video>`. Note that this answers about the *browser's* native support,
    not avbridge's full capabilities.
  - **Attributes** (reflected to the inner `<video>`): `poster`, `playsinline`,
    `crossorigin`, `disableremoteplayback`.
  - **Event forwarding**: 17 standard `HTMLMediaElement` events are forwarded
    from the inner `<video>` to the wrapper element — `loadstart`,
    `loadedmetadata`, `loadeddata`, `canplay`, `canplaythrough`, `play`,
    `playing`, `pause`, `seeking`, `seeked`, `volumechange`, `ratechange`,
    `durationchange`, `waiting`, `stalled`, `emptied`, `resize`. Consumers can
    `el.addEventListener("loadedmetadata", …)` exactly like a real `<video>`.
  - **`<track>` children**: light-DOM `<track>` elements declared as children
    of `<avbridge-player>` are now mirrored into the shadow `<video>` and kept
    in sync via a `MutationObserver`. This works for static HTML markup as
    well as dynamic insertion / removal.
  - **`videoElement` getter**: escape hatch returning the underlying shadow
    `<video>` for native APIs the wrapper doesn't expose
    (`requestPictureInPicture`, browser-native `audioTracks`, `captureStream`,
    library integrations needing a real `HTMLVideoElement`). Caveat: when the
    active strategy is `"fallback"` or `"hybrid"`, frames render to a canvas
    overlay rather than into this `<video>`, so APIs that depend on the actual
    pixels won't show the playing content in those modes.

### Changed

- The element's `observedAttributes` list grew to include `poster`,
  `playsinline`, `crossorigin`, and `disableremoteplayback`.

## [1.0.0]

### Added

- **`createPlayer()`** — universal browser media player with automatic strategy
  selection (native → remux → hybrid → fallback), runtime fallback escalation,
  manual `setStrategy()`, typed events, diagnostics, and subtitle support.
- **`probe()` / `classify()`** — standalone analysis functions. Probe sniffs
  the container via magic bytes, then routes to mediabunny (modern containers)
  or libav.js (AVI/ASF/FLV). Classify decides the best playback strategy with
  a fallback chain.
- **`remux()`** — standalone repackage from any avbridge-readable container
  into a finalized downloadable MP4, WebM, or MKV. Built on mediabunny's
  `Conversion` for modern containers and libav.js demux for AVI/ASF/FLV.
  Lossless. Supports `signal`, `onProgress`, and `strict` mode.
- **`transcode()`** — standalone re-encode via WebCodecs encoders. Configurable
  output container (mp4 / webm / mkv), video codec (h264 / h265 / vp9 / av1),
  audio codec (aac / opus / flac), quality preset, explicit bitrate override,
  resize, frame rate, drop-tracks, and `hardwareAcceleration` hint.
- **Native strategy** — direct `<video src>` playback for files browsers play
  out of the box.
- **HTTP Range streaming for URL sources across all strategies.** Local files
  (`File` / `Blob`) and remote URLs use the same API. URL inputs are read via
  HTTP Range requests by every strategy:
  - **Native**: passes the URL straight to `<video src>`; the browser drives
    its own progressive download.
  - **Remux**: uses mediabunny's `UrlSource` (Range requests + prefetch + cache).
  - **Hybrid / fallback** (libav.js): uses a new HTTP block reader that wires
    `libav.mkblockreaderdev` + `onblockread` to issue Range requests on demand.
  Servers without Range support fail fast with a clear error rather than
  silently downloading the whole file. The initial sniff is a single
  `Range: bytes=0-32767` request — no full GET, ever.
- **Remux strategy** — mediabunny demux → fragmented MP4 → MSE for files whose
  codecs are browser-supported but whose container isn't. Backpressure on the
  SourceBuffer queue, deferred-seek across discontinuous ranges, automatic
  re-creation of the muxer on seek to satisfy mediabunny's monotonic-timestamp
  requirement.
- **MPEG-TS support** in the remux strategy — mediabunny demuxes TS natively,
  Annex B H.264 packets are passed through (mediabunny extracts the AVC
  decoder config from in-band SPS/PPS), and the MseSink snaps `video.currentTime`
  to the start of the first buffered range to handle TS sources whose PTS
  doesn't start at 0.
- **Hybrid strategy** — libav.js demux + WebCodecs `VideoDecoder` (hardware) +
  libav.js audio decode for AVI/ASF/FLV files with browser-supported codecs.
  Falls back to wall-clock timing when no audio decoder is available.
- **Fallback strategy** — full WASM software decode via libav.js, canvas
  rendering, Web Audio output, audio-driven master clock with wall-clock
  fallback when audio decode fails.
- **Subtitles** — SRT → VTT conversion, sidecar discovery, native `<track>`
  for video strategies, overlay renderer for the fallback strategy.
- **Plugin system** — strategy registry with `canHandle()` / `execute()`
  interface for injecting custom playback strategies.
- **Custom libav.js variant** — build script (`scripts/build-libav.sh`) for
  AVI / WMV3 / MPEG-4 Part 2 / DivX / VC-1 and 15+ legacy codecs.
- **`<avbridge-player>.buffered`** — `TimeRanges` getter and `progress` event
  forwarded from the underlying `<video>` element. Native and remux strategies
  expose real buffered ranges; hybrid and fallback (canvas-rendered) currently
  return an empty `TimeRanges` (synthesizing from the decoder is on the v1.1
  list).
- **Streaming diagnostics** — `DiagnosticsSnapshot` now includes `sourceType`
  (`"blob" | "url"`), `transport` (`"memory" | "http-range"`), and
  `rangeSupported`, so consumers can show what's actually happening.
- **Demos** — Player demo (`demo/index.html`) and HandBrake-like Converter
  demo (`demo/convert.html`).

### Public API

```ts
createPlayer(options): Promise<UnifiedPlayer>
probe(source): Promise<MediaContext>
classify(context): Classification
remux(source, options?): Promise<ConvertResult>
transcode(source, options?): Promise<ConvertResult>
srtToVtt(srt): string
```

Public types: `MediaInput`, `CreatePlayerOptions`, `MediaContext`,
`Classification`, `StrategyName`, `StrategyClass`, `PlaybackSession`, `Plugin`,
`DiagnosticsSnapshot`, `PlayerEventMap`, `PlayerEventName`, `VideoTrackInfo`,
`AudioTrackInfo`, `SubtitleTrackInfo`, `ContainerKind`, `VideoCodec`,
`AudioCodec`, `OutputFormat`, `ConvertOptions`, `ConvertResult`, `ProgressInfo`,
`TranscodeOptions`, `TranscodeQuality`, `OutputVideoCodec`, `OutputAudioCodec`,
`HardwareAccelerationHint`.

### Package boundary

- `avbridge` core (probe + classify + native + remux + transcode) — ~110 KB
  ESM, no WASM.
- Optional fallback / hybrid: `@libav.js/variant-webcodecs` +
  `libavjs-webcodecs-bridge` (peer-installed by the consumer).
- Custom libav.js build for AVI / WMV3 / DivX: documented in
  `vendor/libav/README.md`.

### Reliability

- **`transcode()` automatically retries on encoder init failures** (up to 2
  retries with backoff). This works around a known headless Chromium bug
  where the H.264 WebCodecs encoder fails on its first call per page and
  recovers on retry. When retries occur, the cause is recorded in
  `ConvertResult.notes` so consumers can detect and report the issue.
- Real browsers (Chrome/Edge/Safari) typically don't hit this bug; the
  retry path is silent in those environments.

### Known limitations

- Fallback / hybrid require optional libav.js installs.
- `transcode()` v1 only accepts inputs in mediabunny-readable containers
  (MP4 / MKV / WebM / OGG / MOV / MP3 / FLAC / WAV). AVI/ASF/FLV transcoding
  is planned for v1.1.
- `transcode()` uses WebCodecs encoders only; codec availability depends on
  the browser. AV1 encoding is not yet universal.
- libav.js threading is disabled due to bugs in v6.8.8; decode runs
  single-threaded with WASM SIMD acceleration.
- Multi-audio track selection in the remux strategy is not yet implemented.
