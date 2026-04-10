/**
 * Core types shared across UBMP modules.
 *
 * The four main concepts:
 * - {@link MediaSource_} — what the user gives us (File / Blob / URL / bytes).
 * - {@link MediaContext} — what we learned about it from probing.
 * - {@link Classification} — which playback strategy we picked.
 * - {@link PlaybackSession} — the running playback, returned by a strategy.
 */

/**
 * Anything we accept as a media source. We do not accept arbitrary
 * `ReadableStream`s in v1 because we need random access for seeking.
 */
export type MediaSource_ = File | Blob | string | URL | ArrayBuffer | Uint8Array;

/** Container format families we know about. */
export type ContainerKind =
  | "mp4"
  | "mov"
  | "mkv"
  | "webm"
  | "avi"
  | "asf"
  | "flv"
  | "ogg"
  | "wav"
  | "mp3"
  | "flac"
  | "adts"
  | "unknown";

/** Video codec families. Strings, not enums, so plugins can extend. */
export type VideoCodec =
  | "h264"
  | "h265"
  | "vp8"
  | "vp9"
  | "av1"
  | "mpeg4" // MPEG-4 Part 2 (DivX/Xvid)
  | "wmv3"
  | "vc1"
  | "rv40"
  | "mpeg2"
  | "mpeg1"
  | "theora"
  | (string & {});

/** Audio codec families. */
export type AudioCodec =
  | "aac"
  | "mp3"
  | "opus"
  | "vorbis"
  | "flac"
  | "pcm"
  | "ac3"
  | "eac3"
  | "wmav2"
  | "wmapro"
  | "alac"
  | (string & {});

export interface VideoTrackInfo {
  id: number;
  codec: VideoCodec;
  /** Codec-private profile string when known (e.g. "High", "Main 10"). */
  profile?: string;
  level?: number;
  width: number;
  height: number;
  /** Pixel format string in ffmpeg style (e.g. "yuv420p", "yuv420p10le"). */
  pixelFormat?: string;
  /** Frames per second, when known. */
  fps?: number;
  bitDepth?: number;
  /** RFC 6381 codec string for `MediaSource.isTypeSupported`, when computable. */
  codecString?: string;
}

export interface AudioTrackInfo {
  id: number;
  codec: AudioCodec;
  channels: number;
  sampleRate: number;
  language?: string;
  codecString?: string;
}

export interface SubtitleTrackInfo {
  id: number;
  /** "vtt" | "srt" | "ass" | "pgs" | "embedded" */
  format: string;
  language?: string;
  /** Set if this is a sidecar file rather than embedded in the container. */
  sidecarUrl?: string;
}

/**
 * Everything the probe layer learned about a source.
 * This is the input to the classification engine.
 */
export interface MediaContext {
  source: MediaSource_;
  /** Stable display name for diagnostics, if we have one. */
  name?: string;
  byteLength?: number;
  container: ContainerKind;
  videoTracks: VideoTrackInfo[];
  audioTracks: AudioTrackInfo[];
  subtitleTracks: SubtitleTrackInfo[];
  /** Which probe backend produced this context, for diagnostics. */
  probedBy: "mediabunny" | "libav" | "sniff";
  /** Total duration in seconds, if known. */
  duration?: number;
}

export type StrategyName = "native" | "remux" | "fallback";

export type StrategyClass =
  | "NATIVE"
  | "REMUX_CANDIDATE"
  | "FALLBACK_REQUIRED"
  | "RISKY_NATIVE";

export interface Classification {
  class: StrategyClass;
  strategy: StrategyName;
  reason: string;
  /**
   * If `class === "RISKY_NATIVE"`, the strategy to escalate to if native
   * playback stalls.
   */
  fallbackStrategy?: StrategyName;
}

/**
 * A live playback session created by a strategy. The {@link UnifiedPlayer}
 * delegates user-facing controls to whichever session is currently active.
 */
export interface PlaybackSession {
  readonly strategy: StrategyName;
  play(): Promise<void>;
  pause(): void;
  seek(time: number): Promise<void>;
  setAudioTrack(id: number): Promise<void>;
  setSubtitleTrack(id: number | null): Promise<void>;
  /** Tear down everything: revoke object URLs, close decoders, etc. */
  destroy(): Promise<void>;
  /** Strategy-specific runtime stats merged into Diagnostics. */
  getRuntimeStats(): Record<string, unknown>;
}

export interface DiagnosticsSnapshot {
  container: ContainerKind | "unknown";
  videoCodec?: VideoCodec;
  audioCodec?: AudioCodec;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  strategy: StrategyName | "pending";
  strategyClass: StrategyClass | "pending";
  reason: string;
  probedBy?: "mediabunny" | "libav" | "sniff";
  runtime?: Record<string, unknown>;
}

/** §8.2 plugin interface, kept structurally identical to the design doc. */
export interface Plugin {
  name: string;
  canHandle(context: MediaContext): boolean;
  /** Returns a session if it claims the context, otherwise throws. */
  execute(context: MediaContext, target: HTMLVideoElement): Promise<PlaybackSession>;
}

/** Player creation options. */
export interface CreatePlayerOptions {
  source: MediaSource_;
  target: HTMLVideoElement;
  /**
   * Optional explicit subtitle list. The player otherwise tries to discover
   * sidecar files via the FileSystemDirectoryHandle (when supplied), or pulls
   * embedded subtitle tracks if the container exposes them.
   */
  subtitles?: Array<{ url: string; language?: string; format?: "vtt" | "srt" }>;
  /**
   * Optional directory handle for sidecar discovery. When the source is a
   * `File` selected from this directory, sibling `*.srt`/`*.vtt` files are
   * picked up automatically.
   */
  directory?: FileSystemDirectoryHandle;
  /**
   * Override the strategy decision. Useful for diagnostics and tests.
   */
  forceStrategy?: StrategyName;
  /** Inject extra plugins; they take priority over built-ins. */
  plugins?: Plugin[];
}

/** Events emitted by {@link UnifiedPlayer}. Strongly typed. */
export interface PlayerEventMap {
  strategy: { strategy: StrategyName; reason: string };
  tracks: {
    video: VideoTrackInfo[];
    audio: AudioTrackInfo[];
    subtitle: SubtitleTrackInfo[];
  };
  error: Error;
  timeupdate: { currentTime: number };
  ended: void;
  ready: void;
}

export type PlayerEventName = keyof PlayerEventMap;

/** Generic listener type re-exported for player.on overloads. */
export type Listener<T> = (payload: T) => void;
