/**
 * Video frames the fallback decoder skips so the sound keeps playing.
 *
 * Software decode slower than the clock used to starve the audio: each batch decoded every video
 * frame, the renderer then dropped most of them as late, and the sound buffer ran dry. Once a
 * second of sound has been buffered since playback started, video is shed as that buffer runs
 * low:
 *
 * - Motion JPEG and DV, where every frame is a keyframe, decodes every second frame below a second of
 *   sound and every third below half a second, and never decodes a frame already late.
 * - Other codecs skip to the next keyframe below half a second, or once a frame is half a second
 *   late. Skipping one of their frames freezes the picture until that keyframe, so they start
 *   later than Motion JPEG and DV. A file whose frames never say keyframe stops being skipped after
 *   12 s of them, rather than freezing for good.
 *
 * The buffer is empty by design just after a start or a seek, which is why nothing is shed until
 * it has once been full: playback stopping (a pause, a seek) disarms the shedder.
 */

export interface SheddingClock {
  isPlaying(): boolean;
  isNoAudio(): boolean;
  /** Seconds of sound scheduled ahead of `now()`. */
  bufferAhead(): number;
  /** Media time, seconds. */
  now(): number;
}

export interface SheddablePacket {
  flags?: number;
}

export interface FrameShedderOptions<T extends SheddablePacket> {
  /** True for codecs where every frame decodes on its own (Motion JPEG, DV). */
  intraOnly: boolean;
  fps: number;
  clock: SheddingClock;
  /** The packet's presentation time in seconds, or null when it has none. */
  ptsSec(pkt: T): number | null;
}

const ARM_AT_SEC = 1;
const LOW_SEC = 0.5;
const LATE_SEC = 0.5;
const KEYLESS_LIMIT_SEC = 12;

const isKey = (pkt: SheddablePacket) => ((pkt.flags ?? 0) & 1) === 1;

export function createFrameShedder<T extends SheddablePacket>(opts: FrameShedderOptions<T>): (pkts: T[]) => T[] {
  let armed = false;
  let skipped = 0;
  let keyless = false;
  let count = 0;

  return (pkts) => {
    const { clock } = opts;
    if (!clock.isPlaying() || clock.isNoAudio()) {
      armed = false;
      skipped = 0;
      return pkts;
    }
    const ahead = clock.bufferAhead();
    if (ahead >= ARM_AT_SEC) armed = true;
    if (!armed) return pkts;

    const now = clock.now();
    const every = ahead < LOW_SEC ? 3 : ahead < ARM_AT_SEC ? 2 : 1;
    return pkts.filter((pkt) => {
      const sec = opts.ptsSec(pkt);
      if (opts.intraOnly) {
        if (sec != null && sec < now) return false;
        return ++count % every === 0;
      }
      if (isKey(pkt)) {
        skipped = 0;
        return true;
      }
      if (keyless) return true;
      if (skipped === 0 && ahead >= LOW_SEC && !(sec != null && sec < now - LATE_SEC)) return true;
      if (++skipped > opts.fps * KEYLESS_LIMIT_SEC) {
        keyless = true;
        return true;
      }
      return false;
    });
  };
}
