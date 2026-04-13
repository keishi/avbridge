import type { Plugin } from "../types.js";
import { createNativeSession } from "../strategies/native.js";
import { createRemuxSession } from "../strategies/remux/index.js";
import { createHybridSession } from "../strategies/hybrid/index.js";
import { createFallbackSession } from "../strategies/fallback/index.js";
import type { PluginRegistry } from "./registry.js";

const nativePlugin: Plugin = {
  name: "native",
  canHandle: () => true,
  execute: (ctx, video) => createNativeSession(ctx, video),
};

const remuxPlugin: Plugin = {
  name: "remux",
  canHandle: () => true,
  execute: (ctx, video) => createRemuxSession(ctx, video),
};

const hybridPlugin: Plugin = {
  name: "hybrid",
  canHandle: () => typeof VideoDecoder !== "undefined",
  execute: (ctx, video, transport) => createHybridSession(ctx, video, transport),
};

const fallbackPlugin: Plugin = {
  name: "fallback",
  canHandle: () => true,
  execute: (ctx, video, transport) => createFallbackSession(ctx, video, transport),
};

export function registerBuiltins(registry: PluginRegistry): void {
  registry.register(nativePlugin);
  registry.register(remuxPlugin);
  registry.register(hybridPlugin);
  registry.register(fallbackPlugin);
}
