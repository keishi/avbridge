import type { Plugin } from "../types.js";
import { createNativeSession } from "../strategies/native.js";
import { createRemuxSession } from "../strategies/remux/index.js";
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

const fallbackPlugin: Plugin = {
  name: "fallback",
  canHandle: () => true,
  execute: (ctx, video) => createFallbackSession(ctx, video),
};

export function registerBuiltins(registry: PluginRegistry): void {
  registry.register(nativePlugin);
  registry.register(remuxPlugin);
  registry.register(fallbackPlugin);
}
