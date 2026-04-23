# Changelog

All notable changes to **avbridge.js** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.12.1]

DivX/Xvid AVI playback reliability — four latent bugs fixed. Content
that had been stuttering and freezing for months now plays smoothly
and seeks cleanly.

### Added

- **Stats-for-Nerds overhaul** with live deltas: per-second decode
  fps (% of realtime), paint fps, drops/sec, decode-ms breakdown
  (avg/batch, % of wall, slowest), producer throttle %, queue span
  + head/tail PTS, newest-decoded PTS, and explicit `PTS REGRESSIONS`
  / `BSF MISSING` warning lines. Designed to answer "why is playback
  stuttering" at a glance.
- **Decoder throughput instrumentation** in the fallback pipeline:
  `videoDecodeMsTotal`, `videoDecodeBatches`, `audioDecodeMsTotal`,
  `audioDecodeBatches`, `readMsTotal`, `pumpThrottleMsTotal`,
  `slowestVideoBatchMs`, `newestVideoPtsMs`, `ptsRegressions`,
  `worstPtsRegressionMs` all exposed in `getDiagnostics().runtime`.
- **`avbsf` fragment** in `scripts/build-libav.sh` + libav variant
  rebuild. The BSF C code (`bsf-mpeg4_unpack_bframes`) was shipped
  since 2.2.0 but the JS wrappers it needs
  (`av_bsf_list_parse_str_js`, `av_bsf_init`, `av_bsf_send_packet`,
  `av_bsf_receive_packet`) were never exported — the fixup was dead
  at runtime. The BSF now actually runs, and its absence (if ever
  rebuilt without `avbsf`) surfaces as `bsfMissing` in diagnostics
  and a loud `console.error`.

### Fixed

- **DivX/Xvid AVI stuttering** — large, clearly visible frame drops
  (42 % of frames on a typical 25 fps 624×352 episode). Three
  independent bugs stacked; all fixed now:
  1. *Synthetic PTS counter ignored valid neighbors.* When libav
     emitted a frame with `AV_NOPTS_VALUE`, the fallback callback
     assigned it a timestamp from a counter that started at 0 and
     only advanced on invalid frames. At minute 5 of playback, one
     bad frame would be tagged as PTS ≈ 0, jumping the renderer
     wildly backwards. Now anchored to the last emitted frame's
     PTS + one frame step, so invalid frames interpolate cleanly.
  2. *`mpeg4_unpack_bframes` BSF was compiled but unreachable from
     JS* (see `avbsf` fragment addition above).
  3. *FPS probe gap for AVI.* `avg_frame_rate_num/_den` don't exist
     as properties on libav.js stream records; they must be read
     via `AVCodecParameters_framerate_num/_den`. Every AVI was
     falling back to a 30 fps default, narrowing the renderer's
     tolerance window and pushing 25 fps content off-cadence. Now
     reads the real rate.
- **Seek freeze in the fallback strategy** — video stayed on the
  pre-seek frame while audio continued from the new position. Root
  cause: `hasFrames()` checked `framesPainted > 0`, which is
  cumulative, so `waitForBuffer()` returned immediately after flush
  even with an empty queue; audio started before any post-seek
  frame had been decoded. Fixed with a `hasEverEnqueuedSinceFlush`
  flag that resets on every `flush()`.
- **`DataCloneError` after seek** — the post-seek pump hammered the
  console with `An ArrayBuffer is detached and could not be cloned`
  on every decode batch. `flushBSF()` was sending a NULL packet as
  its flush signal, but NULL is the EOF signal — it locked the BSF
  into EOF state, so every subsequent `av_bsf_send_packet` failed
  and `applyBSF` fell through to pushing the original input packet,
  whose buffer had already been transferred to WASM by
  `ff_copyin_packet`. Now uses `av_bsf_flush` (the actual flush
  API) and defensively drops rejected packets instead of passing
  their detached buffers through to the decoder.
- **Post-seek out-of-order frames from the mpeg4 decoder** —
  `avcodec_flush_buffers` doesn't always clear the B-frame reorder
  tail on mpeg4, so the first post-seek batch could contain frames
  from before the seek mixed with frames from after, in arbitrary
  order. The renderer's paint loop assumes monotonic queue and
  breaks (head stuck, newer frames age out to late-drop) when that
  invariant fails. The decoder now drops any frame whose PTS is
  less than the previously emitted frame, with a console warning.
  Counter resets at every seek so a legitimate large jump in PTS
  after seek is always accepted.

## [2.12.0]

Network playback performance + seek-bar polish.

### Added

