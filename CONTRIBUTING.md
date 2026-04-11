# Contributing to avbridge

Thanks for your interest! avbridge is a small, focused project. The fastest
way to get a contribution merged is to discuss the design first via an issue,
then send a PR with focused changes + tests.

## Quick start

```bash
git clone https://github.com/keishi/avbridge.git
cd avbridge
npm install
npm run build         # tsup → dist/ (ESM + CJS + d.ts)
npm run typecheck     # tsc --noEmit
npm test              # vitest unit tests
npm run audit:bundle  # verify tree-shaking budgets
```

## Demo

Two pages share the same dev server:

```bash
npm run demo                       # http://localhost:5173/
```

- `/` — player demo (drop a file, watch the strategy badge)
- `/convert.html` — HandBrake-like converter UI
- `/element-test.html` — `<avbridge-player>` test harness (used by lifecycle tests)

## Test fixtures

The test corpus lives in `tests/fixtures/`. The canonical source is
`big-buck-bunny-480p-30sec.mp4`; everything else is generated from it via
ffmpeg:

```bash
npm run fixtures           # regenerate any missing fixtures
npm run fixtures -- --force # regenerate everything
```

Requires `ffmpeg` on `PATH`. See `tests/fixtures/README.md` for what each
fixture exercises.

## Browser smoke tests

These require the dev server to be running in another terminal:

```bash
npm run demo                           # in one terminal
npm run test:playback -- tests/fixtures/   # in another
npm run test:convert
npm run test:element                   # element lifecycle (Puppeteer)
npm run test:url-streaming             # URL → Range request streaming
```

## Project structure

```
src/
├── classify/         # rules engine: which strategy for which file
├── convert/          # remux() + transcode() standalone exports
├── element/          # <avbridge-player> custom element
├── plugins/          # strategy registry
├── probe/            # source sniffing + mediabunny / libav probing
├── strategies/
│   ├── native.ts     # direct <video src> playback
│   ├── remux/        # mediabunny → fragmented MP4 → MSE
│   ├── hybrid/       # libav demux + WebCodecs decode
│   └── fallback/     # libav software decode
├── subtitles/        # SRT → VTT, sidecar discovery
├── util/             # source.ts (NormalizedSource), libav-http-reader
├── index.ts          # core public entry
└── element.ts        # avbridge/element subpath entry
```

The dev/internal docs (vision, roadmap, web component spec) live in
`docs/dev/`. The end-user docs are `README.md` + `CHANGELOG.md` at the
repo root.

## Notes

- **libav.js fallback is optional.** Core (probe + classify + native +
  remux + transcode) does not require libav. The libav-backed strategies
  load lazily via dynamic import — they're code-split into separate
  chunks and only fetched when a file actually needs them.
- **Tree-shaking is enforced via CI.** `npm run audit:bundle` fails if a
  consumer importing only `remux` accidentally pulls in element code,
  libav stubs, etc. Don't add cross-imports between the entry points.
- **The element is a quality harness, not a UI framework.** It exists to
  validate the core API by being a real consumer of it. Resist the urge
  to add controls, theming, or plugins to the element layer — those
  belong outside avbridge.
- **No silent buffering.** URL sources stream via Range requests across
  every strategy. If you change the source layer, run
  `npm run test:url-streaming` to verify nothing slipped back to a full
  download.

## Coding style

- TypeScript strict mode
- No new dependencies without discussion
- Tests for any non-trivial change
- Prefer plain DOM / Web APIs over abstraction layers

## Reporting bugs

- Include the file's container + codecs (run `probe(file)` to get them)
- Include `player.getDiagnostics()` output if you have a running player
- A 1-30 second sample file helps a lot — if you can share one
- Browser + version

## License

By contributing, you agree your contributions will be licensed under the
project's [MIT License](./LICENSE).
