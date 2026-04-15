/**
 * Cross-browser runtime-playback validation.
 *
 * For each (fixture, browser): mount a fresh `<avbridge-player>`, load
 * the fixture, play for ~2 seconds, then assert that:
 *   1. Playback actually advanced (currentTime moved OR frames painted
 *      to the canvas — covers both audio-clocked native/remux paths and
 *      canvas-rendered hybrid/fallback paths).
 *   2. The runtime strategy matches the per-browser expectation. This
 *      catches the runtime escalation story that fixtures.spec.ts can't
 *      see — e.g. Firefox escalating HEVC MKV from remux → fallback.
 *
 * Pairs with fixtures.spec.ts (deterministic decision) and the planned
 * contract.spec.ts (HTMLMediaElement parity).
 */
import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { FIXTURE_EXPECTATIONS, type BrowserName } from "./_expectations.js";

const FIXTURES_DIR = resolve("tests/fixtures");

// Generous — software decode of mpeg4 in WASM is slow on a cold WebKit
// run, and libav variant load + bootstrap can take several seconds.
test.setTimeout(45_000);

test.beforeEach(async ({ page }) => {
  await page.goto("/tests-harness.html");
  await page.waitForFunction(() => (window as unknown as { __avbridgeReady?: boolean }).__avbridgeReady === true);
});

for (const expectation of FIXTURE_EXPECTATIONS) {
  test(`${expectation.fixture} — playback`, async ({ page, browserName }, testInfo) => {
    const browser = browserName as BrowserName;
    const skipReason = expectation.skipPlayback?.[browser];
    test.skip(skipReason !== undefined, skipReason ?? "");

    // Runtime expectation: explicit playbackStrategy if set, otherwise
    // the same as the classify-time strategy.
    const expectedRuntime =
      expectation.playbackStrategy?.[browser] ?? expectation.strategy[browser];
    test.skip(
      expectedRuntime === undefined,
      `no expectation declared for ${browser} × ${expectation.fixture}`,
    );

    const fixturePath = resolve(FIXTURES_DIR, expectation.fixture);
    const fixtureUrl = `/@fs${fixturePath}`;
    const playMs = expectation.playMs?.[browser];

    const result = await page.evaluate(async ({ url, playMs }) => {
      const api = (window as unknown as {
        avbridge: {
          loadAndPlay: (url: string, opts?: { playMs?: number }) => Promise<{
            strategy: string | null;
            timeAdvanced: number;
            framesPainted: number;
            durationSec: number | null;
            playError: string | null;
            fallbackReason: string | null;
          }>;
        };
      }).avbridge;
      try {
        return {
          ok: true as const,
          value: await api.loadAndPlay(url, playMs != null ? { playMs } : undefined),
        };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    }, { url: fixtureUrl, playMs });

    if (!result.ok) {
      // Attach the failure to the report so a CI run shows what broke
      // without needing to fish through Playwright traces.
      testInfo.annotations.push({ type: "loadAndPlay error", description: result.error });
      throw new Error(`loadAndPlay threw: ${result.error}`);
    }
    const r = result.value;

    // Diagnostic context for failures.
    const summary = `strategy=${r.strategy} timeAdvanced=${r.timeAdvanced.toFixed(3)}s framesPainted=${r.framesPainted} duration=${r.durationSec ?? "?"}s playError=${r.playError ?? "none"}`;
    testInfo.annotations.push({ type: "playback result", description: summary });
    // Also log to console so list-reporter output shows context without
    // needing to drill into the trace file.
    // eslint-disable-next-line no-console
    console.log(`  [${browser}] ${expectation.fixture}: ${summary}`);

    // Assertion 1: playback actually advanced. Either the audio clock
    // moved (native/remux) or the canvas painted at least one frame
    // (hybrid/fallback). 0.3s is conservative — some fixtures take a
    // beat to start advancing on a cold WebKit run.
    const advanced = r.timeAdvanced > 0.3 || r.framesPainted > 0;
    expect(
      advanced,
      `expected playback to advance; got timeAdvanced=${r.timeAdvanced.toFixed(3)}s framesPainted=${r.framesPainted} (playError=${r.playError ?? "none"})`,
    ).toBe(true);

    // Assertion 2: the runtime strategy matches the matrix. This is
    // where runtime escalation surfaces — if Firefox's MSE rejected
    // HEVC, the diagnostics will report "fallback" here even though
    // classify() initially picked "remux".
    expect(
      r.strategy,
      `expected ${browser} runtime strategy "${expectedRuntime}" for ${expectation.fixture}, got "${r.strategy}" (fallback reason: ${r.fallbackReason ?? "none"})`,
    ).toBe(expectedRuntime);
  });
}