- **libav HTTP reader LRU block cache** — replaces the single-slot
  cache with a bounded LRU keyed by fetched block position. Hot
  regions (header/moov at the front, tail index, current read
  position) all stay resident across seeks instead of evicting
  each other on every bounce. Byte-budgeted (default 8 MB) so
  memory stays predictable.
- **`cacheBytes` option** on `CreatePlayerOptions` and
  `TransportConfig`. Raise this for apps that play seek-heavy
  legacy-container media over HTTP — e.g. 32 MB holds ~32 distinct
  hot regions. Set to `0` to disable caching.
- **Multi-range buffered rendering** in `<avbridge-player>`. The
  seek bar now draws each buffered `TimeRange` as its own segment
  with real gaps between them instead of collapsing to a single
  bar from 0 to the last range's end. Matches MSE behavior after
  seeks (where buffered typically has two disjoint ranges).

### Fixed

- **Touch scrub broken on Android** (Chrome, Samsung Internet,
  Galaxy S23 Ultra). The seek bar lacked `touch-action: none`, so
  the browser treated horizontal drags as scroll candidates and
  cancelled `pointermove` after the first resolution. Now claimed
  in CSS — drags stay with the player's pointer handler.
- **Buffered indicator didn't refresh while paused.** Was only
  updated on `timeupdate` (and gated by `_userSeeking`). Now also
  listens on `progress` and updates independently of playback
  state, so the indicator stays current during paused buffering
  and while the user is scrubbing.

## [2.11.0]

Subtitle panel, interaction fixes, and quality-of-life.

### Added

- **`<avbridge-subtitles>` element** — scrollable cue timeline panel.
  Connects to a player via `for` attribute, renders all subtitle cues
  as timestamped rows, highlights the active cue, auto-scrolls to
  follow playback, and click-to-seek. Shadow DOM with dark styles.
- **Frame-by-frame keyboard shortcuts** (`,` / `.`) — YouTube-style.
  Pauses if playing, then steps back/forward one frame (1/fps).
- **Real-time scrub seeking on narrow seekbars** — when the seekbar
  is <400px wide, dragging seeks in real-time (throttled to 4 Hz)
  instead of preview-only. Immediate video feedback on small players.
- **`controls-timeout` attribute** on `<avbridge-player>`. Customize
  the auto-hide duration (default 3000ms). Set to `"0"` to disable
  auto-hide entirely (always-visible controls).

### Fixed

- **Subtitles not showing** — `addSubtitle()` didn't dispatch
  `trackschange` (settings sheet never showed the new track) and the
  `<track>` element was created with `mode="disabled"` (never
  rendered on native strategy). Now dispatches + auto-enables.
- **Audio bleed on pause** for hybrid/fallback — already-scheduled
  AudioBufferSourceNodes kept playing ~200ms after pause. Now
  disconnects the gain node immediately (same pattern as seek/reset).
- **Double-tap fires both ff/rw AND fullscreen on touch** — browser's
  synthetic `dblclick` after two rapid taps was calling fullscreen
  on top of the touch handler's ff/rw. Blocked via a consumed flag.
- **Settings sheet didn't show active audio/subtitle selection** —
  always displayed "Track 1" / "Off" regardless of actual state.

## [2.10.0]

Settings UI overhaul + playback rate on all strategies.

### Added

- **Bottom-sheet settings panel** replacing the popup menu. Slides up
  from the controls bar with a scrim overlay. Each section uses a
  native `<select>` picker overlaid on a styled row — the OS picker
  renders outside the player bounds (intentional for small players).
  Rows show label left, current value right. Tapping anywhere outside
  the sheet or pressing Escape dismisses it.
- **Consumer extensibility API**: `player.addSettingsSection({ id,
  label, items, onSelect })` / `player.removeSettingsSection(id)`.
  Custom sections render after built-in ones using the same native
  `<select>` pattern. New `SettingsSectionConfig` type exported.
- **Playback rate on hybrid + fallback strategies.** `playbackRate`
  was a no-op on canvas strategies because the inner `<video>` has
  no `src`. Now patched via `Object.defineProperty` — drives the
  `AudioOutput` clock speed + `AudioBufferSourceNode.playbackRate`
  for pitch-shifted audio. Video renderer follows automatically
  since it syncs to `audio.now()`. The `ratechange` event fires.

### Fixed

- **Settings menu sizing** — JS-measured max-height (70% of player)
  replaces the broken CSS percentage approach.
- **Blue tap-highlight flash** suppressed on `<avbridge-player>`.
- **`cursor: pointer` removed** from the player container — the
  video surface isn't a button.

## [2.9.0]

Player chrome ergonomics — four changes driven by explorer integration
and mobile testing.

### Added

