#!/usr/bin/env node
/**
 * Two responsibilities:
 *
 * 1. **Vendor the webcodecs variant** into `vendor/libav/webcodecs/` so the
 *    published npm tarball contains every binary a consumer needs. Without
 *    this step, the webcodecs variant lives at `node_modules/@libav.js/…`
 *    and browser-direct consumers have no way to reach it.
 *
 * 2. **Mirror the whole `vendor/libav/` tree into `demo/public/libav/`** so
 *    the local demo's dev server and the Puppeteer test harness can serve
 *    the files at a stable URL.
 *
 * The canonical runtime layout is:
 *
 *   vendor/libav/webcodecs/libav-webcodecs.mjs
 *   vendor/libav/webcodecs/libav-<ver>-webcodecs.wasm.wasm
 *   …
 *   vendor/libav/avbridge/libav-avbridge.mjs
 *   vendor/libav/avbridge/libav-<ver>-avbridge.wasm.wasm
 *   …
 *
 * The libav loader at runtime resolves `<base>/<variant>/libav-<variant>.mjs`
 * relative to its own module URL, so once the package is installed under
 * `node_modules/avbridge/`, these files are automatically found without any
 * consumer configuration.
 *
 * Run as a prebuild step (`npm run build` triggers it via the `prebuild`
 * hook) so the npm tarball always contains fresh webcodecs binaries.
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

// Where the demo/test harness expects them.
const demoLibav = resolve(repoRoot, "demo/public/libav");

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
    `(skipped ${skipped} unused variants: asm.js fallbacks + threaded builds)`,
  );
}

// ── Step 1b: prune any unused files already in vendor/libav/avbridge/ ──────
//
// The custom avbridge variant is built locally via scripts/build-libav.sh
// and lands here. Apply the same whitelist so the tarball doesn't carry
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

// ── Step 2: mirror vendor/libav/ → demo/public/libav/ for the demo ─────────

if (existsSync(demoLibav)) {
  rmSync(demoLibav, { recursive: true, force: true });
}
mkdirSync(demoLibav, { recursive: true });

let demoCount = 0;
for (const name of readdirSync(vendorLibav)) {
  const from = join(vendorLibav, name);
  const to = join(demoLibav, name);
  const st = statSync(from);
  if (st.isDirectory()) {
    cpSync(from, to, { recursive: true });
    demoCount += readdirSync(from).length;
  } else if (st.isFile() && name !== "README.md") {
    cpSync(from, to);
    demoCount += 1;
  }
}
console.log(`[copy-libav] mirrored ${demoCount} file(s) → demo/public/libav/`);
