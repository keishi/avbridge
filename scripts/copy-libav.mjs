#!/usr/bin/env node
/**
 * Vendor the `@libav.js/variant-webcodecs` binaries into
 * `vendor/libav/webcodecs/` so the published npm tarball ships every libav
 * binary a consumer needs. Without this step, the webcodecs variant would
 * live at `node_modules/@libav.js/variant-webcodecs/` and browser-direct
 * consumers would have no way to reach it.
 *
 * The canonical runtime layout is:
 *
 *   vendor/libav/
 *     webcodecs/
 *       libav-webcodecs.mjs
 *       libav-<ver>-webcodecs.wasm.mjs
 *       libav-<ver>-webcodecs.wasm.wasm
 *     avbridge/
 *       libav-avbridge.mjs
 *       libav-<ver>-avbridge.wasm.mjs
 *       libav-<ver>-avbridge.wasm.wasm
 *
 * The libav loader at runtime resolves `<base>/<variant>/libav-<variant>.mjs`
 * relative to its own module URL (for the browser entry) or via an explicit
 * `AVBRIDGE_LIBAV_BASE` override (for dev servers and bundler consumers).
 * Either way it finds the binaries under `vendor/libav/<variant>/` with no
 * extra configuration.
 *
 * Demo / dev server note: `vite.config.ts` has a tiny middleware plugin
 * (`serveVendorLibav`) that streams files out of this directory at
 * `/libav/*`, so the demo doesn't need a copy-to-public-dir step.
 *
 * Run as a prebuild step (`npm run build` triggers it via `prebuild`) so
 * every `npm run build` rewrites the vendored webcodecs binaries in place,
 * keeping them in lockstep with the pinned npm package version.
 */
import { cpSync, mkdirSync, readdirSync, rmSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Variants that come from npm packages. Copy their dist/ into vendor/libav/<name>/.
const npmVariants = [
  { name: "webcodecs", pkg: "@libav.js/variant-webcodecs" },
];

// Where vendored binaries live inside the package — this directory is
// listed in package.json `files:` so it ships in the tarball.
const vendorLibav = resolve(repoRoot, "vendor/libav");

// Whitelist of filename patterns we actually ship. Everything else in the
// upstream variant's dist/ (asm.js fallbacks for browsers that don't
// support WASM, threaded `.thr.*` variants we don't use because libav.js
// pthreads are unreliable — see libav-loader.ts) is excluded to keep the
// tarball under ~5 MB packed.
const SHIPPED_FILENAME_PATTERNS = [
  /^libav-[a-z]+\.mjs$/,                          // entry ESM (libav-<variant>.mjs)
  /^libav-[0-9.]+-[a-z]+\.wasm\.mjs$/,            // non-threaded WASM glue
  /^libav-[0-9.]+-[a-z]+\.wasm\.wasm$/,           // non-threaded WASM binary
  /^libav\.types\.d\.ts$/,                        // type defs (small)
];

function shouldShip(filename) {
  return SHIPPED_FILENAME_PATTERNS.some((re) => re.test(filename));
}

// ── Step 1: populate vendor/libav/webcodecs/ from node_modules ─────────────

for (const v of npmVariants) {
  const src = resolve(repoRoot, "node_modules", v.pkg, "dist");
  const dst = join(vendorLibav, v.name);
  if (!existsSync(src)) {
    console.warn(
      `[copy-libav] ${v.pkg} not installed — skipping vendor step. ` +
        `Run \`npm install\` first.`,
    );
    continue;
  }
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  let copied = 0;
  let skipped = 0;
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    if (!statSync(from).isFile()) continue;
    if (!shouldShip(name)) { skipped++; continue; }
    cpSync(from, join(dst, name));
    copied++;
  }
  console.log(
    `[copy-libav] vendored ${v.name}: ${copied} file(s) → vendor/libav/${v.name}/ ` +
    `(skipped ${skipped} unused variants)`,
  );
}

// ── Step 2: prune any unused files already in vendor/libav/avbridge/ ───────
//
// The custom avbridge variant is built locally via scripts/build-libav.sh
// and lands there. Apply the same whitelist so the tarball doesn't carry
// asm.js fallbacks or non-module .js entry points we never load.
const avbridgeDir = join(vendorLibav, "avbridge");
if (existsSync(avbridgeDir)) {
  let pruned = 0;
  for (const name of readdirSync(avbridgeDir)) {
    const p = join(avbridgeDir, name);
    if (!statSync(p).isFile()) continue;
    if (shouldShip(name)) continue;
    rmSync(p);
    pruned++;
  }
  if (pruned > 0) {
    console.log(`[copy-libav] pruned ${pruned} unused file(s) from vendor/libav/avbridge/`);
  }
}
