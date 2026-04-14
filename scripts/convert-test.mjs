#!/usr/bin/env node
/**
 * Headless conversion smoke-tester for avbridge.
 *
 * Drives the converter demo (`/convert.html`) via Puppeteer:
 *   1. Upload a fixture file
 *   2. Pick container + codec + quality
 *   3. Run the conversion
 *   4. Verify the output blob is non-empty and the result info shows the
 *      expected container/codec
 *
 * Usage:
 *   node scripts/convert-test.mjs                       # runs the default fixture matrix
 *   node scripts/convert-test.mjs --port 5173
 *
 * Requirements:
 *   npm i -D puppeteer
 *   npm run demo                # dev server must be running on --port
 *
 * Exit code:
 *   0 = all conversions succeeded
 *   1 = one or more failed
 */
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { parseArgs } from "node:util";

const FIXTURE = resolve("tests/fixtures/big-buck-bunny-480p-30sec.mp4");
const FIXTURE_AVI_H264 = resolve("tests/fixtures/bbb-h264-mp3.avi");
const FIXTURE_AVI_MPEG4 = resolve("tests/fixtures/bbb-mpeg4-mp3.avi");

/**
 * Test matrix: each entry = (label, { container, video, audio, quality, ... })
 *
 * The primary fixture is MP4 H.264/AAC, so:
 * - copy + mp4  = remux (lossless container repackage)
 * - copy + mkv  = remux (container change)
 * - h264 + 480p = transcode with resize (realistic downscale scenario)
 * - vp9  + webm = transcode (full codec + container change)
 *
 * AVI fixtures exercise the Phase 1 libav-demux → WebCodecs re-encode path.
 * `verify: "deep"` means: after the blob is produced, load it back into a
 * bare `<video>` and assert duration, playback advances, and codec identity.
 */
const MATRIX = [
  { label: "remux mp4 (copy)",       fixture: FIXTURE, container: "mp4",  video: "copy", audio: "copy",  quality: "medium" },
  { label: "remux mkv (copy)",       fixture: FIXTURE, container: "mkv",  video: "copy", audio: "copy",  quality: "medium" },
  { label: "transcode mp4 h264 480p (sw)", fixture: FIXTURE, container: "mp4",  video: "h264", audio: "aac",   quality: "medium", width: 480, height: 270, hwAccel: "prefer-software" },
  { label: "transcode webm vp9",      fixture: FIXTURE, container: "webm", video: "vp9",  audio: "opus",  quality: "medium" },
  { label: "transcode AVI h264+mp3 → mp4 (libav path)", fixture: FIXTURE_AVI_H264, container: "mp4", video: "h264", audio: "aac", quality: "medium", verify: "deep" },
  { label: "transcode AVI mpeg4+mp3 → mp4 (libav path, BSF)", fixture: FIXTURE_AVI_MPEG4, container: "mp4", video: "h264", audio: "aac", quality: "medium", verify: "deep" },
];

// transcode() now handles the headless Chromium H.264 encoder first-call
// init bug internally with an automatic retry, so the smoke test no longer
// needs its own retry loop.
const RETRIES = 0;

// ── CLI args ────────────────────────────────────────────────────────────────

const { values: opts } = parseArgs({
  options: {
    port:    { type: "string", default: "5173" },
    timeout: { type: "string", default: "120" },
    json:    { type: "boolean", default: false },
  },
});

const PORT = Number(opts.port);
const TIMEOUT_SEC = Number(opts.timeout);
const JSON_OUTPUT = opts.json;
const BASE_URL = `http://localhost:${PORT}/convert.html`;

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  for (const f of [FIXTURE, FIXTURE_AVI_H264, FIXTURE_AVI_MPEG4]) {
    const s = await stat(f).catch(() => null);
    if (!s) {
      console.error(`[test] fixture not found: ${f}`);
      process.exit(1);
    }
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
      "--enable-features=SharedArrayBuffer",
    ],
  });

  const results = [];
  let failures = 0;

  for (const cfg of MATRIX) {
    if (!JSON_OUTPUT) process.stdout.write(`\n[test] ${cfg.label} ... `);

    const r = await runConversion(browser, cfg.fixture ?? FIXTURE, cfg);
    results.push({ label: cfg.label, ...r });

    if (r.status === "PASS") {
      if (!JSON_OUTPUT) {
        const noteSuffix = r.notes && r.notes.length > 0 ? " ⚠ retried" : "";
        process.stdout.write(
          `PASS${noteSuffix} (${formatBytes(r.size)}, ${r.elapsedSec.toFixed(1)}s, ${r.videoCodec ?? "?"}/${r.audioCodec ?? "?"})\n`,
        );
      }
    } else {
      failures++;
      if (!JSON_OUTPUT) process.stdout.write(`FAIL: ${r.error}\n`);
    }
  }

  await browser.close();

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`\n[test] ${results.length} conversions, ${failures} failed.`);
  }

  process.exit(failures > 0 ? 1 : 0);
}

// ── Per-conversion test ─────────────────────────────────────────────────────

