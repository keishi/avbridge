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
});
