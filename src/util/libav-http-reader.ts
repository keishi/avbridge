/**
 * libav.js HTTP block reader.
 *
 * Wraps `libav.mkblockreaderdev` + `libav.onblockread` +
 * `libav.ff_block_reader_dev_send` so that libav can demux a remote file
 * via HTTP Range requests instead of needing the entire file in memory.
 *
 * Used by the AVI/ASF/FLV probe path and the libav-backed playback /
 * conversion strategies whenever the source is a URL.
 *
 * Design notes:
 *
 * - **Range support detection** is done by issuing a `Range: bytes=0-0`
 *   probe request. We do NOT trust `Accept-Ranges` headers — some servers
 *   support ranges but don't advertise them, others advertise but don't.
 *   The probe request is the canonical signal: a `206 Partial Content`
 *   response means we can stream; anything else fails fast with a clear
 *   error. We never silently fall back to a full download.
 *
 * - **Sequential reads.** libav can issue overlapping `onblockread`
 *   callbacks. The reader serializes them through a single async queue
 *   so a) `ff_block_reader_dev_send` calls are well-ordered and b) we
 *   never have two in-flight fetches for unrelated reads. Throughput
 *   for v1 is "good enough"; correctness > parallelism.
 *
 * - **In-flight dedup.** If libav asks for `(pos=1000, len=4096)` twice
 *   in a row before the first request resolves, the second call awaits
 *   the first instead of issuing a duplicate fetch. This handles the
 *   "demuxer re-reads the same header" pattern cheaply.
 *
 * - **Read-ahead clamp.** libav's requested length is doubled, then
 *   clamped to `[256 KB, 1 MB]`. Small reads get amortized; pathological
 *   large requests don't OOM us.
 *
 * - **Last-block cache.** Only the most-recent fetched block is kept.
 *   Re-fetches via Range are cheap; an LRU cache is post-1.0.
 *
 * - **Safe detach.** `detach()` clears `libav.onblockread`, sets a
 *   destroyed flag, and ignores any in-flight fetch resolutions so we
 *   never write into a torn-down demuxer.
 */

const MIN_READ = 256 * 1024;
const MAX_READ = 1 * 1024 * 1024;

interface LibavLike {
  mkblockreaderdev(name: string, size: number): Promise<void>;
  unlinkreadaheadfile(name: string): Promise<void>;
  ff_block_reader_dev_send(
    name: string,
    pos: number,
    data: Uint8Array | null,
    opts?: { errorCode?: number; error?: unknown },
  ): Promise<void>;
  onblockread?: (filename: string, pos: number, length: number) => void;
}

export interface LibavHttpReaderHandle {
  /** Total file size (bytes) reported by the server. */
  readonly size: number;
  /** Always `"http-range"` for now. Reserved for future transports. */
  readonly transport: "http-range";
  /** Stop serving reads, clear the libav callback, and ignore late fetches. */
  detach(): Promise<void>;
}

