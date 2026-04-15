import { describe, it, expect, beforeAll, vi } from "vitest";
import { buildInitialDecision, decideVisibilityAction, evaluateDecodeHealth, readDecodedFrameCount } from "../src/player.js";
import { SubtitleResourceBag } from "../src/subtitles/index.js";
import { Diagnostics } from "../src/diagnostics.js";
import type { MediaContext } from "../src/types.js";

// jsdom doesn't ship URL.createObjectURL / revokeObjectURL. Stub them for
// the bag tests so we can verify the lifecycle without a browser.
beforeAll(() => {
  let counter = 0;
  if (!URL.createObjectURL) {
    URL.createObjectURL = vi.fn(() => `blob:fake/${++counter}`);
  }
  if (!URL.revokeObjectURL) {
    URL.revokeObjectURL = vi.fn();
  }
});

function ctx(partial: Partial<MediaContext>): MediaContext {
  return {
    source: new Blob([]),
    container: "mp4",
    videoTracks: [],
    audioTracks: [],
    subtitleTracks: [],
    probedBy: "mediabunny",
    ...partial,
  } as MediaContext;
}

describe("buildInitialDecision", () => {
  // Invariant: the returned `class` must derive from the chosen strategy
  // (not a hard-coded NATIVE) so diagnostics and any downstream consumer
  // of strategyClass see the real strategy.

  it("derives REMUX_CANDIDATE class when initialStrategy='remux' on a remuxable container", () => {
    const decision = buildInitialDecision(
      "remux",
      ctx({
        container: "mkv",
        videoTracks: [
          { id: 0, codec: "h264", width: 1280, height: 720, pixelFormat: "yuv420p", bitDepth: 8 },
        ],
        audioTracks: [{ id: 1, codec: "aac", channels: 2, sampleRate: 48000 }],
      }),
    );
    expect(decision.strategy).toBe("remux");
    expect(decision.class).toBe("REMUX_CANDIDATE");
    expect(decision.reason).toMatch(/initialStrategy/);
  });

  it("derives FALLBACK_REQUIRED class when initialStrategy='fallback'", () => {
    const decision = buildInitialDecision(
      "fallback",
      ctx({
        container: "mp4",
        videoTracks: [
          { id: 0, codec: "h264", width: 1280, height: 720, pixelFormat: "yuv420p", bitDepth: 8 },
        ],
      }),
    );
    expect(decision.strategy).toBe("fallback");
    expect(decision.class).toBe("FALLBACK_REQUIRED");
  });

  it("derives HYBRID_CANDIDATE class when initialStrategy='hybrid'", () => {
    const decision = buildInitialDecision(
      "hybrid",
      ctx({
        container: "mp4",
        videoTracks: [
          { id: 0, codec: "h264", width: 1280, height: 720, pixelFormat: "yuv420p", bitDepth: 8 },
        ],
      }),
    );
    expect(decision.strategy).toBe("hybrid");
    expect(decision.class).toBe("HYBRID_CANDIDATE");
  });

  it("provides a sensible fallback chain so escalation can still walk it", () => {
    const decision = buildInitialDecision(
      "native",
      ctx({
        container: "mp4",
        videoTracks: [
          { id: 0, codec: "h264", width: 1280, height: 720, pixelFormat: "yuv420p", bitDepth: 8 },
        ],
      }),
    );
    expect(decision.fallbackChain).toBeDefined();
    // Native should be able to escalate down through the chain.
    expect(decision.fallbackChain!.length).toBeGreaterThan(0);
  });

  it("does not reinsert the initial strategy into the inherited fallback chain", () => {
    // Hi10P on mp4 classifies as RISKY_NATIVE with fallbackChain
    // ["remux", "hybrid", "fallback"]. If the caller forces initialStrategy
    // "remux", the synthetic decision must strip "remux" so startSession
    // doesn't retry it after its own failure.
    const decision = buildInitialDecision(
      "remux",
      ctx({
        container: "mp4",
        videoTracks: [
          { id: 0, codec: "h264", profile: "High 10", bitDepth: 10, pixelFormat: "yuv420p10le", width: 1920, height: 1080 },
        ],
        audioTracks: [{ id: 1, codec: "aac", channels: 2, sampleRate: 48000 }],
      }),
    );
    expect(decision.strategy).toBe("remux");
    expect(decision.fallbackChain).not.toContain("remux");
    expect(decision.fallbackChain).toEqual(["hybrid", "fallback"]);
  });
});

