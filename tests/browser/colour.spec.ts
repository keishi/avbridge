/**
 * What the fallback strategy paints for SD video. Chromium only: it checks the
 * VideoFrames avbridge builds, not a browser's strategy choice.
 */
import { test, expect } from "@playwright/test";
import { fixture, mount, openHarness, painted, playsFrames } from "./_player.js";

test.skip(({ browserName }) => browserName !== "chromium", "fallback rendering, not strategy");
test.setTimeout(60_000);

test.beforeEach(({ page }) => openHarness(page));

// Untagged, Chrome took SD video as BT.709, which paints pure green at about 216.
test("paints SD video in BT.601 colours, at its pixel aspect ratio", async ({ page }) => {
  await mount(page, fixture("xvid-green-wide.avi"));
  await playsFrames(page);
  const p = (await painted(page))!;
  expect.soft(p.centre[1]).toBeGreaterThan(240);
  expect.soft(p.width / p.height).toBeCloseTo(16 / 9, 1);
});