- **`<slot name="content-overlay">`** on `<avbridge-player>`. Full-area
  overlay for rich consumer content (tweet cards, media info,
  annotations) that auto-hides with the chrome. Sits above the video,
  below controls in z-order. Wrapper is `pointer-events: none`; slotted
  content gets `pointer-events: auto` via `::slotted(*)`. Stylable via
  `::part(content-overlay)`. Gesture gating updated so clicks on
  slotted content don't toggle play/pause.
- **Mobile seek bar improvements.** Touch target expanded from 20px →
  44px (matching YouTube Mobile) while the visual track stays 4px.
  Tooltip now follows the finger during drag (was desktop-hover-only).
  Thumb enlarges during active scrub (1.5x on mobile, 1.4x on desktop)
  for visual feedback. All driven by a `data-seeking` attribute on
  `.avp-seek` set during the pointer-capture drag cycle.

### Fixed

- **Top-left toolbar slot didn't grow.** Wrapper lacked `flex: 1`,
  so slotted text/content couldn't fill remaining width. Any consumer
  putting a title or description in `top-left` hit this.
- **Blue tap-highlight flash on `<avbridge-player>`.** Suppressed
  `-webkit-tap-highlight-color` on `:host` and `.avp`. Added
  `user-select: none` on `.avp` to prevent accidental text selection
  during tap-and-hold gestures.
- **Settings menu clipped on short player elements.** `max-height` was
  a fixed 300px; now `min(300px, calc(100% - 60px))` so it shrinks to
  fit within the player and scrolls when needed.

## [2.8.7]

`contract.spec.ts` — the third and final slice of the Tier 4
cross-browser test matrix — landed, and surfaced three real
HTMLMediaElement contract bugs in the process. Fixing them. Matrix
is now 42/0 green across Chromium, Firefox, and WebKit.

### Fixed

- **`volumechange` not firing on any strategy.** `<avbridge-video>.set
  muted(value)` toggled the `muted` HTML *attribute*, but attribute
  changes on `<video>` do NOT fire `volumechange` at runtime — only
  IDL property changes do (per HTML spec). Now the setter writes
  `_videoEl.muted = value` directly, which fires `volumechange`
  naturally on native/remux and goes through the Object.defineProperty
  shim on hybrid/fallback (which dispatches manually). Attribute is
  kept in sync for CSS selectors.
- **`seeking` + `seeked` not firing on hybrid/fallback.** These
  strategies hide the inner `<video>` and seek via a custom
  pump/decoder; the native element never saw a `currentTime` change,
  so no native seek events. Now dispatched manually at the start and
  end of `doSeek()` in both sessions.
- **`seeked` unreliable on remux in Firefox + WebKit.** Chromium's
  MSE fires `seeked` after a `SourceBuffer.remove()` + refill cycle;
  Firefox and WebKit don't, leaving consumers waiting forever.
  Remux session now dispatches `seeked` via `queueMicrotask` after
  `pipeline.seek()` completes. Harmless duplicate on Chromium per
  spec; consistent cross-browser signal where it mattered.
- **`loadedmetadata` not firing on hybrid/fallback.** Again, the
  inner `<video>` has no `src`, so the native event never fires. Now
  dispatched once the session is constructed (duration, dimensions,
  tracks all known via the MediaContext).

### Added

- **`tests/browser/contract.spec.ts`** — HTMLMediaElement event +
  property parity per fixture per browser. 12 tests covering all four
  strategies via `mp4 h264/aac` (native), `mkv h264/aac` (remux),
  `avi h264/mp3` (hybrid), `avi mpeg4/mp3` (fallback). Drives each
  player through play → pause → volumechange → seek and asserts
  events fire and properties (`duration`, `currentTime`,
  `readyState`, `seekable`, `buffered`) are truthful.

## [2.8.6]

Un-skips the last deferred Firefox HEVC entry from the cross-browser
playback matrix. Matrix is now 30/0 green.

### Fixed

- **Firefox HEVC playback test was skipped on a false premise.** The
  v2.8.1 skip comment claimed Firefox's MSE accepted `hev1.*` but the
  decoder silently failed; v2.8.4 built a silent-video watchdog to
  handle that case. Root-cause debugging (instrumenting
  `getVideoPlaybackQuality().totalVideoFrames` over time) showed Firefox
  on current Playwright actually **does** decode HEVC — frames increment,
  no drops, audio+video advance together. The test was sampling at
  2000ms while the remux pipeline's cold-start takes ~2.5s.
- **`_expectations.ts` gained a per-browser `playMs` override** (landed
  in 5219e69 but unused until now). Firefox HEVC uses `playMs: 5000` to
  sample after playback advances. The v2.8.4 watchdog stays in place
  as defense against the original failure mode on any future
  browser/version that does lie about codec support.

