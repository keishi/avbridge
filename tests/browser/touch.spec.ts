/**
 * How <avbridge-player>'s controls answer a finger. Chromium only: touches are
 * sent through the DevTools protocol.
 */
import { test, expect } from "@playwright/test";
import { fixture, framesPainted, mount, openHarness, player, playsFrames } from "./_player.js";

test.skip(({ browserName }) => browserName !== "chromium", "touch input via CDP");
test.setTimeout(60_000);

test.beforeEach(({ page }) => openHarness(page));

// A finger moves a little as it taps: that move showed the controls, and the tap's toggle hid
// them again 250 ms later. A tap mid-picture hit the unseen play button and paused the video.
test("a tap shows the controls and leaves the video playing", async ({ page }) => {
  await mount(page, fixture("bbb-mpeg4-mp3.avi"));
  await playsFrames(page);
  const box = (await player(page).boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const tap = async (fx: number, fy: number) => {
    const x = box.x + box.width * fx;
    const y = box.y + box.height * fy;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 2, y: y + 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(500); // outlasts the 250 ms tap delay that hid them
  };

  await player(page).evaluate((el) => el.setAttribute("data-controls-hidden", ""));
  await tap(0.25, 0.25);
  expect.soft(await player(page).evaluate((el) => el.hasAttribute("data-controls-hidden"))).toBe(false);
  await tap(0.5, 0.5);
  expect.soft(await player(page).evaluate((el) => (el as HTMLElement).dataset.state)).toBe("playing");
  expect.soft(await framesPainted(page)).toBeGreaterThan(5);
});
