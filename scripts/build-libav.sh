#!/usr/bin/env bash
#
# Build the custom UBMP libav.js variant.
#
# This produces a single WASM binary that includes the demuxers + decoders
# UBMP needs for legacy file playback (AVI, ASF, FLV, MKV with WMV3, MPEG-4
# Part 2 / DivX / Xvid, …). The npm-published libav.js variants are
# intentionally minimal and ship none of this; building locally is the
# supported path.
#
# Requirements:
#   - macOS or Linux
#   - git, make, python3, a working C toolchain (Xcode Command Line Tools on
#     macOS, build-essential on Linux)
#   - ~2 GB free disk in $UBMP_BUILD_CACHE
#   - 15-30 minutes of CPU time
#
# This script does NOT touch your system Python, Homebrew, or any global
# package manager. emsdk is fetched into UBMP_BUILD_CACHE (defaults to
# ~/.cache/ubmp) and only modifies its own directory.
#
# Usage:
#   ./scripts/build-libav.sh                  # build with defaults
#   UBMP_BUILD_CACHE=/tmp/ubmp build-libav.sh # custom cache location
#   UBMP_LIBAV_CLEAN=1 build-libav.sh         # force rebuild from scratch
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${UBMP_BUILD_CACHE:-$HOME/.cache/ubmp}"
EMSDK_DIR="$CACHE/emsdk"
LIBAV_DIR="$CACHE/libav.js"
LIBAV_VERSION="6.8.8.0"
LIBAV_TAG="v${LIBAV_VERSION}"
VARIANT_NAME="ubmp"
VENDOR_DIR="$REPO_ROOT/vendor/libav"

# Compiler optimization flags. The libav.js Makefile defaults to OPTFLAGS=-Oz
# (optimize for *size*), which produces small binaries with the slowest C
# code. We override to -O3 for max speed and add -msimd128 so emscripten
# emits WASM SIMD instructions for ffmpeg's SSE2-style intrinsic paths
# (mpeg4 IDCT, motion compensation, deblocking, etc.).
#
# These propagate to ffmpeg's --optflags AND to all dependency library
# CFLAGS via the Makefile, AND to the final emcc link step. Override at
# invocation time with `UBMP_LIBAV_OPTFLAGS=...`.
LIBAV_OPTFLAGS="${UBMP_LIBAV_OPTFLAGS:--O3 -msimd128}"

# The fragment list. See libav.js docs/CONFIG.md and configs/mkconfigs.js for
# the full grammar. Anything you add here gets compiled into the binary; the
# binary size grows roughly linearly with what's enabled.
#
# Order doesn't matter, but grouping by purpose makes the diff easy to read.
read -r -d '' VARIANT_FRAGMENTS <<'EOF' || true
[
  "avformat", "avcodec", "swscale", "swresample",

  "demuxer-avi",
  "demuxer-asf",
  "demuxer-flv",
  "demuxer-matroska",
  "demuxer-mov",
  "demuxer-mp3",
  "demuxer-ogg",
  "demuxer-wav",
  "demuxer-aac",

  "parser-h264",
  "parser-hevc",
  "parser-mpeg4video",
  "parser-mpegvideo",
  "parser-mpegaudio",
  "parser-aac",
  "parser-vc1",

  "decoder-h264",
  "decoder-hevc",
  "decoder-mpeg4",
  "decoder-msmpeg4v3",
  "decoder-msmpeg4v2",
  "decoder-msmpeg4v1",
  "decoder-wmv1",
  "decoder-wmv2",
  "decoder-wmv3",
  "decoder-vc1",
  "decoder-mpeg2video",
  "decoder-mpeg1video",

  "decoder-aac",
  "decoder-mp3",
  "decoder-ac3",
  "decoder-eac3",
  "decoder-wmav1",
  "decoder-wmav2",
  "decoder-wmapro",

  "bsf-mpeg4_unpack_bframes"
]
EOF

log() { echo "[build-libav] $*"; }