### Fixed (typecheck)

- **`packetPtsSec` parameter type narrowed** to
  `Pick<LibavPacket, "pts" | "ptshi">` — matches what the function
  actually reads, unblocks the `time-ranges.test.ts` unit tests that
  pass in minimal packet shapes.

## [2.8.5]

Buffered ranges on canvas strategies — the seek bar's "buffered"
indicator now fills on hybrid and fallback playback, where it was
empty before.

### Added

- **`<video>.buffered` on hybrid + fallback** — each strategy
  patches `target.buffered` with a single synthesized `[0, frontier]`
  `TimeRanges`, where `frontier` is the highest packet pts pumped
  from the libav demuxer. Monotonic; does not shrink on seek. This
  is a seek-bar-UX signal, not MSE-fidelity per-range availability
  (decoded frames are consumed in flight on canvas strategies).
- **`packetPtsSec(pkt, timeBase)` helper** in
  `src/util/libav-demux.ts` — pure pts-to-seconds conversion that
  handles AV_NOPTS_VALUE, 64-bit pts split across hi/lo, and
  arbitrary time_base. Unit-tested.
- **`bufferedUntilSec()` on `HybridDecoderHandles` and
  `DecoderHandles`** — the pump-loop signal the strategies read
  from to implement the buffered patch.

### Fixed

- README's "known limitations" note about canvas `buffered` being
  empty is now gone; replaced with a description of the synthesized
  approximation.

## [2.8.4]

Decode-stall detection — the robustness follow-up that addresses the
v2.8.1 "Known deferred" item.

### Added

- **Silent-video watchdog in the stall supervisor.** Catches the class
  of bug where MSE reports a codec as supported but the decoder can't
  actually decode it — audio plays, `currentTime` advances, but the
  video decoder never produces frames. The supervisor now samples
  `HTMLVideoElement.getVideoPlaybackQuality().totalVideoFrames` (or
  `webkitDecodedFrameCount` on older Safari) and triggers strategy
  escalation when audio is advancing but frames haven't for 3 s. The
  Firefox HEVC case (MSE lies about `hev1.*`) is the motivating
  example, but the watchdog is codec- and browser-agnostic.
- **`fallbackChain` on `REMUX_CANDIDATE` classifications.** Previously
  the supervisor had nowhere to escalate to from a plain remux
  classification, so stalls sat there forever. The chain is
  `["hybrid", "fallback"]` (or `["fallback"]` without WebCodecs) —
  initial strategy is still remux; the chain only engages on stall.
- **`evaluateDecodeHealth(input)` and `readDecodedFrameCount(target)`
  extracted as pure helpers** in `src/player.ts` (not re-exported from
  the package root; same pattern as `buildInitialDecision`) so the
  supervisor's decision logic is unit-testable without a browser.

### Fixed

- **Firefox HEVC** in `tests/browser/playback.spec.ts` should now
  un-skip once this ships — the watchdog gives Firefox a mechanism to
  escalate off the lying MSE path to hybrid / fallback automatically.

## [2.8.3]

### Added

- **`showControls(durationMs?)` on `<avbridge-player>`.** Public method
  to reveal the auto-hiding chrome (top toolbar + bottom controls)
  and re-start the auto-hide timer. Intended for app-level "flash the
  UI" moments like a carousel slide change or focus handoff — one call
  instead of reaching into `data-controls-hidden`. Custom duration
  overrides the default 3 s; pointer movement during the flash resets
  the timer so there's no flicker if the user interacts mid-flash.

## [2.8.2]

Small ergonomics release driven by downstream `<avbridge-player>`
consumer feedback.

### Added

- **Opt-in "Fit" entry in the `<avbridge-player>` settings menu.** Set
  the new `show-fit` attribute on `<avbridge-player>` and the settings
  menu gains a Fit section with Contain / Cover / Fill choices; picking
  one writes the `fit` attribute (which proxies through to the inner
  `<avbridge-video>`). Off by default — chromeless consumers don't get
  a surprise entry.
- **`data-visible="true|false"` on `part="toolbar-top"`.** Mirrors the
  controls auto-hide state so slotted toolbar buttons can drive JS
  behavior (focus management, screen-reader announcements, disabling
  clicks) without listening to the host's `data-controls-hidden`. The
  existing CSS fade on opacity is unchanged.

## [2.8.1]

Cross-browser playback validation — second slice of the v2.7.0 Playwright
tier. Bootstrap → play → destroy lifecycle tested across Chromium,
Firefox, and WebKit. Surfaced and fixed three real bugs along the way:

### Fixed

