/**
 * `ClockSource` is the abstraction the renderer uses to ask "what time is it
 * and are we playing?" In the fallback strategy that role is played by
 * `AudioOutput`, which owns the actual media-time state machine. This file
 * is a re-export so callers don't need to know.
 */
export type { ClockSource } from "./audio-output.js";