describe("decideVisibilityAction (background tab pause/resume)", () => {
  // State transitions for the visibility-change handler. Pure function,
  // no DOM — tested exhaustively so the state machine is correct.

  it("pauses when tab hides and user was playing", () => {
    const action = decideVisibilityAction({
      hidden: true,
      userIntent: "play",
      sessionIsPlaying: true,
      autoPausedForVisibility: false,
    });
    expect(action).toBe("pause");
  });

  it("no-op when tab hides and user already paused", () => {
    const action = decideVisibilityAction({
      hidden: true,
      userIntent: "pause",
      sessionIsPlaying: false,
      autoPausedForVisibility: false,
    });
    expect(action).toBe("noop");
  });

  it("no-op when tab hides but session wasn't playing (e.g. still buffering)", () => {
    const action = decideVisibilityAction({
      hidden: true,
      userIntent: "play",
      sessionIsPlaying: false,
      autoPausedForVisibility: false,
    });
    expect(action).toBe("noop");
  });

  it("resumes when tab becomes visible and we had auto-paused", () => {
    const action = decideVisibilityAction({
      hidden: false,
      userIntent: "play",
      sessionIsPlaying: false,
      autoPausedForVisibility: true,
    });
    expect(action).toBe("resume");
  });

  it("no-op when tab becomes visible but we didn't auto-pause", () => {
    // E.g. user paused manually while hidden, or tab was never hidden
    const action = decideVisibilityAction({
      hidden: false,
      userIntent: "pause",
      sessionIsPlaying: false,
      autoPausedForVisibility: false,
    });
    expect(action).toBe("noop");
  });

  it("no-op when tab becomes visible and is already playing (rare)", () => {
    const action = decideVisibilityAction({
      hidden: false,
      userIntent: "play",
      sessionIsPlaying: true,
      autoPausedForVisibility: false,
    });
    expect(action).toBe("noop");
  });

  it("respects user pause during hidden state (no auto-resume on return)", () => {
    // Scenario: play → hide (auto-pause) → user explicitly pauses while
    // hidden (userIntent="pause", autoPausedForVisibility cleared by
    // pause()) → tab returns. Should NOT auto-resume.
    const action = decideVisibilityAction({
      hidden: false,
      userIntent: "pause",
      sessionIsPlaying: false,
      autoPausedForVisibility: false,
    });
    expect(action).toBe("noop");
  });
});

describe("Diagnostics transport hoist (regression: URL range overstatement)", () => {
  // Regression: recordProbe used to hardcode `rangeSupported: true` for any
  // URL input. Now recordProbe leaves rangeSupported undefined until a
  // strategy confirms via recordTransport() — and strategies surface that
  // confirmation by putting `_transport` / `_rangeSupported` into their
  // runtime stats, which recordRuntime hoists to the typed fields.

  function probeCtx(src: string | Blob): MediaContext {
    return {
      source: src,
      container: "mp4",
      videoTracks: [],
      audioTracks: [],
      subtitleTracks: [],
      probedBy: "mediabunny",
    } as MediaContext;
  }

  it("URL input starts with rangeSupported undefined (no false claim)", () => {
    const d = new Diagnostics();
    d.recordProbe(probeCtx("https://example.com/a.mp4"));
    const snap = d.snapshot();
    expect(snap.sourceType).toBe("url");
    expect(snap.transport).toBe("http-range");
    expect(snap.rangeSupported).toBeUndefined();
  });

  it("Blob input reports memory transport with rangeSupported: false", () => {
    const d = new Diagnostics();
    d.recordProbe(probeCtx(new Blob(["x"])));
    const snap = d.snapshot();
    expect(snap.sourceType).toBe("blob");
    expect(snap.transport).toBe("memory");
    expect(snap.rangeSupported).toBe(false);
  });

  it("recordRuntime hoists _transport / _rangeSupported to typed fields", () => {
    const d = new Diagnostics();
    d.recordProbe(probeCtx("https://example.com/a.avi"));
    d.recordRuntime({
      packetsRead: 42,
      _transport: "http-range",
      _rangeSupported: true,
    });
    const snap = d.snapshot();
    expect(snap.rangeSupported).toBe(true);
    expect(snap.transport).toBe("http-range");
    // The well-known keys are stripped from the generic bag.
    expect(snap.runtime).not.toHaveProperty("_transport");
    expect(snap.runtime).not.toHaveProperty("_rangeSupported");
    // Other runtime stats are preserved.
    expect(snap.runtime?.packetsRead).toBe(42);
  });

  it("recordTransport can be called directly", () => {
    const d = new Diagnostics();
    d.recordProbe(probeCtx("https://example.com/a.mp4"));
    d.recordTransport("http-range", true);
    expect(d.snapshot().rangeSupported).toBe(true);
  });
});

