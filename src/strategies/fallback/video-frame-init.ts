/**
 * The `VideoFrame` of a planar YUV frame libav.js decoded, built here rather than by
 * libavjs-webcodecs-bridge.
 *
 * libav.js's frames carry no colour tags, and the bridge builds its `VideoFrame` with none, so
 * Chrome read SD video (BT.601, nearly every AVI) as BT.709 and shifted its colours. It also
 * refuses full-range `yuvj*` (Motion JPEG) as "Unsupported pixel format", and ignores the pixel
 * aspect ratio, so an anamorphic 16:9 picture sat at 4:3. Frames are tagged as players read
 * untagged video: BT.601 below 720 lines, BT.709 from 720, and full range for `yuvj*`.
 */

/** AVPixelFormat numbers of planar YUV, to WebCodecs' format and whether it is full range. */
const PLANAR_YUV: Readonly<Record<number, readonly [VideoPixelFormat, boolean]>> = {
  0: ["I420", false], // yuv420p
  4: ["I422", false], // yuv422p
  5: ["I444", false], // yuv444p
  12: ["I420", true], // yuvj420p
  13: ["I422", true], // yuvj422p
  14: ["I444", true], // yuvj444p
};

/** Pixel aspect ratios beyond this either way are taken as broken and ignored. */
const MAX_PIXEL_ASPECT = 4;

export interface PlanarFrame {
  format: number;
  width?: number;
  height?: number;
  layout?: PlaneLayout[];
  sample_aspect_ratio?: [number, number];
}

/** The init of this frame's `VideoFrame`, or null when it is not planar YUV (the bridge's). */
export function videoFrameInit(frame: PlanarFrame, timestamp: number): VideoFrameBufferInit | null {
  const planar = PLANAR_YUV[frame.format];
  const { width, height, layout } = frame;
  if (!planar || !layout || !width || !height) return null;
  const [format, fullRange] = planar;
  const tag = fullRange || height < 720 ? "smpte170m" : "bt709";
  const init: VideoFrameBufferInit = {
    format,
    codedWidth: width,
    codedHeight: height,
    layout,
    timestamp,
    colorSpace: { matrix: tag, primaries: tag, transfer: tag, fullRange },
  };
  const [num, den] = frame.sample_aspect_ratio ?? [0, 1];
  const ratio = num / den;
  if (num > 0 && den > 0 && num !== den && ratio >= 1 / MAX_PIXEL_ASPECT && ratio <= MAX_PIXEL_ASPECT) {
    init.displayWidth = Math.round(width * ratio);
    init.displayHeight = height;
  }
  return init;
}
