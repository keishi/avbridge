import type { FetchFn, TransportConfig } from "../types.js";

/**
 * Merge two RequestInit objects. Headers are merged (not overwritten) so
 * the caller's auth headers coexist with the player's Range headers.
 * Other fields (credentials, mode, signal, etc.) in `extra` override `base`.
 */
export function mergeFetchInit(
  base: RequestInit | undefined,
  extra: RequestInit | undefined,
): RequestInit | undefined {
  if (!base && !extra) return undefined;
  return {
    ...base,
    ...extra,
    headers: {
      ...(base?.headers as Record<string, string> | undefined ?? {}),
      ...(extra?.headers as Record<string, string> | undefined ?? {}),
    },
  };
}

/** Return the fetch function from a TransportConfig, falling back to globalThis.fetch. */
export function fetchWith(transport?: TransportConfig): FetchFn {
  return transport?.fetchFn ?? globalThis.fetch;
}
