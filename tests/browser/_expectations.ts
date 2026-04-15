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
   * **Initial** strategy classify() picks per browser. Used by
   * fixtures.spec.ts. classify() is browser-independent for most paths,
   * so these often agree across browsers — that's the point.
   */
  strategy: Partial<Record<BrowserName, StrategyName>>;
  /**
   * **Runtime** strategy used after escalation, per browser. Used by
   * playback.spec.ts. Defaults to `strategy` when undefined for a
   * browser. Only override when runtime escalation differs from the
   * initial pick — e.g. Firefox escalating HEVC MKV from remux →
   * fallback because MSE rejects hevc1.*.
   */
  playbackStrategy?: Partial<Record<BrowserName, StrategyName>>;
  /**
   * Skip playback testing on these browsers. Use sparingly and with a
   * comment in the entry — e.g. WebKit known-flaky on a given codec.
   */
  skipPlayback?: Partial<Record<BrowserName, string>>;
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
    // classify() is browser-sensitive for this codec combo: it calls
    // MediaSource.isTypeSupported for the remux target mime and routes
    // to hybrid when MSE rejects.
    strategy: {
      chromium: "hybrid",
      firefox: "remux",
      webkit: "remux",
    },
    // Runtime escalation on Playwright-Chromium: classify picks hybrid,
    // but WebCodecs HEVC also isn't available in open-source Chromium,
    // so hybrid fails and we escalate to fallback. Fallback's libav
    // "avbridge" variant has a software HEVC decoder — playback works.
    // That's the correct end-to-end degradation.
    playbackStrategy: {
      chromium: "fallback",
      webkit: "remux",
    },
    // Runtime reality:
    //
    // - **Chromium (open-source / Playwright)**: no HEVC via MSE OR
    //   WebCodecs (open-source build lacks proprietary codecs). Double
    //   degrade: classify→hybrid (MSE says no) → hybrid fails (WebCodecs
    //   says no) → fallback (libav software decode). ✓
    //
    // - **WebKit**: hardware HEVC; MSE accepts; remux → native. ✓
    //
    // - **Firefox**: MSE optimistically reports hev1.* supported even
    //   though the decoder can't decode it. classify sees MSE=yes and
    //   returns remux. At runtime audio plays but video is black;
    //   needs decode-stall detection in the remux pipeline to
    //   escalate. Skipping playback for firefox until that lands.
    //
    // - **Shipping Chrome** (not Playwright): same as WebKit.
    skipPlayback: {
      firefox: "Firefox MSE accepts HEVC but can't decode it; needs decode-stall detection (follow-up)",
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
