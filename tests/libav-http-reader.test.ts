import { describe, it, expect, beforeEach } from "vitest";
import { attachLibavHttpReader } from "../src/util/libav-http-reader.js";

// ─────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────

/**
 * Minimal libav.js double. Captures every `ff_block_reader_dev_send` call
 * so tests can assert what the reader replied to which `(pos, length)`
 * request. Exposes `triggerRead` for the test to simulate libav pulling
 * bytes.
 */
function makeFakeLibav(filename: string) {
  const sends: Array<{ pos: number; data: Uint8Array | null }> = [];
  let onblockread: ((name: string, pos: number, length: number) => void) | undefined;

  const libav = {
    async mkblockreaderdev(_name: string, _size: number) {},
    async unlinkreadaheadfile(_name: string) {},
    async ff_block_reader_dev_send(
      _name: string,
      pos: number,
      data: Uint8Array | null,
    ): Promise<void> {
      sends.push({ pos, data });
    },
    get onblockread() { return onblockread; },
    set onblockread(fn) { onblockread = fn; },
  };

  /** Simulate libav asking for `[pos, pos+length)` and wait for the reply. */
  async function triggerRead(pos: number, length: number): Promise<void> {
    const before = sends.length;
    onblockread?.(filename, pos, length);
    // Poll until a send is recorded — the reader dispatches async.
    for (let i = 0; i < 1000; i++) {
      if (sends.length > before) return;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error(`triggerRead(${pos}, ${length}): no reply after 1000 ticks`);
  }

  return { libav, sends, triggerRead };
}

/**
 * Fake fetch. First call returns a 206 probe ("0-0/SIZE"), subsequent
 * calls parse `Range: bytes=A-B` and return a fake buffer of the right
 * length. Counts calls per range so tests can verify cache hits.
 */
function makeFakeFetch(size: number) {
  const calls: Array<{ start: number; end: number }> = [];
  async function fetchFn(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range ?? "";
    const probeMatch = rangeHeader === "bytes=0-0";
    const rangeMatch = rangeHeader.match(/^bytes=(\d+)-(\d+)$/);
    if (probeMatch) {
      return new Response(new ArrayBuffer(1), {
        status: 206,
        headers: { "content-range": `bytes 0-0/${size}` },
      });
    }
    if (!rangeMatch) throw new Error(`fake fetch: no Range header (got "${rangeHeader}")`);
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    calls.push({ start, end });
    const len = end - start + 1;
    // Fill with deterministic bytes so tests can verify slice correctness.
    const buf = new Uint8Array(len);
    for (let i = 0; i < len; i++) buf[i] = (start + i) & 0xff;
    return new Response(buf, {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${size}` },
    });
  }
  return { fetchFn, calls };
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

const FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const URL = "https://example.test/media.avi";

describe("libav HTTP reader — LRU cache", () => {
  let fake: ReturnType<typeof makeFakeLibav>;

  beforeEach(() => {
    fake = makeFakeLibav("input.bin");
  });

  it("serves a repeated read from cache without a second fetch", async () => {
    const { fetchFn, calls } = makeFakeFetch(FILE_SIZE);
    const handle = await attachLibavHttpReader(fake.libav, "input.bin", URL, { fetchFn });

    // First read at pos=0 — one network fetch.
    await fake.triggerRead(0, 1024);
    // Non-probe calls so far.
    expect(calls.length).toBe(1);

    // Second read at pos=0 for the same window — cache hit, no new fetch.
    await fake.triggerRead(0, 1024);
    expect(calls.length).toBe(1);

    await handle.detach();
  });

  it("evicts the least-recently-used block when budget is exceeded", async () => {
    const { fetchFn, calls } = makeFakeFetch(FILE_SIZE);
    // Budget fits 2 blocks of 256 KB each (MIN_READ). A 3rd fetch should
    // evict the oldest.
    const handle = await attachLibavHttpReader(fake.libav, "input.bin", URL, {
      fetchFn,
      cacheBytes: 600 * 1024,
    });

    // Read A at pos=0 (fetch + cache).
    await fake.triggerRead(0, 1024);
    // Read B at pos=1_000_000 (fetch + cache).
    await fake.triggerRead(1_000_000, 1024);
    // Read C at pos=2_000_000 — evicts A (oldest).
    await fake.triggerRead(2_000_000, 1024);
    expect(calls.length).toBe(3);

    // Re-read C (most recent) — cache hit.
    await fake.triggerRead(2_000_000, 1024);
    expect(calls.length).toBe(3);

    // Re-read A — must fetch again (was evicted).
    await fake.triggerRead(0, 1024);
    expect(calls.length).toBe(4);

    await handle.detach();
  });

  it("promotes a block on access so it survives later eviction", async () => {
    const { fetchFn, calls } = makeFakeFetch(FILE_SIZE);
    const handle = await attachLibavHttpReader(fake.libav, "input.bin", URL, {
      fetchFn,
      cacheBytes: 600 * 1024,
    });

    // Fill with A then B. LRU order: [A, B] (A oldest).
    await fake.triggerRead(0, 1024);
    await fake.triggerRead(1_000_000, 1024);
    expect(calls.length).toBe(2);

    // Touch A — now LRU order is [B, A] (B is oldest).
    await fake.triggerRead(0, 1024);
    expect(calls.length).toBe(2); // still cached

    // Fetch C — evicts B, NOT A.
    await fake.triggerRead(2_000_000, 1024);
    expect(calls.length).toBe(3);

    // A must still be cached.
    await fake.triggerRead(0, 1024);
    expect(calls.length).toBe(3);

    // B must have been evicted.
    await fake.triggerRead(1_000_000, 1024);
    expect(calls.length).toBe(4);

    await handle.detach();
  });

  it("disables caching entirely when cacheBytes is 0", async () => {
    const { fetchFn, calls } = makeFakeFetch(FILE_SIZE);
    const handle = await attachLibavHttpReader(fake.libav, "input.bin", URL, {
      fetchFn,
      cacheBytes: 0,
    });

    await fake.triggerRead(0, 1024);
    await fake.triggerRead(0, 1024);
    await fake.triggerRead(0, 1024);
    expect(calls.length).toBe(3);

    await handle.detach();
  });

  it("returns cached data that matches the requested slice", async () => {
    const { fetchFn } = makeFakeFetch(FILE_SIZE);
    const handle = await attachLibavHttpReader(fake.libav, "input.bin", URL, { fetchFn });

    // Request 100 bytes starting at pos=50.
    await fake.triggerRead(50, 100);
    const firstReply = fake.sends.at(-1)!.data!;
    expect(firstReply.byteLength).toBe(100);
    // Fake fetch fills each byte with (start+i) & 0xff. Read-ahead fetched
    // from pos=50, so reply[0] should be 50 & 0xff.
    expect(firstReply[0]).toBe(50 & 0xff);
    expect(firstReply[99]).toBe((50 + 99) & 0xff);

    // Re-read a sub-window from cache.
    await fake.triggerRead(70, 30);
    const secondReply = fake.sends.at(-1)!.data!;
    expect(secondReply.byteLength).toBe(30);
    expect(secondReply[0]).toBe(70 & 0xff);
    expect(secondReply[29]).toBe((70 + 29) & 0xff);

    await handle.detach();
  });
});
