/**
 * H.264/HEVC bitstream conversion helpers.
 *
 * Demuxers from MP4-family containers (mediabunny) hand us packets in **AVCC**
 * format: each NAL unit prefixed with a 4-byte big-endian length.
 *
 * Demuxers from elementary-stream/AVI/TS hand us **Annex B**: NAL units
 * separated by `00 00 00 01` (or `00 00 01`) start codes.
 *
 * MSE expects AVCC inside fragmented MP4. So when the source side emits Annex
 * B, we need to convert before muxing. Going the other way (AVCC → Annex B) is
 * useful for feeding `VideoDecoder` configured with `description` omitted.
 */

const START_CODE_4 = new Uint8Array([0, 0, 0, 1]);

/** True if the bytes look like Annex B (start with `00 00 00 01` or `00 00 01`). */
export function isAnnexB(bytes: Uint8Array): boolean {
  if (bytes.length < 3) return false;
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1) return true;
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 1) return true;
  return false;
}

/**
 * Walk an Annex B byte stream and yield each NAL unit (without start code).
 * This is the standard byte-by-byte scan; no SIMD tricks because the typical
 * frame is small.
 */
export function* iterateAnnexBNalus(bytes: Uint8Array): Generator<Uint8Array> {
  const length = bytes.length;
  let i = 0;
  let nalStart = -1;

  while (i < length) {
    // Look for start code at position i
    let scLen = 0;
    if (i + 3 < length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) {
      scLen = 4;
    } else if (i + 2 < length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      scLen = 3;
    }

    if (scLen > 0) {
      if (nalStart >= 0) {
        yield bytes.subarray(nalStart, i);
      }
      nalStart = i + scLen;
      i += scLen;
    } else {
      i += 1;
    }
  }

  if (nalStart >= 0 && nalStart < length) {
    yield bytes.subarray(nalStart, length);
  }
}

/**
 * Convert an Annex B byte stream to AVCC. Each NALU is prefixed with its
 * 4-byte big-endian length.
 */
export function annexBToAvcc(annexB: Uint8Array): Uint8Array {
  const nalus: Uint8Array[] = [];
  let total = 0;
  for (const nal of iterateAnnexBNalus(annexB)) {
    nalus.push(nal);
    total += 4 + nal.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const nal of nalus) {
    const len = nal.length;
    out[off++] = (len >>> 24) & 0xff;
    out[off++] = (len >>> 16) & 0xff;
    out[off++] = (len >>> 8) & 0xff;
    out[off++] = len & 0xff;
    out.set(nal, off);
    off += len;
  }
  return out;
}

/**
 * Convert AVCC (4-byte length-prefixed) NALUs to Annex B. Each NALU is
 * prefixed with `00 00 00 01`.
 */
export function avccToAnnexB(avcc: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [];
  let total = 0;
  let i = 0;
  while (i + 4 <= avcc.length) {
    const len =
      (avcc[i] << 24) | (avcc[i + 1] << 16) | (avcc[i + 2] << 8) | avcc[i + 3];
    i += 4;
    if (i + len > avcc.length) {
      throw new Error(`avccToAnnexB: NAL length ${len} overflows buffer at offset ${i}`);
    }
    out.push(START_CODE_4);
    out.push(avcc.subarray(i, i + len));
    total += 4 + len;
    i += len;
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const chunk of out) {
    merged.set(chunk, off);
    off += chunk.length;
  }
  return merged;
}
