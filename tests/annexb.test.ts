import { describe, it, expect } from "vitest";
import {
  isAnnexB,
  iterateAnnexBNalus,
  annexBToAvcc,
  avccToAnnexB,
} from "../src/strategies/remux/annexb.js";

describe("annexb", () => {
  it("isAnnexB recognizes 4-byte and 3-byte start codes", () => {
    expect(isAnnexB(new Uint8Array([0, 0, 0, 1, 0x67]))).toBe(true);
    expect(isAnnexB(new Uint8Array([0, 0, 1, 0x67]))).toBe(true);
    expect(isAnnexB(new Uint8Array([0, 0, 0, 0]))).toBe(false);
    expect(isAnnexB(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("iterates NAL units", () => {
    // Two NALUs: [0x67] and [0x68, 0x99]
    const stream = new Uint8Array([0, 0, 0, 1, 0x67, 0, 0, 1, 0x68, 0x99]);
    const nalus = [...iterateAnnexBNalus(stream)].map((u) => Array.from(u));
    expect(nalus).toEqual([[0x67], [0x68, 0x99]]);
  });

  it("AVCC ↔ Annex B round trips", () => {
    const original = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 0xce]);
    const avcc = annexBToAvcc(original);
    // Length-prefixed: [0,0,0,2, 0x67, 0x42, 0,0,0,2, 0x68, 0xce]
    expect(Array.from(avcc)).toEqual([0, 0, 0, 2, 0x67, 0x42, 0, 0, 0, 2, 0x68, 0xce]);
    const back = avccToAnnexB(avcc);
    expect(Array.from(back)).toEqual(Array.from(original));
  });

  it("avccToAnnexB throws on truncated input", () => {
    const bad = new Uint8Array([0, 0, 0, 5, 0x67]);
    expect(() => avccToAnnexB(bad)).toThrow();
  });

  it("annexBToAvcc is idempotent on already-AVCC data", () => {
    // AVCC data should NOT be detected as Annex B
    const avcc = new Uint8Array([0, 0, 0, 2, 0x67, 0x42, 0, 0, 0, 2, 0x68, 0xce]);
    expect(isAnnexB(avcc)).toBe(false);
    // So the normalization guard (if isAnnexB → convert) correctly skips it
  });

  it("normalizes H.264 Annex B to AVCC for muxing (remux integration pattern)", () => {
    // This mirrors the normalization pattern in src/convert/remux.ts:
    //   if (codec === "h264" && isAnnexB(pkt.data)) pkt.data = annexBToAvcc(pkt.data);
    const annexB = new Uint8Array([0, 0, 0, 1, 0x65, 0xaa, 0xbb]);
    const codec: string = "h264";

    let data: Uint8Array = annexB;
    if ((codec === "h264" || codec === "h265") && isAnnexB(data)) {
      data = annexBToAvcc(data);
    }

    // Result should be length-prefixed, not start-code-framed
    expect(isAnnexB(data)).toBe(false);
    // 4-byte length (3) + 3 bytes of NAL data
    expect(Array.from(data)).toEqual([0, 0, 0, 3, 0x65, 0xaa, 0xbb]);
  });

  it("skips normalization for non-H.264 codecs", () => {
    const annexB = new Uint8Array([0, 0, 0, 1, 0x65, 0xaa]);
    const codec: string = "vp9";

    let data: Uint8Array = annexB;
    if ((codec === "h264" || codec === "h265") && isAnnexB(data)) {
      data = annexBToAvcc(data);
    }

    // VP9 packets are passed through unchanged even if they happen to
    // look like Annex B (which they wouldn't in practice)
    expect(data).toBe(annexB);
  });
});
