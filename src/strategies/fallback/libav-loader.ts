/**
 * Lazy libav.js loader supporting multiple variants.
 *
 * UBMP recognises three libav variants:
 *
 * - **webcodecs** — npm `@libav.js/variant-webcodecs`, ~5 MB. Modern formats
 *   only (mp4/mkv/webm/ogg/wav/...) — designed to bridge to WebCodecs.
 *
 * - **default** — npm `@libav.js/variant-default`, ~12 MB. Audio-only build
 *   (Opus, FLAC, WAV) despite the name. Useful for audio fallback.
 *
 * - **ubmp** — a custom build produced by `scripts/build-libav.sh` and
 *   landing in `vendor/libav/`. Includes the AVI/ASF/FLV/MKV demuxers plus
 *   the legacy decoders (WMV3, MPEG-4 Part 2, MS-MPEG4 v1/2/3, VC-1, MPEG-1/2,
 *   AC-3/E-AC-3, WMAv1/v2/Pro). This is the only variant that can read AVI;
 *   the npm variants are intentionally minimal and ship none of the legacy
 *   demuxers.
 *
 * Variant resolution always goes through a runtime URL + `/* @vite-ignore *\/`
 * dynamic import. Static imports trigger Vite's optimized-deps pipeline,
 * which rewrites `import.meta.url` away from the real `dist/` directory and
 * breaks libav's sibling-binary loading.
 */

export type LibavVariant = "webcodecs" | "default" | "ubmp";

export interface LoadLibavOptions {
  /**
   * Force threading on/off for this load. If unspecified, defaults to
   * "true if `crossOriginIsolated`, otherwise false". Some libav.js code
   * paths (notably the cross-thread reader-device protocol used during
   * `avformat_find_stream_info` for AVI) are unreliable in threaded mode,
   * so probing forces this to `false` while decode keeps it default.
   */
  threads?: boolean;
}

// Cache key includes both variant and threading mode so probe and decode
// can run different libav instances of the same variant.
const cache: Map<string, Promise<LibavInstance>> = new Map();

function cacheKey(variant: LibavVariant, threads: boolean): string {
  return `${variant}:${threads ? "thr" : "wasm"}`;
}

/**
 * Load (and cache) a libav.js variant. Pass `"webcodecs"` for the small
 * default; pass `"default"` for the audio fallback; pass `"ubmp"` for the
 * custom build that supports AVI/WMV/legacy codecs.
 */
export function loadLibav(
  variant: LibavVariant = "webcodecs",
  opts: LoadLibavOptions = {},
): Promise<LibavInstance> {
  // Threading is OFF by default. The threaded libav.js variant is too
  // fragile in practice for our usage:
  //   - Probe (`avformat_find_stream_info` for AVI) throws an `undefined`
  //     exception out of `ff_init_demuxer_file`, apparently due to the
  //     cross-thread reader-device protocol racing with the main thread.
  //   - Decode hits a `TypeError: Cannot read properties of undefined
  //     (reading 'apply')` inside libav.js's own worker message handler
  //     within seconds of starting — a bug in libav.js's threaded message
  //     dispatch that we can't fix from outside.
  //
  // Performance work for the fallback strategy needs to come from elsewhere
  // (WASM SIMD, OffscreenCanvas, larger decode batches) instead of libav's
  // pthreads. Threading can still be force-enabled with
  // `globalThis.UBMP_LIBAV_THREADS = true` for testing if libav.js fixes
  // those bugs in a future release.
  const env = globalThis as { UBMP_LIBAV_THREADS?: boolean };
  const wantThreads =
    opts.threads !== undefined
      ? opts.threads
      : env.UBMP_LIBAV_THREADS === true;

  const key = cacheKey(variant, wantThreads);
  let entry = cache.get(key);
  if (!entry) {
    entry = loadVariant(variant, wantThreads);
    cache.set(key, entry);
  }
  return entry;
}