- **`<avbridge-player>` constructor violated the Custom Elements spec**
  by setting attributes (`tabindex`, `data-toolbar-empty`) on `this`.
  Browsers allow this when the parser constructs the element, but
  `document.createElement("avbridge-player")` fails with "The result
  must not have attributes" — so programmatic creation, including all
  Playwright tests, was broken. Moved attribute writes to
  `connectedCallback`. Caught by the new browser matrix.
- **classify() didn't feature-detect MSE for remuxable non-native
  containers.** On open-source Chromium (no proprietary codecs),
  MKV+HEVC was classified as `remux` even though MSE rejected the
  target mime — playback stalled silently. classify() now calls
  `MediaSource.isTypeSupported()` for the remux target and gracefully
  degrades to hybrid/fallback when it says no.
- **Fallback strategy was loading the wrong libav variant for some
  codecs.** `pickLibavVariant` would choose the "webcodecs" companion
  variant (smaller, assumes the browser decodes natively) for codecs
  like HEVC — but fallback does *full* software decode, and that
  variant lacks HEVC's software decoder. Fallback now unconditionally
  loads the "avbridge" variant, which is correct since we're there
  specifically because the browser can't decode.

### Added

- **`tests/browser/playback.spec.ts`** — bootstrap → play → destroy per
  fixture per browser. Asserts playback actually advances (either via
  audio-clock `currentTime` for native/remux, or `framesPainted` for
  canvas strategies) and that the runtime strategy after escalation
  matches the per-browser matrix. 29 passed, 1 skipped (documented).
- **`playbackStrategy` field on `_expectations.ts`** for codifying
  per-browser runtime expectations distinct from initial classify
  output. Firefox HEVC is the one skip, pending a decode-stall
  detection follow-up.

### Known deferred

- **Firefox HEVC**: MSE optimistically reports `hev1.*` supported but
  the decoder can't decode it. Audio plays, video is black. No signal
  currently reaches escalation. Runtime decode-stall detection
  (buffered but `currentTime` not advancing) is the right fix; tracked
  as a follow-up, skipped in the matrix for now.

## [2.8.0]

Element feature release — fit mode, consumer-slotted toolbar chrome, and
orientation-aware fullscreen.

### Added

- **`fit` attribute on `<avbridge-video>`.** `fit="contain|cover|fill"`
  (also reflected as the `fit` property, with a `fitchange` event) maps to
  `object-fit` on the inner `<video>` and the fallback canvas via a new
  `--avbridge-fit` CSS custom property on the stage wrapper. Default
  `contain`; invalid values fall back to `contain`. Proxied through
  `<avbridge-player>`.
- **Top toolbar slots on `<avbridge-player>`.** `<slot name="top-left">`
  and `<slot name="top-right">` inside a new `part="toolbar-top"`
  wrapper let consumers place back / title / translate buttons inside the
  auto-hide chrome so they fade together with the bottom controls. A
  `slotchange` listener toggles a `data-toolbar-empty` host attribute so
  the gradient band disappears when no content is slotted. Click,
  double-click, and tap handlers ignore events originating from slotted
  content via `composedPath()` — so consumer buttons don't trigger
  play/pause or seek.
- **Orientation-aware fullscreen on `<avbridge-video>`.** On fullscreen
  entry (including fullscreen applied to an ancestor like
  `<avbridge-player>` whose shadow DOM hosts the video), the element
  derives the target orientation from the video's intrinsic
  `videoWidth`/`videoHeight` (already SAR-corrected by the browser) and
  calls `screen.orientation.lock('landscape'|'portrait')`. Releases the
  lock on exit. iOS Safari rejections are swallowed (iOS handles rotation
  via `webkitEnterFullscreen` on `<video>` itself). Opt out per element
  with the `no-orientation-lock` attribute / `noOrientationLock` property.

### Notes

- `<avbridge-player>` is no longer a "reserved" name — it's the
  shipping chrome-bearing player. `<avbridge-video>` remains the bare
  HTMLMediaElement-compatible primitive.

## [2.7.0]

Cross-browser confidence release. A Playwright-based test tier now
validates that avbridge picks the right strategy on each major browser
engine. No runtime code changes — the release is tooling, fixtures, and
a new testing discipline.

### Added

- **Cross-browser test tier (Playwright).** New `tests/browser/` directory
  with the matrix run via `npm run test:browser` across Chromium, Firefox,
  and WebKit. Initial slice — `fixtures.spec.ts` — validates that `probe()`
  and `classify()` produce the expected output for each fixture on each
  browser (15 tests, ~11s). Per-browser expectations live in
  `tests/browser/_expectations.ts` so evolving browser codec support is
  a one-file change. Playwright's `webServer` config auto-starts Vite;
  the five existing Puppeteer scripts are unchanged and continue to
  cover Chromium-only scenarios. `npm run test:browser:ui` for the
  interactive trace viewer.
