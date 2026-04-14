# CLAUDE.md

Project primer for Claude Code sessions working in this repo. Not a
duplicate of `README.md` — that's for library users; this is for the
agent editing the code. Read this first.

## Naming convention

The public-facing name is **avbridge.js** (used in README, docs,
demo pages, changelogs). The npm package name stays `avbridge` and all
code identifiers (`AvbridgeError`, `<avbridge-video>`,
`<avbridge-player>`, import paths, CSS class prefixes) are unchanged.
Console log prefixes stay `[avbridge:*]`. When writing user-facing
prose, use "avbridge.js"; when writing code, use "avbridge".

## What avbridge.js is

A browser media compatibility layer. Probes any media file
(`probe()`), routes it to one of four playback strategies via
`classify()`, and plays it through a common `UnifiedPlayer` API. The
strategies in order of preference:

1. **Native** — hand the URL/Blob to `<video src>` directly
2. **Remux** — mediabunny demux → fragmented MP4 → MSE
3. **Hybrid** — libav.js demux + WebCodecs hardware decode
4. **Fallback** — libav.js software decode → canvas + Web Audio

Also ships `remux()` and `transcode()` as standalone exports, plus a
`<avbridge-video>` custom element and a browser-direct bundle at
`dist/element-browser.js`.

## Repo layout — quick reference

| Path | What's there |
|---|---|
| `src/probe/{index,mediabunny,avi}.ts` | Source sniffing + probe entry points. `probe/index.ts` picks mediabunny or libav per container. |
| `src/classify/rules.ts` | Strategy routing. `NATIVE_VIDEO_CODECS`, `FALLBACK_VIDEO_CODECS`, `REMUXABLE_CONTAINERS` live here. |
| `src/strategies/native.ts` | Trivial `<video src>` wrapper. |
| `src/strategies/remux/{index,pipeline,mse}.ts` | mediabunny → fMP4 → MSE. `pipeline.ts` has the video/audio pump. |
| `src/strategies/hybrid/{index,decoder}.ts` | libav demux + WebCodecs decode. |
| `src/strategies/fallback/{index,decoder,video-renderer,audio-output,libav-loader}.ts` | Full software decode path. **Most subtle bugs live here.** |
| `src/element/{avbridge-video,avbridge-player,player-styles,player-icons}.ts` | Custom elements. `<avbridge-video>` is the bare HTMLMediaElement-compatible primitive; `<avbridge-player>` is the chrome-bearing player on top of it. |
| `src/util/source.ts` | `NormalizedSource`, magic-byte sniff, Range-request fetcher. |
| `src/util/debug.ts` | `dbg.info/warn/diag/timed` helper + the unconditional watchdogs. |
| `src/util/libav-http-reader.ts` | HTTP block reader for streaming libav inputs over Range. |
| `vendor/libav/{avbridge,webcodecs}/` | Bundled libav binaries, ship in the npm tarball via `files:`. |
| `scripts/build-libav.sh` | Custom libav variant rebuild (emscripten, 15–30 min). |
| `scripts/copy-libav.mjs` | Prebuild that vendors `@libav.js/variant-webcodecs` into `vendor/libav/webcodecs/`. |
| `scripts/bundle-audit.mjs` | Per-scenario gzip budgets. Fails the gate if any scenario exceeds. |
| `docs/dev/POSTMORTEMS.md` | Running log of hard bugs + generalizable lessons. Read when touching the fallback strategy. |

## The gate

Run all four after any code change. Commit only when all pass.

```
npm run build         # tsup — prebuild vendors webcodecs into vendor/libav/
npm run typecheck     # tsc --noEmit
npm test              # vitest, 199+ unit tests
npm run audit:bundle  # tree-shaking budgets per entry point
```

For browser verification: `npm run demo` starts the Vite dev server at
`http://localhost:5173/`. Drop a media file and watch the strategy
badge + diagnostics panel.

## Testing tiers