describe("SubtitleResourceBag (regression: blob URL leak)", () => {
  // Regression: subtitle sidecar discovery and SRT->VTT conversion both
  // created blob URLs that were never revoked. Repeated source swaps in a
  // long-lived SPA leaked memory. The bag is the cleanup primitive.

  it("createObjectURL tracks the URL it returns", () => {
    const bag = new SubtitleResourceBag();
    const blob = new Blob(["WEBVTT\n"], { type: "text/vtt" });
    const url = bag.createObjectURL(blob);
    expect(url).toMatch(/^blob:/);
    // Smoke check: revoking should not throw.
    expect(() => bag.revokeAll()).not.toThrow();
  });

  it("track() lets externally-created URLs join the bag", () => {
    const bag = new SubtitleResourceBag();
    const blob = new Blob(["WEBVTT\n"], { type: "text/vtt" });
    const url = URL.createObjectURL(blob);
    bag.track(url);
    expect(() => bag.revokeAll()).not.toThrow();
  });

  it("revokeAll is idempotent", () => {
    const bag = new SubtitleResourceBag();
    bag.createObjectURL(new Blob(["a"]));
    bag.revokeAll();
    expect(() => bag.revokeAll()).not.toThrow();
  });
});

describe("evaluateDecodeHealth (stall supervisor pure decision)", () => {
  const base = {
    hasVideoTrack: true,
    timeAdvanced: true,
    framesAdvanced: true,
    now: 10_000,
    lastProgressTime: 10_000,
    lastFrameProgressTime: 10_000,
  };

  it("returns no escalation while everything is advancing", () => {
    expect(evaluateDecodeHealth(base)).toEqual({ escalate: false });
  });

  it("flags time-stall when currentTime hasn't moved for >5s", () => {
    const r = evaluateDecodeHealth({
      ...base,
      timeAdvanced: false,
      lastProgressTime: 10_000,
      now: 15_500,
    });
    expect(r).toEqual({ escalate: true, kind: "time-stall" });
  });

  it("does not flag time-stall before the threshold", () => {
    expect(evaluateDecodeHealth({
      ...base,
      timeAdvanced: false,
      lastProgressTime: 10_000,
      now: 14_000,
    })).toEqual({ escalate: false });
  });

  it("flags silent-video when audio advances but frames don't (>3s)", () => {
    const r = evaluateDecodeHealth({
      ...base,
      timeAdvanced: true,
      framesAdvanced: false,
      lastFrameProgressTime: 10_000,
      now: 13_500,
    });
    expect(r).toEqual({ escalate: true, kind: "silent-video" });
  });

  it("does not flag silent-video on audio-only sources", () => {
    expect(evaluateDecodeHealth({
      ...base,
      hasVideoTrack: false,
      framesAdvanced: false,
      lastFrameProgressTime: 10_000,
      now: 20_000,
    })).toEqual({ escalate: false });
  });

  it("does not flag silent-video before the threshold", () => {
    expect(evaluateDecodeHealth({
      ...base,
      framesAdvanced: false,
      lastFrameProgressTime: 10_000,
      now: 12_500,
    })).toEqual({ escalate: false });
  });

  it("does not flag silent-video when currentTime is also stuck (time-stall wins first)", () => {
    const r = evaluateDecodeHealth({
      ...base,
      timeAdvanced: false,
      framesAdvanced: false,
      lastProgressTime: 10_000,
      lastFrameProgressTime: 10_000,
      now: 20_000,
    });
    expect(r).toEqual({ escalate: true, kind: "time-stall" });
  });

  it("honors custom thresholds", () => {
    expect(evaluateDecodeHealth({
      ...base,
      timeAdvanced: false,
      lastProgressTime: 10_000,
      now: 11_500,
      timeStallThresholdMs: 1000,
    })).toEqual({ escalate: true, kind: "time-stall" });

    expect(evaluateDecodeHealth({
      ...base,
      framesAdvanced: false,
      lastFrameProgressTime: 10_000,
      now: 10_500,
      frameStallThresholdMs: 250,
    })).toEqual({ escalate: true, kind: "silent-video" });
  });
});

describe("readDecodedFrameCount", () => {
  it("returns 0 for an audio-only HTMLAudioElement", () => {
    const a = document.createElement("audio");
    expect(readDecodedFrameCount(a)).toBe(0);
  });

  it("reads totalVideoFrames via getVideoPlaybackQuality when available", () => {
    const v = document.createElement("video");
    Object.defineProperty(v, "getVideoPlaybackQuality", {
      configurable: true,
      value: () => ({ totalVideoFrames: 42 }),
    });
    expect(readDecodedFrameCount(v)).toBe(42);
  });

  it("falls back to webkitDecodedFrameCount", () => {
    const v = document.createElement("video");
    Object.defineProperty(v, "webkitDecodedFrameCount", {
      configurable: true,
      value: 17,
    });
    expect(readDecodedFrameCount(v)).toBe(17);
  });
});
