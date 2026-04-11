/**
 * Debug + self-diagnosis helper.
 *
 * avbridge has a lot of async stages (probe → classify → libav load →
 * strategy.execute → decoder pump → cold-start gate → first paint) and
 * when something's slow or wrong the symptom — "it hangs", "it stutters",
 * "it plays audio without video" — is usually nowhere near the actual
 * cause. This module gives us two things:
 *
 * 1. **Gated verbose logging.** `dbg.info(tag, ...)` etc. are no-ops
 *    unless the consumer sets `globalThis.AVBRIDGE_DEBUG = true` (or
 *    uses the matching `?avbridge_debug` URL search param at dev time).
 *    When enabled, every log is prefixed with `[avbridge:<tag>]` so the
 *    console is filterable.
 *
 * 2. **Unconditional self-diagnosis.** `dbg.warnIf(cond, tag, ...)`
 *    always fires when a suspicious condition is detected, even with
 *    debug off. These are the things we *know* mean something is
 *    broken or degraded and the user would want to know about — e.g.
 *    the cold-start gate timing out, the decoder running slower than
 *    realtime, a libav variant taking longer to load than any network
 *    should take, >20% of packets getting rejected.
 *
 * The guiding principle: **if a symptom caused more than 10 minutes of
 * human debugging once, add a targeted warning so the next instance
 * self-identifies in the console.** This module is where those
 * warnings live.
 */

/** Read the debug flag fresh on every call so it's runtime-toggleable. */
function isDebugEnabled(): boolean {
  if (typeof globalThis === "undefined") return false;
  const g = globalThis as { AVBRIDGE_DEBUG?: unknown };
  if (g.AVBRIDGE_DEBUG === true) return true;
  // Convenience: if running in a browser with a `?avbridge_debug` search
  // param, flip the flag on automatically. Useful for demos and quick
  // user reproduction without editing code.
  if (typeof location !== "undefined" && typeof URLSearchParams !== "undefined") {
    try {
      const p = new URLSearchParams(location.search);
      if (p.has("avbridge_debug")) {
        g.AVBRIDGE_DEBUG = true;
        return true;
      }
    } catch { /* ignore */ }
  }
  return false;
}

function fmt(tag: string): string {
  return `[avbridge:${tag}]`;
}

/* eslint-disable no-console */

export const dbg = {
  /** Verbose — only when debug is enabled. The hot-path normal case. */
  info(tag: string, ...args: unknown[]): void {
    if (isDebugEnabled()) console.info(fmt(tag), ...args);
  },

  /** Warning — only when debug is enabled. Non-fatal oddities. */
  warn(tag: string, ...args: unknown[]): void {
    if (isDebugEnabled()) console.warn(fmt(tag), ...args);
  },

  /**
   * Self-diagnosis warning. **Always** emits regardless of debug flag.
   * Use this only for conditions that mean something is actually wrong
   * or degraded — not for routine chatter.
   */
  diag(tag: string, ...args: unknown[]): void {
    console.warn(fmt(tag), ...args);
  },

  /**
   * Timing helper: wraps an async call and logs its elapsed time when
   * debug is on. The callback runs whether debug is on or off — this is
   * just for the `dbg.info` at the end.
   *
   * Also unconditionally fires `dbg.diag` if the elapsed time exceeds
   * `slowMs`, so "the bootstrap took 8 seconds" shows up even without
   * debug mode enabled.
   */
  async timed<T>(
    tag: string,
    label: string,
    slowMs: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      const elapsed = performance.now() - start;
      if (isDebugEnabled()) {
        console.info(fmt(tag), `${label} ${elapsed.toFixed(0)}ms`);
      }
      if (elapsed > slowMs) {
        console.warn(
          fmt(tag),
          `${label} took ${elapsed.toFixed(0)}ms (>${slowMs}ms expected) — ` +
          `this is unusually slow; possible causes: ${hintForTag(tag)}`,
        );
      }
      return result;
    } catch (err) {
      const elapsed = performance.now() - start;
      console.warn(
        fmt(tag),
        `${label} FAILED after ${elapsed.toFixed(0)}ms:`,
        err,
      );
      throw err;
    }
  },
};

function hintForTag(tag: string): string {
  switch (tag) {
    case "probe":
      return "slow network (range request), large sniff window, or libav cold-start";
    case "libav-load":
      return "large .wasm download, misconfigured AVBRIDGE_LIBAV_BASE, or server-side MIME type";
    case "bootstrap":
      return "probe+classify+strategy-init chain; enable AVBRIDGE_DEBUG for a phase breakdown";
    case "cold-start":
      return "decoder is producing output slower than realtime — check framesDecoded in getDiagnostics()";
    default:
      return "unknown stage — enable globalThis.AVBRIDGE_DEBUG for more detail";
  }
}
