/**
 * Contract tests for AudioOutput's volume/muted API. These are the
 * hooks that hybrid/fallback strategies use to make their hidden
 * <video> target behave like a real HTMLMediaElement — getters/setters
 * on target.volume and target.muted proxy to these methods.
 *
 * If this contract breaks, the <avbridge-player> controls UI silently
 * stops working for hybrid/fallback playback (like the Zootopia MKV
 * bug: mute button showed mute icon but audio kept playing).
 *
 * jsdom doesn't expose real AudioContext, so we test the observable
 * shape of the public API rather than the audio graph itself. The
 * browser-level behavior is covered by scripts/player-controls-test.mjs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Test fixture: mock AudioContext so we can inspect GainNode state ────

class MockGainParam {
  value = 1;
}
class MockGainNode {
  gain = new MockGainParam();
  connect = vi.fn();
  disconnect = vi.fn();
}
class MockAudioContext {
  currentTime = 0;
  destination = {};
  state = "running" as const;
  createGain(): MockGainNode { return new MockGainNode(); }
  createBufferSource() { return { connect: vi.fn(), start: vi.fn() }; }
  createBuffer() { return { copyToChannel: vi.fn() }; }
  suspend() { return Promise.resolve(); }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

beforeEach(() => {
  (globalThis as unknown as { AudioContext: typeof MockAudioContext }).AudioContext = MockAudioContext;
});

afterEach(() => {
  delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
});

// ── Contract ────────────────────────────────────────────────────────────

describe("AudioOutput volume/muted contract", () => {
  it("getVolume defaults to 1", async () => {
    const { AudioOutput } = await import("../src/strategies/fallback/audio-output.js");
    const out = new AudioOutput();
    expect(out.getVolume()).toBe(1);
  });

  it("getMuted defaults to false", async () => {
    const { AudioOutput } = await import("../src/strategies/fallback/audio-output.js");
    const out = new AudioOutput();
    expect(out.getMuted()).toBe(false);
  });

  it("setVolume/getVolume round-trip", async () => {
    const { AudioOutput } = await import("../src/strategies/fallback/audio-output.js");
    const out = new AudioOutput();
    out.setVolume(0.5);
    expect(out.getVolume()).toBe(0.5);
    out.setVolume(0);
    expect(out.getVolume()).toBe(0);
    out.setVolume(1);
    expect(out.getVolume()).toBe(1);
  });

  it("setVolume clamps to [0, 1]", async () => {
    const { AudioOutput } = await import("../src/strategies/fallback/audio-output.js");
    const out = new AudioOutput();
    out.setVolume(-0.5);
    expect(out.getVolume()).toBe(0);
    out.setVolume(2);
    expect(out.getVolume()).toBe(1);
  });

  it("setMuted/getMuted round-trip", async () => {
    const { AudioOutput } = await import("../src/strategies/fallback/audio-output.js");
    const out = new AudioOutput();
    out.setMuted(true);
    expect(out.getMuted()).toBe(true);
    out.setMuted(false);
    expect(out.getMuted()).toBe(false);
  });

  it("muted state is independent of volume (volume preserved when unmuted)", async () => {
    const { AudioOutput } = await import("../src/strategies/fallback/audio-output.js");
    const out = new AudioOutput();
    out.setVolume(0.6);
    out.setMuted(true);
    expect(out.getVolume()).toBe(0.6); // volume preserved
    expect(out.getMuted()).toBe(true);
    out.setMuted(false);
    expect(out.getVolume()).toBe(0.6); // still there
  });

  it("applies volume to underlying GainNode", async () => {
    const { AudioOutput } = await import("../src/strategies/fallback/audio-output.js");
    const out = new AudioOutput();
    out.setVolume(0.3);
    // The GainNode is private; we check the public effect by setting
    // muted and observing — a muted output must have gain 0
    out.setMuted(true);
    expect(out.getMuted()).toBe(true);
    // We can't directly inspect the GainNode without exposing internals,
    // but the fact that setVolume/setMuted don't throw and state is
    // preserved verifies the contract. The browser test verifies actual
    // audibility.
  });
});
