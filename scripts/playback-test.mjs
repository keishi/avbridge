#!/usr/bin/env node
/**
 * Headless playback smoke-tester for UBMP.
 *
 * Launches a headless Chromium via Puppeteer, opens the UBMP demo, feeds
 * each file from the command line (or a directory glob), plays for N seconds,
 * and reports probe/classification/strategy/runtime diagnostics + pass/fail.
 *
 * Usage:
 *   node scripts/playback-test.mjs file1.avi file2.mkv ...
 *   node scripts/playback-test.mjs /path/to/media/dir
 *   node scripts/playback-test.mjs --duration 5 --port 5173 file.avi
 *
 * Options:
 *   --duration <sec>    How long to play each file (default: 10)
 *   --port <port>       Dev server port (default: 5173)
 *   --timeout <sec>     Max wait for probe+classify+first-frame (default: 30)
 *   --json              Output results as JSON (default: table)
 *   --keep-browser      Don't close the browser after all tests (for debugging)
 *
 * Requirements:
 *   npm i -D puppeteer    (or have Chrome/Chromium on PATH)
 *   npm run demo          (dev server must be running on --port)
 *
 * The script does NOT start the dev server — run `npm run demo` in another
 * terminal first. This keeps the script simple and lets you see server logs.
 *
 * Exit code:
 *   0 = all files played successfully
 *   1 = one or more files failed
 */
import { readdir, stat } from "node:fs/promises";
import { resolve, extname, basename } from "node:path";
import { parseArgs } from "node:util";

const MEDIA_EXTENSIONS = new Set([
  ".avi", ".mkv", ".mp4", ".mov", ".wmv", ".flv", ".webm",
  ".ogv", ".mpg", ".mpeg", ".m4v", ".3gp", ".ts",
  ".mp3", ".aac", ".ogg", ".flac", ".wav", ".wma", ".m4a",
]);

// ── CLI args ─────────────────────────────────────────────────────────────────

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    duration:      { type: "string", default: "10" },
    port:          { type: "string", default: "5173" },
    timeout:       { type: "string", default: "30" },
    json:          { type: "boolean", default: false },
    "keep-browser": { type: "boolean", default: false },
  },
});

const PLAY_DURATION_SEC = Number(opts.duration);
const PORT = Number(opts.port);
const TIMEOUT_SEC = Number(opts.timeout);
const JSON_OUTPUT = opts.json;
const KEEP_BROWSER = opts["keep-browser"];
const BASE_URL = `http://localhost:${PORT}`;

// ── Resolve input files ──────────────────────────────────────────────────────

async function resolveFiles(paths) {
  const files = [];
  for (const p of paths) {
    const abs = resolve(p);
    const s = await stat(abs).catch(() => null);
    if (!s) {
      console.error(`[test] skipping ${p}: not found`);
      continue;
    }
    if (s.isDirectory()) {
      const entries = await readdir(abs);
      for (const e of entries) {
        if (MEDIA_EXTENSIONS.has(extname(e).toLowerCase())) {
          files.push(resolve(abs, e));
        }
      }
    } else if (s.isFile()) {
      files.push(abs);
    }
  }
  return files;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const files = await resolveFiles(positionals);
  if (files.length === 0) {
    console.error("Usage: node scripts/playback-test.mjs <file|dir> ...");
    console.error("  Run `npm run demo` in another terminal first.");
    process.exit(1);
  }

  let puppeteer;
  try {
    puppeteer = await import("puppeteer");
  } catch {
    console.error("[test] puppeteer is required. Install with: npm i -D puppeteer");
    process.exit(1);
  }

  const browser = await puppeteer.default.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--autoplay-policy=no-user-gesture-required",
      // Required for crossOriginIsolated (SharedArrayBuffer)
      "--enable-features=SharedArrayBuffer",
    ],
  });

  const results = [];
  let failures = 0;

  for (const file of files) {
    const name = basename(file);
    if (!JSON_OUTPUT) process.stdout.write(`\n[test] ${name} ... `);

    const result = await testFile(browser, file);
    results.push(result);

    if (result.status === "PASS") {
      if (!JSON_OUTPUT) process.stdout.write(`PASS (${result.strategy}, ${result.framesPainted}/${result.framesDecoded} frames, ${result.playedSec.toFixed(1)}s)\n`);
    } else {
      failures++;
      if (!JSON_OUTPUT) process.stdout.write(`FAIL: ${result.error}\n`);
    }
  }

  if (!KEEP_BROWSER) await browser.close();

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`\n[test] ${results.length} files tested, ${failures} failed.`);
  }

  process.exit(failures > 0 ? 1 : 0);
}

