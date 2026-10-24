/**
 * Players that come and go on one page, played by URL (HTTP Range reads, as a
 * real app streams them) rather than as a Blob. Chromium only: what these
 * guard is avbridge's own libav and element lifecycle, not a browser's
 * strategy choice.
 *
 * Every libav.js call runs in turn on its instance's worker, so a read that
 * never answers (a phone's network) held up every later call on it. With one
 * instance shared by the page, that stopped every later video, the stalled
 * one included, until a reload. Each probe and decoder now has an instance of
 * its own, released when it is done.
 */
import { test, expect, type Route } from "@playwright/test";
import { attach, closesWithin, fixture, mount, openHarness, player, playsFrames, type Player } from "./_player.js";

test.skip(({ browserName }) => browserName !== "chromium", "lifecycle, not strategy");
test.setTimeout(90_000);

const LONG = "bbb-mpeg4-mp3.avi"; // 30 s, read in many Range requests as it plays
const SHORT = "xvid-green-wide.avi"; // 2 s

test.beforeEach(({ page }) => openHarness(page));

test("a stalled read stops neither the next video nor the stalled one later", async ({ page }) => {
  await mount(page, fixture(LONG));
  await playsFrames(page);

  // From here on no read of the long file is ever answered; a seek far ahead needs new ones.
  const stalled: Route[] = [];
  await page.route(`**/${LONG}`, (route) => { stalled.push(route); });
  await player(page).evaluate((el) => { (el as Player).currentTime = 25; });
  await expect.poll(() => stalled.length, { timeout: 10_000 }).toBeGreaterThan(0);

  expect(await closesWithin(page, 5_000), "destroy() should not wait on a stalled read").toBe(true);

  await mount(page, fixture(SHORT));
  await playsFrames(page);
  expect(await closesWithin(page, 5_000)).toBe(true);

  await page.unroute(`**/${LONG}`);
  await Promise.all(stalled.map((r) => r.abort().catch(() => undefined)));
  await mount(page, fixture(LONG));
  await playsFrames(page);
});

test("a file whose reads stall while it opens can still be closed, and the next one plays", async ({ page }) => {
  // The first read sizes the file; none after it is ever answered, so the probe never finishes.
  const stalled: Route[] = [];
  let reads = 0;
  await page.route(`**/${LONG}`, (route) => (reads++ === 0 ? route.continue() : void stalled.push(route)));
  await attach(page, fixture(LONG));
  await expect.poll(() => stalled.length, { timeout: 10_000 }).toBeGreaterThan(0);

  expect(await closesWithin(page, 5_000), "destroy() should not wait on a stalled open").toBe(true);

  await mount(page, fixture(SHORT));
  await playsFrames(page);
  await page.unroute(`**/${LONG}`);
  await Promise.all(stalled.map((r) => r.abort().catch(() => undefined)));
});

test("plays after many players opened and closed, some before they were ready", async ({ page }) => {
  const files = [LONG, SHORT, "bbb-h264-mp3.avi", SHORT];
  for (let round = 0; round < 8; round++) {
    const file = files[round % files.length];
    if (round % 3 === 2) {
      // Closed while still opening.
      await attach(page, fixture(file));
      await page.waitForTimeout(150);
    } else {
      await mount(page, fixture(file));
      await playsFrames(page);
    }
    expect.soft(await closesWithin(page, 5_000), `round ${round}: destroy() settled`).toBe(true);
  }
  await mount(page, fixture(LONG));
  await playsFrames(page);
});

test("plays by URL where AbortSignal.any is missing, as before Safari 17.4", async ({ page }) => {
  await page.addInitScript(() => { delete (AbortSignal as { any?: unknown }).any; });
  await openHarness(page);
  await mount(page, fixture(SHORT));
  await playsFrames(page);
});

// The decoder's packets and bitstream filter used to be freed with av_packet_free /
// av_bsf_free, which take the pointer's address: the shared libav instance was
// corrupted and the next file trapped with "memory access out of bounds".
test("plays the next file after one has played and closed", async ({ page }) => {
  for (let i = 0; i < 3; i++) {
    await mount(page, fixture(LONG));
    await playsFrames(page);
    await page.waitForTimeout(2_000);
    expect(await closesWithin(page, 5_000)).toBe(true);
  }
});
