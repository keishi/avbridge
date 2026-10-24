/**
 * Page helpers shared by the specs that drive `<avbridge-player>` directly on
 * tests-harness.html, by URL (Range reads) rather than through loadAndPlay.
 */
import { expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

export const fixture = (name: string) => `/@fs${resolve("tests/fixtures", name)}`;

export type Player = HTMLElement & {
  src: string;
  muted: boolean;
  currentTime: number;
  play(): Promise<void>;
  destroy(): Promise<void>;
  getDiagnostics(): { videoCodec?: string; runtime?: { framesPainted?: number } } | null;
};

/** Opens the harness page the specs mount players on. */
export async function openHarness(page: Page): Promise<void> {
  await page.goto("/tests-harness.html");
  await page.waitForFunction(() => (window as unknown as { __avbridgeReady?: boolean }).__avbridgeReady === true);
}

/** Mounts a player on `url` without waiting for it to open. */
export async function attach(page: Page, url: string): Promise<void> {
  await page.evaluate((src) => {
    const el = document.createElement("avbridge-player") as Player;
    el.muted = true;
    document.getElementById("player-mount")!.appendChild(el);
    el.src = src;
  }, url);
}

/** Mounts a player on `url` and waits for ready. */
export async function mount(page: Page, url: string): Promise<void> {
  await page.evaluate(async (src) => {
    const mount = document.getElementById("player-mount")!;
    const player = document.createElement("avbridge-player") as Player;
    player.muted = true;
    mount.appendChild(player);
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("ready timeout")), 20_000);
      player.addEventListener("ready", () => { clearTimeout(timer); ok(); }, { once: true });
      player.addEventListener("error", (e) => {
        clearTimeout(timer);
        fail((e as unknown as CustomEvent).detail?.error ?? new Error("error event"));
      }, { once: true });
      player.src = src;
    });
  }, url);
}

export const player = (page: Page) => page.locator("#player-mount avbridge-player");

export async function framesPainted(page: Page): Promise<number> {
  return player(page).evaluate((el) => (el as Player).getDiagnostics()?.runtime?.framesPainted ?? 0);
}

/** Plays and waits until the player has painted frames. */
export async function playsFrames(page: Page): Promise<void> {
  await player(page).evaluate((el) => (el as Player).play());
  await expect.poll(() => framesPainted(page), { timeout: 15_000 }).toBeGreaterThan(5);
}

/** Destroys and removes the player; true when destroy() settled within `limitMs`. */
export async function closesWithin(page: Page, limitMs: number): Promise<boolean> {
  return page.evaluate(async (limit) => {
    const el = document.querySelector("#player-mount avbridge-player") as Player;
    const done = await Promise.race([
      el.destroy().then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), limit)),
    ]);
    el.remove();
    return done;
  }, limitMs);
}

export interface Painted {
  width: number;
  height: number;
  /** RGB at the centre of the canvas. */
  centre: number[];
}

/** The canvas the player paints on, inside its shadow roots: its size and centre pixel. */
export async function painted(page: Page): Promise<Painted | null> {
  return player(page).evaluate((el) => {
    const find = (root: ParentNode): HTMLCanvasElement | null => {
      for (const node of Array.from(root.querySelectorAll("*"))) {
        if (node instanceof HTMLCanvasElement && node.width > 0) return node;
        const inner = node.shadowRoot && find(node.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    const canvas = find(el.shadowRoot ?? el);
    if (!canvas) return null;
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext("2d")!;
    ctx.drawImage(canvas, 0, 0);
    const centre = Array.from(ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data.slice(0, 3));
    return { width: canvas.width, height: canvas.height, centre };
  });
}