- New test harness page at `demo/tests-harness.html` that exposes the
  avbridge API on `window` for `page.evaluate()`-style tests. Only served
  in dev mode; not shipped in production builds.
- New fixture: `bbb-hevc-aac.mkv` (generated via `npm run fixtures`) for
  exercising the HEVC strategy boundary across browsers.
- `docs/dev/TESTING.md` — documents the new Tier 4 alongside the
  existing three tiers, with scope guidance (what belongs in `fixtures`,
  `playback`, and `contract` spec files).

### Findings worth surfacing

- `classify()` is deliberately **browser-independent** for most codec
  paths. Per-browser divergence surfaces at runtime via escalation, not
  at classification. The test-tier split reflects this architecture:
  `fixtures.spec.ts` for the deterministic decision, `playback.spec.ts`
  (planned v2.7.1) for runtime escalation behavior.

### Coming in follow-ups

- **v2.7.1** — `playback.spec.ts`. Bootstrap → play → destroy per
  fixture per browser. Catches runtime escalation (e.g. Firefox
  escalating HEVC MKV from remux → fallback when MSE rejects hevc1.*).
- **v2.7.2** — `contract.spec.ts`. HTMLMediaElement event + property
  parity across strategies and browsers.

## [2.6.0]

`<avbridge-player>` polish release. Four targeted ergonomics upgrades.

### Added

- **Typed `addEventListener` / `removeEventListener` overloads** on both
  `<avbridge-video>` and `<avbridge-player>`. Consumers using avbridge
  custom events (`ready`, `strategychange`, `trackschange`, `timeupdate`,
  `error`, etc.) now receive a typed `CustomEvent<Detail>` without the
  `as unknown as CustomEvent` cast tax. Standard HTMLMediaElement events
  (`play`, `pause`, `seeking`, etc.) retain their native typing via
  `HTMLElementEventMap`. New type: `AvbridgeVideoElementEventMap`.
- **Drag-and-drop file input** on `<avbridge-player>`. Drop a video file
  onto the player and it loads + plays, matching the demo's file-picker
  flow. Visual dashed-border feedback during dragover (stylable via
  `.avp-dragover`).
- **`<track>` children parsing.** Light-DOM `<track src="subs.vtt"
  srclang="en">` children declared inside `<avbridge-player>` or
  `<avbridge-video>` were already cloned into the shadow `<video>` for
  native/remux strategies; they now also populate the subtitle list that
  the player's settings menu renders. HTML-declared tracks get stable
  IDs in the 10000+ range to avoid colliding with container-embedded
  IDs. MutationObserver-driven — add or remove a `<track>` at any time
  and the menu updates.
- **HTMLMediaElement parity — `readyState` and `seekable`** on canvas
  strategies. Previously the inner `<video>` (with no `src`) returned
  `readyState: 0` and empty `seekable` ranges for hybrid/fallback.
  Now synthesized: `readyState` reflects frame+audio readiness,
  `seekable` spans `[0, duration]` once probe completes. `buffered`
  and `networkState` remain deferred — both need meaningful transport
  state machinery.

### Deprecated / Deferred

- `buffered` on canvas strategies still returns empty TimeRanges. Requires
  decoder-position → media-time plumbing; tracked for a follow-up.
- `networkState` not yet exposed on the element. Needs a transport
  state machine spanning probe → libav reader → decoder; out of scope
  for this release.

## [2.5.0]

The "legacy transcode breadth" release. avbridge.js can now transcode
from legacy containers (AVI, ASF, FLV, RealMedia) to any modern output
container (MP4, WebM, MKV) in a single one-pass pipeline. Reinforces
the engine-first positioning: if avbridge can *play* it, avbridge can
now generally *convert* it too.

### Added

- **rm/rmvb transcode input.** The legacy-container transcode pipeline
  now handles RealMedia. Video codecs WebCodecs doesn't support
  (rv10/20/30/40) go through a libav software video decoder whose
  decoded frames are bridged to `VideoFrame` via `laFrameToVideoFrame` —
  same downstream queue+drain → mediabunny encode+mux. Audio codecs
  (cook, ra_144/288, sipr, atrac3) already decode via libav.
- **WebM and MKV output from legacy containers.** The libav-demux
  transcode path previously only emitted MP4. Any supported output
  format (mp4, webm, mkv) now works. Default codecs adapt per output:
  mp4/mkv → h264/aac, webm → vp9/opus. The existing
  `validateCodecCompatibility` gate (in `transcode()`) still catches
  nonsense combos like webm + h264.

