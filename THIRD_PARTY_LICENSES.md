# Third-party license texts

This document contains the full license text of every third-party
component bundled with avbridge.js. The short overview lives in
[NOTICE.md](./NOTICE.md); this file is what you need if you redistribute
avbridge.js and have to comply with the underlying licenses.

---

## libav.js (LGPL-2.1-or-later)

avbridge bundles prebuilt binaries of libav.js — a compilation of FFmpeg's
libraries (libavformat, libavcodec, libavfilter, libavutil, libswresample,
libswscale) for WebAssembly. These binaries live in
`vendor/libav/avbridge/` and `vendor/libav/webcodecs/`.

- Upstream project: https://github.com/Yahweasel/libav.js
- FFmpeg legal notice: https://ffmpeg.org/legal.html
- License: **GNU Lesser General Public License version 2.1 or later**

The full LGPL-2.1 license text is available at
https://www.gnu.org/licenses/old-licenses/lgpl-2.1.en.html and is
incorporated by reference. avbridge ships this text as a hyperlink rather
than a copy to keep the tarball size reasonable; the text is short, stable,
and universally accessible.

### Your obligations if you redistribute avbridge

LGPL-2.1 §6 ("Works that use the Library") allows combined works that link
the library if the recipient can replace the library with a modified
version. avbridge satisfies this requirement in three ways:

1. **The libav binaries are separate files.** They are not inlined into
   `dist/index.js` or any other JavaScript bundle. They live under
   `vendor/libav/<variant>/` and are loaded at runtime via a dynamic
   import of `libav-<variant>.mjs`. You can replace the `.mjs` and
   `.wasm` files with a different build and the rest of avbridge keeps
   working unchanged.

2. **The load path is user-overridable.** Set
   `globalThis.AVBRIDGE_LIBAV_BASE = "/my/path"` before the first
   playback and avbridge will load libav from your path instead of the
   bundled default. This is the documented replaceability hook.

3. **The build is reproducible.** `scripts/build-libav.sh` in the
   avbridge repository builds the exact `avbridge` variant bundled in
   this package. It downloads the pinned libav.js source, applies the
   fragment list documented in `vendor/libav/README.md`, and writes the
   output to `vendor/libav/avbridge/`. Running it gives you the same
   bytes that ship in the npm tarball.

If you need the upstream libav.js / FFmpeg source code that corresponds
to the bundled binaries, either run `./scripts/build-libav.sh` (which
downloads it) or obtain it directly from
https://github.com/Yahweasel/libav.js and https://ffmpeg.org/download.html.
You may also open an issue at
https://github.com/keishi/avbridge/issues and a source archive matching
the shipped binaries will be provided.

---

## mediabunny (MPL-2.0)

mediabunny is inlined into `dist/element-browser.js` and kept as an external
dependency in `dist/index.js` and `dist/element.js`.

- Upstream project: https://github.com/Vanilagy/mediabunny
- License: **Mozilla Public License, version 2.0**
- License text: https://www.mozilla.org/MPL/2.0/

MPL-2.0 is a file-scoped copyleft. You may combine mediabunny with code
under a different license (as avbridge does), provided:

1. The mediabunny source code remains available to recipients of the
   combined work. avbridge satisfies this by pointing at the unmodified
   upstream repository above; the version bundled is pinned in
   `package.json`.
2. Any modifications to mediabunny's own files are released under
   MPL-2.0. avbridge does **not** modify mediabunny — the inlined copy
   in `dist/element-browser.js` is a direct bundle of the unmodified
   upstream source.

---

## libavjs-webcodecs-bridge (MIT)

- Upstream project: https://github.com/Yahweasel/libavjs-webcodecs-bridge
- License: **MIT**
- Version: as pinned in `package.json`

MIT License text (applies to libavjs-webcodecs-bridge):

```
Copyright (c) Yahweasel and contributors

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```

---

## Questions

If anything here is unclear, or you need a specific form of compliance
material (source tarballs, signed attestations, build reproducibility
evidence), open an issue at https://github.com/keishi/avbridge/issues.
