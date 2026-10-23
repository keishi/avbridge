/**
 * Players that come and go on one page, played by URL (HTTP Range reads) as an
 * app streams them. Chromium only: this guards avbridge's own libav lifecycle,
 * not a browser's strategy choice.
 */
import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

test.skip(({ browserName }) => browserName !== "chromium", "lifecycle, not strategy");
test.setTimeout(60_000);

type Player = HTMLElement & {
  src: string;
  muted: boolean;
  play(): Promise<void>;
  destroy(): Promise<void>;
  getDiagnostics(): { runtime?: { framesPainted?: number } } | null;
};

const fixture = (name: string) => `/@fs${resolve("tests/fixtures", name)}`;
const player = (page: Page) => page.locator("#player-mount avbridge-player");

async function mount(page: Page, url: string): Promise<void> {
  await page.evaluate(async (src) => {
    const el = document.createElement("avbridge-player") as Player;
    el.muted = true;
    document.getElementById("player-mount")!.appendChild(el);
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("ready timeout")), 20_000);
      el.addEventListener("ready", () => { clearTimeout(timer); ok(); }, { once: true });
      el.addEventListener("error", (e) => {
        clearTimeout(timer);
        fail(new Error(String((e as unknown as CustomEvent).detail?.error?.message ?? "error event")));
      }, { once: true });
      el.src = src;
    });
  }, url);
}

async function playsFrames(page: Page): Promise<void> {
  await player(page).evaluate((el) => (el as Player).play());
  await expect.poll(
    () => player(page).evaluate((el) => (el as Player).getDiagnostics()?.runtime?.framesPainted ?? 0),
    { timeout: 15_000 },
  ).toBeGreaterThan(5);
}

async function close(page: Page): Promise<void> {
  await player(page).evaluate(async (el) => {
    await (el as Player).destroy();
    el.remove();
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/tests-harness.html");
  await page.waitForFunction(() => (window as unknown as { __avbridgeReady?: boolean }).__avbridgeReady === true);
});

// The decoder's packets and bitstream filter used to be freed with av_packet_free /
// av_bsf_free, which take the pointer's address: the shared libav instance was
// corrupted and the next file trapped with "memory access out of bounds".
test("plays the next file after one has played and closed", async ({ page }) => {
  for (let i = 0; i < 3; i++) {
    await mount(page, fixture("bbb-mpeg4-mp3.avi"));
    await playsFrames(page);
    await page.waitForTimeout(2_000);
    await close(page);
  }
});
