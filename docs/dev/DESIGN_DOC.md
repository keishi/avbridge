# Universal Browser Media Player (UBMP)

## Design Document (v1)

---

## 1. Overview

UBMP is a JavaScript library that enables reliable playback of **locally stored and legacy video/audio files in web browsers**.

It automatically selects the best playback strategy:

1. **Native playback** (fastest, hardware accelerated)
2. **Remux/transmux to browser-friendly container** (preserves native decoding)
3. **Software fallback decoding (WASM)** (maximum compatibility)

The goal is:

> **“Play any file on your HDD in the browser reliably.”**

---

## 2. Goals

### Primary Goals

* Play arbitrary local media files (AVI, MKV, MP4, FLV, ASF, etc.)
* Support legacy codecs (WMV, MPEG-4 Part 2, etc.)
* Preserve hardware decode whenever possible
* Provide consistent playback API
* Support subtitles and multiple audio tracks from day one
* Work well on mobile (especially Android)

### Secondary Goals

* Provide diagnostics explaining playback decisions
* Be extensible via plugins
* Keep API simple for consumers

---

## 3. Non-Goals (v1)

* Streaming protocols (HLS, DASH, RTSP)
* DRM support
* Video editing or transcoding UI
* Full VLC feature parity
* Advanced filters/effects

---

## 4. Core Principles

### 4.1 Native First

Always prefer browser-native playback (`<video>` / hardware decode).

### 4.2 Remux Before Decode

If codecs are supported but container is problematic:

* **remux instead of decode**

### 4.3 Decode Only as Last Resort

Use WASM decoding only when absolutely necessary.

### 4.4 Unified API

Consumers should not care about internal playback strategy.

### 4.5 Deterministic Decisions

Playback strategy should be:

* explainable
* inspectable
* reproducible

---

## 5. High-Level Architecture

```text
           Source (File / URL / Blob)
                        ↓
                    Probe Layer
                        ↓
                  Classification
                        ↓
              Strategy Selection
                        ↓
    ┌───────────────┬───────────────┬───────────────┐
    │ Native        │ Remux         │ Fallback      │
    │ (<video>)     │ (MSE)         │ (WASM decode) │
    └───────────────┴───────────────┴───────────────┘
                        ↓
                Unified Player API
```

---

## 6. Playback Strategies

### 6.1 Native Strategy

**When:**

* Container supported
* Codecs supported
* No known risk factors

**Implementation:**

* Assign source directly to `<video>`
* Use native track/subtitle handling

**Pros:**

* Best performance
* Lowest battery usage
* Minimal complexity

---

### 6.2 Remux Strategy

**When:**

* Codecs supported (e.g. H.264 + AAC)
* Container problematic (AVI, MKV, etc.)
* Browser likely to fail or stutter

**Implementation:**

* Demux with MediaBunny
* Repackage into fragmented MP4 (fMP4)
* Feed via Media Source Extensions (MSE)

**Responsibilities:**

* Convert Annex B → AVCC (H.264)
* Normalize timestamps
* Align fragments to keyframes
* Generate init segment

**Pros:**

* Preserves hardware decode
* Fixes most Android issues
* Much cheaper than decode

---

### 6.3 Fallback Decode Strategy

**When:**

* Codec unsupported (WMV, MPEG-4 Part 2, etc.)
* Remux not possible

**Implementation:**

* Decode via `libav.js`
* Render frames via canvas/WebGL
* Output audio via Web Audio API

**Responsibilities:**

* A/V sync
* buffering
* seeking
* frame scheduling

**Cons:**

* High CPU usage
* Higher battery consumption
* More complex implementation

---

## 7. Probe & Classification

### 7.1 Probe Layer

Extract metadata:

* container
* video codec/profile/level
* audio codec
* pixel format
* resolution
* frame rate
* subtitles

### 7.2 Classification Buckets

| Class             | Description                     |
| ----------------- | ------------------------------- |
| NATIVE            | Safe for direct playback        |
| REMUX_CANDIDATE   | Supported codecs, bad container |
| FALLBACK_REQUIRED | Unsupported codec               |
| RISKY_NATIVE      | Might stutter (edge cases)      |

---

### 7.3 Example Rules

**Native:**

* MP4 + H.264 + AAC + yuv420p

**Remux:**

* MKV/AVI + H.264 + AAC
* H.264 in non-MP4 container

**Fallback:**

* WMV3, WMA
* MPEG-4 Part 2 (DivX/Xvid)
* VC-1
* RealVideo

---

## 8. Plugin Architecture

### 8.1 Plugin Types

#### Probe Plugins

* Detect formats/codecs
* Discover sidecar subtitles

#### Strategy Plugins

* Native playback
* Remux pipeline
* WASM decode pipeline

#### Codec Plugins

* MPEG-4 Part 2 decoder
* WMV/WMA decoder
* Audio codec fallbacks

#### Subtitle Plugins

* SRT → WebVTT converter
* ASS/SSA parser (future)

---

### 8.2 Plugin Interface

```ts
interface Plugin {
  name: string;
  canHandle(context: MediaContext): boolean;
  execute(context: MediaContext): PlaybackSession;
}
```

---

## 9. Subtitles

### v1 Support

* Sidecar `.vtt`
* Sidecar `.srt` (converted to VTT)
* Embedded subtitle tracks (if available)

### Strategy

| Playback Mode | Subtitle Handling |
| ------------- | ----------------- |
| Native        | `<track>` element |
| Remux         | Inject or attach  |
| Fallback      | Custom renderer   |

---

## 10. Audio Track Support

* Detect multiple audio tracks
* Allow runtime switching
* Fallback decoding if unsupported codec

---

## 11. Public API

### Initialization

```ts
const player = await createPlayer({
  source: fileOrUrl,
  target: videoElement,
});
```

### Events

```ts
player.on("strategy", s => console.log(s));
player.on("tracks", tracks => {});
player.on("error", err => {});
```

### Controls

```ts
player.play();
player.pause();
player.seek(time);

player.setAudioTrack(id);
player.setSubtitleTrack(id);
```

---

## 12. Diagnostics

Expose structured debug info:

```ts
player.getDiagnostics();
```

Example:

```json
{
  "container": "mkv",
  "videoCodec": "h264",
  "audioCodec": "aac",
  "strategy": "remux",
  "reason": "unsupported container for Android"
}
```

---

## 13. Performance Considerations

* Prefer native decode whenever possible
* Avoid WASM decoding unless necessary
* Stream remux output incrementally
* Use workers for heavy processing

---

## 14. Mobile Considerations

* Android is primary constraint
* Avoid relying on desktop behavior
* Optimize for hardware decode paths
* Minimize CPU-heavy fallback usage

---

## 15. Future Extensions

* HLS/DASH support (via strategy plugins)
* RTSP ingestion
* Additional codecs
* GPU-based rendering for fallback
* Adaptive streaming

---

## 16. Risks

* Complexity of remux pipeline
* Timestamp edge cases
* Inconsistent browser behavior
* WASM performance limits

---

## 17. Summary

UBMP is not a full VLC clone.

It is:

> **A compatibility layer that intelligently bridges legacy media and modern browser playback.**

Key innovation:

* **Decision engine + multi-strategy playback**
* Not just decoding everything

---

## 18. MVP Scope

Ship with:

* Native playback
* Remux for H.264/AAC
* libav fallback for WMV + MPEG-4 Part 2
* Subtitles (VTT + SRT)
* Audio track selection
* Diagnostics
