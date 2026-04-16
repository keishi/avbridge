/**
 * Cross-browser HTMLMediaElement contract parity.
 *
 * For each (fixture, browser): mount a fresh `<avbridge-player>`, drive it
 * through the standard media-element verbs (play, pause, seek, volumechange)
 * and check that both the **events** and **properties** the HTMLMediaElement
 * contract defines show up truthfully. Strategies that hide the inner
 * `<video>` (hybrid, fallback — canvas rendered) are the most likely to
 * forget an event or misreport a property; this spec exists to catch that
 * class of regression before it reaches consumers.
 *
 * Pairs with:
 *   - `fixtures.spec.ts` — deterministic classify() output
 *   - `playback.spec.ts` — runtime strategy + playback advance
 *   - this (`contract.spec.ts`) — HTMLMediaElement parity
 */
import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import type { BrowserName } from "./_expectations.js";

const FIXTURES_DIR = resolve("tests/fixtures");

// Canvas strategies + Firefox remux both have cold-start costs. 30 s is
// more than enough even for the slowest cases.
test.setTimeout(30_000);

// Each fixture maps to a distinct strategy path, so running contract
// parity on all four gives us coverage across native / remux / hybrid /
// fallback. HEVC MKV is deliberately excluded because its strategy
// depends on per-browser codec support — playback.spec.ts owns that
// particular matrix.
const CONTRACT_FIXTURES = [
  { fixture: "big-buck-bunny-480p-30sec.mp4", strategyHint: "native" },
  { fixture: "bbb-h264-aac.mkv",              strategyHint: "remux" },
  { fixture: "bbb-h264-mp3.avi",              strategyHint: "hybrid" },
  { fixture: "bbb-mpeg4-mp3.avi",             strategyHint: "fallback" },
] as const;

test.beforeEach(async ({ page }) => {
  await page.goto("/tests-harness.html");
  await page.waitForFunction(() => (window as unknown as { __avbridgeReady?: boolean }).__avbridgeReady === true);
});

