import { describe, it, expect } from "vitest";
import { Diagnostics } from "../src/diagnostics.js";
import type { Classification, MediaContext } from "../src/types.js";

function probeCtx(
  src: string | Blob,
  partial?: Partial<MediaContext>,
): MediaContext {
  return {
    source: src,
    container: "mp4",
    videoTracks: [],
    audioTracks: [],
    subtitleTracks: [],
    probedBy: "mediabunny",
    ...partial,
  } as MediaContext;
}

describe("Diagnostics", () => {
  describe("initial state", () => {
    it("snapshot returns pending defaults before any recording", () => {
      const d = new Diagnostics();
      const s = d.snapshot();
      expect(s.container).toBe("unknown");
      expect(s.strategy).toBe("pending");
      expect(s.strategyClass).toBe("pending");
      expect(s.reason).toBe("");
      expect(s.videoCodec).toBeUndefined();
      expect(s.audioCodec).toBeUndefined();
      expect(s.strategyHistory).toBeUndefined();
    });
  });

  describe("recordProbe", () => {
    it("extracts video and audio codec from first tracks", () => {
      const d = new Diagnostics();
      d.recordProbe(probeCtx(new Blob([]), {
        container: "mkv",
        videoTracks: [
          { id: 0, codec: "h264", width: 1920, height: 1080, fps: 24 },
        ],
        audioTracks: [
          { id: 1, codec: "aac", channels: 2, sampleRate: 48000 },
        ],
      }));
      const s = d.snapshot();
      expect(s.container).toBe("mkv");
      expect(s.videoCodec).toBe("h264");
      expect(s.audioCodec).toBe("aac");
      expect(s.width).toBe(1920);
      expect(s.height).toBe(1080);
      expect(s.fps).toBe(24);
    });

    it("sets blob transport for Blob source", () => {
      const d = new Diagnostics();
      d.recordProbe(probeCtx(new Blob([])));
      const s = d.snapshot();
      expect(s.sourceType).toBe("blob");
      expect(s.transport).toBe("memory");
      expect(s.rangeSupported).toBe(false);
    });

    it("sets url transport for string URL source with rangeSupported undefined", () => {
      const d = new Diagnostics();
      d.recordProbe(probeCtx("https://example.com/a.mp4"));
      const s = d.snapshot();
      expect(s.sourceType).toBe("url");
      expect(s.transport).toBe("http-range");
      expect(s.rangeSupported).toBeUndefined();
    });

    it("handles audio-only content (no video tracks)", () => {
      const d = new Diagnostics();
      d.recordProbe(probeCtx(new Blob([]), {
        container: "mp3",
        audioTracks: [{ id: 0, codec: "mp3", channels: 2, sampleRate: 44100 }],
      }));
      const s = d.snapshot();
      expect(s.videoCodec).toBeUndefined();
      expect(s.audioCodec).toBe("mp3");
      expect(s.width).toBeUndefined();
    });
  });

  describe("recordClassification", () => {
    it("records strategy, class, and reason", () => {
      const d = new Diagnostics();
      const c: Classification = {
        strategy: "remux",
        class: "REMUX_CANDIDATE",
        reason: "mkv with native codecs",
      };
      d.recordClassification(c);
      const s = d.snapshot();
      expect(s.strategy).toBe("remux");
      expect(s.strategyClass).toBe("REMUX_CANDIDATE");
      expect(s.reason).toBe("mkv with native codecs");
    });
  });

  describe("recordTransport", () => {
    it("overrides probe-time transport heuristic with confirmed value", () => {
      const d = new Diagnostics();
      d.recordProbe(probeCtx("https://example.com/a.mp4"));
      expect(d.snapshot().rangeSupported).toBeUndefined();

      d.recordTransport("http-range", true);
      const s = d.snapshot();
      expect(s.transport).toBe("http-range");
      expect(s.rangeSupported).toBe(true);
    });
  });

  describe("recordRuntime", () => {
    it("merges runtime stats into snapshot", () => {
      const d = new Diagnostics();
      d.recordRuntime({ framesDecoded: 100, fps: 30 });
      expect(d.snapshot().runtime).toMatchObject({ framesDecoded: 100, fps: 30 });
    });

    it("accumulates stats across multiple calls", () => {
      const d = new Diagnostics();
      d.recordRuntime({ a: 1 });
      d.recordRuntime({ b: 2 });
      expect(d.snapshot().runtime).toMatchObject({ a: 1, b: 2 });
    });

    it("later values override earlier ones for the same key", () => {
      const d = new Diagnostics();
      d.recordRuntime({ count: 10 });
      d.recordRuntime({ count: 20 });
      expect(d.snapshot().runtime!.count).toBe(20);
    });

    it("hoists _transport and _rangeSupported to typed fields", () => {
      const d = new Diagnostics();
      d.recordProbe(probeCtx("https://example.com/a.mp4"));
      d.recordRuntime({
        framesDecoded: 5,
        _transport: "http-range",
        _rangeSupported: true,
      });
      const s = d.snapshot();
      expect(s.transport).toBe("http-range");
      expect(s.rangeSupported).toBe(true);
      // Hoisted keys should not appear in generic runtime bag
      expect(s.runtime!._transport).toBeUndefined();
      expect(s.runtime!._rangeSupported).toBeUndefined();
      expect(s.runtime!.framesDecoded).toBe(5);
    });

    it("does not hoist if _rangeSupported is not a boolean", () => {
      const d = new Diagnostics();
      d.recordProbe(probeCtx("https://example.com/a.mp4"));
      d.recordRuntime({ _transport: "http-range", _rangeSupported: "yes" });
      // rangeSupported stays undefined — not hoisted
      expect(d.snapshot().rangeSupported).toBeUndefined();
    });
  });

  describe("recordStrategySwitch", () => {
    it("updates current strategy and appends to history", () => {
      const d = new Diagnostics();
      d.recordStrategySwitch("remux", "initial");
      d.recordStrategySwitch("fallback", "remux failed");
      const s = d.snapshot();
      expect(s.strategy).toBe("fallback");
      expect(s.reason).toBe("remux failed");
      expect(s.strategyHistory).toHaveLength(2);
      expect(s.strategyHistory![0].strategy).toBe("remux");
      expect(s.strategyHistory![1].strategy).toBe("fallback");
      expect(s.strategyHistory![1].at).toBeGreaterThan(0);
    });
  });

  describe("recordError", () => {
    it("includes error message in snapshot runtime", () => {
      const d = new Diagnostics();
      d.recordError(new Error("decode failed"));
      const s = d.snapshot();
      expect(s.runtime!.error).toBe("decode failed");
    });
  });

  describe("snapshot", () => {
    it("is frozen (immutable)", () => {
      const d = new Diagnostics();
      const s = d.snapshot();
      expect(Object.isFrozen(s)).toBe(true);
    });

    it("returns a copy of strategyHistory (not a shared reference)", () => {
      const d = new Diagnostics();
      d.recordStrategySwitch("remux", "test");
      const s1 = d.snapshot();
      d.recordStrategySwitch("fallback", "test2");
      const s2 = d.snapshot();
      // s1 should not be affected by later switches
      expect(s1.strategyHistory).toHaveLength(1);
      expect(s2.strategyHistory).toHaveLength(2);
    });

    it("omits strategyHistory when empty", () => {
      const d = new Diagnostics();
      expect(d.snapshot().strategyHistory).toBeUndefined();
    });
  });
});
