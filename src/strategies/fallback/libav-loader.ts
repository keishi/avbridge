/**
 * Lazy libav.js loader supporting multiple variants.
 *
 * avbridge recognises three libav variants:
 *
 * - **webcodecs** — npm `@libav.js/variant-webcodecs`, ~5 MB. Modern formats
 *   only (mp4/mkv/webm/ogg/wav/...) — designed to bridge to WebCodecs.
 *
 * - **default** — npm `@libav.js/variant-default`, ~12 MB. Audio-only build
 *   (Opus, FLAC, WAV) despite the name. Useful for audio fallback.
 *
 * - **avbridge** — a custom build produced by `scripts/build-libav.sh` and
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

import { dbg } from "../../util/debug.js";

export type LibavVariant = "webcodecs" | "default" | "avbridge";

export interface LoadLibavOptions {
  /** Force threading on/off for this load; see `wantsThreads()` for the default. */
  threads?: boolean;
}

// loadLibav's shared instances, by variant and threading mode.
const cache: Map<string, Promise<LibavInstance>> = new Map();
// The variant's module, imported once whatever number of instances it makes.
const modules: Map<string, Promise<LoadedVariant>> = new Map();

function cacheKey(variant: LibavVariant, threads: boolean): string {
  return `${variant}:${threads ? "thr" : "wasm"}`;
}

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
// `globalThis.AVBRIDGE_LIBAV_THREADS = true` for testing if libav.js fixes
// those bugs in a future release.
function wantsThreads(opts: LoadLibavOptions): boolean {
  const env = globalThis as { AVBRIDGE_LIBAV_THREADS?: boolean };
  return opts.threads !== undefined ? opts.threads : env.AVBRIDGE_LIBAV_THREADS === true;
}

/**
 * Load (and cache) a libav.js variant. Pass `"webcodecs"` for the small
 * default; pass `"default"` for the audio fallback; pass `"avbridge"` for the
 * custom build that supports AVI/WMV/legacy codecs.
 *
 * The instance is shared by every caller for the life of the page, and libav.js
 * runs one call at a time on its worker: a call that never returns (a Range read
 * whose response never arrives) holds up every later one. Playback therefore
 * uses `createLibav()`; this stays for one-shot work (remux, transcode).
 */
export function loadLibav(
  variant: LibavVariant = "webcodecs",
  opts: LoadLibavOptions = {},
): Promise<LibavInstance> {
  const wantThreads = wantsThreads(opts);
  const key = cacheKey(variant, wantThreads);
  let entry = cache.get(key);
  if (!entry) {
    entry = createLibav(variant, opts);
    entry.catch(() => cache.delete(key));
    cache.set(key, entry);
  }
  return entry;
}

/**
 * A libav.js instance of its own: its own worker and heap, which nothing else
 * can wedge or corrupt. The caller owns it and must `releaseLibav()` it, which
 * is also how a call stuck on a read is ended. The module is imported once;
 * each instance costs a worker and a WebAssembly instantiation.
 */
export function createLibav(
  variant: LibavVariant = "webcodecs",
  opts: LoadLibavOptions = {},
): Promise<LibavInstance> {
  const wantThreads = wantsThreads(opts);
  return dbg.timed("libav-load", `load "${variant}" (threads=${wantThreads})`, 5000, async () => {
    const { mod, base } = await loadModule(variant);
    try {
      const inst = (await mod.LibAV(buildOpts(base, wantThreads))) as LibavInstance;
      trackCalls(inst);
      await silenceLibavLogs(inst);
      return inst;
    } catch (err) {
      throw chain(`LibAV() factory failed for "${variant}" variant (threads=${wantThreads})`, err);
    }
  });
}

/** Fails the calls an instance still has in flight; see trackCalls. */
const inFlight = new WeakMap<object, Set<(err: Error) => void>>();

/**
 * Wraps the one function every libav.js method posts through (`c`, in the worker and the
 * threaded wrappers alike) to keep each call's rejecter, so releaseLibav can fail them. libav.js
 * keeps its own pending handlers where nothing outside can reach them in threaded mode.
 *
 * @internal Exported for unit tests.
 */
export function trackCalls(libav: unknown): void {
  const inst = libav as { c?: (...args: unknown[]) => Promise<unknown> };
  const call = inst.c;
  if (typeof call !== "function") return;
  const pending = new Set<(err: Error) => void>();
  inFlight.set(inst, pending);
  inst.c = (...args: unknown[]) => new Promise((resolve, reject) => {
    pending.add(reject);
    call.apply(inst, args).then(
      (value) => { pending.delete(reject); resolve(value); },
      (err) => { pending.delete(reject); reject(err); },
    );
  });
}