// ── Per-file test ────────────────────────────────────────────────────────────

async function testFile(browser, filePath) {
  const name = basename(filePath);
  const page = await browser.newPage();

  // Collect console errors from the page
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  try {
    await page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 15000 });

    // Upload the file via the file input
    const fileInput = await page.waitForSelector("#file", { timeout: 5000 });
    await fileInput.uploadFile(filePath);

    // Wait for either the strategy badge to show a strategy name or an error
    const readyOrError = await page.evaluate((timeoutMs) => {
      return new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
          const badge = document.getElementById("badge");
          const error = document.getElementById("error");
          const text = badge?.textContent ?? "";
          const errText = error?.textContent ?? "";

          if (errText) {
            resolve({ status: "error", message: errText });
            return;
          }
          if (["native", "remux", "fallback"].some((s) => text.includes(s)) && !text.includes("buffering")) {
            resolve({ status: "ready", strategy: text.trim() });
            return;
          }
          if (Date.now() - start > timeoutMs) {
            resolve({ status: "timeout", badge: text });
            return;
          }
          setTimeout(check, 200);
        };
        check();
      });
    }, TIMEOUT_SEC * 1000);

    if (readyOrError.status === "error") {
      return { file: name, status: "FAIL", error: readyOrError.message };
    }
    if (readyOrError.status === "timeout") {
      return { file: name, status: "FAIL", error: `timed out after ${TIMEOUT_SEC}s (badge: "${readyOrError.badge}")` };
    }

    // Let it play for the configured duration
    await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), PLAY_DURATION_SEC * 1000);

    // Grab diagnostics
    const diag = await page.evaluate(() => {
      const pre = document.getElementById("diagnostics");
      try { return JSON.parse(pre?.textContent ?? "{}"); } catch { return {}; }
    });

    const rt = diag.runtime ?? {};
    const framesDecoded = rt.videoFramesDecoded ?? 0;
    const framesPainted = rt.framesPainted ?? 0;
    const droppedLate = rt.framesDroppedLate ?? 0;
    const droppedOverflow = rt.framesDroppedOverflow ?? 0;
    const paintRate = framesDecoded > 0 ? framesPainted / framesDecoded : 0;

    // Get current time from the time label
    const timeText = await page.evaluate(() =>
      document.getElementById("time")?.textContent ?? "0:00 / 0:00"
    );
    const playedSec = parseTimeLabel(timeText);

    // Determine pass/fail
    const hasFrames = framesPainted > 0 || diag.strategy === "native";
    const hasAudio = (rt.framesScheduled ?? 0) > 0 || diag.strategy === "native";
    const pass = hasFrames && playedSec > 1;

    return {
      file: name,
      status: pass ? "PASS" : "FAIL",
      error: pass ? undefined : `no frames painted (decoded=${framesDecoded}, painted=${framesPainted})`,
      strategy: diag.strategy,
      container: diag.container,
      videoCodec: diag.videoCodec,
      audioCodec: diag.audioCodec,
      width: diag.width,
      height: diag.height,
      duration: diag.duration,
      playedSec,
      framesDecoded,
      framesPainted,
      paintRate: Math.round(paintRate * 100),
      droppedLate,
      droppedOverflow,
      audioScheduled: rt.framesScheduled ?? 0,
      consoleErrors: consoleErrors.length > 0 ? consoleErrors.slice(0, 5) : undefined,
    };
  } catch (err) {
    return { file: name, status: "FAIL", error: err.message };
  } finally {
    await page.close();
  }
}

function parseTimeLabel(text) {
  // "1:23 / 58:56" → 83
  const match = text.match(/^(\d+):(\d+)/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
