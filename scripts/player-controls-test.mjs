#!/usr/bin/env node
/**
 * Controls contract tests for `<avbridge-player>` against hybrid/fallback
 * strategies.
 *
 * These catch the class of bug where a strategy hides the inner <video>
 * and drives playback from Web Audio — making standard HTMLMediaElement
 * events (play/pause/volumechange) silently fail unless the strategy
 * explicitly dispatches them. The <avbridge-player> controls UI listens
 * to those events, so the contract must be preserved.
 *
 * Drives `demo/player-test.html` via Puppeteer.
 *
 * Run:
 *   npm run demo                      # in another terminal
 *   node scripts/player-controls-test.mjs
 */
import puppeteer from "puppeteer";
import { parseArgs } from "node:util";
import { resolve as pathResolve } from "node:path";

const { values: opts } = parseArgs({
  options: {
    port: { type: "string", default: "5173" },
    timeout: { type: "string", default: "30" },
  },
});

const PORT = Number(opts.port);
const TIMEOUT_SEC = Number(opts.timeout);
const BASE_URL = `http://localhost:${PORT}/player-test.html`;

// Fixtures — chosen to exercise hybrid and fallback strategies specifically
const HYBRID_FIXTURE = `/@fs${pathResolve("tests/fixtures/bbb-h264-mp3.avi")}`;
const FALLBACK_FIXTURE = `/@fs${pathResolve("tests/fixtures/bbb-mpeg4-mp3.avi")}`;

// ── Test runner ─────────────────────────────────────────────────────────

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function assert(cond, msg) { if (!cond) throw new Error(`ASSERT: ${msg}`); }
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`ASSERT: ${msg} (expected ${expected}, got ${actual})`);
}

async function runTests() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--autoplay-policy=no-user-gesture-required",
      "--enable-features=SharedArrayBuffer",
    ],
  });
  let passed = 0, failed = 0;
  for (const t of tests) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    try {
      await page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 15000 });
      await page.evaluate(() => window.playerHarness.reset());
      await t.fn(page);
      if (errors.length > 0) {
        throw new Error(`page errors: ${errors.slice(0, 3).join("; ")}`);
      }
      process.stdout.write(`  ✓ ${t.name}\n`);
      passed++;
    } catch (err) {
      process.stdout.write(`  ✗ ${t.name}\n    ${err.message}\n`);
      failed++;
    } finally {
      await page.close();
    }
  }
  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

// Wait for a predicate on the harness to become true
async function waitForHarness(page, fnBody, timeoutMs = 10_000) {
  await page.waitForFunction(fnBody, { timeout: timeoutMs });
}

// ── Tests ───────────────────────────────────────────────────────────────

test("hybrid: play button reflects playing state after play()", async (page) => {
  await page.evaluate((url) => window.playerHarness.setSourceFromUrl(url), HYBRID_FIXTURE);
  // Wait for the strategy to be decided as hybrid
  await waitForHarness(page, () => window.playerHarness.state().strategy === "hybrid");

  const before = await page.evaluate(() => window.playerHarness.uiState());
  assertEq(before.playButtonIsPlaying, false, "play button should show PLAY icon initially");

  await page.evaluate(() => window.playerHarness.play());
  // Give the play event time to propagate through the state machine
  await waitForHarness(page, () => window.playerHarness.uiState().playButtonIsPlaying === true);
  const after = await page.evaluate(() => window.playerHarness.uiState());
  assertEq(after.playButtonIsPlaying, true, "play button should show PAUSE icon after play()");
});

test("hybrid: pause button reverts icon on pause()", async (page) => {
  await page.evaluate((url) => window.playerHarness.setSourceFromUrl(url), HYBRID_FIXTURE);
  await waitForHarness(page, () => window.playerHarness.state().strategy === "hybrid");
  await page.evaluate(() => window.playerHarness.play());
  await waitForHarness(page, () => window.playerHarness.uiState().playButtonIsPlaying === true);

  await page.evaluate(() => window.playerHarness.pause());
  await waitForHarness(page, () => window.playerHarness.uiState().playButtonIsPlaying === false);
  const after = await page.evaluate(() => window.playerHarness.uiState());
  assertEq(after.playButtonIsPlaying, false, "play button should show PLAY icon after pause()");
});

