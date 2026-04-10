import { describe, it, expect } from "vitest";
import { sniffContainer } from "../src/util/source.js";

function blob(bytes: number[], pad = 32): Blob {
  const u = new Uint8Array(Math.max(bytes.length, pad));
  u.set(bytes);
  return new Blob([u]);
}

describe("sniffContainer", () => {
  it("detects AVI from RIFF/AVI signature", async () => {
    const head = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20];
    expect(await sniffContainer(blob(head))).toBe("avi");
  });

  it("detects WAV from RIFF/WAVE", async () => {
    const head = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45];
    expect(await sniffContainer(blob(head))).toBe("wav");
  });

  it("detects MKV from EBML header", async () => {
    expect(await sniffContainer(blob([0x1a, 0x45, 0xdf, 0xa3]))).toBe("mkv");
  });

  it("detects MP4 from ftyp box", async () => {
    const head = [0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d];
    expect(await sniffContainer(blob(head))).toBe("mp4");
  });

  it("detects ASF from GUID prefix", async () => {
    const head = [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11];
    expect(await sniffContainer(blob(head))).toBe("asf");
  });

  it("returns unknown for garbage", async () => {
    expect(await sniffContainer(blob([1, 2, 3, 4]))).toBe("unknown");
  });
});
