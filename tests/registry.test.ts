import { describe, it, expect } from "vitest";
import { PluginRegistry } from "../src/plugins/registry.js";
import type { Plugin, MediaContext, StrategyName } from "../src/types.js";

function ctx(partial?: Partial<MediaContext>): MediaContext {
  return {
    source: new Blob([]),
    container: "mp4",
    videoTracks: [],
    audioTracks: [],
    subtitleTracks: [],
    probedBy: "mediabunny",
    ...partial,
  } as MediaContext;
}

function fakePlugin(name: StrategyName, canHandle = true): Plugin {
  return {
    name,
    canHandle: () => canHandle,
    execute: async () => ({
      strategy: name,
      async play() {},
      pause() {},
      async seek() {},
      async setAudioTrack() {},
      async setSubtitleTrack() {},
      getCurrentTime() { return 0; },
      async destroy() {},
      getRuntimeStats() { return {}; },
    }),
  };
}

describe("PluginRegistry", () => {
  it("registers and retrieves plugins in order", () => {
    const reg = new PluginRegistry();
    reg.register(fakePlugin("native"));
    reg.register(fakePlugin("remux"));
    expect(reg.all().map((p) => p.name)).toEqual(["native", "remux"]);
  });

  it("prepend inserts at the front", () => {
    const reg = new PluginRegistry();
    reg.register(fakePlugin("native"));
    reg.register(fakePlugin("remux"));
    reg.register(fakePlugin("fallback"), true);
    expect(reg.all().map((p) => p.name)).toEqual(["fallback", "native", "remux"]);
  });

  it("findFor matches by name and canHandle", () => {
    const reg = new PluginRegistry();
    reg.register(fakePlugin("native"));
    reg.register(fakePlugin("remux"));
    expect(reg.findFor(ctx(), "remux")?.name).toBe("remux");
  });

  it("findFor returns null when no plugin matches the strategy name", () => {
    const reg = new PluginRegistry();
    reg.register(fakePlugin("native"));
    expect(reg.findFor(ctx(), "remux")).toBeNull();
  });

  it("findFor skips plugins where canHandle returns false", () => {
    const reg = new PluginRegistry();
    reg.register(fakePlugin("native", false));
    reg.register(fakePlugin("native", true));
    const found = reg.findFor(ctx(), "native");
    expect(found).not.toBeNull();
    expect(found!.canHandle(ctx())).toBe(true);
  });

  it("findFor returns null when canHandle is false for all matching names", () => {
    const reg = new PluginRegistry();
    reg.register(fakePlugin("hybrid", false));
    expect(reg.findFor(ctx(), "hybrid")).toBeNull();
  });

  it("prepended plugin preempts built-in of the same name", () => {
    const reg = new PluginRegistry();
    const builtin = fakePlugin("native");
    const custom = fakePlugin("native");
    reg.register(builtin);
    reg.register(custom, true);
    // findFor should return the prepended one (first match)
    expect(reg.findFor(ctx(), "native")).toBe(custom);
  });

  it("all() returns empty array for fresh registry", () => {
    const reg = new PluginRegistry();
    expect(reg.all()).toEqual([]);
  });
});
