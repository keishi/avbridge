# Changelog

All notable changes to **avbridge** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
