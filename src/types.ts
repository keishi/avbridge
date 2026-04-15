/**
 * Core types shared across avbridge modules.
 *
 * The four main concepts:
 * - {@link MediaInput} — what the user gives us (File / Blob / URL / bytes).
 * - {@link MediaContext} — what we learned about it from probing.
 * - {@link Classification} — which playback strategy we picked.
 * - {@link PlaybackSession} — the running playback, returned by a strategy.
 */

/**
 * Anything we accept as a media source. We do not accept arbitrary
 * `ReadableStream`s in v1 because we need random access for seeking.
 */
export type MediaInput = File | Blob | string | URL | ArrayBuffer | Uint8Array;

/** Container format families we know about. */
export type ContainerKind =
  | "mp4"
  | "mov"
  | "mkv"
  | "webm"
  | "avi"
  | "asf"
  | "flv"
  | "rm" // RealMedia (.rm / .rmvb)
  | "ogg"
  | "wav"
  | "mp3"
  | "flac"
  | "adts"
  | "mpegts"
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
  | "rv10" // RealVideo 1.0 (H.263-like)
  | "rv20" // RealVideo G2
  | "rv30" // RealVideo 8
  | "rv40" // RealVideo 9/10
  | "mpeg2"
  | "mpeg1"
  | "theora"
  | "dv" // DV / DVCPRO (camcorder, MiniDV)
  | "hq_hqa" // Canopus HQ / HQA (Grass Valley intermediate)
  | "rawvideo" // uncompressed frames
  | "qtrle" // QuickTime Animation (Apple RLE)
  | "png" // PNG sequence in MOV
  | "vp6f" // VP6 Flash variant
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
  | "cook" // RealAudio Cooker (G2/RealAudio 8)
  | "ra_144" // RealAudio 1.0 (14.4 kbps)
  | "ra_288" // RealAudio 2.0 (28.8 kbps)
  | "sipr" // RealAudio Sipr (voice codec)
  | "atrac3" // Sony ATRAC3 (sometimes seen in .rm)
  | "dts" // DTS (common in Blu-ray MKV rips)
  | "truehd" // Dolby TrueHD (Blu-ray lossless)
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
  source: MediaInput;
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

/**
 * The four playback strategies, ordered from lightest to heaviest:
 * - `"native"` — direct `<video>` playback (zero overhead)
 * - `"remux"` — repackage to fragmented MP4 via MSE (preserves hardware decode)
 * - `"hybrid"` — libav.js demux + WebCodecs hardware decode (for AVI/ASF/FLV with modern codecs)
 * - `"fallback"` — full WASM software decode via libav.js (universal, CPU-intensive)
 */
export type StrategyName = "native" | "remux" | "hybrid" | "fallback";

/**
 * Classification outcome from the rules engine. Determines which strategy to use:
 * - `NATIVE` — browser plays this directly
 * - `REMUX_CANDIDATE` — codecs are native, container needs repackaging
 * - `HYBRID_CANDIDATE` — container needs libav demux, codecs are hardware-decodable
 * - `FALLBACK_REQUIRED` — codec has no browser decoder, WASM decode needed
 * - `RISKY_NATIVE` — might work natively but may stall (e.g. Hi10P, 4K120)
 */
export type StrategyClass =
  | "NATIVE"
  | "REMUX_CANDIDATE"
  | "HYBRID_CANDIDATE"
  | "FALLBACK_REQUIRED"
  | "RISKY_NATIVE";

export interface Classification {
  class: StrategyClass;
  strategy: StrategyName;
  reason: string;
  /**
   * Ordered list of strategies to try if the primary fails or stalls.
   * The player pops from the front on each escalation.
   */
  fallbackChain?: StrategyName[];
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
  /** Current playback position in seconds. Used to capture position before strategy switch. */
  getCurrentTime(): number;
  /** Register a callback for unrecoverable errors that should trigger escalation. */
  onFatalError?(handler: (reason: string) => void): void;
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
  /**
   * Where the source is coming from. `"blob"` means File / Blob /
   * ArrayBuffer / Uint8Array (in-memory). `"url"` means an HTTP/HTTPS URL
   * being streamed via Range requests.
   */
  sourceType?: "blob" | "url";
  /**
   * Transport used to read the source. `"memory"` for in-memory blobs;
   * `"http-range"` for URL sources streamed via HTTP Range requests.
   */
  transport?: "memory" | "http-range";
  /**
   * For URL sources, true if the server supports HTTP Range requests
   * (the only mode we accept — see `attachLibavHttpReader`). Always true
   * when `transport === "http-range"` because we fail fast otherwise.
   */
  rangeSupported?: boolean;
  runtime?: Record<string, unknown>;
  strategyHistory?: Array<{ strategy: StrategyName; reason: string; at: number }>;
}