/**
 * Ends an instance from `createLibav()`: terminates its workers, fails every
 * call still waiting on it (a pending read included, so whatever awaited it
 * moves on) and every call made after. Safe to call twice.
 */
export function releaseLibav(libav: unknown): void {
  const inst = libav as {
    terminate?: () => void;
    c?: (...args: unknown[]) => Promise<unknown>;
    __released?: boolean;
  };
  if (!inst || inst.__released) return;
  inst.__released = true;
  const released = () => new Error("libav released");
  inst.c = () => Promise.reject(released());
  try { inst.terminate?.(); } catch { /* ignore */ }
  for (const fail of inFlight.get(inst) ?? []) fail(released());
  inFlight.delete(inst);
}

function loadModule(variant: LibavVariant): Promise<{ mod: LoadedVariant; base: string }> {
  const base = `${libavBaseUrl()}/${variant}`;
  const variantUrl = `${base}/libav-${variant}.mjs`;
  let entry = modules.get(variantUrl);
  if (!entry) {
    entry = importVariant(variant, base, variantUrl);
    entry.catch(() => modules.delete(variantUrl));
    modules.set(variantUrl, entry);
  }
  return entry.then((mod) => ({ mod, base }));
}

async function importVariant(variant: LibavVariant, base: string, variantUrl: string): Promise<LoadedVariant> {
  dbg.info("libav-load", `fetching ${variantUrl}`);

  // Preflight HEAD-ish check: issue a bytes=0-0 range request so a missing
  // file fails fast with a clear error instead of hanging deep inside the
  // dynamic import or inside libav's own WASM instantiation. Surfaces the
  // most common mistake ("libav base path is wrong") in <100 ms instead of
  // an indeterminate stall.
  if (typeof fetch === "function") {
    try {
      const head = await fetch(variantUrl, { method: "GET", headers: { Range: "bytes=0-0" } });
      if (!head.ok && head.status !== 206) {
        throw new Error(
          `HTTP ${head.status} ${head.statusText} — check that libav files are served ` +
          `at ${base}/ (override via globalThis.AVBRIDGE_LIBAV_BASE)`,
        );
      }
      try { await head.arrayBuffer(); } catch { /* ignore */ }
    } catch (err) {
      throw chain(
        `libav.js "${variant}" variant not reachable at ${variantUrl}`,
        err,
      );
    }
  }

  try {
    const imported: unknown = await import(/* @vite-ignore */ variantUrl);
    if (!imported || typeof (imported as { LibAV?: unknown }).LibAV !== "function") {
      throw new Error(`module at ${variantUrl} did not export LibAV`);
    }
    return imported as LoadedVariant;
  } catch (err) {
    const hint =
      variant === "avbridge"
        ? `The "avbridge" variant is a custom local build. Run \`./scripts/build-libav.sh\` ` +
          `to produce it (requires Emscripten; ~15-30 min the first time).`
        : `Make sure the variant files are present at ${base}/ (set ` +
          `globalThis.AVBRIDGE_LIBAV_BASE to override the default lookup path).`;
    throw new Error(
      `failed to load libav.js "${variant}" variant from ${variantUrl}. ${hint} ` +
        `Original error: ${(err as Error).message || String(err)}`,
    );
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
  // wantThreads comes from wantsThreads().
  return {
    base,
    nothreads: !wantThreads,
    yesthreads: wantThreads,
  };
}

function libavBaseUrl(): string {
  // Consumer override — the documented "LGPL replaceability" hook.
  // Setting `globalThis.AVBRIDGE_LIBAV_BASE = "/my/path"` lets anyone swap
  // in a different libav build (custom fragments, security patches, etc.)
  // without rebuilding avbridge.
  const override =
    typeof globalThis !== "undefined"
      ? (globalThis as { AVBRIDGE_LIBAV_BASE?: string }).AVBRIDGE_LIBAV_BASE
      : undefined;
  if (override) return override;

  // Default: resolve relative to this module's URL. When avbridge is installed
  // under `node_modules/avbridge/`, this module lives at `dist/chunk-*.js` (or
  // `dist/element-browser.js` for the browser entry) and `../vendor/libav`
  // resolves to `node_modules/avbridge/vendor/libav`, where the build step
  // vendored every variant's binaries. That's the zero-config path.
  //
  // `import.meta.url` throws in some synthetic environments (CJS tests, some
  // SSR evaluators). If it fails, fall back to the legacy `/libav` path so
  // consumers who relied on the pre-2.1 behavior still work.
  try {
    return new URL("../vendor/libav", import.meta.url).href;
  } catch {
    if (typeof location !== "undefined" && location.protocol.startsWith("http")) {
      return `${location.origin}/libav`;
    }
    return "/libav";
  }
}

function chain(message: string, err: unknown): Error {
  const inner = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`[avbridge] ${message}:`, err);
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
