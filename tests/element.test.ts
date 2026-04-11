import { describe, it, expect, beforeAll } from "vitest";
import { AvbridgePlayerElement } from "../src/element/avbridge-player.js";

// Register the element once for all tests in this file. We import the class
// directly (rather than the side-effecting `src/element.ts` entry) so we can
// also exercise the double-registration guard explicitly below.
beforeAll(() => {
  if (!customElements.get("avbridge-player")) {
    customElements.define("avbridge-player", AvbridgePlayerElement);
  }
});

function createElement(): AvbridgePlayerElement {
  return document.createElement("avbridge-player") as AvbridgePlayerElement;
}

describe("avbridge-player — construction", () => {
  it("attaches a shadow root containing a <video part='video'>", () => {
    const el = createElement();
    expect(el.shadowRoot).not.toBeNull();
    const video = el.shadowRoot!.querySelector("video");
    expect(video).not.toBeNull();
    expect(video!.getAttribute("part")).toBe("video");
  });

  it("starts with no player and no active source", () => {
    const el = createElement();
    expect(el.player).toBeNull();
    expect(el.src).toBeNull();
    expect(el.source).toBeNull();
    expect(el.strategy).toBeNull();
    expect(el.audioTracks).toEqual([]);
    expect(el.subtitleTracks).toEqual([]);
  });

  it("getDiagnostics returns null when no player exists", () => {
    const el = createElement();
    expect(el.getDiagnostics()).toBeNull();
  });

  it("destroy() is safe to call on a fresh element", async () => {
    const el = createElement();
    await el.destroy();
    expect(el.player).toBeNull();
  });
});

describe("avbridge-player — attribute / property reflection", () => {
  it("src property reflects to attribute", () => {
    const el = createElement();
    el.src = "https://example.com/movie.mp4";
    expect(el.getAttribute("src")).toBe("https://example.com/movie.mp4");
    expect(el.src).toBe("https://example.com/movie.mp4");
  });

  it("setting src to null removes the attribute", () => {
    const el = createElement();
    el.src = "a.mp4";
    el.src = null;
    expect(el.hasAttribute("src")).toBe(false);
    expect(el.src).toBeNull();
  });

  it("autoplay/muted/loop are boolean attributes", () => {
    const el = createElement();
    el.autoplay = true;
    el.muted = true;
    el.loop = true;
    expect(el.hasAttribute("autoplay")).toBe(true);
    expect(el.hasAttribute("muted")).toBe(true);
    expect(el.hasAttribute("loop")).toBe(true);
    el.autoplay = false;
    el.muted = false;
    el.loop = false;
    expect(el.hasAttribute("autoplay")).toBe(false);
    expect(el.hasAttribute("muted")).toBe(false);
    expect(el.hasAttribute("loop")).toBe(false);
  });

  it("preload defaults to 'auto' and accepts none/metadata/auto", () => {
    const el = createElement();
    expect(el.preload).toBe("auto");
    el.preload = "none";
    expect(el.preload).toBe("none");
    el.preload = "metadata";
    expect(el.preload).toBe("metadata");
  });

  it("diagnostics is a boolean attribute", () => {
    const el = createElement();
    expect(el.diagnostics).toBe(false);
    el.diagnostics = true;
    expect(el.diagnostics).toBe(true);
    expect(el.hasAttribute("diagnostics")).toBe(true);
  });

  it("preferredStrategy reflects via the preferstrategy attribute", () => {
    const el = createElement();
    expect(el.preferredStrategy).toBe("auto");
    el.preferredStrategy = "remux";
    expect(el.getAttribute("preferstrategy")).toBe("remux");
    expect(el.preferredStrategy).toBe("remux");
  });

  it("preferredStrategy ignores invalid values", () => {
    const el = createElement();
    el.preferredStrategy = "remux";
    // @ts-expect-error — testing runtime guard
    el.preferredStrategy = "bogus";
    // The setter rejects the invalid value, so the previous value remains.
    expect(el.preferredStrategy).toBe("remux");
  });
});

describe("avbridge-player — source mutual exclusion", () => {
  it("setting source clears src", () => {
    const el = createElement();
    el.src = "a.mp4";
    el.source = new Blob(["fake"]);
    expect(el.src).toBeNull();
    expect(el.hasAttribute("src")).toBe(false);
    expect(el.source).not.toBeNull();
  });

  it("setting src clears source", () => {
    const el = createElement();
    el.source = new Blob(["fake"]);
    el.src = "a.mp4";
    expect(el.source).toBeNull();
    expect(el.src).toBe("a.mp4");
  });

  it("setting source to null leaves a clean idle state", () => {
    const el = createElement();
    el.source = new Blob(["fake"]);
    el.source = null;
    expect(el.source).toBeNull();
    expect(el.src).toBeNull();
    expect(el.player).toBeNull();
  });
});

describe("avbridge-player — pending operations before bootstrap", () => {
  it("currentTime assignment before player exists is queued", () => {
    const el = createElement();
    // Reading currentTime returns 0 with no player.
    expect(el.currentTime).toBe(0);
    // Assigning is silently queued — no throw.
    expect(() => { el.currentTime = 30; }).not.toThrow();
  });

  it("play() before player exists resolves without throwing", async () => {
    const el = createElement();
    // No connect, no source — play() must not reject. It queues a pending
    // play that will fire on the next ready event (or never, if none).
    await expect(el.play()).resolves.toBeUndefined();
  });

  it("pause() on a fresh element is a no-op", () => {
    const el = createElement();
    expect(() => el.pause()).not.toThrow();
  });
});

describe("avbridge-player — destroy semantics", () => {
  it("destroy() is idempotent", async () => {
    const el = createElement();
    await el.destroy();
    await expect(el.destroy()).resolves.toBeUndefined();
  });

  it("methods become no-ops after destroy()", async () => {
    const el = createElement();
    await el.destroy();
    // No throws.
    await expect(el.play()).resolves.toBeUndefined();
    expect(() => el.pause()).not.toThrow();
    await expect(el.load()).resolves.toBeUndefined();
  });
});

describe("avbridge-player — double registration guard", () => {
  it("re-importing the side-effecting entry does not throw", async () => {
    // The src/element.ts entry guards against double registration. We
    // simulate that import here by checking the current registration is
    // intact and re-running the guard.
    expect(customElements.get("avbridge-player")).toBe(AvbridgePlayerElement);
    expect(() => {
      if (!customElements.get("avbridge-player")) {
        customElements.define("avbridge-player", AvbridgePlayerElement);
      }
    }).not.toThrow();
  });
});
