import { describe, it, expect } from "vitest";
import { classify } from "../src/classify/index.js";
import { mediabunnyVideoToAvbridge, mediabunnyAudioToAvbridge } from "../src/probe/mediabunny.js";
import type { MediaContext } from "../src/types.js";

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

describe("classify", () => {
  it("routes mp4/h264/aac/yuv420p to native", () => {
    const c = classify(
      ctx({
        container: "mp4",
        videoTracks: [
          { id: 0, codec: "h264", width: 1920, height: 1080, pixelFormat: "yuv420p", bitDepth: 8 },
        ],
        audioTracks: [{ id: 1, codec: "aac", channels: 2, sampleRate: 48000 }],
      }),
    );
    expect(c.strategy).toBe("native");
    expect(c.class).toBe("NATIVE");
  });

  it("routes mkv/h264/aac to remux", () => {
    const c = classify(
      ctx({
        container: "mkv",
        videoTracks: [
          { id: 0, codec: "h264", width: 1280, height: 720, pixelFormat: "yuv420p", bitDepth: 8 },
        ],
        audioTracks: [{ id: 1, codec: "aac", channels: 2, sampleRate: 48000 }],
      }),
    );
    expect(c.strategy).toBe("remux");
    expect(c.class).toBe("REMUX_CANDIDATE");
  });

  it("routes avi/h264/aac to hybrid or fallback depending on WebCodecs", () => {
    // The test runs in jsdom where VideoDecoder is undefined, so fallback
    const c = classify(
      ctx({
        container: "avi",
        videoTracks: [
          { id: 0, codec: "h264", width: 1280, height: 720, pixelFormat: "yuv420p", bitDepth: 8 },
        ],
        audioTracks: [{ id: 1, codec: "aac", channels: 2, sampleRate: 48000 }],
      }),
    );
    // In jsdom, VideoDecoder is not defined → fallback
    expect(["hybrid", "fallback"]).toContain(c.strategy);
  });

  it("routes wmv3 to fallback", () => {
    const c = classify(
      ctx({
        container: "asf",
        videoTracks: [{ id: 0, codec: "wmv3", width: 640, height: 480 }],
        audioTracks: [{ id: 1, codec: "wmav2", channels: 2, sampleRate: 44100 }],
      }),
    );
    expect(c.strategy).toBe("fallback");
    expect(c.class).toBe("FALLBACK_REQUIRED");
    expect(c.reason).toMatch(/wmv3/);
  });

  it("routes DivX (mpeg4) AVI to fallback", () => {
    const c = classify(
      ctx({
        container: "avi",
        videoTracks: [{ id: 0, codec: "mpeg4", width: 720, height: 480 }],
        audioTracks: [{ id: 1, codec: "mp3", channels: 2, sampleRate: 48000 }],
      }),
    );
    expect(c.strategy).toBe("fallback");
  });

  it("flags Hi10P H.264 as RISKY_NATIVE", () => {
    const c = classify(
      ctx({
        container: "mp4",
        videoTracks: [
          { id: 0, codec: "h264", profile: "High 10", bitDepth: 10, pixelFormat: "yuv420p10le", width: 1920, height: 1080 },
        ],
        audioTracks: [{ id: 1, codec: "aac", channels: 2, sampleRate: 48000 }],
      }),
    );
    expect(c.class).toBe("RISKY_NATIVE");
    expect(c.fallbackChain).toContain("remux");
  });

  it("audio-only mp3 → native", () => {
    const c = classify(
      ctx({
        container: "mp3",
        audioTracks: [{ id: 0, codec: "mp3", channels: 2, sampleRate: 44100 }],
      }),
    );
    expect(c.strategy).toBe("native");
  });

  it("audio-only WMA → fallback", () => {
    const c = classify(
      ctx({
        container: "asf",
        audioTracks: [{ id: 0, codec: "wmav2", channels: 2, sampleRate: 44100 }],
      }),
    );
    expect(c.strategy).toBe("fallback");
  });

  it("routes avi/h264/mp3 to hybrid when WebCodecs available", () => {
    // Simulate WebCodecs availability
    (globalThis as unknown as Record<string, unknown>).VideoDecoder = class {};
    try {
      const c = classify(
        ctx({
          container: "avi",
          videoTracks: [
            { id: 0, codec: "h264", width: 852, height: 480, pixelFormat: "yuv420p", bitDepth: 8 },
          ],
          audioTracks: [{ id: 1, codec: "mp3", channels: 2, sampleRate: 44100 }],
        }),
      );
      expect(c.strategy).toBe("hybrid");
      expect(c.class).toBe("HYBRID_CANDIDATE");
      expect(c.fallbackChain).toEqual(["fallback"]);
    } finally {
      delete (globalThis as unknown as Record<string, unknown>).VideoDecoder;
    }
  });

  it("routes avi/h264/mp3 to fallback when WebCodecs unavailable", () => {
    // Ensure VideoDecoder is not defined
    const saved = (globalThis as unknown as Record<string, unknown>).VideoDecoder;
    delete (globalThis as unknown as Record<string, unknown>).VideoDecoder;
    try {
      const c = classify(
        ctx({
          container: "avi",
          videoTracks: [
            { id: 0, codec: "h264", width: 852, height: 480, pixelFormat: "yuv420p", bitDepth: 8 },
          ],
          audioTracks: [{ id: 1, codec: "mp3", channels: 2, sampleRate: 44100 }],
        }),
      );
      expect(c.strategy).toBe("fallback");
    } finally {
      if (saved !== undefined) {
        (globalThis as unknown as Record<string, unknown>).VideoDecoder = saved;
      }
    }
  });

  it("routes an unknown video codec to fallback (does NOT silently relabel as h264)", () => {
    // Regression: mediabunnyVideoToAvbridge used to default to "h264" for any
    // unrecognized codec, which sent unsupported media down the native/remux
    // path and produced opaque playback failures.
    const c = classify(
      ctx({
        container: "mp4",
        videoTracks: [
          { id: 0, codec: mediabunnyVideoToAvbridge("some-future-codec"), width: 1920, height: 1080 },
        ],
        audioTracks: [{ id: 1, codec: "aac", channels: 2, sampleRate: 48000 }],
      }),
    );
    expect(c.strategy).toBe("fallback");
    expect(c.class).toBe("FALLBACK_REQUIRED");
    expect(c.reason).toContain("some-future-codec");
  });

  it("routes a null video codec to fallback as 'unknown'", () => {
    expect(mediabunnyVideoToAvbridge(null)).toBe("unknown");
    expect(mediabunnyVideoToAvbridge(undefined)).toBe("unknown");
    const c = classify(
      ctx({
        container: "mp4",
        videoTracks: [
          { id: 0, codec: mediabunnyVideoToAvbridge(null), width: 1920, height: 1080 },
        ],
      }),
    );
    expect(c.strategy).toBe("fallback");
  });

  it("does not silently relabel a null audio codec as aac", () => {
    expect(mediabunnyAudioToAvbridge(null)).toBe("unknown");
    expect(mediabunnyAudioToAvbridge(undefined)).toBe("unknown");
  });

  it("routes RealMedia rv40 + cook to fallback", () => {
    const c = classify(
      ctx({
        container: "rm",
        videoTracks: [{ id: 0, codec: "rv40", width: 640, height: 480 }],
        audioTracks: [{ id: 1, codec: "cook", channels: 2, sampleRate: 44100 }],
      }),
    );
    expect(c.strategy).toBe("fallback");
    expect(c.class).toBe("FALLBACK_REQUIRED");
    expect(c.reason).toContain("rv40");
  });

  it("routes RealMedia rv30 + ra_288 to fallback", () => {
    const c = classify(
      ctx({
        container: "rm",
        videoTracks: [{ id: 0, codec: "rv30", width: 320, height: 240 }],
        audioTracks: [{ id: 1, codec: "ra_288", channels: 1, sampleRate: 22050 }],
      }),
    );
    expect(c.strategy).toBe("fallback");
    expect(c.reason).toContain("rv30");
  });

  it("flags Hi10P with fallbackChain", () => {
    const c = classify(
      ctx({
        container: "mp4",
        videoTracks: [
          { id: 0, codec: "h264", profile: "High 10", bitDepth: 10, pixelFormat: "yuv420p10le", width: 1920, height: 1080 },
        ],
        audioTracks: [{ id: 1, codec: "aac", channels: 2, sampleRate: 48000 }],
      }),
    );
    expect(c.class).toBe("RISKY_NATIVE");
    expect(c.fallbackChain).toContain("remux");
    expect(c.fallbackChain).toContain("fallback");
  });
});