/** §8.2 plugin interface, kept structurally identical to the design doc. */
export interface Plugin {
  name: string;
  canHandle(context: MediaContext): boolean;
  /** Returns a session if it claims the context, otherwise throws. */
  execute(context: MediaContext, target: HTMLVideoElement, transport?: TransportConfig): Promise<PlaybackSession>;
}

/** Player creation options. */
export interface CreatePlayerOptions {
  source: MediaInput;
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
   * Skip classification and start with the given strategy. Useful for
   * diagnostics, tests, and consumers that already know the right path.
   *
   * **Note:** this is the *initial* strategy, not a hard force — if the
   * named strategy fails to start, the player still walks the fallback
   * chain like a normal classification would. The strategy class shown in
   * diagnostics matches whatever the picked strategy actually is, not
   * "NATIVE" by default.
   */
  initialStrategy?: StrategyName;
  /** Inject extra plugins; they take priority over built-ins. */
  plugins?: Plugin[];
  /**
   * When true (default), the player automatically escalates to the next
   * strategy in the fallback chain on failure or stall.
   */
  autoEscalate?: boolean;
  /**
   * Behavior when the browser tab becomes hidden.
   * - `"pause"` (default): auto-pause on hide, auto-resume on visible
   *   if the user had been playing. Matches YouTube, Netflix, and
   *   native media players. Prevents degraded playback from Chrome's
   *   background throttling of requestAnimationFrame and setTimeout.
   * - `"continue"`: keep playing. Playback will degrade anyway due to
   *   browser throttling, but useful for consumers who want full
   *   control of visibility handling themselves.
   */
  backgroundBehavior?: "pause" | "continue";
  /**
   * Extra {@link RequestInit} merged into every HTTP request the player
   * makes (probe Range requests, subtitle fetches, libav HTTP reader).
   * Headers are merged, not overwritten — so you can add `Authorization`
   * without losing the player's `Range` header.
   */
  requestInit?: RequestInit;
  /**
   * Custom fetch implementation. Defaults to `globalThis.fetch`. Useful
   * for interceptors, logging, or environments without a global fetch.
   */
  fetchFn?: FetchFn;
}

/** Signature-compatible with `globalThis.fetch`. */
export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Internal transport config bundle. Not part of the public API. */
export interface TransportConfig {
  requestInit?: RequestInit;
  fetchFn?: FetchFn;
}

