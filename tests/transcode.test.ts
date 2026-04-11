import { describe, it, expect } from "vitest";
import {
  defaultVideoCodec,
  defaultAudioCodec,
  validateCodecCompatibility,
} from "../src/convert/transcode.js";

describe("defaultVideoCodec", () => {
  it("returns h264 for mp4", () => {
    expect(defaultVideoCodec("mp4")).toBe("h264");
  });

  it("returns h264 for mkv", () => {
    expect(defaultVideoCodec("mkv")).toBe("h264");
  });

  it("returns vp9 for webm", () => {
    expect(defaultVideoCodec("webm")).toBe("vp9");
  });
});

describe("defaultAudioCodec", () => {
  it("returns aac for mp4", () => {
    expect(defaultAudioCodec("mp4")).toBe("aac");
  });

  it("returns aac for mkv", () => {
    expect(defaultAudioCodec("mkv")).toBe("aac");
  });

  it("returns opus for webm", () => {
    expect(defaultAudioCodec("webm")).toBe("opus");
  });
});

describe("validateCodecCompatibility", () => {
  it("accepts mp4 + h264 + aac", () => {
    expect(() => validateCodecCompatibility("mp4", "h264", "aac")).not.toThrow();
  });

  it("accepts mp4 + h265 + aac", () => {
    expect(() => validateCodecCompatibility("mp4", "h265", "aac")).not.toThrow();
  });

  it("accepts mp4 + av1 + aac", () => {
    expect(() => validateCodecCompatibility("mp4", "av1", "aac")).not.toThrow();
  });

  it("accepts mkv + any modern combo", () => {
    expect(() => validateCodecCompatibility("mkv", "h264", "aac")).not.toThrow();
    expect(() => validateCodecCompatibility("mkv", "h265", "opus")).not.toThrow();
    expect(() => validateCodecCompatibility("mkv", "vp9", "flac")).not.toThrow();
  });

  it("accepts webm + vp9 + opus", () => {
    expect(() => validateCodecCompatibility("webm", "vp9", "opus")).not.toThrow();
  });

  it("accepts webm + av1 + opus", () => {
    expect(() => validateCodecCompatibility("webm", "av1", "opus")).not.toThrow();
  });

  it("rejects webm + h264 (wrong video codec)", () => {
    expect(() => validateCodecCompatibility("webm", "h264", "opus")).toThrow(
      /WebM does not support video codec "h264"/,
    );
  });

  it("rejects webm + h265 (wrong video codec)", () => {
    expect(() => validateCodecCompatibility("webm", "h265", "opus")).toThrow(
      /WebM does not support video codec "h265"/,
    );
  });

  it("rejects webm + aac (wrong audio codec)", () => {
    expect(() => validateCodecCompatibility("webm", "vp9", "aac")).toThrow(
      /WebM does not support audio codec "aac"/,
    );
  });

  it("rejects webm + flac (wrong audio codec)", () => {
    expect(() => validateCodecCompatibility("webm", "vp9", "flac")).toThrow(
      /WebM does not support audio codec "flac"/,
    );
  });
});
