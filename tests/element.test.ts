import { describe, it, expect, beforeAll } from "vitest";
import { AvbridgeVideoElement } from "../src/element/avbridge-video.js";

// Register the element once for all tests in this file. We import the class
// directly (rather than the side-effecting `src/element.ts` entry) so we can
// also exercise the double-registration guard explicitly below.
beforeAll(() => {
  if (!customElements.get("avbridge-video")) {
    customElements.define("avbridge-video", AvbridgeVideoElement);
  }
});

function createElement(): AvbridgeVideoElement {
  return document.createElement("avbridge-video") as AvbridgeVideoElement;
}

describe("avbridge-video — construction", () => {
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

describe("avbridge-video — attribute / property reflection", () => {
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

describe("avbridge-video — source mutual exclusion", () => {
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

describe("avbridge-video — pending operations before bootstrap", () => {
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

describe("avbridge-video — destroy semantics", () => {
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

describe("avbridge-video — HTMLMediaElement parity surface", () => {
  it("exposes the underlying <video> via videoElement", () => {
    const el = createElement();
    const v = el.videoElement;
    expect(v).toBeInstanceOf(HTMLVideoElement);
    expect(v).toBe(el.shadowRoot!.querySelector("video"));
  });

  it("poster reflects via the poster attribute", () => {
    const el = createElement();
    expect(el.poster).toBe("");
    el.poster = "https://example.com/p.jpg";
    expect(el.getAttribute("poster")).toBe("https://example.com/p.jpg");
    expect(el.videoElement.getAttribute("poster")).toBe("https://example.com/p.jpg");
    el.poster = "";
    expect(el.hasAttribute("poster")).toBe(false);
  });

  it("volume passes through to the inner video", () => {
    const el = createElement();
    el.volume = 0.42;
    expect(el.volume).toBeCloseTo(0.42);
    expect(el.videoElement.volume).toBeCloseTo(0.42);
  });

  it("playbackRate passes through to the inner video", () => {
    const el = createElement();
    el.playbackRate = 1.5;
    expect(el.playbackRate).toBe(1.5);
    expect(el.videoElement.playbackRate).toBe(1.5);
  });

  it("videoWidth / videoHeight are read-only and default to 0", () => {
    const el = createElement();
    expect(el.videoWidth).toBe(0);
    expect(el.videoHeight).toBe(0);
  });

  it("played and seekable return TimeRanges-like objects", () => {
    const el = createElement();
    expect(el.played).toBeDefined();
    expect(typeof el.played.length).toBe("number");
    expect(el.seekable).toBeDefined();
    expect(typeof el.seekable.length).toBe("number");
  });

  it("crossOrigin reflects via the crossorigin attribute", () => {
    const el = createElement();
    expect(el.crossOrigin).toBeNull();
    el.crossOrigin = "anonymous";
    expect(el.getAttribute("crossorigin")).toBe("anonymous");
    expect(el.videoElement.crossOrigin).toBe("anonymous");
    el.crossOrigin = null;
    expect(el.hasAttribute("crossorigin")).toBe(false);
  });

  it("disableRemotePlayback setter reflects to the disableremoteplayback attribute", () => {
    const el = createElement();
    // Note: the getter passes through to the inner video, which jsdom does
    // not implement (returns undefined). We verify the setter / attribute
    // reflection path, which is the part the wrapper actually owns.
    el.disableRemotePlayback = true;
    expect(el.hasAttribute("disableremoteplayback")).toBe(true);
    expect(el.videoElement.hasAttribute("disableremoteplayback")).toBe(true);
    el.disableRemotePlayback = false;
    expect(el.hasAttribute("disableremoteplayback")).toBe(false);
  });

  it("canPlayType passes through to the inner video", () => {
    const el = createElement();
    // The result may be "", "maybe", or "probably" depending on jsdom — we
    // just verify it returns a valid CanPlayTypeResult string.
    const result = el.canPlayType("video/mp4");
    expect(["", "maybe", "probably"]).toContain(result);
  });
});

describe("avbridge-video — event forwarding", () => {
  it("forwards loadedmetadata from the inner video to the wrapper", () => {
    const el = createElement();
    let count = 0;
    el.addEventListener("loadedmetadata", () => { count++; });
    el.videoElement.dispatchEvent(new Event("loadedmetadata"));
    expect(count).toBe(1);
  });

  it("forwards error from the inner video", () => {
    const el = createElement();
    let count = 0;
    el.addEventListener("error", () => { count++; });
    el.videoElement.dispatchEvent(new Event("error"));
    expect(count).toBe(1);
  });

  it("forwards play / pause / seeking / seeked / volumechange", () => {
    const el = createElement();
    const seen: string[] = [];
    for (const name of ["play", "pause", "seeking", "seeked", "volumechange"]) {
      el.addEventListener(name, () => seen.push(name));
    }
    for (const name of ["play", "pause", "seeking", "seeked", "volumechange"]) {
      el.videoElement.dispatchEvent(new Event(name));
    }
    expect(seen).toEqual(["play", "pause", "seeking", "seeked", "volumechange"]);
  });

  it("stops forwarding events after destroy()", async () => {
    const el = createElement();
    let count = 0;
    el.addEventListener("play", () => { count++; });
    await el.destroy();
    el.videoElement.dispatchEvent(new Event("play"));
    expect(count).toBe(0);
  });
});

describe("avbridge-video — light-DOM <track> children", () => {
  it("clones <track> children appended before connect", () => {
    // Append the track BEFORE connection — covers the
    //   el.src = "..."; el.appendChild(track);  (pre-bootstrap)
    // case from the review.
    const el = createElement();
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.src = "https://example.com/pre.vtt";
    el.appendChild(track);
    document.body.appendChild(el);
    const shadowTracks = el.videoElement.querySelectorAll("track");
    expect(shadowTracks.length).toBe(1);
    expect(shadowTracks[0].getAttribute("src")).toBe("https://example.com/pre.vtt");
    document.body.removeChild(el);
  });

  it("clones <track> children into the shadow video on connect", () => {
    const el = createElement();
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.src = "https://example.com/subs.vtt";
    track.srclang = "en";
    el.appendChild(track);
    document.body.appendChild(el);
    const shadowTracks = el.videoElement.querySelectorAll("track");
    expect(shadowTracks.length).toBe(1);
    expect(shadowTracks[0].getAttribute("src")).toBe("https://example.com/subs.vtt");
    document.body.removeChild(el);
  });

  it("syncs newly added <track> children via MutationObserver", async () => {
    const el = createElement();
    document.body.appendChild(el);
    expect(el.videoElement.querySelectorAll("track").length).toBe(0);

    const track = document.createElement("track");
    track.kind = "captions";
    track.src = "https://example.com/cap.vtt";
    el.appendChild(track);

    // MutationObserver callbacks fire as microtasks; await one tick.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(el.videoElement.querySelectorAll("track").length).toBe(1);
    document.body.removeChild(el);
  });

  it("removes shadow tracks when light-DOM tracks are removed", async () => {
    const el = createElement();
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.src = "https://example.com/a.vtt";
    el.appendChild(track);
    document.body.appendChild(el);
    expect(el.videoElement.querySelectorAll("track").length).toBe(1);

    el.removeChild(track);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(el.videoElement.querySelectorAll("track").length).toBe(0);
    document.body.removeChild(el);
  });
});

describe("avbridge-video — double registration guard", () => {
  it("re-importing the side-effecting entry does not throw", async () => {
    // The src/element.ts entry guards against double registration. We
    // simulate that import here by checking the current registration is
    // intact and re-running the guard.
    expect(customElements.get("avbridge-video")).toBe(AvbridgeVideoElement);
    expect(() => {
      if (!customElements.get("avbridge-video")) {
        customElements.define("avbridge-video", AvbridgeVideoElement);
      }
    }).not.toThrow();
  });
});
