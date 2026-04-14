/**
 * Cross-browser fixture validation: each fixture should probe identically
 * across browsers (probe runs in JS, so codec detection is deterministic)
 * and classify() should pick the expected strategy per browser
 * (browser-dependent because classify checks native codec support).
 *
 * This is the smallest meaningful Playwright slice — validates the core
 * "avbridge picks the right strategy on each browser" claim without
 * depending on MSE/WebCodecs/Canvas actually working.
 */
import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { FIXTURE_EXPECTATIONS, type BrowserName } from "./_expectations.js";

const FIXTURES_DIR = resolve("tests/fixtures");

// Give Vite time to serve the harness + dynamic imports on a cold
// WebKit run. 20s is generous but not infinite.
test.setTimeout(20_000);

test.beforeEach(async ({ page }) => {
  // Navigate to the harness, which exposes window.avbridge = { probe, classify }
  // and sets window.__avbridgeReady = true once module imports complete.
  await page.goto("/tests-harness.html");
  await page.waitForFunction(() => (window as unknown as { __avbridgeReady?: boolean }).__avbridgeReady === true);
});

for (const expectation of FIXTURE_EXPECTATIONS) {
  test(`${expectation.fixture} — probe + classify`, async ({ page, browserName }) => {
    const browser = browserName as BrowserName;
    const expectedStrategy = expectation.strategy[browser];

    // Skip if we don't have an expectation for this browser. Rather than
    // pretending the test passes, be explicit that this combination
    // hasn't been validated — the matrix should be completed over time.
    test.skip(
      expectedStrategy === undefined,
      `no expectation declared for ${browser} × ${expectation.fixture}`,
    );

    // Serve the fixture via Vite's /@fs prefix (allows fetching files
    // outside the demo/ root). The harness fetches it as a Blob and
    // passes it to probe().
    const fixturePath = resolve(FIXTURES_DIR, expectation.fixture);
    const result = await page.evaluate(async (url) => {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
      const blob = await resp.blob();
      const api = (window as unknown as {
        avbridge: {
          probe: (input: unknown) => Promise<Record<string, unknown>>;
          classify: (ctx: unknown) => Record<string, unknown>;
        };
      }).avbridge;
      const ctx = await api.probe(blob);
      const decision = api.classify(ctx);
      return {
        container: ctx.container,
        videoCodec: (ctx.videoTracks as Array<{ codec: string }>)[0]?.codec,
        audioCodec: (ctx.audioTracks as Array<{ codec: string }>)[0]?.codec,
        strategy: decision.strategy,
        class: decision.class,
        reason: decision.reason,
      };
    }, `/@fs${fixturePath}`);

    // Deterministic claims (same across browsers): probe output.
    expect(result.container).toBe(expectation.container);
    expect(result.videoCodec).toBe(expectation.videoCodec);
    expect(result.audioCodec).toBe(expectation.audioCodec);

    // Browser-dependent claim: chosen strategy. The matrix entry is
    // what we expect; mismatches are loud and the error message points
    // at the browser and the strategy diff so a contributor knows
    // exactly what drifted.
    expect(
      result.strategy,
      `expected ${browser} to pick "${expectedStrategy}" for ${expectation.fixture}, got "${result.strategy}" (${result.reason})`,
    ).toBe(expectedStrategy);
  });
}
