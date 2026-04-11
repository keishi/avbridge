import type { ContainerKind, MediaInput } from "../types.js";

/**
 * Bytes needed by the sniffer to identify every container we recognize.
 * MPEG-TS needs the most: a sync byte at offset 0 *and* offset 188 (one TS
 * packet apart). Allow a little extra for the M2TS variant (offset 4/192).
 */
const SNIFF_BYTES_NEEDED = 380;

/**
 * Bytes to fetch from a URL during the initial sniff. We grab a slightly
 * larger range than `SNIFF_BYTES_NEEDED` so the cache has some headroom for
 * the demuxer's first read after sniffing, in case it wants to look at
 * a few extra bytes (e.g. mp4 ftyp + first moov box).
 */
const URL_SNIFF_RANGE_BYTES = 32 * 1024;

/**
 * `NormalizedSource` is a discriminated union: every consumer (probe,
 * strategies) decides what to do based on `kind`. URL sources are NOT
 * fetched eagerly; we only do a Range request for the first ~32 KB so the
 * sniffer has bytes to look at. The strategies are then handed the URL
 * directly so they can stream the rest via Range requests.
 *
 * For File / Blob / ArrayBuffer / Uint8Array sources, the bytes are
 * already in memory, so we wrap them as a `blob` variant.
 */
export type NormalizedSource =
  | {
      kind: "blob";
      blob: Blob;
      name?: string;
      byteLength: number;
      original: MediaInput;
    }
  | {
      kind: "url";
      url: string;
      /** Bytes pulled via Range request for the sniffer. NOT the full file. */
      sniffBytes: Uint8Array;
      name?: string;
      /** Total file size from Content-Length / Content-Range. May be undefined. */
      byteLength: number | undefined;
      original: MediaInput;
    };

/** True if this source carries the entire file's bytes (vs. streaming). */
export function isInMemorySource(source: NormalizedSource): source is Extract<NormalizedSource, { kind: "blob" }> {
  return source.kind === "blob";
}


/**
 * Normalize a `MediaInput` for the probe + strategy layers. **Does not**
 * download URL sources in full — only fetches the first ~32 KB via a
 * Range request, which is enough for the sniffer to identify the
 * container. The strategies are then expected to stream the rest via
 * mediabunny's `UrlSource` (Range requests, prefetch, parallelism, cache).
 *
 * For non-URL inputs, the bytes are already in memory and we just wrap them.
 */
export async function normalizeSource(source: MediaInput): Promise<NormalizedSource> {
  if (source instanceof File) {
    return {
      kind: "blob",
      blob: source,
      name: source.name,
      byteLength: source.size,
      original: source,
    };
  }
  if (source instanceof Blob) {
    return { kind: "blob", blob: source, byteLength: source.size, original: source };
  }
  if (source instanceof ArrayBuffer) {
    const blob = new Blob([source]);
    return { kind: "blob", blob, byteLength: blob.size, original: source };
  }
  if (source instanceof Uint8Array) {
    const blob = new Blob([source as BlobPart]);
    return { kind: "blob", blob, byteLength: blob.size, original: source };
  }
  if (typeof source === "string" || source instanceof URL) {
    const url = source instanceof URL ? source.toString() : source;
    return await fetchUrlForSniff(url, source);
  }
  throw new TypeError("unsupported source type");
}

/**
 * Fetch the first ~32 KB of a URL via a Range request. Falls back to a
 * full GET if the server doesn't support range requests, but in that case
 * we only read the first 32 KB and abort the rest of the response so we
 * don't accidentally buffer a large file.
 */
async function fetchUrlForSniff(url: string, originalSource: MediaInput): Promise<NormalizedSource> {
  const name = url.split("/").pop()?.split("?")[0] ?? undefined;

  // First attempt: Range request for the sniff window.
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Range: `bytes=0-${URL_SNIFF_RANGE_BYTES - 1}` },
    });
  } catch (err) {
    throw new Error(`failed to fetch source ${url}: ${(err as Error).message}`);
  }
  if (!res.ok && res.status !== 206) {
    throw new Error(`failed to fetch source ${url}: ${res.status} ${res.statusText}`);
  }

  // Determine the total file size from Content-Range (preferred) or Content-Length.
  let byteLength: number | undefined;
  const contentRange = res.headers.get("content-range");
  if (contentRange) {
    // "bytes 0-32767/12345678" — parse the part after the slash
    const m = contentRange.match(/\/(\d+)$/);
    if (m) byteLength = parseInt(m[1], 10);
  }
  if (byteLength === undefined) {
    const cl = res.headers.get("content-length");
    if (cl) {
      const n = parseInt(cl, 10);
      if (Number.isFinite(n)) {
        // If the server returned 200 (full body), Content-Length is the
        // FILE size. If 206 (partial), it's the chunk size — only use it
        // as a total if no Content-Range was present (server doesn't do
        // ranges) AND the full response is smaller than our sniff window.
        if (res.status === 200) byteLength = n;
        else if (res.status === 206 && !contentRange) byteLength = n;
      }
    }
  }

  // Read the sniff bytes. If the server ignored the Range header and is
  // streaming the full file, only read the first window and let the rest
  // be GC'd. We use a reader so we can stop early.
  const reader = res.body?.getReader();
  if (!reader) {
    // No streamed body (some test environments). Fall back to .arrayBuffer()
    // and slice — this might pull more than we wanted, but only for the
    // initial sniff, not the full file.
    const buf = new Uint8Array(await res.arrayBuffer());
    const sniffBytes = buf.slice(0, URL_SNIFF_RANGE_BYTES);
    return { kind: "url", url, sniffBytes, name, byteLength, original: originalSource };
  }

  const chunks: Uint8Array[] = [];
  let collected = 0;
  while (collected < URL_SNIFF_RANGE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    collected += value.byteLength;
  }
  // Cancel the response so we don't keep downloading.
  await reader.cancel().catch(() => { /* ignore */ });

  // Concatenate up to URL_SNIFF_RANGE_BYTES.
  const total = Math.min(collected, URL_SNIFF_RANGE_BYTES);
  const sniffBytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= total) break;
    const room = total - offset;
    sniffBytes.set(chunk.subarray(0, Math.min(chunk.byteLength, room)), offset);
    offset += chunk.byteLength;
  }

  return { kind: "url", url, sniffBytes, name, byteLength, original: originalSource };
}

