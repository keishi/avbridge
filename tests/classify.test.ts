import { describe, it, expect } from "vitest";
import { classify } from "../src/classify/index.js";
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

  it("routes avi/h264/aac to fallback (mediabunny can't read AVI)", () => {
    const c = classify(
      ctx({
        container: "avi",
        videoTracks: [
          { id: 0, codec: "h264", width: 1280, height: 720, pixelFormat: "yuv420p", bitDepth: 8 },
        ],
        audioTracks: [{ id: 1, codec: "aac", channels: 2, sampleRate: 48000 }],
      }),
    );
    expect(c.strategy).toBe("fallback");
    expect(c.reason).toMatch(/cannot be remuxed/);
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
    expect(c.fallbackStrategy).toBe("remux");
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

  it("routes avi/h264/mp3 to fallback (mediabunny can't read AVI)", () => {
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
    expect(c.reason).toMatch(/cannot be remuxed/);
  });
});