log "cache directory: $CACHE"
log "vendor target:   $VENDOR_DIR"
mkdir -p "$CACHE" "$VENDOR_DIR"

if [ "${UBMP_LIBAV_CLEAN:-0}" = "1" ]; then
  log "UBMP_LIBAV_CLEAN=1 — wiping cached emsdk + libav.js trees"
  rm -rf "$EMSDK_DIR" "$LIBAV_DIR"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 1. emsdk
# ─────────────────────────────────────────────────────────────────────────────
if [ ! -d "$EMSDK_DIR/.git" ]; then
  log "cloning emsdk into $EMSDK_DIR"
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
fi
pushd "$EMSDK_DIR" >/dev/null
if [ ! -f "$EMSDK_DIR/upstream/emscripten/emcc" ] && [ ! -f "$EMSDK_DIR/upstream/emscripten/emcc.py" ]; then
  log "installing latest emsdk (downloads ~500 MB into $EMSDK_DIR)"
  ./emsdk install latest
  ./emsdk activate latest
fi
# shellcheck disable=SC1091
source ./emsdk_env.sh
popd >/dev/null

log "emcc: $(command -v emcc)"
emcc --version | head -1 | sed 's/^/[build-libav]   /'

# ─────────────────────────────────────────────────────────────────────────────
# 2. libav.js source tree
# ─────────────────────────────────────────────────────────────────────────────
if [ ! -d "$LIBAV_DIR/.git" ]; then
  log "cloning libav.js into $LIBAV_DIR"
  git clone https://github.com/Yahweasel/libav.js.git "$LIBAV_DIR"
fi
pushd "$LIBAV_DIR" >/dev/null
log "checking out tag $LIBAV_TAG"
git fetch --tags --quiet origin
git checkout --quiet "$LIBAV_TAG"
git submodule update --init --recursive --quiet

# ─────────────────────────────────────────────────────────────────────────────
# 3. Custom variant config
# ─────────────────────────────────────────────────────────────────────────────
# mkconfig.js resolves relative paths against its own directory (it reads
# `fragments/.../license-head.js` etc.), so we have to invoke it with cwd
# inside `configs/`. Running from the libav.js root fails with ENOENT.
log "writing variant config 'configs/configs/$VARIANT_NAME'"
( cd configs && node mkconfig.js "$VARIANT_NAME" "$VARIANT_FRAGMENTS" )

# ─────────────────────────────────────────────────────────────────────────────
# 3a. Cache-busting: detect when the inputs to the build (fragments and
#     compile flags) have changed since the last successful build, and force
#     a partial clean rebuild if so. Make can't see OPTFLAGS as a dependency,
#     so without this an old build with -Oz objects would silently survive.
# ─────────────────────────────────────────────────────────────────────────────
INPUT_HASH_FILE="$LIBAV_DIR/.ubmp-build-inputs"
INPUTS_NOW=$(printf "%s\n%s\n" "$VARIANT_FRAGMENTS" "$LIBAV_OPTFLAGS")
INPUTS_NOW_HASH=$(printf "%s" "$INPUTS_NOW" | shasum -a 256 | cut -d' ' -f1)
INPUTS_PREV_HASH=""
if [ -f "$INPUT_HASH_FILE" ]; then
  INPUTS_PREV_HASH=$(cat "$INPUT_HASH_FILE")
fi

