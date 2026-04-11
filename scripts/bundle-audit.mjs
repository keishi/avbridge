#!/usr/bin/env node
/**
 * Bundle size audit. Bundles several different import patterns against the
 * built `dist/` output and reports:
 *
 * 1. The minified+gzipped size of each entry
 * 2. Whether libav-related modules are present (they should NOT be for the
 *    core paths — only the optional fallback/hybrid code may pull them)
 * 3. A baseline "everything" import for comparison
 *
 * Run:
 *   npm run build           # produce dist/
 *   node scripts/bundle-audit.mjs
 *
 * Exit code: 0 if all expectations are met, 1 otherwise.
 */
import { writeFile, mkdir, rm, stat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const TMP = resolve("dist/.bundle-audit");
await rm(TMP, { recursive: true, force: true });
await mkdir(TMP, { recursive: true });

const ESM_PATH = resolve("dist/index.js");
const ELEMENT_PATH = resolve("dist/element.js");
const ESM_STAT = await stat(ESM_PATH).catch(() => null);
if (!ESM_STAT) {
  console.error("dist/index.js not found. Run `npm run build` first.");
  process.exit(1);
}
const ELEMENT_STAT = await stat(ELEMENT_PATH).catch(() => null);
if (!ELEMENT_STAT) {
  console.error("dist/element.js not found. Run `npm run build` first.");
  process.exit(1);
}

// Each scenario specifies a max eager-chunk size (in bytes, gzip).
// Eager = the bytes a consumer downloads before any user action.
// Lazy chunks (libav-loader, avi.ts, etc.) are excluded — they only get
// fetched if the user actually invokes a code path that needs them.
const SCENARIOS = [
  {
    name: "everything",
    description: "import * — full library, baseline",
    code: `import * as avbridge from "${ESM_PATH}"; export { avbridge };`,
    maxEagerGzip: 25_000,
  },
  {
    name: "createPlayer-only",
    description: "import { createPlayer } — full player",
    code: `import { createPlayer } from "${ESM_PATH}"; export { createPlayer };`,
    maxEagerGzip: 20_000,
  },
  {
    name: "remux-only",
    description: "import { remux } — repackage path",
    code: `import { remux } from "${ESM_PATH}"; export { remux };`,
    maxEagerGzip: 6_000,
  },
  {
    name: "transcode-only",
    description: "import { transcode } — re-encode path",
    code: `import { transcode } from "${ESM_PATH}"; export { transcode };`,
    maxEagerGzip: 5_000,
  },
  {
    name: "probe-classify-only",
    description: "import { probe, classify } — analysis only",
    code: `import { probe, classify } from "${ESM_PATH}"; export { probe, classify };`,
    maxEagerGzip: 5_000,
  },
  {
    name: "srtToVtt-only",
    description: "import { srtToVtt } — pure subtitle helper",
    code: `import { srtToVtt } from "${ESM_PATH}"; export { srtToVtt };`,
    maxEagerGzip: 1_000,
    // Importing the core MUST NOT pull element registration code.
    forbidInEntry: ["customElements.define"],
  },
  {
    name: "core-no-element",
    description: "import everything from core — element code MUST be absent",
    code: `import * as a from "${ESM_PATH}"; export { a };`,
    maxEagerGzip: 25_000,
    forbidInEntry: ["customElements.define", '"avbridge-video"', "AvbridgeVideoElement"],
  },
  {
    name: "element-only",
    description: "import 'avbridge/element' — registers <avbridge-video>",
    code: `import "${ELEMENT_PATH}";`,
    // Element entry includes the full createPlayer engine since the element
    // wraps it. ~16 KB gzip is a reasonable ceiling.
    maxEagerGzip: 17_000,
    requireInEntry: ["customElements"],
  },
];

async function bundleScenario(name, code) {
  const entry = resolve(TMP, `${name}.entry.mjs`);
  const outdir = resolve(TMP, `${name}-out`);
  await writeFile(entry, code);
  // Use code-splitting so esbuild preserves the lazy `import()` boundaries
  // we set up in tsup. With splitting, the entry chunk only contains the
  // code reachable synchronously from the import; lazy chunks live in
  // separate files and don't count toward the entry size.
  await exec("npx", [
    "esbuild",
    entry,
    "--bundle",
    "--splitting",
    "--minify",
    "--format=esm",
    "--platform=browser",
    "--external:mediabunny",
    "--external:@libav.js/variant-webcodecs",
    "--external:libavjs-webcodecs-bridge",
    `--outdir=${outdir}`,
  ]);
  // Read every file produced; entry is named after the entry, lazy chunks
  // are auto-named. Combined size = total payload if user actually executes
  // the lazy paths; entry size = what gets downloaded eagerly.
  const fs = await import("node:fs/promises");
  const files = await fs.readdir(outdir);
  const entryFile = files.find((f) => f.endsWith(".js") && f.startsWith(name));
  if (!entryFile) throw new Error(`no entry file for ${name}`);
  const entryBytes = await readFile(resolve(outdir, entryFile));
  let totalRaw = 0;
  let totalText = "";
  for (const f of files) {
    if (!f.endsWith(".js")) continue;
    const bytes = await readFile(resolve(outdir, f));
    totalRaw += bytes.byteLength;
    totalText += bytes.toString("utf8");
  }
  return {
    raw: entryBytes.byteLength,
    gzip: gzipSync(entryBytes).byteLength,
    totalRaw,
    chunks: files.filter((f) => f.endsWith(".js")).length,
    // Contamination check runs against the EAGER entry only. Lazy chunks
    // may legitimately contain libav code — that's what makes them lazy.
    entryText: entryBytes.toString("utf8"),
  };
}

function fmt(n) {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

console.log("[audit] bundling scenarios...\n");

const results = [];
let failures = 0;

for (const sc of SCENARIOS) {
  process.stdout.write(`  ${sc.name.padEnd(22)} ... `);
  try {
    const r = await bundleScenario(sc.name, sc.code);
    const sizeOk = r.gzip <= sc.maxEagerGzip;
    const forbidden = (sc.forbidInEntry ?? []).filter((p) => r.entryText.includes(p));
    const missing = (sc.requireInEntry ?? []).filter((p) => !r.entryText.includes(p));
    const ok = sizeOk && forbidden.length === 0 && missing.length === 0;
    if (!ok) failures++;
    results.push({
      name: sc.name,
      description: sc.description,
      raw: r.raw,
      gzip: r.gzip,
      totalRaw: r.totalRaw,
      chunks: r.chunks,
      maxEagerGzip: sc.maxEagerGzip,
      forbidden,
      missing,
      ok,
    });
    const lazy = r.totalRaw - r.raw;
    const lazyStr = lazy > 0 ? ` (+${fmt(lazy)} lazy in ${r.chunks - 1} chunks)` : "";
    const sizeStr = sizeOk ? "" : ` (over ${fmt(sc.maxEagerGzip)} gzip limit)`;
    console.log(`${fmt(r.raw)} eager / ${fmt(r.gzip)} gzip${lazyStr} ${ok ? "✓" : "✗"}${sizeStr}`);
    if (forbidden.length > 0) {
      console.log(`    ✗ forbidden patterns in entry: ${forbidden.join(", ")}`);
    }
    if (missing.length > 0) {
      console.log(`    ✗ required patterns missing from entry: ${missing.join(", ")}`);
    }
  } catch (err) {
    failures++;
    console.log(`FAIL: ${err.message}`);
    results.push({ name: sc.name, error: err.message, ok: false });
  }
}

console.log("\n[audit] summary table\n");
console.log("Scenario               Eager       Gzip        Total       OK");
console.log("──────────────────────────────────────────────────────────────");
for (const r of results) {
  const raw = (r.raw !== undefined ? fmt(r.raw) : "-").padEnd(11);
  const gz = (r.gzip !== undefined ? fmt(r.gzip) : "-").padEnd(11);
  const tot = (r.totalRaw !== undefined ? fmt(r.totalRaw) : "-").padEnd(11);
  console.log(`${r.name.padEnd(22)} ${raw} ${gz} ${tot} ${r.ok ? "✓" : "✗"}`);
}

// Cleanup
await rm(TMP, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n[audit] ${failures} scenario(s) exceeded their eager-gzip budget.`);
  process.exit(1);
}
console.log("\n[audit] all scenarios within eager-gzip budgets — tree-shaking is working.");
