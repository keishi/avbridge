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
  FetchFn,
  TransportConfig,
  SettingsSectionConfig,
} from "./types.js";

export { classify } from "./classify/index.js";
export {
  NATIVE_VIDEO_CODECS,
  NATIVE_AUDIO_CODECS,
  FALLBACK_VIDEO_CODECS,
  FALLBACK_AUDIO_CODECS,
} from "./classify/rules.js";
export { probe } from "./probe/index.js";
export { remux, transcode } from "./convert/index.js";
export { srtToVtt } from "./subtitles/srt.js";
export { AvbridgeError } from "./errors.js";
export {
  ERR_PROBE_FAILED,
  ERR_PROBE_UNKNOWN_CONTAINER,
  ERR_PROBE_FETCH_FAILED,
  ERR_CODEC_NOT_SUPPORTED,
  ERR_STRATEGY_FAILED,
  ERR_ALL_STRATEGIES_EXHAUSTED,
  ERR_PLAYER_NOT_READY,
  ERR_RANGE_NOT_SUPPORTED,
  ERR_FETCH_FAILED,
  ERR_LIBAV_NOT_REACHABLE,
  ERR_MSE_NOT_SUPPORTED,
  ERR_MSE_CODEC_NOT_SUPPORTED,
} from "./errors.js";