if [ "$INPUTS_NOW_HASH" != "$INPUTS_PREV_HASH" ]; then
  log "build inputs changed (or first run with hash check) — wiping build dirs for clean rebuild"
  rm -rf build/ffmpeg-* build/inst dist
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. Build
# ─────────────────────────────────────────────────────────────────────────────
# We build ONLY the wasm variant targets, skipping asm.js and threaded:
#
#   - asm.js: `wasm2js` crashes on WASM SIMD instructions
#     ("unhandled unaligned load / UNREACHABLE"). asm.js is a legacy fallback
#     for browsers without WebAssembly (essentially IE11); we don't need it.
#
#   - threaded (.thr): libav.js's threaded message dispatch has runtime bugs
#     (undefined handler / reader-device race) that we can't fix from outside.
#     Disabled in the loader. If a future libav.js release fixes pthreads, we
#     can re-enable.
#
# Building only the wasm targets also cuts build time roughly in half.
VER="$LIBAV_VERSION"
V="$VARIANT_NAME"
log "running make (wasm-only) with OPTFLAGS=\"$LIBAV_OPTFLAGS\""
log "  -O3 for speed + -msimd128 for WASM SIMD → ~3-4× decode vs the default -Oz"
log "  this takes 10-30 minutes the first time; re-runs are incremental"
make OPTFLAGS="$LIBAV_OPTFLAGS" \
  "dist/libav-${VER}-${V}.wasm.js" \
  "dist/libav-${VER}-${V}.wasm.mjs" \
  "dist/libav-${VER}-${V}.dbg.wasm.js" \
  "dist/libav-${VER}-${V}.dbg.wasm.mjs" \
  "dist/libav-${V}.js" \
  "dist/libav-${V}.mjs" \
  "dist/libav-${V}.dbg.js" \
  "dist/libav-${V}.dbg.mjs" \
  "dist/libav.types.d.ts"

# Record the inputs that produced this artifact so the next run can
# detect changes.
printf "%s" "$INPUTS_NOW_HASH" > "$INPUT_HASH_FILE"

# ─────────────────────────────────────────────────────────────────────────────
# 5. Copy artifacts to vendor/libav
# ─────────────────────────────────────────────────────────────────────────────
DIST="$LIBAV_DIR/dist"
log "copying artifacts from $DIST to $VENDOR_DIR"

# Wipe stale files from older builds so we don't carry around dead binaries.
find "$VENDOR_DIR" -maxdepth 1 -name 'libav-*' -delete 2>/dev/null || true

cp "$DIST/libav-${VARIANT_NAME}.mjs"                              "$VENDOR_DIR/" || true
cp "$DIST/libav-${VARIANT_NAME}.js"                               "$VENDOR_DIR/" || true
cp "$DIST/libav-${LIBAV_VERSION}-${VARIANT_NAME}.mjs"             "$VENDOR_DIR/" || true
cp "$DIST/libav-${LIBAV_VERSION}-${VARIANT_NAME}.wasm.mjs"        "$VENDOR_DIR/"
cp "$DIST/libav-${LIBAV_VERSION}-${VARIANT_NAME}.wasm.wasm"       "$VENDOR_DIR/"
cp "$DIST/libav-${LIBAV_VERSION}-${VARIANT_NAME}.wasm.js"         "$VENDOR_DIR/" 2>/dev/null || true
# Threaded + asm.js builds are optional; copy if present.
cp "$DIST/libav-${LIBAV_VERSION}-${VARIANT_NAME}.thr.mjs"         "$VENDOR_DIR/" 2>/dev/null || true
cp "$DIST/libav-${LIBAV_VERSION}-${VARIANT_NAME}.thr.wasm"        "$VENDOR_DIR/" 2>/dev/null || true
cp "$DIST/libav-${LIBAV_VERSION}-${VARIANT_NAME}.thr.js"          "$VENDOR_DIR/" 2>/dev/null || true
cp "$DIST/libav-${LIBAV_VERSION}-${VARIANT_NAME}.asm.mjs"         "$VENDOR_DIR/" 2>/dev/null || true
cp "$DIST/libav-${LIBAV_VERSION}-${VARIANT_NAME}.asm.js"          "$VENDOR_DIR/" 2>/dev/null || true

popd >/dev/null

log "done — files in $VENDOR_DIR:"
ls -lh "$VENDOR_DIR" | sed 's/^/[build-libav]   /'

log ""
log "Next steps:"
log "  1. Run \`npm run predemo\` to copy the variant into demo/public/libav/ubmp/"
log "  2. Run \`npm run demo\` and try a legacy file"
log ""
log "The loader at src/strategies/fallback/libav-loader.ts will pick up the"
log "ubmp variant automatically — see the 'ubmp' branch in loadVariant()."
