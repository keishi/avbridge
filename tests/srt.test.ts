import { describe, it, expect } from "vitest";
import { srtToVtt } from "../src/subtitles/srt.js";

describe("srtToVtt", () => {
  it("converts a single cue with comma timestamps", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello world`;
    const vtt = srtToVtt(srt);
    expect(vtt).toContain("WEBVTT");
    expect(vtt).toContain("00:00:01.000 --> 00:00:04.000");
    expect(vtt).toContain("Hello world");
  });

  it("handles CRLF line endings", () => {
    const srt = "1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n";
    const vtt = srtToVtt(srt);
    expect(vtt).toContain("Hi");
    expect(vtt).toContain("00:00:01.000 --> 00:00:02.000");
  });

  it("strips BOM", () => {
    const srt = "\ufeff1\n00:00:00,500 --> 00:00:01,500\nLine\n";
    expect(srtToVtt(srt)).toContain("WEBVTT");
  });

  it("handles multi-line cues", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Line one
Line two

2
00:00:05,000 --> 00:00:06,000
Solo`;
    const vtt = srtToVtt(srt);
    expect(vtt).toContain("Line one\nLine two");
    expect(vtt).toContain("Solo");
  });

  it("skips malformed timing lines", () => {
    const srt = `1
not a timing line
oops

2
00:00:01,000 --> 00:00:02,000
ok`;
    const vtt = srtToVtt(srt);
    expect(vtt).toContain("ok");
    expect(vtt).not.toContain("oops");
  });
});