### Changed

- Removed the hard "WebCodecs doesn't support this video codec" throw
  in the transcode-libav setup. The setup now tries WebCodecs first
  and falls back to libav software decode silently. The only path
  that throws at setup is when *both* fail — a codec neither WebCodecs
  nor the avbridge libav variant can decode.
- Migrated hybrid/fallback/remux from their duplicated copies of
  `sanitizePacketTimestamp` / `sanitizeFrameTimestamp` /
  `libavFrameToInterleavedFloat32` to the shared helpers in
  `src/util/libav-demux.ts`. No behavioral change; bundle sizes
  decreased slightly as a side effect (duplicates weren't tree-shaking
  across strategy boundaries).

### Known caveats (out of scope for this release)

- **10-bit video transcode** — source 10-bit video throws with a
  clear error. Needs pixel-format conversion before encode.
- **Streaming output** (`outputStream`) is not yet supported for the
  libav-backed transcode path. Output goes through an in-memory
  `BufferTarget`. Large files are limited by available memory.
- **Multi-track output** remains deferred — extra input tracks are
  silently dropped.

## [2.4.0]

### Added

- **Multi-audio track selection across all strategies.** The
  `<avbridge-player>` audio track menu previously rendered the list but
  `setAudioTrack(id)` was a no-op in every strategy. Fallback and hybrid
  rebuild the libav audio decoder and reseek. Remux rebuilds the
  mediabunny Output (MSE SourceBuffer mime can change across tracks).
  Common pain for anime/movie rips with dual-language audio.
- **AVI/ASF/FLV input support for MP4 transcoding.** New libav-demux-backed
  transcode pipeline: libav demux → WebCodecs `VideoDecoder` + libav
  software audio decode → mediabunny `VideoSampleSource` /
  `AudioSampleSource` → MP4 Blob. Phase 1 scope: MP4 output only, single
  video + single audio track, 8-bit video. Extra tracks are silently
  dropped. 10-bit sources throw with a clear error. rm/rmvb, WebM output,
  and multi-track output remain on the roadmap.
- Shared `src/util/libav-demux.ts` helper (`openLibavDemux`,
  `sanitizePacketTimestamp`, `sanitizeFrameTimestamp`,
  `libavFrameToInterleavedFloat32`). Phase 1 only consumed by the new
  transcode path; hybrid/fallback/remux keep their own copies and migrate
  in a follow-up.
- New error codes: `ERR_AVBRIDGE_TRANSCODE_ABORTED`,
  `ERR_AVBRIDGE_TRANSCODE_UNSUPPORTED_COMBO`,
  `ERR_AVBRIDGE_TRANSCODE_DECODE`, `ERR_AVBRIDGE_CONTAINER_NOT_SUPPORTED`.

## [2.3.0]

This release makes avbridge.js production-ready for authenticated
remote media, legacy codecs, and end-user embedding.

### Added

- **`<avbridge-player>` controls-bearing element** (new subpath:
  `avbridge/player`). Full YouTube-style player UI — play/pause, seek
  bar, time display, volume/mute, settings menu (playback speed,
  subtitle + audio tracks, Stats for Nerds), fullscreen. Auto-hide
  controls, keyboard shortcuts (space/k, f, m, j/l, arrows, >/<, Esc),
  touch gestures (tap-to-toggle, double-tap ±10s with ripple,
  tap-and-hold for 2x speed). `::part()` hooks on every control.
- **Transport configurability** — `requestInit` and `fetchFn` on
  `CreatePlayerOptions`; `probe()` takes a transport argument.
  Threaded through probe Range requests, subtitle fetches, and the
  libav HTTP reader. Unblocks signed URLs and custom auth headers.
- **Bitstream fixups** — `mpeg4_unpack_bframes` BSF wired into the
  fallback and hybrid decoders for DivX packed-B-frame files.
  Annex B → AVCC normalization in the libav remux path. Applied
  filters visible in diagnostics as `bsfApplied`.
- **Structured errors** — new `AvbridgeError` class with
  machine-readable `code` (`ERR_AVBRIDGE_*`) and human-readable
  `recovery` hints. Applied to probe, codec, MSE, player-readiness,
  and strategy-exhaustion paths.
- **DTS, TrueHD, Theora decoder support** in the custom libav
  variant. Probe re-runs via libav when mediabunny returns unknown
  codecs. Hybrid strategy now used for "native video + fallback
  audio" combos (e.g. H.264 + DTS in Blu-ray MKV rips) instead of
  the much slower full WASM fallback.
- **Streaming transcode output** via `outputStream` option. Pairs
  with `showSaveFilePicker()` for multi-GB file transcoding without
  loading the entire output into memory.