export interface AttachLibavHttpReaderOptions {
  /** Optional `RequestInit` extras (mode, credentials, headers, etc.). */
  requestInit?: RequestInit;
  /** Override fetch (for testing). Defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
}

/**
 * Result of preparing a libav-readable file from a normalized source.
 * Either an in-memory Blob (created via `mkreadaheadfile`) or a streaming
 * HTTP reader (created via `attachLibavHttpReader`). Callers should
 * `await detach()` when done so resources are cleaned up symmetrically.
 */
export interface LibavInputHandle {
  /** The virtual filename libav sees — pass to `ff_init_demuxer_file`. */
  readonly filename: string;
  /** "blob" for in-memory, "http-range" for streaming URL. */
  readonly transport: "blob" | "http-range";
  /** Total file size in bytes if known, otherwise undefined. */
  readonly size: number | undefined;
  /** Tear down the virtual file (and any HTTP reader state). */
  detach(): Promise<void>;
}

interface LibavLikeWithBlob extends LibavLike {
  mkreadaheadfile(name: string, blob: Blob): Promise<void>;
}

/**
 * Convenience for the libav-backed strategies. Given a normalized source,
 * either creates an in-memory readahead file (for Blob inputs) or attaches
 * the HTTP block reader (for URL inputs). Returns a handle the caller
 * should detach when done.
 */
export async function prepareLibavInput(
  libav: LibavLikeWithBlob,
  filename: string,
  source: import("./source.js").NormalizedSource,
): Promise<LibavInputHandle> {
  if (source.kind === "url") {
    const handle = await attachLibavHttpReader(libav, filename, source.url);
    return {
      filename,
      transport: "http-range",
      size: handle.size,
      detach: () => handle.detach(),
    };
  }
  await libav.mkreadaheadfile(filename, source.blob);
  return {
    filename,
    transport: "blob",
    size: source.byteLength,
    detach: async () => {
      try { await libav.unlinkreadaheadfile(filename); } catch { /* ignore */ }
    },
  };
}

/**
 * Attach an HTTP block reader to a libav.js instance. After this resolves,
 * libav can `ff_init_demuxer_file(filename)` and the demuxer will pull
 * bytes via Range requests instead of needing a Blob.
 *
 * Fails fast (before any libav setup) if the server doesn't support
 * Range requests.
 */
export async function attachLibavHttpReader(
  libav: LibavLike,
  filename: string,
  url: string,
  options: AttachLibavHttpReaderOptions = {},
): Promise<LibavHttpReaderHandle> {
  const fetchFn = options.fetchFn ?? fetch;

  // 1. Probe the server with a single-byte Range request.
  let probeRes: Response;
  try {
    probeRes = await fetchFn(url, {
      ...options.requestInit,
      headers: {
        ...(options.requestInit?.headers ?? {}),
        Range: "bytes=0-0",
      },
    });
  } catch (err) {
    throw new Error(
      `libav HTTP reader: failed to reach ${url}: ${(err as Error).message}`,
    );
  }
  if (probeRes.status !== 206) {
    // 200 means the server ignored Range and would have sent the whole
    // file. We refuse to silently slurp gigabytes.
    throw new Error(
      `libav HTTP reader: ${url} does not support HTTP Range requests ` +
      `(server returned ${probeRes.status} for a Range probe; need 206 Partial Content). ` +
      `Remote AVI/ASF/FLV playback requires a server that honors byte-range requests.`,
    );
  }

  // 2. Parse total file size from Content-Range: "bytes 0-0/12345678"
  const contentRange = probeRes.headers.get("content-range") ?? "";
  const sizeMatch = contentRange.match(/\/(\d+)$/);
  if (!sizeMatch) {
    throw new Error(
      `libav HTTP reader: ${url} returned 206 but no parseable Content-Range header (got: "${contentRange}")`,
    );
  }
  const size = parseInt(sizeMatch[1], 10);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(
      `libav HTTP reader: ${url} reported invalid file size ${size}`,
    );
  }

  // Drain the probe body so the connection can be reused.
  try { await probeRes.arrayBuffer(); } catch { /* ignore */ }

  // 3. Create the virtual file libav will read from.
  await libav.mkblockreaderdev(filename, size);

  // ── State ───────────────────────────────────────────────────────────────

  let detached = false;
  // Most-recently fetched block. Cached so re-reads of the same region
  // (e.g. demuxer re-walks the header) don't issue another HTTP request.
  let cached: { pos: number; bytes: Uint8Array } | null = null;
  // The currently in-flight fetch, if any. Used both for serialization
  // (we await this before starting another) and for in-flight dedup.
  let inflight: Promise<void> | null = null;

  function clampReadLength(requested: number): number {
    const doubled = requested * 2;
    if (doubled < MIN_READ) return MIN_READ;
    if (doubled > MAX_READ) return MAX_READ;
    return doubled;
  }