for (const { fixture, strategyHint } of CONTRACT_FIXTURES) {
  test(`${fixture} — HTMLMediaElement contract (${strategyHint})`, async ({ page, browserName }, testInfo) => {
    const browser = browserName as BrowserName;
    const fixtureUrl = `/@fs${resolve(FIXTURES_DIR, fixture)}`;

    const result = await page.evaluate(async (url) => {
      interface PlayerLike extends HTMLElement {
        muted: boolean;
        currentTime: number;
        duration: number;
        paused: boolean;
        source: Blob;
        videoElement: HTMLVideoElement;
        play(): Promise<void>;
        pause(): void;
        destroy?(): Promise<void>;
      }

      const mount = document.getElementById("player-mount");
      if (!mount) throw new Error("#player-mount missing");
      mount.innerHTML = "";
      const player = document.createElement("avbridge-player") as PlayerLike;
      mount.appendChild(player);
      await customElements.whenDefined("avbridge-player");
      player.muted = true;

      // Event-capture set up before source so nothing is missed.
      const events: string[] = [];
      const track = (name: string) =>
        player.addEventListener(name, () => { events.push(name); });
      for (const name of [
        "ready", "play", "playing", "pause", "timeupdate",
        "seeking", "seeked", "volumechange", "loadedmetadata",
      ]) {
        track(name);
      }

      const blob = await (await fetch(url)).blob();
      player.source = blob;

      // Wait for ready (or a hard error).
      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(
          () => rejectReady(new Error("ready timeout after 15s")),
          15_000,
        );
        player.addEventListener("ready", () => { clearTimeout(timer); resolveReady(); }, { once: true });
        player.addEventListener("error", (e) => {
          clearTimeout(timer);
          const err = (e as unknown as CustomEvent<{ error?: Error }>).detail?.error
            ?? new Error("player dispatched error");
          rejectReady(err);
        }, { once: true });
      });

      // Phase 1: play + let playback actually advance. Canvas strategies
      // take ~2.5 s to warm up, so 3.5 s is a comfortable window.
      await player.play();
      await new Promise((r) => setTimeout(r, 3500));

      const afterPlay = {
        currentTime: player.currentTime,
        duration: player.duration,
        paused: player.paused,
        readyState: player.videoElement?.readyState ?? 0,
        seekableLen: player.videoElement?.seekable?.length ?? 0,
        bufferedLen: player.videoElement?.buffered?.length ?? 0,
      };

      // Phase 2: pause — must flip `paused` and fire "pause".
      const pauseEventsBefore = events.filter((e) => e === "pause").length;
      player.pause();
      await new Promise((r) => setTimeout(r, 300));
      const afterPause = {
        paused: player.paused,
        pauseEventsFired: events.filter((e) => e === "pause").length - pauseEventsBefore,
      };

      // Phase 3: volumechange — flip muted, expect the event.
      const volChangeBefore = events.filter((e) => e === "volumechange").length;
      player.muted = false;
      await new Promise((r) => setTimeout(r, 200));
      player.muted = true; // leave muted for tests running in parallel
      await new Promise((r) => setTimeout(r, 200));
      const afterVolChange = {
        volumechangeEventsFired:
          events.filter((e) => e === "volumechange").length - volChangeBefore,
      };

      // Phase 4: seek (while playing).
      // Resume playback first — Firefox + WebKit's remux pipeline won't
      // fire `seeked` on a seek-while-paused because data delivery to
      // the SourceBuffer stops with the pipeline. Seeking while playing
      // is also the more natural consumer pattern — seek bars scrub
      // during playback.
      await player.play();
      await new Promise((r) => setTimeout(r, 300));
      const seekingBefore = events.filter((e) => e === "seeking").length;
      const seekedBefore = events.filter((e) => e === "seeked").length;
      const seekTarget = 5;
      player.currentTime = seekTarget;
      // Seeks take variable time:
      // - native/remux: MSE must feed new data before `currentTime` is
      //   applied and `seeked` fires. Firefox + WebKit slower than
      //   Chromium here.
      // - canvas (hybrid/fallback): libav av_seek_frame + renderer
      //   flush + gate.
      // 3 s covers the spread.
      await new Promise((r) => setTimeout(r, 3000));
      const afterSeek = {
        currentTime: player.currentTime,
        seekingEventsFired: events.filter((e) => e === "seeking").length - seekingBefore,
        seekedEventsFired: events.filter((e) => e === "seeked").length - seekedBefore,
      };

      // Cleanup
      try { if (typeof player.destroy === "function") await player.destroy(); } catch { /* ignore */ }
      mount.innerHTML = "";

      return {
        eventsSeen: Array.from(new Set(events)), // dedupe; order preserved by Set on insertion
        timeupdateCount: events.filter((e) => e === "timeupdate").length,
        afterPlay, afterPause, afterVolChange, afterSeek,
      };
    }, fixtureUrl);

    // Attach a single-line summary to the report so failure context is
    // visible without cracking open a trace.
    testInfo.annotations.push({
      type: "contract result",
      description:
        `events=${result.eventsSeen.join(",")} timeupdates=${result.timeupdateCount} ` +
        `afterPlay=${JSON.stringify(result.afterPlay)} ` +
        `afterPause=${JSON.stringify(result.afterPause)} ` +
        `afterVolChange=${JSON.stringify(result.afterVolChange)} ` +
        `afterSeek=${JSON.stringify(result.afterSeek)}`,
    });
    // eslint-disable-next-line no-console
    console.log(`  [${browser}] ${fixture}: events=${result.eventsSeen.join(",")} timeupdates=${result.timeupdateCount}`);

    // ── Event parity ──
    // These are the standard HTMLMediaElement events that consumers rely on.
    // Strategies that hide the inner <video> must re-dispatch them.
    expect(result.eventsSeen, `ready event`).toContain("ready");
    expect(result.eventsSeen, `play event`).toContain("play");
    expect(result.eventsSeen, `playing event`).toContain("playing");
    expect(result.eventsSeen, `pause event`).toContain("pause");
    expect(result.eventsSeen, `timeupdate event`).toContain("timeupdate");
    expect(result.eventsSeen, `seeking event`).toContain("seeking");
    expect(result.eventsSeen, `seeked event`).toContain("seeked");
    expect(result.eventsSeen, `volumechange event`).toContain("volumechange");

    // Multiple timeupdates should fire during 3.5 s of playback.
    expect(result.timeupdateCount, `timeupdate should fire repeatedly`).toBeGreaterThan(1);

    // ── Property parity (after play) ──
    expect(result.afterPlay.duration, `duration should be > 0`).toBeGreaterThan(0);
    expect(result.afterPlay.currentTime, `currentTime should advance`).toBeGreaterThan(0.3);
    expect(result.afterPlay.paused, `paused should be false while playing`).toBe(false);
    expect(result.afterPlay.readyState, `readyState should be >= HAVE_CURRENT_DATA (2)`).toBeGreaterThanOrEqual(2);
    expect(result.afterPlay.seekableLen, `seekable.length >= 1 (synthesized on canvas strategies per v2.8.0)`).toBeGreaterThanOrEqual(1);
    expect(result.afterPlay.bufferedLen, `buffered.length >= 1 (synthesized on canvas strategies per v2.8.5)`).toBeGreaterThanOrEqual(1);

    // ── Pause parity ──
    expect(result.afterPause.paused, `paused should be true after pause()`).toBe(true);
    expect(result.afterPause.pauseEventsFired, `pause event should fire`).toBeGreaterThanOrEqual(1);

    // ── volumechange parity ──
    // We flipped muted twice, so at least one volumechange should fire.
    expect(result.afterVolChange.volumechangeEventsFired, `volumechange should fire on muted toggle`).toBeGreaterThanOrEqual(1);

    // ── Seek parity ──
    expect(result.afterSeek.seekingEventsFired, `seeking event should fire`).toBeGreaterThanOrEqual(1);
    expect(result.afterSeek.seekedEventsFired, `seeked event should fire`).toBeGreaterThanOrEqual(1);
    // currentTime should end up near the seek target (generous tolerance —
    // canvas strategies resume at the nearest keyframe).
    expect(result.afterSeek.currentTime, `currentTime should land near seek target`).toBeGreaterThan(3);
  });
}
