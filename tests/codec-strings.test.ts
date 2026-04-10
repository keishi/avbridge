import { describe, it, expect } from "vitest";
import { videoCodecString, audioCodecString, mp4MimeFor } from "../src/util/codec-strings.js";

describe("codec strings", () => {
  it("builds avc1 string for h264 high profile level 4.0", () => {
    const s = videoCodecString({
      id: 0,
      codec: "h264",
      profile: "High",
      level: 40,
      width: 1920,
      height: 1080,
    });
    expect(s).toBe("avc1.640028");
  });

  it("baseline H.264", () => {
    expect(
      videoCodecString({
        id: 0,
        codec: "h264",
        profile: "Baseline",
        level: 31,
        width: 640,
        height: 480,
      }),
    ).toBe("avc1.42001f");
  });

  it("aac → mp4a.40.2", () => {
    expect(audioCodecString({ id: 0, codec: "aac", channels: 2, sampleRate: 48000 })).toBe(
      "mp4a.40.2",
    );
  });

  it("composes a full MP4 MIME with both codecs", () => {
    const mime = mp4MimeFor(
      { id: 0, codec: "h264", profile: "High", level: 40, width: 1920, height: 1080 },
      { id: 1, codec: "aac", channels: 2, sampleRate: 48000 },
    );
    expect(mime).toBe('video/mp4; codecs="avc1.640028,mp4a.40.2"');
  });

  it("returns null for unknown video codecs", () => {
    expect(
      videoCodecString({ id: 0, codec: "wmv3", width: 320, height: 240 }),
    ).toBeNull();
  });
});
