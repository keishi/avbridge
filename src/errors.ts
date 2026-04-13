/**
 * Structured error with a machine-readable code and human-readable
 * recovery hint. Consumers can switch on `error.code` for programmatic
 * handling and show `error.recovery` in UI.
 *
 * All codes use the `ERR_AVBRIDGE_` prefix to avoid collisions.
 */
export class AvbridgeError extends Error {
  override name = "AvbridgeError";

  constructor(
    /** Machine-readable error code. */
    public readonly code: string,
    message: string,
    /** Human-readable recovery suggestion. */
    public readonly recovery?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

// ── Error codes ────────────────────────────────────────────────────────

// Probe
export const ERR_PROBE_FAILED = "ERR_AVBRIDGE_PROBE_FAILED";
export const ERR_PROBE_UNKNOWN_CONTAINER = "ERR_AVBRIDGE_PROBE_UNKNOWN_CONTAINER";
export const ERR_PROBE_FETCH_FAILED = "ERR_AVBRIDGE_PROBE_FETCH_FAILED";

// Codec / strategy
export const ERR_CODEC_NOT_SUPPORTED = "ERR_AVBRIDGE_CODEC_NOT_SUPPORTED";
export const ERR_STRATEGY_FAILED = "ERR_AVBRIDGE_STRATEGY_FAILED";
export const ERR_ALL_STRATEGIES_EXHAUSTED = "ERR_AVBRIDGE_ALL_STRATEGIES_EXHAUSTED";

// Player lifecycle
export const ERR_PLAYER_NOT_READY = "ERR_AVBRIDGE_PLAYER_NOT_READY";

// Transport / network
export const ERR_RANGE_NOT_SUPPORTED = "ERR_AVBRIDGE_RANGE_NOT_SUPPORTED";
export const ERR_FETCH_FAILED = "ERR_AVBRIDGE_FETCH_FAILED";

// libav
export const ERR_LIBAV_NOT_REACHABLE = "ERR_AVBRIDGE_LIBAV_NOT_REACHABLE";

// MSE
export const ERR_MSE_NOT_SUPPORTED = "ERR_AVBRIDGE_MSE_NOT_SUPPORTED";
export const ERR_MSE_CODEC_NOT_SUPPORTED = "ERR_AVBRIDGE_MSE_CODEC_NOT_SUPPORTED";