Three tiers, each covering a different layer. See
`docs/dev/TESTING.md` for the full philosophy.

1. **Unit tests** (`npm test`) — vitest, runs in jsdom. Covers
   boundary validation (classification, codec mapping, sniffing,
   conversion eligibility), infrastructure (TypedEmitter,
   PluginRegistry, Diagnostics), and element lifecycle. Does **not**
   test real playback — no MSE, WebCodecs, or Canvas in jsdom.
2. **Browser integration** (`npm run test:playback`,
   `npm run test:convert`) — Puppeteer against the Vite dev server.
   Validates end-to-end: probe → classify → strategy → real A/V
   output. Requires `npm run demo` running in another terminal.
3. **Element lifecycle** (`node scripts/element-test.mjs`) — Puppeteer
   tests for disconnect-during-bootstrap, rapid src reassignment,
   race conditions, DOM move, play-before-ready.

When adding tests, put them in the right tier:
- **Can it run in jsdom?** → unit test in `tests/`.
- **Does it need real MSE/WebCodecs/Canvas?** → browser test in
  `scripts/`.
- **Don't** try to unit-test A/V sync, MSE backpressure, or renderer
  timing — those belong in the browser tier.

## Debug flag

When a user reports a playback issue, the **first** thing to reach for:

```js
globalThis.AVBRIDGE_DEBUG = true;
// or append ?avbridge_debug to the demo URL
```

Enables `[avbridge:<tag>]` prefixed logs at every decision point.
Separately, these diagnostics emit **unconditionally** (even with the
flag off) when something smells wrong — use them to triage symptoms:

| Channel | Fires when |
|---|---|
| `[avbridge:bootstrap]` | end-to-end bootstrap >5 s |
| `[avbridge:probe]` | probe >3 s |
| `[avbridge:libav-load]` | variant load >5 s (usually wrong base path or MIME type) |
| `[avbridge:cold-start]` | fallback `waitForBuffer` released on timeout or video-only grace |
| `[avbridge:decode-rate]` | decoder sustains <60% of realtime fps for 5 s |
| `[avbridge:overflow-drop]` | renderer drops >10% of decoded frames (burst problem, not speed) |

## Publish workflow

**Never run `npm publish` from a Bash tool.** The registry requires an
interactive OTP. Have the user run `! npm publish` in their own
terminal. Wait for them to confirm before pushing tags.

- **Commits require explicit approval.** Never commit unprompted.
- **Version bumps are manual** — `package.json` + `CHANGELOG.md` in
  the same commit. Follow semver: patch for bug fixes, minor for
  additions to the public type unions or new exports, major for
  breaking API changes.
- **Amend freely before push.** After push, never force-push `main`.
- **Tags:** `git tag vX.Y.Z`. If you amended after tagging, retag with
  `git tag -f vX.Y.Z` and push with `git push origin vX.Y.Z -f`.
- **Tarball sanity check:** `npm pack --dry-run | grep -E "package
  size|total files"` before publish if the size could have shifted.

## The three libav path-resolution environments

Biggest architectural gotcha. `libavBaseUrl()` in
`src/strategies/fallback/libav-loader.ts` has to work from all three:

1. **Bundler consumer / installed package** — loader chunk is at
   `node_modules/avbridge/dist/chunk-*.js`. `new URL("../vendor/libav",
   import.meta.url)` resolves to `node_modules/avbridge/vendor/libav/`.
   Zero config.
2. **Script-tag consumer** — `dist/element-browser.js` with mediabunny
   + libavjs-webcodecs-bridge inlined. Same `import.meta.url` default
   works because the file sits in `dist/` next to `vendor/`.
3. **Vite dev mode (the demo)** — loader is served from
   `src/strategies/fallback/libav-loader.ts`. Default path resolves
   wrong (`src/strategies/vendor/libav`). Fix: `vite.config.ts` has a
   `serveVendorLibav()` middleware plugin that streams files at
   `/libav/*` directly from `vendor/libav/`, and each demo HTML sets
   `window.AVBRIDGE_LIBAV_BASE = "/libav"` before loading the element.

