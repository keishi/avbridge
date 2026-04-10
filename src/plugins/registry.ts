import type { MediaContext, Plugin, StrategyName } from "../types.js";

/**
 * Plugin registry. Built-in strategies are registered as plugins so that
 * user-supplied plugins can preempt them. The registry is consulted twice:
 * once by the player layer to find a plugin matching the picked strategy, and
 * (optionally) by classification to ask plugins what they support.
 */
export class PluginRegistry {
  private plugins: Plugin[] = [];

  register(plugin: Plugin, prepend = false): void {
    if (prepend) this.plugins.unshift(plugin);
    else this.plugins.push(plugin);
  }

  all(): readonly Plugin[] {
    return this.plugins;
  }

  /**
   * Find the first plugin that claims this context AND its name matches the
   * strategy. Built-in strategy plugins are named exactly `"native"`,
   * `"remux"`, `"fallback"`.
   */
  findFor(context: MediaContext, strategy: StrategyName): Plugin | null {
    for (const p of this.plugins) {
      if (p.name === strategy && p.canHandle(context)) return p;
    }
    return null;
  }
}
