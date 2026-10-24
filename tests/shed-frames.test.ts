import { describe, it, expect } from "vitest";
import { createFrameShedder, type SheddingClock } from "../src/strategies/fallback/shed-frames.js";

type Pkt = { pts: number; flags?: number };

function clock(over: Partial<{ playing: boolean; noAudio: boolean; ahead: number; now: number }> = {}) {
  const state = { playing: true, noAudio: false, ahead: 2, now: 0, ...over };
  const c: SheddingClock = {
    isPlaying: () => state.playing,
    isNoAudio: () => state.noAudio,
    bufferAhead: () => state.ahead,
    now: () => state.now,
  };
  return { c, state };
}

const frames = (from: number, n: number, keyEvery = 0): Pkt[] =>
  Array.from({ length: n }, (_, i) => ({ pts: from + i / 10, flags: keyEvery && i % keyEvery === 0 ? 1 : 0 }));

function shedder(intraOnly: boolean, c: SheddingClock) {
  return createFrameShedder<Pkt>({ intraOnly, fps: 10, clock: c, ptsSec: (p) => p.pts });
}

describe("createFrameShedder", () => {
  it("decodes everything while sound is buffered", () => {
    const { c } = clock({ ahead: 1.5 });
    expect(shedder(false, c)(frames(1, 20, 10))).toHaveLength(20);
    expect(shedder(true, c)(frames(1, 20, 1))).toHaveLength(20);
  });

  it("sheds nothing before a second of sound has been buffered, as just after a start or a seek", () => {
    const { c } = clock({ ahead: 0.1 });
    const shed = shedder(false, c);
    expect(shed(frames(1, 20, 10))).toHaveLength(20);
  });

  it("thins Motion JPEG to every second frame below a second, every third below half", () => {
    const { c, state } = clock();
    const shed = shedder(true, c);
    shed([]); // arms at 2 s buffered
    state.ahead = 0.8;
    expect(shed(frames(5, 12, 1))).toHaveLength(6);
    state.ahead = 0.3;
    expect(shed(frames(7, 12, 1))).toHaveLength(4);
  });

  it("never decodes a late Motion JPEG frame", () => {
    const { c, state } = clock({ now: 3 });
    const shed = shedder(true, c);
    shed([]);
    state.ahead = 1.5;
    const kept = shed(frames(2, 20, 1));
    expect(kept.every((p) => p.pts >= 3)).toBe(true);
  });

  it("skips another codec's frames to the next keyframe once low", () => {
    const { c, state } = clock();
    const shed = shedder(false, c);
    shed([]);
    state.ahead = 0.3;
    const kept = shed(frames(5, 30, 10));
    expect(kept.map((p) => p.flags)).toEqual([1, 1, 1]);
  });

  it("does not freeze a file whose frames never say keyframe", () => {
    const { c, state } = clock();
    const shed = shedder(false, c);
    shed([]);
    state.ahead = 0.3;
    expect(shed(frames(5, 120))).toHaveLength(0);
    expect(shed(frames(17, 10))).toHaveLength(10);
  });

  it("disarms when playback stops, so a seek does not start skipping", () => {
    const { c, state } = clock();
    const shed = shedder(false, c);
    shed([]);
    state.playing = false;
    shed([]);
    state.playing = true;
    state.ahead = 0.04;
    expect(shed(frames(9, 20, 10))).toHaveLength(20);
  });

  it("leaves files with no sound alone", () => {
    const { c } = clock({ noAudio: true, ahead: 0 });
    expect(shedder(false, c)(frames(1, 20))).toHaveLength(20);
  });
});