async function loadVariant(
  variant: LibavVariant,
  wantThreads: boolean,
): Promise<LibavInstance> {
  const key = cacheKey(variant, wantThreads);
  const base = `${libavBaseUrl()}/${variant}`;
  // The custom variant is named `libav-ubmp.mjs`; the npm variants follow
  // the same convention (`libav-webcodecs.mjs`, `libav-default.mjs`).
  const variantUrl = `${base}/libav-${variant}.mjs`;

  let mod: LoadedVariant;
  try {
    // @ts-ignore runtime URL
    const imported: unknown = await import(/* @vite-ignore */ variantUrl);
    if (!imported || typeof (imported as { LibAV?: unknown }).LibAV !== "function") {
      throw new Error(`module at ${variantUrl} did not export LibAV`);
    }
    mod = imported as LoadedVariant;
  } catch (err) {
    cache.delete(key);
    const hint =
      variant === "ubmp"
        ? `The "ubmp" variant is a custom local build. Run \`./scripts/build-libav.sh\` ` +
          `to produce it (requires Emscripten; ~15-30 min the first time), then ` +
          `\`npm run predemo\` to copy it into the demo asset path.`
        : `Make sure the variant files are present (run \`npm run predemo\` or copy ` +
          `node_modules/@libav.js/variant-${variant}/dist/* into the URL space).`;
    throw new Error(
      `failed to load libav.js "${variant}" variant from ${variantUrl}. ${hint} ` +
        `Original error: ${(err as Error).message || String(err)}`,
    );
  }

  try {
    const inst = (await mod.LibAV(buildOpts(base, wantThreads))) as LibavInstance;
    await silenceLibavLogs(inst);
    return inst;
  } catch (err) {
    cache.delete(key);
    throw chain(`LibAV() factory failed for "${variant}" variant (threads=${wantThreads})`, err);
  }
}

/**
 * Lower libav's internal log level so the console doesn't get flooded with
 * `[mp3 @ ...] Header missing` and `Video uses a non-standard and wasteful
 * way to store B-frames` warnings on every legacy file. We still get any
 * actual JS-level errors via the normal Error path; this only affects
 * libav's own ffmpeg log channel.
 *
 * AV_LOG_QUIET = -8 (no output at all). If you want to keep fatal errors,
 * use AV_LOG_FATAL = 8 instead.
 */
async function silenceLibavLogs(inst: LibavInstance): Promise<void> {
  try {
    const setLevel = (inst as { av_log_set_level?: (n: number) => Promise<void> })
      .av_log_set_level;
    if (typeof setLevel === "function") {
      const quiet = (inst as { AV_LOG_QUIET?: number }).AV_LOG_QUIET ?? -8;
      await setLevel(quiet);
    }
  } catch {
    /* not fatal — verbose logs are noise, not an error */
  }
}

function buildOpts(base: string, wantThreads: boolean): Record<string, unknown> {
  // The wantThreads decision is made by `loadLibav()` so callers (probe,
  // decoder) can override per-load. Decode wants pthreads for speed; probe
  // forces them off because libav.js's cross-thread reader-device protocol
  // is unreliable mid-`avformat_find_stream_info` for some AVI files.
  return {
    base,
    nothreads: !wantThreads,
    yesthreads: wantThreads,
  };
}

function libavBaseUrl(): string {
  const override =
    typeof globalThis !== "undefined"
      ? (globalThis as { UBMP_LIBAV_BASE?: string }).UBMP_LIBAV_BASE
      : undefined;
  if (override) return override;
  if (typeof location !== "undefined" && location.protocol.startsWith("http")) {
    return `${location.origin}/libav`;
  }
  return "/libav";
}

function chain(message: string, err: unknown): Error {
  const inner = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`[ubmp] ${message}:`, err);
  return new Error(`${message}: ${inner || "(no message — see browser console)"}`);
}

interface LoadedVariant {
  LibAV: (opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/** Loose structural type — the AVI probe and the fallback decoder add fields. */
export type LibavInstance = Record<string, unknown> & {
  mkreadaheadfile(name: string, blob: Blob): Promise<void>;
  unlinkreadaheadfile(name: string): Promise<void>;
};
