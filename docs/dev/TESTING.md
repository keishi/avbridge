# Testing Philosophy & Status

## Design principle

Test at the layer where a bug would actually manifest:

- **Boundary logic** (codec mapping, classification rules, input
  validation) breaks deterministically — unit test it in jsdom.
- **Playback behavior** (A/V sync, MSE backpressure, canvas rendering,
  stall detection) is timing-sensitive and browser-dependent — test it
  in headless Chromium via Puppeteer.
- **Contracts between components** (strategy ↔ element, session ↔
  renderer) break silently when one side changes without the other.
  Test the observable contract, not the wiring.
- **Don't chase coverage %** — add tests where a bug would be hard to
  spot manually or easy to reintroduce during refactors.

## The strategy-to-element contract

Strategy sessions (native/remux/hybrid/fallback) must preserve the
observable `HTMLMediaElement` contract on the target `<video>` element.
This matters because `<avbridge-video>` and `<avbridge-player>` both
expose standard HTML media properties (`paused`, `volume`, `muted`,
`currentTime`) and emit standard media events (`play`, `pause`,
`volumechange`, `timeupdate`).

For strategies that DON'T render into the real `<video>` (hybrid and
fallback both hide it and use a canvas + Web Audio), the inner video
never plays on its own. The strategy is responsible for:

1. Patching getter/setter properties on the target so `.paused`,
   `.volume`, `.muted`, `.currentTime` return meaningful values.
2. Dispatching the corresponding events (`play`, `pause`,
   `playing`, `volumechange`) when state changes.

Without this contract, `<avbridge-player>`'s controls UI shows stale
state — the play button doesn't update when audio starts, mute
doesn't silence output. This class of bug is invisible to both unit
tests (jsdom can't run WebCodecs/Web Audio) and generic playback
smoke tests (which only check that frames render). It's caught by
**Tier 2b** below, which specifically exercises the contract.

---

## Tier 1: Unit tests (vitest + jsdom)

```bash
npm test
```

**262 tests** across 17 test files. Runs in ~2 seconds with no
browser. These are the gate — every commit must pass.

### What's covered

| Area | Tests | Files |
|---|---|---|
| Element lifecycle | 37 | `tests/element.test.ts` |
| Source normalization + sniffing | 31 | `tests/source.test.ts` |
| Diagnostics accumulation | 17 | `tests/diagnostics.test.ts` |
| Conversion eligibility (remux) | 17 | `tests/remux.test.ts` |
| Classification rules | 16 | `tests/classify.test.ts` |
| Conversion defaults (transcode) | 16 | `tests/transcode.test.ts` |
| TypedEmitter | 14 | `tests/events.test.ts` |
| Player (buildInitialDecision) | 12 | `tests/player.test.ts` |
| Probe routing | 10 | `tests/probe.test.ts` |
| PluginRegistry | 8 | `tests/registry.test.ts` |
| Container sniffing (legacy) | 7 | `tests/sniff.test.ts` |
| SRT → VTT | 5 | `tests/srt.test.ts` |
| Codec strings | 5 | `tests/codec-strings.test.ts` |
| Annex B ↔ AVCC | 4 | `tests/annexb.test.ts` |

### What's intentionally NOT unit-tested

Strategy session implementations (native, remux, hybrid, fallback)
require real MSE, WebCodecs, Canvas, and Web Audio — none of which
exist in jsdom. These are covered by Tier 2 instead.

Specific untested paths that could benefit from future unit tests
(mocked dependencies):
- `remux()` / `transcode()` entry points — the validators are tested
  but the orchestration pipeline isn't (would need mocked mediabunny)
- `classify/rules.ts` edge cases — more profile/bitdepth/resolution
  thresholds

---

## Tier 2: Browser integration (Puppeteer)

Requires the Vite dev server running: `npm run demo`

### Playback smoke tests

```bash
npm run test:playback -- tests/fixtures/
```

Feeds each fixture file to the demo player via Puppeteer's file upload,
plays for N seconds, and asserts:
- Strategy badge resolves (not stuck on "buffering")
- Playback advances (currentTime > threshold for native/remux;
  framesPainted > 0 for hybrid/fallback)
- No console errors

**5 fixture files** covering all four strategies:
- `big-buck-bunny-480p-30sec.mp4` → native
- `bbb-h264-aac.mkv` → remux
- `bbb-h264-aac.ts` → remux (MPEG-TS, non-zero starting PTS)
- `bbb-h264-mp3.avi` → hybrid
- `bbb-mpeg4-mp3.avi` → fallback

Can also point at arbitrary files or directories:
```bash
npm run test:playback -- /path/to/media/dir --duration 5
```

### Controls contract tests

```bash
npm run test:player-controls
```

Exercises the `<avbridge-player>` UI against hybrid and fallback
fixtures — the two strategies where the inner `<video>` is hidden
and playback is driven by Web Audio. Verifies:

- `play()` / `pause()` dispatch the right events → play button icon
  toggles in the shadow DOM
- `volume` / `muted` setters route through the audio output's
  GainNode → volume slider + mute icon reflect the state
- Clicking the shadow DOM play button toggles playback
- `paused` getter reflects the real audio clock state

Catches the **strategy-to-element contract** bugs described above —
bugs that neither unit tests nor playback smoke tests can see, because
they only manifest when an HTMLMediaElement consumer (like the
controls UI) queries the target's properties or listens for standard
events.

### Conversion smoke tests

```bash
npm run test:convert
```

Drives the converter demo through 4 conversions and validates output
info (container, codecs, size). Includes auto-retry for the headless
Chromium H.264 encoder first-call init bug.

### URL streaming test

```bash
node scripts/url-streaming-test.mjs
```

Tests playback from HTTP URLs via Range requests (as opposed to local
File/Blob input).

---

## Tier 3: Element lifecycle (Puppeteer)

```bash
node scripts/element-test.mjs
```

**5 P0 lifecycle tests** that exercise `<avbridge-video>` under
adversarial conditions:
1. Disconnect during bootstrap
2. Rapid `src` reassignment
3. Bootstrap race (concurrent source changes)
4. DOM move (element reparented mid-playback)
5. `play()` called before `ready` event

These validate the bootstrap token pattern and the "no half-alive
state" invariant documented in `WEB_COMPONENT_SPEC.md`.

---

## Fixture corpus

All test fixtures live in `tests/fixtures/` and are derived from a
single source file (`big-buck-bunny-480p-30sec.mp4`) via:

```bash
npm run fixtures
```

This runs ffmpeg to produce the MKV, MPEG-TS, AVI, and truncated
variants. See `tests/fixtures/README.md` for details on each file.

**Don't commit ad-hoc test files.** Regenerate from the canonical
source so the corpus stays reproducible.

---

## Adding tests

**Rule of thumb:** add a test where a bug would be hard to spot
manually or easy to reintroduce during a refactor.

Decision tree:
- Can it run in jsdom (no browser APIs needed)? → `tests/*.test.ts`
- Does it need real MSE/WebCodecs/Canvas? → Puppeteer script in
  `scripts/`
- Is it a one-off smoke test for a specific file? → use
  `npm run test:playback -- /path/to/file.avi`

Avoid:
- Unit-testing A/V sync, MSE backpressure, or renderer timing — the
  browser tier exists for this.
- Mocking so heavily that the test validates the mock, not the code.
- Testing internal implementation details that change with every
  refactor — test behavior, not wiring.
