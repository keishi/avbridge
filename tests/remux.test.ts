import { describe, it, expect } from "vitest";
import { validateRemuxEligibility, mimeForFormat, generateFilename } from "../src/convert/remux.js";
import type { MediaContext } from "../src/types.js";

function ctx(partial: Partial<MediaContext>): MediaContext {
  return {
    source: new Blob([]),
    container: "mkv",
    videoTracks: [],
    audioTracks: [],
    subtitleTracks: [],
    probedBy: "mediabunny",
    ...partial,
  } as MediaContext;
}

describe("validateRemuxEligibility", () => {
  it("accepts h264 + aac", () => {
    expect(() =>
      validateRemuxEligibility(
        ctx({
          videoTracks: [{ id: 0, codec: "h264", width: 1920, height: 1080 }],
          audioTracks: [{ id: 1, codec: "aac", channels: 2, sampleRate: 48000 }],
        }),
        false,
      ),
    ).not.toThrow();
  });

  it("accepts h265 + opus", () => {
    expect(() =>
      validateRemuxEligibility(
        ctx({
          videoTracks: [{ id: 0, codec: "h265", width: 3840, height: 2160 }],
          audioTracks: [{ id: 1, codec: "opus", channels: 2, sampleRate: 48000 }],
        }),
        false,
      ),
    ).not.toThrow();
  });

  it("accepts vp9 + opus (webm-friendly)", () => {
    expect(() =>
      validateRemuxEligibility(
        ctx({
          videoTracks: [{ id: 0, codec: "vp9", width: 1920, height: 1080 }],
          audioTracks: [{ id: 1, codec: "opus", channels: 2, sampleRate: 48000 }],
        }),
        false,
      ),
    ).not.toThrow();
  });

  it("accepts av1 video", () => {
    expect(() =>
      validateRemuxEligibility(
        ctx({
          videoTracks: [{ id: 0, codec: "av1", width: 1920, height: 1080 }],
        }),
        false,
      ),
    ).not.toThrow();
  });

  it("accepts audio-only flac", () => {
    expect(() =>
      validateRemuxEligibility(
        ctx({
          audioTracks: [{ id: 0, codec: "flac", channels: 2, sampleRate: 96000 }],
        }),
        false,
      ),
    ).not.toThrow();
  });

  it("rejects wmv3 video codec", () => {
    expect(() =>
      validateRemuxEligibility(
        ctx({
          videoTracks: [{ id: 0, codec: "wmv3", width: 720, height: 480 }],
        }),
        false,
      ),
    ).toThrow(/Cannot remux.*wmv3.*transcode/);
  });

  it("rejects mpeg4 (DivX) video codec", () => {
    expect(() =>
      validateRemuxEligibility(
        ctx({
          videoTracks: [{ id: 0, codec: "mpeg4", width: 640, height: 480 }],
        }),
        false,
      ),
    ).toThrow(/Cannot remux.*mpeg4.*transcode/);
  });

  it("rejects wmav2 audio codec", () => {
    expect(() =>
      validateRemuxEligibility(
        ctx({
          videoTracks: [{ id: 0, codec: "h264", width: 1920, height: 1080 }],
          audioTracks: [{ id: 1, codec: "wmav2", channels: 2, sampleRate: 44100 }],
        }),
        false,
      ),
    ).toThrow(/Cannot remux.*wmav2.*transcode/);
  });

  it("rejects empty source (no tracks)", () => {
    expect(() => validateRemuxEligibility(ctx({}), false)).toThrow(
      /no video or audio/,
    );
  });

  it("allows h264 + mp3 in default mode", () => {
    expect(() =>
      validateRemuxEligibility(
        ctx({
          videoTracks: [{ id: 0, codec: "h264", width: 1920, height: 1080 }],
          audioTracks: [{ id: 1, codec: "mp3", channels: 2, sampleRate: 44100 }],
        }),
        false,
      ),
    ).not.toThrow();
  });

  it("rejects h264 + mp3 in strict mode", () => {
    expect(() =>
      validateRemuxEligibility(
        ctx({
          videoTracks: [{ id: 0, codec: "h264", width: 1920, height: 1080 }],
          audioTracks: [{ id: 1, codec: "mp3", channels: 2, sampleRate: 44100 }],
        }),
        true,
      ),
    ).toThrow(/strict mode.*H\.264 \+ MP3/);
  });
});

describe("mimeForFormat", () => {
  it("returns video/mp4 for mp4", () => {
    expect(mimeForFormat("mp4")).toBe("video/mp4");
  });

  it("returns video/webm for webm", () => {
    expect(mimeForFormat("webm")).toBe("video/webm");
  });

  it("returns video/x-matroska for mkv", () => {
    expect(mimeForFormat("mkv")).toBe("video/x-matroska");
  });
});

describe("generateFilename", () => {
  it("replaces extension with output format", () => {
    expect(generateFilename("movie.avi", "mp4")).toBe("movie.mp4");
    expect(generateFilename("movie.avi", "webm")).toBe("movie.webm");
    expect(generateFilename("movie.avi", "mkv")).toBe("movie.mkv");
  });

  it("handles files with multiple dots", () => {
    expect(generateFilename("my.home.video.mkv", "mp4")).toBe(
      "my.home.video.mp4",
    );
  });

  it("uses default name when no original name", () => {
    expect(generateFilename(undefined, "mp4")).toBe("output.mp4");
    expect(generateFilename(undefined, "webm")).toBe("output.webm");
    expect(generateFilename(undefined, "mkv")).toBe("output.mkv");
  });
});
