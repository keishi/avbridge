#!/usr/bin/env node
/**
 * Copy libav.js variant dist files into demo/public/libav/{name}/ so Vite
 * serves them from a stable, predictable URL space:
 *
 *   /libav/webcodecs/libav-webcodecs.mjs       (lightweight, modern formats)
 *   /libav/default/libav-default.mjs           (full-featured: AVI, ASF, …)
 *
 * UBMP uses the smaller webcodecs variant for the common path (probing modern
 * containers, bridging to WebCodecs) and only loads the heavier default
 * variant when a legacy container or codec actually needs it. This keeps the
 * cold start cost low for users who never touch a legacy file.
 *
 * Why a copy step instead of a Vite middleware:
 *   - Vite's `optimizeDeps.exclude` does not actually prevent Vite from
 *     pre-bundling these packages. Their dist .mjs ends up in `.vite/deps/`
 *     and `import.meta.url` no longer points at the real dist directory, so
 *     sibling .wasm files 404.
 *   - `demo/public/libav/<variant>/` is served verbatim by Vite with the
 *     right MIME types and works the same in dev and production builds.
 *
 * Idempotent: copies whenever the source mtime is newer than the destination.
 */
import { mkdirSync, copyFileSync, readdirSync, statSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const demoLibav = resolve(repoRoot, "demo/public/libav");

const variants = [
  { name: "webcodecs", pkg: "@libav.js/variant-webcodecs" },
];

// The custom UBMP variant (with AVI/ASF/FLV demuxers + legacy decoders) is
// not on npm — it's built locally via `scripts/build-libav.sh` and lands in
// `vendor/libav/`. If that directory has files, copy them into the demo's
// public path so Vite can serve them at /libav/ubmp/.
const vendoredVariant = {
  name: "ubmp",
  src: resolve(repoRoot, "vendor/libav"),
};

// Wipe stale files from previous runs (e.g. variants we no longer copy, or
// old top-level files left over from a flat layout). Cheap and avoids
// confusing leftover binaries on disk.
if (existsSync(demoLibav)) {
  rmSync(demoLibav, { recursive: true, force: true });
}
mkdirSync(demoLibav, { recursive: true });

let total = 0;
for (const v of variants) {
  const src = resolve(repoRoot, "node_modules", v.pkg, "dist");
  if (!existsSync(src)) {
    console.warn(
      `[copy-libav] ${v.pkg} not installed — skipping. ` +
        `Install with: npm i ${v.pkg}`,
    );
    continue;
  }
  const dst = resolve(demoLibav, v.name);
  mkdirSync(dst, { recursive: true });
  let copied = 0;
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    if (!statSync(from).isFile()) continue;
    copyFileSync(from, to);
    copied++;
  }
  console.log(`[copy-libav] ${v.name}: ${copied} file(s) → demo/public/libav/${v.name}/`);
  total += copied;
}

// Vendored custom variant — only present after running scripts/build-libav.sh.
if (existsSync(vendoredVariant.src)) {
  const dst = resolve(demoLibav, vendoredVariant.name);
  mkdirSync(dst, { recursive: true });
  let copied = 0;
  for (const name of readdirSync(vendoredVariant.src)) {
    const from = join(vendoredVariant.src, name);
    const to = join(dst, name);
    if (!statSync(from).isFile()) continue;
    if (name === "README.md") continue;
    copyFileSync(from, to);
    copied++;
  }
  if (copied > 0) {
    console.log(
      `[copy-libav] ubmp: ${copied} file(s) → demo/public/libav/ubmp/ (custom build)`,
    );
    total += copied;
  } else {
    console.log(
      `[copy-libav] ubmp: vendor/libav/ exists but is empty — run scripts/build-libav.sh to build`,
    );
  }
} else {
  console.log(
    `[copy-libav] ubmp: not built (run scripts/build-libav.sh for AVI/WMV/legacy support)`,
  );
}

console.log(`[copy-libav] done — ${total} total file(s)`);