test("hybrid: volume setter updates UI and paused state reflects audio", async (page) => {
  await page.evaluate((url) => window.playerHarness.setSourceFromUrl(url), HYBRID_FIXTURE);
  await waitForHarness(page, () => window.playerHarness.state().strategy === "hybrid");

  await page.evaluate(() => window.playerHarness.setVolume(0.4));
  await waitForHarness(page, () => Math.abs(window.playerHarness.state().volume - 0.4) < 0.01);
  const state = await page.evaluate(() => ({
    state: window.playerHarness.state(),
    ui: window.playerHarness.uiState(),
  }));
  assert(Math.abs(state.state.volume - 0.4) < 0.01, `volume should be 0.4 (got ${state.state.volume})`);
  assert(Math.abs(state.ui.volumeSliderValue - 0.4) < 0.01, `slider should reflect 0.4 (got ${state.ui.volumeSliderValue})`);
});

test("hybrid: muted setter shows mute icon and reflects in element state", async (page) => {
  await page.evaluate((url) => window.playerHarness.setSourceFromUrl(url), HYBRID_FIXTURE);
  await waitForHarness(page, () => window.playerHarness.state().strategy === "hybrid");

  await page.evaluate(() => window.playerHarness.setMuted(true));
  await waitForHarness(page, () => window.playerHarness.uiState().volumeButtonMuted === true);
  const state = await page.evaluate(() => window.playerHarness.state());
  assertEq(state.muted, true, "muted state should reflect on element");
});

test("hybrid: paused getter starts true, becomes false after play", async (page) => {
  await page.evaluate((url) => window.playerHarness.setSourceFromUrl(url), HYBRID_FIXTURE);
  await waitForHarness(page, () => window.playerHarness.state().strategy === "hybrid");

  const initial = await page.evaluate(() => window.playerHarness.state().paused);
  assertEq(initial, true, "should start paused");

  await page.evaluate(() => window.playerHarness.play());
  await waitForHarness(page, () => window.playerHarness.state().paused === false);
});

test("fallback: play button reflects playing state", async (page) => {
  await page.evaluate((url) => window.playerHarness.setSourceFromUrl(url), FALLBACK_FIXTURE);
  await waitForHarness(page, () => window.playerHarness.state().strategy === "fallback");

  await page.evaluate(() => window.playerHarness.play());
  await waitForHarness(page, () => window.playerHarness.uiState().playButtonIsPlaying === true);
});

test("fallback: volume and muted setters propagate through audio output", async (page) => {
  await page.evaluate((url) => window.playerHarness.setSourceFromUrl(url), FALLBACK_FIXTURE);
  await waitForHarness(page, () => window.playerHarness.state().strategy === "fallback");

  await page.evaluate(() => window.playerHarness.setMuted(true));
  await waitForHarness(page, () => window.playerHarness.uiState().volumeButtonMuted === true);

  await page.evaluate(() => window.playerHarness.setVolume(0.25));
  await waitForHarness(page, () => Math.abs(window.playerHarness.state().volume - 0.25) < 0.01);
});

test("hybrid: clicking shadow DOM play button toggles playback", async (page) => {
  await page.evaluate((url) => window.playerHarness.setSourceFromUrl(url), HYBRID_FIXTURE);
  await waitForHarness(page, () => window.playerHarness.state().strategy === "hybrid");

  await page.evaluate(() => window.playerHarness.clickControl(".avp-play"));
  await waitForHarness(page, () => window.playerHarness.state().paused === false);

  await page.evaluate(() => window.playerHarness.clickControl(".avp-play"));
  await waitForHarness(page, () => window.playerHarness.state().paused === true);
});

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
