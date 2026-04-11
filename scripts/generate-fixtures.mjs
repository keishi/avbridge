#!/usr/bin/env node
/**
 * Regenerate the avbridge fixture corpus from the canonical Big Buck Bunny
 * MP4 source. Each fixture targets a specific playback strategy in the
 * avbridge pipeline.
 *
 * Usage:
 *   node scripts/generate-fixtures.mjs              # generate missing fixtures
 *   node scripts/generate-fixtures.mjs --force      # regenerate all
 *
 * Requirements:
 *   ffmpeg on PATH (brew install ffmpeg / apt install ffmpeg / etc.)
 *
 * The source file (`tests/fixtures/big-buck-bunny-480p-30sec.mp4`) is the
 * sole input. Everything else is derived from it for reproducibility.
 *
 * Generated files cover one fixture per playback strategy:
 *
 *   bbb-h264-aac.mkv     → remux strategy   (modern codecs in non-native container)
 *   bbb-h264-mp3.avi     → hybrid strategy  (AVI demux + WebCodecs decode)
 *   bbb-mpeg4-mp3.avi    → fallback strategy (legacy codec, no browser decoder)
 *   bbb-truncated.mp4    → failure path     (file cut off mid-stream)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { stat, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

const exec = promisify(execFile);

const FIXTURE_DIR = resolve("tests/fixtures");
const SOURCE = resolve(FIXTURE_DIR, "big-buck-bunny-480p-30sec.mp4");

const { values: opts } = parseArgs({
  options: {
    force: { type: "boolean", default: false },
  },
});

const FIXTURES = [
  {
    name: "bbb-h264-aac.mkv",
    description: "MKV with H.264 + AAC — exercises the remux strategy (modern codecs, non-native container)",
    args: [
      "-i", SOURCE,
      "-c", "copy",            // lossless copy of both streams
      "-map", "0",
    ],
  },
  {
    name: "bbb-h264-mp3.avi",
    description: "AVI with H.264 + MP3 — exercises the hybrid strategy (libav demux + WebCodecs decode)",
    args: [
      "-i", SOURCE,
      "-c:v", "copy",          // keep the H.264 video as-is
      "-c:a", "libmp3lame",    // re-encode audio to MP3
      "-b:a", "128k",
      "-ac", "2",              // downmix to stereo
      "-map", "0",
    ],
  },
  {
    name: "bbb-mpeg4-mp3.avi",
    description: "AVI with MPEG-4 Part 2 (DivX) + MP3 — exercises the fallback strategy (legacy codec, WASM decode)",
    args: [
      "-i", SOURCE,
      "-c:v", "mpeg4",         // re-encode video to MPEG-4 Part 2 / DivX
      "-vtag", "DX50",         // FourCC for DivX 5
      "-q:v", "5",             // mid-quality
      "-c:a", "libmp3lame",
      "-b:a", "128k",
      "-ac", "2",
      "-map", "0",
    ],
  },
  {
    name: "bbb-h264-aac.ts",
    description: "MPEG-TS with H.264 + AAC — exercises the remux strategy (mediabunny demuxes TS, browsers can't play <video src='*.ts'> natively)",
    args: [
      "-i", SOURCE,
      "-c:v", "copy",          // keep H.264
      "-c:a", "copy",          // keep AAC
      "-bsf:v", "h264_mp4toannexb", // convert AVCC → Annex B for TS muxer
      "-f", "mpegts",
      "-map", "0",
    ],
  },
  {
    // Lives in `failures/` so the playback smoke test (which auto-discovers
    // files in `tests/fixtures/`) doesn't try to play it as a happy path.
    name: "failures/bbb-truncated.mp4",
    description: "Truncated MP4 (first 80% of bytes only) — exercises error handling on incomplete files",
    truncate: true,
  },
];

async function main() {
  if (!existsSync(SOURCE)) {
    console.error(`[fixtures] source file not found: ${SOURCE}`);
    console.error("[fixtures] Place the canonical Big Buck Bunny 480p 30sec MP4 there first.");
    process.exit(1);
  }

  // Verify ffmpeg is available
  try {
    await exec("ffmpeg", ["-version"]);
  } catch {
    console.error("[fixtures] ffmpeg not found on PATH. Install with `brew install ffmpeg` or equivalent.");
    process.exit(1);
  }

  await mkdir(FIXTURE_DIR, { recursive: true });

  const summary = [];

  for (const fx of FIXTURES) {
    const out = resolve(FIXTURE_DIR, fx.name);
    const exists = existsSync(out);

    if (exists && !opts.force) {
      const s = await stat(out);
      console.log(`[fixtures] ${fx.name} already exists (${formatBytes(s.size)}), skipping. Use --force to regenerate.`);
      summary.push({ name: fx.name, status: "skipped", bytes: s.size });
      continue;
    }

    console.log(`[fixtures] generating ${fx.name} ...`);
    try {
      // Make sure any nested directory exists.
      await mkdir(resolve(out, ".."), { recursive: true });
      if (fx.truncate) {
        await truncateFile(SOURCE, out, 0.8);
      } else {
        await exec("ffmpeg", ["-y", "-loglevel", "error", ...fx.args, out]);
      }
      const s = await stat(out);
      console.log(`[fixtures]   ✓ ${fx.name} (${formatBytes(s.size)})`);
      summary.push({ name: fx.name, status: "generated", bytes: s.size });
    } catch (err) {
      console.error(`[fixtures]   ✗ ${fx.name} failed: ${err.message}`);
      summary.push({ name: fx.name, status: "failed", error: err.message });
    }
  }

  console.log("\n[fixtures] summary:");
  for (const s of summary) {
    const tag = s.status === "generated" ? "+" : s.status === "skipped" ? "·" : "!";
    console.log(`  ${tag} ${s.name.padEnd(28)} ${s.status === "failed" ? s.error : formatBytes(s.bytes ?? 0)}`);
  }
}

/** Write the first `fraction` of bytes from `src` into `dst`. */
async function truncateFile(src, dst, fraction) {
  const data = await readFile(src);
  const cut = Math.floor(data.byteLength * fraction);
  await writeFile(dst, data.subarray(0, cut));
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