/** Events emitted by {@link UnifiedPlayer}. Strongly typed. */
export interface PlayerEventMap {
  strategy: { strategy: StrategyName; reason: string };
  strategychange: { from: StrategyName; to: StrategyName; reason: string; currentTime: number };
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

/**
 * CustomEvents dispatched by `<avbridge-video>` and `<avbridge-player>`.
 * Map each event name to the full `CustomEvent<Detail>` so addEventListener
 * overloads can type the listener parameter correctly.
 *
 * Standard HTMLMediaElement events (play, pause, seeking, volumechange,
 * etc.) are forwarded from the inner `<video>` as plain `Event`s and remain
 * typed via the built-in `HTMLElementEventMap`. They are NOT in this map —
 * TypeScript will pick up their native types automatically.
 */
export interface AvbridgeVideoElementEventMap {
  strategychange: CustomEvent<{
    strategy: StrategyName;
    strategyClass: string | null;
    reason: string;
    from?: StrategyName;
    currentTime?: number;
    diagnostics: DiagnosticsSnapshot;
  }>;
  trackschange: CustomEvent<{
    audioTracks: AudioTrackInfo[];
    subtitleTracks: SubtitleTrackInfo[];
  }>;
  timeupdate: CustomEvent<{ currentTime: number }>;
  ended: CustomEvent<Record<string, never>>;
  ready: CustomEvent<{ diagnostics: DiagnosticsSnapshot }>;
  destroy: CustomEvent<Record<string, never>>;
  error: CustomEvent<{ error: Error; diagnostics: DiagnosticsSnapshot | null }>;
  progress: CustomEvent<{ buffered: TimeRanges }>;
  loadstart: CustomEvent<Record<string, never>>;
  fitchange: CustomEvent<{ fit: "contain" | "cover" | "fill" }>;
}

// ── Conversion types ────────────────────────────────────────────────────

/** Target output format for conversion functions. */
export type OutputFormat = "mp4" | "webm" | "mkv";

/** Options for standalone conversion functions ({@link remux}, transcode). */
export interface ConvertOptions {
  /** Target container format. Default: `"mp4"`. */
  outputFormat?: OutputFormat;
  /** AbortSignal to cancel the operation. */
  signal?: AbortSignal;
  /** Called periodically with progress information. */
  onProgress?: (info: ProgressInfo) => void;
  /** When true, reject on any uncertain codec/container combo. Default: `false` (best-effort). */
  strict?: boolean;
  /**
   * Write output progressively to a `WritableStream` instead of accumulating
   * in memory. Use with the File System Access API (`showSaveFilePicker()`) to
   * transcode files larger than available memory.
   *
   * When set, the returned `ConvertResult.blob` will be an empty Blob (the
   * real data went to the stream). The caller is responsible for closing the
   * stream after the returned promise resolves.
   *
   * @example
   * ```ts
   * const handle = await showSaveFilePicker({ suggestedName: "output.mp4" });
   * const writable = await handle.createWritable();
   * const result = await transcode(file, { outputStream: writable });
   * await writable.close();
   * ```
   */
  outputStream?: WritableStream;
}

/** Progress information passed to {@link ConvertOptions.onProgress}. */
export interface ProgressInfo {
  /** Estimated completion percentage, 0–100. */
  percent: number;
  /** Total bytes written to the output so far. */
  bytesWritten: number;
}

/** Quality preset for transcode. */
export type TranscodeQuality = "low" | "medium" | "high" | "very-high";

/** Modern video codecs supported as transcode targets. */
export type OutputVideoCodec = "h264" | "h265" | "vp9" | "av1";

/** Modern audio codecs supported as transcode targets. */
export type OutputAudioCodec = "aac" | "opus" | "flac";

/**
 * Hardware acceleration hint for WebCodecs encoders.
 * - `"no-preference"` (default) — let the browser pick
 * - `"prefer-hardware"` — faster, may produce slightly lower quality at low bitrates
 * - `"prefer-software"` — better quality at low bitrates, slower; recommended for archival
 */
export type HardwareAccelerationHint = "no-preference" | "prefer-hardware" | "prefer-software";

/** Options for {@link transcode}. Extends {@link ConvertOptions} with codec/quality. */
export interface TranscodeOptions extends ConvertOptions {
  /** Target video codec. Default: `"h264"` for mp4/mkv, `"vp9"` for webm. */
  videoCodec?: OutputVideoCodec;
  /** Target audio codec. Default: `"aac"` for mp4/mkv, `"opus"` for webm. */
  audioCodec?: OutputAudioCodec;
  /** Quality preset. Default: `"medium"`. Maps to mediabunny `Quality` levels. */
  quality?: TranscodeQuality;
  /** Explicit video bitrate in bits per second. Overrides `quality`. */
  videoBitrate?: number;
  /** Explicit audio bitrate in bits per second. Overrides `quality`. */
  audioBitrate?: number;
  /** Target output width in pixels. Height is auto-deduced if not set. */
  width?: number;
  /** Target output height in pixels. Width is auto-deduced if not set. */
  height?: number;
  /** Target output frame rate. */
  frameRate?: number;
  /** Drop the video track entirely (audio-only output). */
  dropVideo?: boolean;
  /** Drop the audio track entirely (silent output). */
  dropAudio?: boolean;
  /**
   * Hardware acceleration hint for the WebCodecs video encoder. Default: `"no-preference"`.
   * Set to `"prefer-software"` for archival-quality encodes at low bitrates;
   * `"prefer-hardware"` for fast batch transcoding where speed matters more than the last
   * few percent of quality.
   */
  hardwareAcceleration?: HardwareAccelerationHint;
}

/** Result of a standalone conversion ({@link remux} or transcode). */
export interface ConvertResult {
  /** The converted file as a Blob, ready for download or further processing. */
  blob: Blob;
  /** Full MIME type string, e.g. `"video/mp4"`. */
  mimeType: string;
  /** Container format name: `"mp4"`, `"webm"`, or `"mkv"`. */
  container: OutputFormat;
  /** Video codec in the output, if present. */
  videoCodec?: string;
  /** Audio codec in the output, if present. */
  audioCodec?: string;
  /** Duration in seconds, if known. */
  duration?: number;
  /** Suggested filename for download. */
  filename?: string;
  /**
   * Diagnostic notes about how the conversion ran. Currently records
   * automatic retry of WebCodecs encoder failures (a known headless
   * Chromium first-call init bug for the H.264 encoder).
   */
  notes?: string[];
}
