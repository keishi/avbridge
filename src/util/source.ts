import type { ContainerKind, MediaSource_ } from "../types.js";

/**
 * Normalize a `MediaSource_` into a `Blob` for the probe layer. URLs are
 * fetched lazily — we only fetch enough bytes to sniff the magic header for
 * container detection, and the strategies receive the original source so they
 * can stream from it.
 */
export interface NormalizedSource {
  blob: Blob;
  name?: string;
  byteLength: number;
  /** Original input, preserved for strategies that prefer File objects (eg. native <video src>). */
  original: MediaSource_;
}

export async function normalizeSource(source: MediaSource_): Promise<NormalizedSource> {
  if (source instanceof File) {
    return { blob: source, name: source.name, byteLength: source.size, original: source };
  }
  if (source instanceof Blob) {
    return { blob: source, byteLength: source.size, original: source };
  }
  if (source instanceof ArrayBuffer) {
    const blob = new Blob([source]);
    return { blob, byteLength: blob.size, original: source };
  }
  if (source instanceof Uint8Array) {
    const blob = new Blob([source as BlobPart]);
    return { blob, byteLength: blob.size, original: source };
  }
  if (typeof source === "string" || source instanceof URL) {
    const url = source instanceof URL ? source.toString() : source;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`failed to fetch source: ${res.status} ${res.statusText}`);
    }
    const blob = await res.blob();
    return {
      blob,
      name: url.split("/").pop() ?? undefined,
      byteLength: blob.size,
      original: source,
    };
  }
  throw new TypeError("unsupported source type");
}

/**
 * Sniff the first ~32 bytes of a Blob to identify the container family. This
 * is the cheap path — it lets us route MP4/MKV/WebM directly to mediabunny
 * without ever loading libav.js, and lets us detect AVI to opt into the libav
 * probe path. Sniffing intentionally does not trust file extensions.
 */
export async function sniffContainer(blob: Blob): Promise<ContainerKind> {
  const buf = await readBlobBytes(blob, 32);
  const head = new Uint8Array(buf);
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
