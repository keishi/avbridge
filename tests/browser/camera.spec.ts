/**
 * Camera AVIs (MVI_*.AVI): Motion JPEG with PCM sound, which the avbridge libav
 * variant decodes in software. Chromium only, like colour.spec.ts.
 */
import { test, expect, type Page } from "@playwright/test";
import { fixture, mount, openHarness, painted, player, playsFrames, type Player } from "./_player.js";

test.skip(({ browserName }) => browserName !== "chromium", "fallback rendering, not strategy");
test.setTimeout(60_000);

test.beforeEach(({ page }) => openHarness(page));

const codec = (page: Page) => player(page).evaluate((el) => (el as Player).getDiagnostics()?.videoCodec);

test("plays a camera AVI: Motion JPEG, full-range yuvj422p, 8-bit PCM", async ({ page }) => {
  await mount(page, fixture("mjpeg-pcm.avi"));
  await playsFrames(page);
  expect.soft(await codec(page)).toBe("mjpeg");
});

// Taken as limited range (what WebCodecs assumes untagged), grey 16 paints black. The upper
// bound leaves room for how Chrome converts the transfer to sRGB.
test("keeps Motion JPEG's full-range levels", async ({ page }) => {
  await mount(page, fixture("mjpeg-grey16.avi"));
  await player(page).evaluate((el) => (el as Player).play());
  await expect.poll(async () => (await painted(page))?.centre[0] ?? -1, { timeout: 15_000 }).toBeGreaterThan(8);
  expect.soft((await painted(page))!.centre[0]).toBeLessThan(40);
});