/**
 * Identify the container family from a small byte buffer. Used by the
 * probe layer for both file (Blob → first 380 bytes) and URL (Range
 * request → first 32 KB) inputs.
 *
 * Sniffing intentionally does not trust file extensions.
 */
export function sniffContainerFromBytes(head: Uint8Array): ContainerKind {
  // MPEG-TS: sync byte 0x47 every 188 bytes. Verify at least two sync
  // bytes in the right places to avoid false positives. Some captures
  // start with a few junk bytes — also try offsets 4 and 192 (M2TS).
  if (head.length >= 376 && head[0] === 0x47 && head[188] === 0x47) {
    return "mpegts";
  }
  if (head.length >= 380 && head[4] === 0x47 && head[192] === 0x47) {
    return "mpegts"; // M2TS — 4-byte timestamp prefix per packet
  }
  // RIFF....AVI  →  AVI
  if (
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x41 && head[9] === 0x56 && head[10] === 0x49
  ) return "avi";
  // RIFF....WAVE → WAV
  if (
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x41 && head[10] === 0x56 && head[11] === 0x45
  ) return "wav";
  // EBML start: 1A 45 DF A3 → MKV/WebM. Distinguish later via DocType.
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return "mkv";
  }
  // ftyp at offset 4 → MP4 family
  if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
    // brand at bytes 8..11
    const brand = String.fromCharCode(head[8], head[9], head[10], head[11]);
    if (brand.startsWith("qt")) return "mov";
    return "mp4";
  }
  // ASF / WMV: 30 26 B2 75 8E 66 CF 11
  if (
    head[0] === 0x30 && head[1] === 0x26 && head[2] === 0xb2 && head[3] === 0x75 &&
    head[4] === 0x8e && head[5] === 0x66 && head[6] === 0xcf && head[7] === 0x11
  ) return "asf";
  // FLV: 46 4C 56
  if (head[0] === 0x46 && head[1] === 0x4c && head[2] === 0x56) return "flv";
  // OggS: 4F 67 67 53
  if (head[0] === 0x4f && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) return "ogg";
  // FLAC: 66 4C 61 43
  if (head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) return "flac";
  // ID3v2: 49 44 33  → MP3 (with id3)
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return "mp3";
  // MPEG audio frame sync: FF Fx
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    // ADTS: FF F1 / FF F9
    if ((head[1] & 0xf6) === 0xf0) return "adts";
    return "mp3";
  }
  return "unknown";
}

/**
 * Convenience: sniff a `NormalizedSource` regardless of kind. For URL
 * sources, uses the pre-fetched `sniffBytes`. For blob sources, reads the
 * first 380 bytes.
 */
export async function sniffNormalizedSource(source: NormalizedSource): Promise<ContainerKind> {
  if (source.kind === "url") {
    return sniffContainerFromBytes(source.sniffBytes);
  }
  const buf = await readBlobBytes(source.blob, SNIFF_BYTES_NEEDED);
  return sniffContainerFromBytes(new Uint8Array(buf));
}

/**
 * Backwards-compatible wrapper for code that still passes a Blob directly.
 * Prefer `sniffNormalizedSource` going forward.
 */
export async function sniffContainer(blob: Blob): Promise<ContainerKind> {
  const buf = await readBlobBytes(blob, SNIFF_BYTES_NEEDED);
  return sniffContainerFromBytes(new Uint8Array(buf));
}

/**
 * Read up to `limit` bytes from a Blob. Tries `Blob.arrayBuffer()` first
 * (modern browsers), then falls back to `FileReader` (works under jsdom).
 */
async function readBlobBytes(blob: Blob, limit: number): Promise<ArrayBuffer> {
  const slice = blob.slice(0, limit);
  if (typeof (slice as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === "function") {
    try {
      return await (slice as Blob & { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
    } catch {
      /* fall through to FileReader */
    }
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsArrayBuffer(slice);
  });
}
