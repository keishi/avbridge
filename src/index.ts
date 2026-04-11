/**
 * avbridge — Universal Browser Media Player.
 *
 * Public entry point. Consumers should only import from `"avbridge"`; everything
 * else (probe, classify, strategies) is internal and subject to change.
 */

export { createPlayer, UnifiedPlayer } from "./player.js";
export type {
  CreatePlayerOptions,
  MediaContext,
  MediaInput,
  MediaInput as MediaSource,
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
  OutputFormat,
  ConvertOptions,
  ConvertResult,
  ProgressInfo,
  TranscodeOptions,
  TranscodeQuality,
  OutputVideoCodec,
  OutputAudioCodec,
  HardwareAccelerationHint,
} from "./types.js";

export { classify } from "./classify/index.js";
export { probe } from "./probe/index.js";
export { remux, transcode } from "./convert/index.js";
export { srtToVtt } from "./subtitles/srt.js";
