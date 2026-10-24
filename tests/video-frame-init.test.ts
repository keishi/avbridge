import { describe, it, expect } from "vitest";
import { videoFrameInit } from "../src/strategies/fallback/video-frame-init.js";

const layout = [{ offset: 0, stride: 640 }, { offset: 307200, stride: 320 }, { offset: 384000, stride: 320 }];
const frame = (over: object = {}) => ({ format: 0, width: 640, height: 480, layout, ...over });
const init = (over: object = {}, ts = 0) => videoFrameInit(frame(over), ts)!;

describe("videoFrameInit", () => {
  it("tags SD video BT.601 and HD BT.709, limited range", () => {
    expect(init().colorSpace).toEqual(
      { matrix: "smpte170m", primaries: "smpte170m", transfer: "smpte170m", fullRange: false });
    expect(init({ width: 1280, height: 720 }).colorSpace).toEqual(
      { matrix: "bt709", primaries: "bt709", transfer: "bt709", fullRange: false });
  });

  it("builds Motion JPEG's yuvj formats as full-range BT.601, at any size", () => {
    const got = init({ format: 13, width: 1920, height: 1080 }, 5);
    expect(got.format).toBe("I422");
    expect(got.colorSpace).toEqual({ matrix: "smpte170m", primaries: "smpte170m", transfer: "smpte170m", fullRange: true });
    expect(got.timestamp).toBe(5);
  });

  it("maps each planar format", () => {
    expect([0, 4, 5, 12, 13, 14].map((format) => init({ format }).format))
      .toEqual(["I420", "I422", "I444", "I420", "I422", "I444"]);
  });

  it("applies the pixel aspect ratio to the display size", () => {
    const got = init({ width: 320, height: 240, sample_aspect_ratio: [4, 3] });
    expect([got.displayWidth, got.displayHeight]).toEqual([427, 240]);
    expect(got.codedWidth).toBe(320);
  });

  it("ignores a square, missing or broken pixel aspect ratio", () => {
    for (const sar of [[1, 1], [0, 1], [1, 0], [1, 1000], [1000, 1]]) {
      expect(init({ sample_aspect_ratio: sar }).displayWidth).toBeUndefined();
    }
  });

  it("builds only planar YUV with planes and a size, leaving the rest to the bridge", () => {
    expect(videoFrameInit(frame({ format: 23 }), 0)).toBeNull(); // nv12: the bridge's
    expect(videoFrameInit(frame({ format: 7 }), 0)).toBeNull(); // yuv411p (DV): nobody's
    expect(videoFrameInit(frame({ layout: undefined }), 0)).toBeNull();
  });
});
