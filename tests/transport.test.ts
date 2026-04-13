import { describe, it, expect } from "vitest";
import { mergeFetchInit, fetchWith } from "../src/util/transport.js";

describe("mergeFetchInit", () => {
  it("returns undefined when both inputs are undefined", () => {
    expect(mergeFetchInit(undefined, undefined)).toBeUndefined();
  });

  it("returns base when extra is undefined", () => {
    const base: RequestInit = { credentials: "include" };
    expect(mergeFetchInit(base, undefined)).toEqual({ credentials: "include", headers: {} });
  });

  it("returns extra when base is undefined", () => {
    const extra: RequestInit = { mode: "cors" };
    expect(mergeFetchInit(undefined, extra)).toEqual({ mode: "cors", headers: {} });
  });

  it("merges headers from both without overwriting", () => {
    const result = mergeFetchInit(
      { headers: { Authorization: "Bearer token" } },
      { headers: { Range: "bytes=0-1023" } },
    );
    expect(result?.headers).toEqual({
      Authorization: "Bearer token",
      Range: "bytes=0-1023",
    });
  });

  it("extra headers override base headers on conflict", () => {
    const result = mergeFetchInit(
      { headers: { Accept: "text/plain" } },
      { headers: { Accept: "application/json" } },
    );
    expect(result?.headers).toEqual({ Accept: "application/json" });
  });

  it("extra body fields override base", () => {
    const result = mergeFetchInit(
      { credentials: "include", mode: "cors" },
      { credentials: "same-origin" },
    );
    expect(result?.credentials).toBe("same-origin");
    expect(result?.mode).toBe("cors");
  });
});

describe("fetchWith", () => {
  it("returns globalThis.fetch when no transport provided", () => {
    expect(fetchWith()).toBe(globalThis.fetch);
  });

  it("returns globalThis.fetch when transport has no fetchFn", () => {
    expect(fetchWith({})).toBe(globalThis.fetch);
  });

  it("returns custom fetchFn when provided", () => {
    const custom = async () => new Response();
    expect(fetchWith({ fetchFn: custom })).toBe(custom);
  });
});
