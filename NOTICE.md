# Third-party notices

avbridge.js is distributed under the MIT License (see [LICENSE](./LICENSE)).

This package **bundles binary builds** of third-party libraries. Each
bundled library retains its original license, which you must honor if you
redistribute avbridge.js or works that include it.

See [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md) for the full
license texts. This file is a short index.

## Bundled components

### libav.js — LGPL-2.1-or-later

`vendor/libav/avbridge/` and `vendor/libav/webcodecs/` contain prebuilt
libav.js binaries (WebAssembly + JavaScript glue). libav.js is a compilation
of FFmpeg for the browser.

- Upstream: https://github.com/Yahweasel/libav.js
- License: LGPL-2.1-or-later (FFmpeg's libraries are LGPL; see
  https://ffmpeg.org/legal.html)
- Bundled variants:
  - `webcodecs` — vendored unmodified from
    [`@libav.js/variant-webcodecs`](https://www.npmjs.com/package/@libav.js/variant-webcodecs)
    at the version pinned in `package.json`.
  - `avbridge` — a custom build produced by `scripts/build-libav.sh`. The
    fragment list, compile flags, and the exact libav.js source commit used
    are documented in [`vendor/libav/README.md`](./vendor/libav/README.md).
    The build script is reproducible: running `./scripts/build-libav.sh`
    downloads the exact upstream sources and reproduces the binary.

**LGPL replaceability.** avbridge's libav loader (`libavBaseUrl()` in
`src/strategies/fallback/libav-loader.ts`) resolves the libav load path at
runtime and can be overridden by setting `globalThis.AVBRIDGE_LIBAV_BASE`
to any other URL before the first playback. Consumers who want to replace
the bundled libav build with their own are therefore not obstructed — the
bundled binaries are a default, not a lock-in.

**Source availability.** avbridge satisfies LGPL-2.1 §6 ("Works that use
the Library") by:

1. Pointing at the exact upstream project
   ([Yahweasel/libav.js](https://github.com/Yahweasel/libav.js)) and the
   version pinned in `package.json`.
2. Shipping the reproducible build script (`scripts/build-libav.sh`) that
   produced the `avbridge` variant, and documenting its inputs in
   `vendor/libav/README.md`.
3. Providing the replaceability hook described above, which lets end users
   use a modified version of libav.js in their own applications without
   relinking avbridge.

If you need a literal source tarball rather than a build script, please
open an issue at https://github.com/keishi/avbridge/issues and it will be
provided.

### mediabunny — MPL-2.0

`dist/element-browser.js` (the pre-bundled browser entry) contains
mediabunny inlined into the bundle. The classic `dist/index.js` and
`dist/element.js` entries do **not** inline mediabunny; they keep it as an
external import for bundler consumers.

- Upstream: https://github.com/Vanilagy/mediabunny
- License: MPL-2.0 (https://www.mozilla.org/MPL/2.0/)
- Inlined version: see `mediabunny` in [`package.json`](./package.json)

MPL-2.0 is a file-level copyleft: modifications to MPL-licensed files must
be released under MPL-2.0, but combining MPL code with differently-licensed
code (as avbridge does) is fine as long as the MPL-licensed portions remain
identifiable and their source is available. mediabunny's source is
available at the upstream repository above; the inlined copy in
`dist/element-browser.js` is unmodified.

### libavjs-webcodecs-bridge — MIT

- Upstream: https://github.com/Yahweasel/libavjs-webcodecs-bridge
- License: MIT

---

For the full license texts, see [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).
