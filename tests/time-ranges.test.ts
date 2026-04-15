import { describe, it, expect } from "vitest";
import { makeTimeRanges } from "../src/util/time-ranges.js";
import { packetPtsSec } from "../src/util/libav-demux.js";

describe("makeTimeRanges", () => {
  it("exposes length matching input count", () => {
    expect(makeTimeRanges([]).length).toBe(0);
    expect(makeTimeRanges([[0, 10]]).length).toBe(1);
    expect(makeTimeRanges([[0, 5], [10, 15]]).length).toBe(2);
  });

  it("start(i) and end(i) return the given bounds", () => {
    const tr = makeTimeRanges([[0, 30], [45, 60]]);
    expect(tr.start(0)).toBe(0);
    expect(tr.end(0)).toBe(30);
    expect(tr.start(1)).toBe(45);
    expect(tr.end(1)).toBe(60);
  });

  it("throws DOMException with IndexSizeError on out-of-range access", () => {
    const tr = makeTimeRanges([[0, 10]]);
    expect(() => tr.start(-1)).toThrow(DOMException);
    expect(() => tr.start(1)).toThrow(DOMException);
    expect(() => tr.end(5)).toThrow(DOMException);
  });

  it("is defensively copied from the input array", () => {
    const input: Array<[number, number]> = [[0, 10]];
    const tr = makeTimeRanges(input);
    input.push([20, 30]);
    // Our snapshot should not reflect the post-construction mutation.
    expect(tr.length).toBe(1);
  });

  it("empty ranges object works — length 0, access throws", () => {
    const tr = makeTimeRanges([]);
    expect(tr.length).toBe(0);
    expect(() => tr.start(0)).toThrow(DOMException);
  });
});

describe("packetPtsSec", () => {
  it("returns null on AV_NOPTS_VALUE packets (hi=INT32_MIN, lo=0)", () => {
    expect(packetPtsSec({ pts: 0, ptshi: -2147483648 }, [1, 90000])).toBeNull();
  });

  it("returns null on non-finite pts", () => {
    expect(packetPtsSec({ pts: NaN, ptshi: 0 }, [1, 90000])).toBeNull();
    expect(packetPtsSec({ pts: Infinity, ptshi: 0 }, [1, 90000])).toBeNull();
  });

  it("returns null on missing / zero time_base_den", () => {
    expect(packetPtsSec({ pts: 9000, ptshi: 0 }, [1, 0])).toBeNull();
    expect(packetPtsSec({ pts: 9000, ptshi: 0 }, [0, 90000])).toBeNull();
  });

  it("converts common 90 kHz time_base correctly", () => {
    // 90000 units = 1 s at 1/90000
    expect(packetPtsSec({ pts: 90000, ptshi: 0 }, [1, 90000])).toBe(1);
    expect(packetPtsSec({ pts: 45000, ptshi: 0 }, [1, 90000])).toBe(0.5);
  });

  it("converts µs time_base", () => {
    expect(packetPtsSec({ pts: 1_500_000, ptshi: 0 }, [1, 1_000_000])).toBe(1.5);
  });

  it("defaults to µs time_base when none passed", () => {
    expect(packetPtsSec({ pts: 2_000_000, ptshi: 0 }, undefined)).toBe(2);
  });

  it("handles 64-bit pts via hi/lo split", () => {
    // hi=1 means pts is 2^32 + lo
    const pts64 = 0x100000000 + 45000;
    expect(packetPtsSec({ pts: 45000, ptshi: 1 }, [1, 90000])).toBeCloseTo(pts64 / 90000, 6);
  });
});