  /** True if the cached block fully covers `[pos, pos+length)`. */
  function cacheCovers(pos: number, length: number): boolean {
    if (!cached) return false;
    return pos >= cached.pos && pos + length <= cached.pos + cached.bytes.byteLength;
  }

  /** Slice the requested window out of the cached block. */
  function sliceFromCache(pos: number, length: number): Uint8Array {
    if (!cached) throw new Error("sliceFromCache called with no cache");
    const offset = pos - cached.pos;
    return cached.bytes.subarray(offset, offset + length);
  }

  /** Fetch one Range and update the cache. */
  async function fetchRange(pos: number, length: number): Promise<Uint8Array> {
    const end = Math.min(pos + length - 1, size - 1);
    const res = await fetchFn(url, {
      ...options.requestInit,
      headers: {
        ...(options.requestInit?.headers ?? {}),
        Range: `bytes=${pos}-${end}`,
      },
    });
    if (res.status !== 206 && res.status !== 200) {
      throw new Error(
        `libav HTTP reader: Range request bytes=${pos}-${end} returned ${res.status}`,
      );
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    cached = { pos, bytes: buf };
    return buf;
  }

  /**
   * Handle a single libav read request. Serializes against any in-flight
   * read by chaining off `inflight`. Honors `detached` at every async
   * boundary so a torn-down reader never writes back into libav.
   */
  async function handleRead(name: string, pos: number, length: number): Promise<void> {
    // Wait for any preceding read to finish so we don't interleave.
    if (inflight) {
      try { await inflight; } catch { /* ignore — that read's own caller handled it */ }
    }
    if (detached) return;

    // Cache hit — reply directly without a network round-trip.
    if (cacheCovers(pos, length)) {
      const data = sliceFromCache(pos, length);
      try { await libav.ff_block_reader_dev_send(name, pos, data); } catch { /* ignore — libav may have torn down */ }
      return;
    }

    // Cache miss — fetch via Range. Read-ahead amortizes small reads.
    const fetchLen = clampReadLength(length);
    const fetched = (async () => {
      try {
        const buf = await fetchRange(pos, fetchLen);
        if (detached) return;
        // Slice exactly what libav asked for and send it back.
        const reply = buf.subarray(0, Math.min(length, buf.byteLength));
        try { await libav.ff_block_reader_dev_send(name, pos, reply); } catch { /* ignore */ }
      } catch (err) {
        if (detached) return;
        // Signal EOF + error code to libav so the demuxer surfaces it.
        try {
          await libav.ff_block_reader_dev_send(name, pos, null, {
            error: err,
          });
        } catch { /* ignore */ }
      }
    })();
    inflight = fetched;
    try { await fetched; } finally { if (inflight === fetched) inflight = null; }
  }

  // 4. Wire the callback. The signature accepts `(name, pos, length)` and
  // we hand it to handleRead which does all the work asynchronously.
  // Note: libav.js dispatches this synchronously from a worker message,
  // so we kick off handleRead but don't await — the queue inside handleRead
  // serializes things.
  const previousCallback = libav.onblockread;
  libav.onblockread = (name: string, pos: number, length: number) => {
    if (detached || name !== filename) {
      // Forward to any previous callback (e.g. another reader on the same
      // libav instance). This is rare in practice but cheap to support.
      previousCallback?.(name, pos, length);
      return;
    }
    void handleRead(name, pos, length);
  };

  return {
    size,
    transport: "http-range",
    async detach() {
      if (detached) return;
      detached = true;
      // Restore the previous callback (if any) so we don't break unrelated
      // readers on the same libav instance.
      libav.onblockread = previousCallback;
      // Wait for the last in-flight read to settle so we don't tear down
      // the virtual file while libav is still expecting a response.
      if (inflight) {
        try { await inflight; } catch { /* ignore */ }
      }
      // Drop the cache and unlink the virtual file.
      cached = null;
      try { await libav.unlinkreadaheadfile(filename); } catch { /* ignore */ }
    },
  };
}
