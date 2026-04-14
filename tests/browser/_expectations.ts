/**
 * Per-browser strategy expectations for the cross-browser test matrix.
 *
 * One place to update when a browser's codec support changes. The tests in
 * `tests/browser/*.spec.ts` reference these to know what "correct" means
 * for the browser they're currently running in.
 *
 * When a browser updates (e.g. Firefox adds HEVC), the test for that
 * combination will fail until the expectation here is moved. That's the
 * intended signal — it forces us to consciously acknowledge browser
 * behavior changes rather than letting them silently drift.
 */
import type { StrategyName } from "../../src/types.js";

export type BrowserName = "chromium" | "firefox" | "webkit";

export interface FixtureExpectation {
  /** Fixture file name under tests/fixtures/. */
  fixture: string;
  /** Container that probe() should detect. */
  container: string;
  /** Video codec that probe() should detect (first video track). */
  videoCodec: string;
  /** Audio codec that probe() should detect (first audio track). */
  audioCodec: string;
  /**
   * Strategy per browser. If a browser isn't listed, the test is skipped
   * for that browser (useful for codecs we know we can't verify on a
   * given engine yet).
   */
  strategy: Partial<Record<BrowserName, StrategyName>>;
}

/**
 * The matrix. Conservative and evidence-based — each entry is the
 * classify() **initial** decision, not the runtime strategy after
 * escalation. classify() is largely browser-independent (it reads the
 * MediaContext); what varies per browser is what MSE/WebCodecs accept
 * *at runtime*, which triggers escalation.
 *
 * So: this fixtures.spec.ts tier verifies the deterministic decision.
 * The per-browser runtime behavior (e.g. Firefox escalating HEVC-MKV
 * from remux → fallback when MSE rejects hevc1.*) belongs in
 * playback.spec.ts (coming in a follow-up slice).
 *
 * Notes:
 * - H.264/AAC MP4 → native. Baseline.
 * - H.264/AAC MKV → remux. mediabunny demuxes → fMP4 → MSE.
 * - HEVC/AAC MKV → remux (classify level). Runtime: MSE plays on
 *   Chromium-macOS/WebKit; Firefox escalates to fallback.
 * - H.264/MP3 AVI → hybrid. libav demux + WebCodecs H.264.
 * - MPEG-4 Part 2 (DivX) AVI → fallback. No browser WebCodecs path.
 */
export const FIXTURE_EXPECTATIONS: FixtureExpectation[] = [
  {
    fixture: "big-buck-bunny-480p-30sec.mp4",
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    strategy: {
      chromium: "native",
      firefox: "native",
      webkit: "native",
    },
  },
  {
    fixture: "bbb-h264-aac.mkv",
    container: "mkv",
    videoCodec: "h264",
    audioCodec: "aac",
    strategy: {
      chromium: "remux",
      firefox: "remux",
      webkit: "remux",
    },
  },
  {
    fixture: "bbb-hevc-aac.mkv",
    container: "mkv",
    videoCodec: "h265",  // avbridge uses "h265" as the internal codec name
    audioCodec: "aac",
    // classify() is browser-independent for MKV + h265 (REMUXABLE_CONTAINER
    // + NATIVE_VIDEO_CODECS path). Per-browser escalation (Firefox → fallback
    // when MSE rejects HEVC) happens at runtime and is validated in
    // playback.spec.ts, not here.
    strategy: {
      chromium: "remux",
      firefox: "remux",
      webkit: "remux",
    },
  },
  {
    fixture: "bbb-h264-mp3.avi",
    container: "avi",
    videoCodec: "h264",
    audioCodec: "mp3",
    strategy: {
      chromium: "hybrid",
      firefox: "hybrid",
      webkit: "hybrid",
    },
  },
  {
    fixture: "bbb-mpeg4-mp3.avi",
    container: "avi",
    videoCodec: "mpeg4",
    audioCodec: "mp3",
    strategy: {
      chromium: "fallback",
      firefox: "fallback",
      webkit: "fallback",
    },
  },
];
