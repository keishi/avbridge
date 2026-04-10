/**
 * UBMP — Universal Browser Media Player.
 *
 * Public entry point. Consumers should only import from `"ubmp"`; everything
 * else (probe, classify, strategies) is internal and subject to change.
 */

export { createPlayer, UnifiedPlayer } from "./player.js";
export type {
  CreatePlayerOptions,
  MediaContext,
  MediaSource_ as MediaSource,
  Classification,
  StrategyName,
  StrategyClass,
  PlaybackSession,
  Plugin,
  DiagnosticsSnapshot,
  PlayerEventMap,
  PlayerEventName,
  VideoTrackInfo,
  AudioTrackInfo,
  SubtitleTrackInfo,
  ContainerKind,
  VideoCodec,
  AudioCodec,
} from "./types.js";

export { classify } from "./classify/index.js";
export { probe } from "./probe/index.js";
export { srtToVtt } from "./subtitles/srt.js";
