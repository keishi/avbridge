import { describe, it, expect } from "vitest";
import { makeTimeRanges } from "../src/util/time-ranges.js";

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
