# vendor/libav — avbridge custom libav.js build

This directory holds a **custom-built libav.js variant** with the demuxers
and decoders avbridge needs for legacy file playback. The npm-published variants
of libav.js are intentionally minimal — none of them include the AVI/ASF/FLV
demuxers or the legacy codec decoders (WMV3, MPEG-4 Part 2, MS-MPEG4, VC-1,
…). The supported way to get those is to build a custom variant locally.

## TL;DR

```bash
./scripts/build-libav.sh   # 15-30 minutes the first time
npm run predemo            # copies vendor/libav/* into demo/public/libav/avbridge/
npm run demo
```

After the first run, `~/.cache/avbridge/` contains the emsdk and libav.js source
trees so subsequent rebuilds (e.g. after editing the fragment list) are
incremental and much faster.

## What gets built

The fragment list in `scripts/build-libav.sh` enables:

| Demuxers | Decoders (video) | Decoders (audio) | Bitstream filters |
|---|---|---|---|
| avi, asf, flv, matroska, mov, mp3, ogg, wav, aac | h264, hevc, mpeg4 (Part 2 / DivX / Xvid), msmpeg4 v1/v2/v3, wmv1/2/3, vc1, mpeg1, mpeg2 | aac, mp3, ac3, eac3, wmav1/v2, wmapro | mpeg4_unpack_bframes |

Plus the parsers needed by each codec, plus `swscale` (video colorspace
conversion) and `swresample` (audio resampling).

The `mpeg4_unpack_bframes` BSF fixes the "packed B-frames" oddity in some
DivX files where two frames are stored in one packet — without the BSF the
decoder produces frames with fuzzy timing that the renderer drops as late.

Output binary is roughly 10–15 MB. It is loaded **lazily** by avbridge — only
when probe or classification routes a file to it. Users who only ever play
modern MP4/MKV/WebM never download it.

## Compile flags

The default libav.js Makefile uses `OPTFLAGS=-Oz` (size-optimized, slow).
We override to `-O3 -msimd128`:

- `-O3` — full optimization, ~1.5–2× speedup over `-Oz` for video decode.
- `-msimd128` — emit WebAssembly SIMD instructions. emscripten translates
  ffmpeg's SSE2-style intrinsics into WASM SIMD ops, which gives another
  ~1.5–2× for IDCT, motion compensation, deblocking. Requires a browser
  with WASM SIMD (Chrome 91+, Firefox 89+, Safari 16.4+).

Override at invocation time:

```bash
avbridge_LIBAV_OPTFLAGS="-O2" ./scripts/build-libav.sh
```

The script tracks the hash of `(fragments, OPTFLAGS)` in
`~/.cache/avbridge/libav.js/.avbridge-build-inputs`. If you re-run with different
inputs, it wipes `build/ffmpeg-*` and `build/inst` to force a clean
rebuild — Make can't detect OPTFLAGS changes on its own, so without the
hash check stale `-Oz` objects would silently survive.

## Adding or removing codecs

Edit the `VARIANT_FRAGMENTS` heredoc in `scripts/build-libav.sh`. The
fragment names follow FFmpeg's `--enable-decoder=<name>` /
`--enable-demuxer=<name>` conventions:

- `demuxer-<format>` — read this container
- `decoder-<codec>` — decode this codec
- `parser-<codec>` — parse stream metadata for this codec (tiny, usually
  needed alongside the matching decoder for seeking)

See [`docs/CONFIG.md`][config-md] in the libav.js repo for the full grammar
and [`configs/mkconfigs.js`][mkconfigs] for the names of every fragment.

[config-md]: https://github.com/Yahweasel/libav.js/blob/master/docs/CONFIG.md
[mkconfigs]: https://github.com/Yahweasel/libav.js/blob/master/configs/mkconfigs.js

After editing, re-run `./scripts/build-libav.sh` — the make-based build is
incremental, so changes only rebuild the affected pieces.

## Build script behavior

- Caches everything under `$avbridge_BUILD_CACHE` (default `~/.cache/avbridge`).
  Override the cache location by setting that env var.
- Installs **emsdk** into `~/.cache/avbridge/emsdk` — does **not** touch your
  system Python, Homebrew, or any global package manager. Only the
  `emsdk/` directory is modified.
- Clones **libav.js** into `~/.cache/avbridge/libav.js` and checks out the
  pinned `v6.8.8.0` tag.
- Writes a custom variant config via `node configs/mkconfig.js avbridge [...]`.
- Runs `make build-avbridge`, which downloads ffmpeg sources, applies libav.js's
  patches, and compiles to WASM.
- Copies the resulting `libav-6.8.8.0-avbridge.{mjs,wasm.mjs,wasm.wasm,…}` into
  this directory.

To force a clean rebuild from scratch:

```bash
avbridge_LIBAV_CLEAN=1 ./scripts/build-libav.sh
```

## Loader integration

The avbridge runtime knows about three variants — `webcodecs`, `default`, `avbridge`
— defined in `src/strategies/fallback/libav-loader.ts`. The variant routing
in `src/strategies/fallback/variant-routing.ts` decides which one a given
`MediaContext` needs:

- Modern containers + browser-supported codecs → `webcodecs`
- AVI / ASF / FLV containers, or any of the legacy codec set → `avbridge`

The loader fetches each variant via a runtime URL with `/* @vite-ignore */`,
so Vite never pre-bundles it. The variant's `import.meta.url` resolves to
`/libav/<variant>/libav-<variant>.mjs` and its sibling `.wasm.mjs` /
`.wasm.wasm` files are served from the same directory.

## Licensing

libav.js is **LGPL-2.1**. If you ship a custom variant in a product, you
must also distribute the corresponding source / build script. Keep
`scripts/build-libav.sh` and the libav.js repo URL alongside any binaries
you redistribute.

## Files in this directory after a successful build

```
vendor/libav/
├── README.md                              ← this file
├── libav-avbridge.mjs                         ← entry point (loaded by avbridge)
├── libav-6.8.8.0-avbridge.wasm.mjs            ← WASM build factory
├── libav-6.8.8.0-avbridge.wasm.wasm           ← compiled binary
├── libav-6.8.8.0-avbridge.thr.mjs             ← threaded build factory (optional)
├── libav-6.8.8.0-avbridge.thr.wasm            ← threaded binary (optional)
└── libav-6.8.8.0-avbridge.asm.{js,mjs}        ← asm.js fallback (very rarely used)
```

The script also copies `.dbg.*` debug builds when present.