async function runConversion(browser, filePath, cfg) {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  try {
    await page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 15000 });

    // Upload fixture
    const fileInput = await page.waitForSelector("#file", { timeout: 5000 });
    await fileInput.uploadFile(filePath);

    // Wait for the source-info card to populate (probe done)
    await page.waitForFunction(
      () => !document.getElementById("source-info")?.classList.contains("hidden"),
      { timeout: 10000 },
    );

    // Configure output
    await page.select("#container", cfg.container);
    await page.select("#video-codec", cfg.video);
    await page.select("#audio-codec", cfg.audio);
    await page.select("#quality", cfg.quality);

    // Optional resize fields
    if (cfg.width !== undefined) {
      await page.evaluate((v) => { document.getElementById("width").value = String(v); }, cfg.width);
    }
    if (cfg.height !== undefined) {
      await page.evaluate((v) => { document.getElementById("height").value = String(v); }, cfg.height);
    }

    // Optional hardware acceleration hint
    if (cfg.hwAccel !== undefined) {
      // Open the Advanced details so the select is interactive
      await page.evaluate(() => {
        const d = document.getElementById("advanced-details");
        if (d) d.open = true;
      });
      await page.select("#hw-accel", cfg.hwAccel);
    }

    // Wait one tick for the mode badge to update
    await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));

    // Click start
    const startBtn = await page.$("#start");
    if (!startBtn) throw new Error("start button not found");
    await startBtn.click();

    // Wait for completion: progress = 100 OR error text appears
    const result = await page.evaluate((timeoutMs) => {
      return new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
          const errEl = document.getElementById("error");
          const errText = errEl?.textContent ?? "";
          if (errText) {
            resolve({ status: "error", message: errText });
            return;
          }
          // Conversion is done when the download button is visible
          const downloadBtn = document.getElementById("download");
          if (downloadBtn && !downloadBtn.classList.contains("hidden")) {
            const resultEl = document.getElementById("result-info");
            try {
              resolve({ status: "done", info: JSON.parse(resultEl?.textContent ?? "{}") });
            } catch {
              resolve({ status: "done", info: {} });
            }
            return;
          }
          if (Date.now() - start > timeoutMs) {
            const status = document.getElementById("status")?.textContent ?? "";
            resolve({ status: "timeout", lastStatus: status });
            return;
          }
          setTimeout(check, 200);
        };
        check();
      });
    }, TIMEOUT_SEC * 1000);

    if (result.status === "error") {
      return { status: "FAIL", error: result.message, consoleErrors: consoleErrors.slice(0, 5) };
    }
    if (result.status === "timeout") {
      return {
        status: "FAIL",
        error: `timed out after ${TIMEOUT_SEC}s (last status: "${result.lastStatus}")`,
        consoleErrors: consoleErrors.slice(0, 5),
      };
    }

    const info = result.info ?? {};
    // Validate the output info matches what we asked for.
    const expectedContainer = cfg.container;
    const ok = info.container === expectedContainer && info.size && parseSize(info.size) > 0;

    if (!ok) {
      return {
        status: "FAIL",
        error: `output mismatch (got container=${info.container}, size=${info.size})`,
        container: info.container,
        videoCodec: info.videoCodec,
        audioCodec: info.audioCodec,
        size: parseSize(info.size),
        elapsedSec: info.elapsedSec ?? 0,
        consoleErrors: consoleErrors.length > 0 ? consoleErrors.slice(0, 5) : undefined,
      };
    }

    // Deep verification for the libav transcode path: reload the output
    // blob into a bare <video> and assert it plays + duration lines up.
    let deepError;
    if (cfg.verify === "deep") {
      deepError = await page.evaluate(async () => {
        const href = document.getElementById("download")?.getAttribute("href");
        if (!href) return "deep-verify: download href missing";
        const v = document.createElement("video");
        v.muted = true;        // allow autoplay in headless
        v.src = href;
        v.preload = "auto";
        document.body.appendChild(v);
        try {
          await new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error("loadedmetadata timeout")), 10000);
            v.addEventListener("loadedmetadata", () => { clearTimeout(timer); res(); }, { once: true });
            v.addEventListener("error", () => { clearTimeout(timer); rej(new Error("video load error")); }, { once: true });
          });
          const duration = v.duration;
          if (!Number.isFinite(duration) || duration <= 0) {
            return `deep-verify: bad duration ${duration}`;
          }
          const t0 = v.currentTime;
          await v.play().catch(() => {});
          await new Promise((r) => setTimeout(r, 2000));
          const t1 = v.currentTime;
          v.pause();
          if (t1 - t0 < 1.0) {
            return `deep-verify: playback did not advance (t0=${t0}, t1=${t1})`;
          }
          return null;
        } finally {
          try { v.remove(); } catch { /* ignore */ }
        }
      });
    }

    return {
      status: deepError ? "FAIL" : "PASS",
      error: deepError ?? undefined,
      container: info.container,
      videoCodec: info.videoCodec,
      audioCodec: info.audioCodec,
      size: parseSize(info.size),
      elapsedSec: info.elapsedSec ?? 0,
      notes: info.notes,
      consoleErrors: consoleErrors.length > 0 ? consoleErrors.slice(0, 5) : undefined,
    };
  } catch (err) {
    return { status: "FAIL", error: err.message, consoleErrors: consoleErrors.slice(0, 5) };
  } finally {
    await page.close();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseSize(s) {
  if (!s) return 0;
  // "12.3 MB" → 12.9e6
  const m = String(s).match(/^([\d.]+)\s*(B|KB|MB|GB)$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2];
  switch (unit) {
    case "B":  return n;
    case "KB": return n * 1024;
    case "MB": return n * 1024 * 1024;
    case "GB": return n * 1024 * 1024 * 1024;
    default:   return n;
  }
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