**If you change `libavBaseUrl()` or the loader's dynamic import,
re-test all three environments, not just one.**

## Project-specific conventions

Additions to the global `~/.claude/CLAUDE.md` — only the things
specific to this repo:

- **Fallback pump order:** decode audio **before** video per cycle.
  Video decode on rv40/mpeg4@720p+ can take 200–400 ms per batch;
  processing audio last starves the scheduler. Audio decode is <1 ms
  per packet so pumping it first barely affects video throughput.
- **Fallback read batch size in `decoder.ts`:** 16 KB, not more.
  Larger batches produce >30 frames per `ff_decode_multi` call and
  blow past the renderer's 64-frame hard cap before `queueHighWater`
  backpressure can apply. (See POSTMORTEMS.md entry 1 for the full
  story.)
- **`scheduleNow()` in `audio-output.ts`:** rebase the anchor forward
  on underrun; do **not** clamp each sample to `ctx.currentTime`.
  `Math.max(scheduled, now)` is a stacking hazard — multiple stale
  samples all start at the same instant and play on top of each
  other. See POSTMORTEMS.md entry 1 for the Web Audio pattern.
- **Two elements ship:** `<avbridge-video>` is the bare
  HTMLMediaElement-compatible primitive with zero built-in UI;
  `<avbridge-player>` wraps it with YouTube-style controls, settings
  menu, keyboard / touch gestures, and top/bottom auto-hiding chrome
  (including `top-left` / `top-right` consumer slots). New *primitive*
  features (fit, orientation, pixel-level presentation) belong on
  `<avbridge-video>`; new *chrome* features (menu entries, toolbar
  slots, `::part(...)` hooks) belong on `<avbridge-player>`.
- **Shadow DOM stage wrapper:** `<avbridge-video>` puts a
  `<div part="stage">` around the inner `<video>` inside its shadow
  root. The fallback renderer's canvas attaches via
  `target.parentElement`, and without the wrapper that would be a
  `ShadowRoot` (which is not an `Element`) and the canvas would
  silently never attach. **Don't remove the wrapper.**
- **Bundle audit budgets:** if a genuine feature pushes a scenario
  over its ceiling, raise the budget in `scripts/bundle-audit.mjs`
  with a comment explaining why. Don't silently shrink the feature.
- **POSTMORTEMS.md:** when a bug takes >1 hour to root-cause, add an
  entry with symptom / hypotheses / root cause / fix / lesson. Future
  sessions will pattern-match against it.
- **Debug layer first.** When diagnosing a playback issue, enable
  `AVBRIDGE_DEBUG` and read the `[avbridge:*]` channels before adding
  ad-hoc `console.log`s. Many subtle issues already have named
  diagnostics.

## Things not to touch

- `docs/dev/RELEASE_NOTES_1.0.0.md` — historical artifact, frozen.
- `CODE_REVIEW.md` — user-provided review notes, don't edit.
- `vendor/libav/avbridge/*.wasm*` — built artifacts. If the avbridge
  libav variant needs changes, edit `scripts/build-libav.sh` and
  rerun it; don't hand-edit binaries.
- `tests/fixtures/*.mp4` — regenerated from
  `tests/fixtures/big-buck-bunny-480p-30sec.mp4` via
  `npm run fixtures`. Don't commit ad-hoc test files.

## Pointers

- Library usage + bundle sizes + codec tables → `README.md`
- Release history → `CHANGELOG.md`
- LGPL compliance for libav.js → `NOTICE.md`, `THIRD_PARTY_LICENSES.md`
- Element spec + lifecycle invariants → `docs/dev/WEB_COMPONENT_SPEC.md`
- Bug archaeology → `docs/dev/POSTMORTEMS.md`
- Roadmap → `docs/dev/ROADMAP.md`
