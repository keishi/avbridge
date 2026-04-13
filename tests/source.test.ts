import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { normalizeSource, sniffContainerFromBytes } from "../src/util/source.js";

// ── sniffContainerFromBytes (exhaustive magic-byte tests) ───────────────

describe("sniffContainerFromBytes", () => {
  function bytes(...values: number[]): Uint8Array {
    return new Uint8Array(values);
  }

  /** Create a buffer of `size` zeros with specific bytes set. */
  function sparse(size: number, patches: Record<number, number>): Uint8Array {
    const buf = new Uint8Array(size);
    for (const [offset, val] of Object.entries(patches)) {
      buf[Number(offset)] = val;
    }
    return buf;
  }

  it("detects MPEG-TS from dual 0x47 sync bytes", () => {
    expect(sniffContainerFromBytes(sparse(376, { 0: 0x47, 188: 0x47 }))).toBe("mpegts");
  });

  it("detects M2TS variant (4-byte prefix)", () => {
    expect(sniffContainerFromBytes(sparse(380, { 4: 0x47, 192: 0x47 }))).toBe("mpegts");
  });

  it("detects AVI from RIFF....AVI header", () => {
    // RIFF at 0-3, AVI at 8-10
    expect(sniffContainerFromBytes(bytes(
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
      0x41, 0x56, 0x49, 0x20,
    ))).toBe("avi");
  });

  it("detects WAV from RIFF....WAVE header", () => {
    expect(sniffContainerFromBytes(bytes(
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45,
    ))).toBe("wav");
  });

  it("detects MKV/WebM from EBML header", () => {
    expect(sniffContainerFromBytes(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe("mkv");
  });

  it("detects MP4 from ftyp at offset 4", () => {
    // ftyp at 4-7, brand "isom" at 8-11
    expect(sniffContainerFromBytes(bytes(
      0x00, 0x00, 0x00, 0x20,
      0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d, // "isom"
    ))).toBe("mp4");
  });

  it("detects MOV from ftyp with qt brand", () => {
    expect(sniffContainerFromBytes(bytes(
      0x00, 0x00, 0x00, 0x14,
      0x66, 0x74, 0x79, 0x70,
      0x71, 0x74, 0x20, 0x20, // "qt  "
    ))).toBe("mov");
  });

  it("detects ASF/WMV from ASF GUID", () => {
    expect(sniffContainerFromBytes(bytes(
      0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11,
    ))).toBe("asf");
  });

  it("detects FLV", () => {
    expect(sniffContainerFromBytes(bytes(0x46, 0x4c, 0x56))).toBe("flv");
  });

  it("detects RealMedia from .RMF header", () => {
    expect(sniffContainerFromBytes(bytes(0x2e, 0x52, 0x4d, 0x46))).toBe("rm");
  });

  it("detects Ogg", () => {
    expect(sniffContainerFromBytes(bytes(0x4f, 0x67, 0x67, 0x53))).toBe("ogg");
  });

  it("detects FLAC", () => {
    expect(sniffContainerFromBytes(bytes(0x66, 0x4c, 0x61, 0x43))).toBe("flac");
  });

  it("detects MP3 from ID3v2 tag", () => {
    expect(sniffContainerFromBytes(bytes(0x49, 0x44, 0x33))).toBe("mp3");
  });

  it("detects MP3 from frame sync", () => {
    // FF FB = MPEG1 Layer3
    expect(sniffContainerFromBytes(bytes(0xff, 0xfb))).toBe("mp3");
  });

  it("detects ADTS from FF F1", () => {
    expect(sniffContainerFromBytes(bytes(0xff, 0xf1))).toBe("adts");
  });

  it("detects ADTS from FF F9", () => {
    expect(sniffContainerFromBytes(bytes(0xff, 0xf9))).toBe("adts");
  });

  it("returns unknown for empty buffer", () => {
    expect(sniffContainerFromBytes(new Uint8Array(0))).toBe("unknown");
  });

  it("returns unknown for unrecognized bytes", () => {
    expect(sniffContainerFromBytes(bytes(0x00, 0x00, 0x00, 0x00))).toBe("unknown");
  });

  it("needs >= 376 bytes for MPEG-TS (short buffer returns unknown)", () => {
    // Set sync bytes but buffer is too short
    expect(sniffContainerFromBytes(sparse(375, { 0: 0x47, 188: 0x47 }))).toBe("unknown");
  });
});

// ── normalizeSource ─────────────────────────────────────────────────────

describe("normalizeSource", () => {
  it("wraps Blob as blob-kind", async () => {
    const blob = new Blob(["hello"]);
    const result = await normalizeSource(blob);
    expect(result.kind).toBe("blob");
    expect(result.byteLength).toBe(5);
    expect(result.original).toBe(blob);
  });

  it("wraps File as blob-kind with name", async () => {
    const file = new File(["data"], "video.mp4", { type: "video/mp4" });
    const result = await normalizeSource(file);
    expect(result.kind).toBe("blob");
    expect(result.name).toBe("video.mp4");
    expect(result.byteLength).toBe(4);
    expect(result.original).toBe(file);
  });

  it("wraps ArrayBuffer as blob-kind", async () => {
    const ab = new ArrayBuffer(16);
    const result = await normalizeSource(ab);
    expect(result.kind).toBe("blob");
    expect(result.byteLength).toBe(16);
    expect(result.original).toBe(ab);
  });

  it("wraps Uint8Array as blob-kind", async () => {
    const u8 = new Uint8Array([1, 2, 3, 4]);
    const result = await normalizeSource(u8);
    expect(result.kind).toBe("blob");
    expect(result.byteLength).toBe(4);
    expect(result.original).toBe(u8);
  });

  it("throws TypeError for unsupported source type", async () => {
    await expect(normalizeSource(42 as unknown as Blob)).rejects.toThrow("unsupported source type");
  });

  // URL source tests — need mocked fetch
  describe("URL sources", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("fetches URL with Range header and returns url-kind", async () => {
      const body = new Uint8Array(1024);
      let capturedHeaders: Record<string, string> = {};

      globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = Object.fromEntries(
          Object.entries(init?.headers ?? {}),
        );
        return new Response(body, {
          status: 206,
          headers: {
            "Content-Range": "bytes 0-1023/50000",
          },
        });
      }) as unknown as typeof fetch;

      const result = await normalizeSource("https://example.com/video.mp4");
      expect(result.kind).toBe("url");
      if (result.kind !== "url") throw new Error("expected url");
      expect(result.url).toBe("https://example.com/video.mp4");
      expect(result.byteLength).toBe(50000);
      expect(result.name).toBe("video.mp4");
      expect(capturedHeaders.Range).toMatch(/^bytes=0-/);
    });

    it("parses total size from Content-Range header", async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response(new Uint8Array(100), {
          status: 206,
          headers: { "Content-Range": "bytes 0-99/999999" },
        });
      }) as unknown as typeof fetch;

      const result = await normalizeSource("https://example.com/big.mkv");
      if (result.kind !== "url") throw new Error("expected url");
      expect(result.byteLength).toBe(999999);
    });

    it("falls back to Content-Length for 200 response (no range support)", async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response(new Uint8Array(500), {
          status: 200,
          headers: { "Content-Length": "500" },
        });
      }) as unknown as typeof fetch;

      const result = await normalizeSource("https://example.com/small.mp4");
      if (result.kind !== "url") throw new Error("expected url");
      expect(result.byteLength).toBe(500);
    });

    it("extracts filename from URL path, stripping query", async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(new Uint8Array(10), { status: 200 }),
      ) as unknown as typeof fetch;

      const result = await normalizeSource("https://cdn.example.com/media/clip.avi?token=abc123");
      if (result.kind !== "url") throw new Error("expected url");
      expect(result.name).toBe("clip.avi");
    });

    it("handles URL object input", async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(new Uint8Array(10), { status: 200 }),
      ) as unknown as typeof fetch;

      const url = new URL("https://example.com/test.webm");
      const result = await normalizeSource(url);
      if (result.kind !== "url") throw new Error("expected url");
      expect(result.url).toBe("https://example.com/test.webm");
      expect(result.original).toBe(url);
    });

    it("throws on fetch failure", async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error("network error");
      }) as unknown as typeof fetch;

      await expect(normalizeSource("https://example.com/fail.mp4"))
        .rejects.toThrow("Failed to fetch source");
    });

    it("throws on non-OK response", async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(null, { status: 403, statusText: "Forbidden" }),
      ) as unknown as typeof fetch;

      await expect(normalizeSource("https://example.com/denied.mp4"))
        .rejects.toThrow("403 Forbidden");
    });
  });
});
