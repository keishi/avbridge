import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the probe routing logic by mocking the dependencies:
// - normalizeSource → returns a pre-built NormalizedSource
// - sniffNormalizedSource → returns a pre-determined container
// - probeWithMediabunny → success or failure
// - probeWithLibav (dynamic import of ./avi.js) → success or failure

// Mock the dependencies before importing probe
vi.mock("../src/util/source.js", () => ({
  normalizeSource: vi.fn(),
  sniffNormalizedSource: vi.fn(),
}));

vi.mock("../src/probe/mediabunny.js", () => ({
  probeWithMediabunny: vi.fn(),
}));

vi.mock("../src/probe/avi.js", () => ({
  probeWithLibav: vi.fn(),
}));

import { probe } from "../src/probe/index.js";
import { normalizeSource, sniffNormalizedSource } from "../src/util/source.js";
import { probeWithMediabunny } from "../src/probe/mediabunny.js";
import { probeWithLibav } from "../src/probe/avi.js";
import type { MediaContext } from "../src/types.js";
import type { NormalizedSource } from "../src/util/source.js";

const mockNormalize = vi.mocked(normalizeSource);
const mockSniff = vi.mocked(sniffNormalizedSource);
const mockMediabunny = vi.mocked(probeWithMediabunny);
const mockLibav = vi.mocked(probeWithLibav);

function fakeNormalized(): NormalizedSource {
  return {
    kind: "blob",
    blob: new Blob([]),
    byteLength: 100,
    original: new Blob([]),
  };
}

function fakeContext(partial?: Partial<MediaContext>): MediaContext {
  return {
    source: new Blob([]),
    container: "mp4",
    videoTracks: [],
    audioTracks: [],
    subtitleTracks: [],
    probedBy: "mediabunny",
    ...partial,
  } as MediaContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNormalize.mockResolvedValue(fakeNormalized());
  // Suppress console.warn/error from probe's fallback logging
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("probe routing", () => {
  it("routes mediabunny containers to probeWithMediabunny", async () => {
    mockSniff.mockResolvedValue("mp4");
    const ctx = fakeContext({ container: "mp4" });
    mockMediabunny.mockResolvedValue(ctx);

    const result = await probe(new Blob([]));
    expect(result).toBe(ctx);
    expect(mockMediabunny).toHaveBeenCalledOnce();
    expect(mockLibav).not.toHaveBeenCalled();
  });

  it("routes mpegts to mediabunny (not directly to libav)", async () => {
    mockSniff.mockResolvedValue("mpegts");
    mockMediabunny.mockResolvedValue(fakeContext({ container: "mpegts" }));

    const result = await probe(new Blob([]));
    expect(result.container).toBe("mpegts");
    expect(mockMediabunny).toHaveBeenCalledOnce();
  });

  it("routes AVI directly to libav (skips mediabunny)", async () => {
    mockSniff.mockResolvedValue("avi");
    const ctx = fakeContext({ container: "avi", probedBy: "libav" });
    mockLibav.mockResolvedValue(ctx);

    const result = await probe(new Blob([]));
    expect(result.container).toBe("avi");
    expect(mockMediabunny).not.toHaveBeenCalled();
    expect(mockLibav).toHaveBeenCalledOnce();
  });

  it("routes ASF directly to libav", async () => {
    mockSniff.mockResolvedValue("asf");
    mockLibav.mockResolvedValue(fakeContext({ container: "asf" }));

    await probe(new Blob([]));
    expect(mockMediabunny).not.toHaveBeenCalled();
    expect(mockLibav).toHaveBeenCalledOnce();
  });

  it("routes FLV directly to libav", async () => {
    mockSniff.mockResolvedValue("flv");
    mockLibav.mockResolvedValue(fakeContext({ container: "flv" }));

    await probe(new Blob([]));
    expect(mockMediabunny).not.toHaveBeenCalled();
    expect(mockLibav).toHaveBeenCalledOnce();
  });

  it("routes unknown container to libav", async () => {
    mockSniff.mockResolvedValue("unknown");
    mockLibav.mockResolvedValue(fakeContext({ container: "unknown" }));

    await probe(new Blob([]));
    expect(mockMediabunny).not.toHaveBeenCalled();
    expect(mockLibav).toHaveBeenCalledOnce();
  });

  // ── Fallback / escalation paths ─────────────────────────────────────

  it("falls back to libav when mediabunny rejects a supported container", async () => {
    mockSniff.mockResolvedValue("mp4");
    mockMediabunny.mockRejectedValue(new Error("unsupported sample entry mp4v"));
    const ctx = fakeContext({ container: "mp4", probedBy: "libav" });
    mockLibav.mockResolvedValue(ctx);

    const result = await probe(new Blob([]));
    expect(result).toBe(ctx);
    expect(mockMediabunny).toHaveBeenCalledOnce();
    expect(mockLibav).toHaveBeenCalledOnce();
  });

  it("surfaces both errors when mediabunny and libav both fail", async () => {
    mockSniff.mockResolvedValue("mkv");
    mockMediabunny.mockRejectedValue(new Error("mediabunny parse error"));
    mockLibav.mockRejectedValue(new Error("libav init failed"));

    await expect(probe(new Blob([])))
      .rejects.toThrow(/mediabunny: mediabunny parse error.*libav fallback: libav init failed/);
  });

  it("throws descriptive error when libav fails for AVI", async () => {
    mockSniff.mockResolvedValue("avi");
    mockLibav.mockRejectedValue(new Error("wasm load failed"));

    await expect(probe(new Blob([])))
      .rejects.toThrow(/AVI files require libav\.js.*wasm load failed/);
  });

  it("throws descriptive error when unknown container and libav fails", async () => {
    mockSniff.mockResolvedValue("unknown");
    mockLibav.mockRejectedValue(new Error("no demuxer found"));

    await expect(probe(new Blob([])))
      .rejects.toThrow(/container could not be identified.*no demuxer found/);
  });
});