- **Background tab pause/resume** — auto-pause on `visibilitychange`
  when hidden, auto-resume on return. Prevents degraded playback
  from Chrome's rAF/setTimeout throttling. Configurable via
  `backgroundBehavior: "pause" | "continue"`.
- **GitHub Pages demo** — deployed at `keishi.github.io/avbridge/`.
  COOP/COEP service worker enables SharedArrayBuffer on static
  hosting.
- **Consolidated rebrand** — public-facing name is now "avbridge.js"
  across README, docs, demos. npm package name unchanged (`avbridge`).

### Fixed

- **A/V sync for long-running hybrid playback** — video PTS and
  `AudioContext.currentTime` drift ~7ms/s (different clock domains).
  Now periodically re-snaps calibration every 10 seconds, keeping
  max drift under 70ms (below human lip-sync threshold). See
  `docs/dev/POSTMORTEMS.md` for the full investigation.
- **Hybrid pump ordering** — audio decoded before video, with
  sub-batch yields during heavy audio decode (DTS) to prevent rAF
  starvation that caused visible stutter.
- **Probe regression** for MKV files with unrecognized codecs —
  now falls back to libav probe instead of returning "unknown".
- **Variant picker** rewritten to use an allowlist (codecs
  webcodecs variant can handle) instead of a denylist. New codecs
  automatically route to the avbridge variant.
- **Hybrid + fallback preserve HTMLMediaElement contract** —
  dispatch standard `play`/`pause`/`volumechange` events and patch
  `target.volume`/`muted` as getter/setters so `<avbridge-player>`'s
  controls reflect real state.
- **Seek bar click position** — custom pointer handler replaces
  native range-input click math, eliminating the thumb-vs-cursor
  offset at the track edges.

### Changed

- Classification now routes native-video + fallback-audio combos
  to hybrid (WebCodecs video + libav audio) instead of full
  fallback. Previously a Blu-ray MKV with H.264 + DTS went straight
  to WASM software decode (unwatchable at 1080p).
- Annex B → AVCC conversion is now applied during libav remux to
  produce correct fMP4 output.
- 269 unit tests across 17 files (up from 119 across 9). Three
  testing tiers documented: unit (vitest + jsdom), browser
  integration (Puppeteer), and strategy-to-element contract.

## [2.2.1]

### Fixed

- **Canvas renderer no longer stretches non-stage-aspect video.** The
  fallback + hybrid renderer's canvas sat at `width:100%;height:100%`
  with no `object-fit`, so portrait or otherwise non-matching content
  was stretched to fill the stage. Now uses `object-fit: contain` to
  letterbox the bitmap inside the stage.
- **Strategy switch to `remux` while playing now resumes playback.**
  `doSetStrategy` calls `session.seek()` before `session.play()`, so
  the remux pipeline used to start with `pendingAutoPlay=false`; the
  subsequent `video.play()` would then hit an element whose `src`
  wasn't yet assigned (the MseSink constructs lazily on first write)
  and silently reject. `RemuxPipeline` gained `setAutoPlay()` so
  `session.play()` can flip `pendingAutoPlay=true` mid-flight; the
  MseSink fires `video.play()` as soon as buffered data lands.
- **Strategy switch from `hybrid` / `fallback` to another backend now
  preserves play state.** Those strategies hide the `<video>` and
  drive playback from their own Web Audio clock, so the underlying
  element's native `paused` was always `true`. `doSetStrategy` read
  `!target.paused` and captured `wasPlaying=false`, skipping the
  restore on the new session. Both strategies now patch a
  configurable `paused` getter on the target that mirrors
  `audio.isPlaying()`, and clean it up on `destroy()`.
- **`initialStrategy` no longer retries the same failing strategy.**
  `buildInitialDecision` inherited `natural.fallbackChain` verbatim,
  so for a `RISKY_NATIVE` file with `initialStrategy: "remux"` the
  chain still contained `"remux"` — on failure, `startSession` would
  shift it off and retry `remux` before escalating. The synthetic
  decision now filters `initial` out of the inherited chain.
- **`UnifiedPlayer.destroy()` removes the `ended` listener it
  attached during `bootstrap()`.** Previously the anonymous handler
  leaked across player lifecycles on long-lived target elements
  (e.g. `<avbridge-video>` swapping source), causing gradual
  accumulation and duplicate `ended` events after source reloads.

### Changed

- Bundle audit ceiling for the `element-only` scenario raised to
  20 KB eager gzip. The budget's purpose is catching
  order-of-magnitude regressions (e.g. libav accidentally eager-
  imported), not policing ±200 bytes; realistic first-play cost is
  dominated by the multi-megabyte lazy wasm load.

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
