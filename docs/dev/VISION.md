# avbridge.js — Vision Document

## 1. Vision

**avbridge.js** is a browser-native media engine that enables:

> **Playback, remuxing, and transcoding of arbitrary audio/video files directly in the browser.**

It bridges the gap between:

* **real-world media** (AVI, MKV, WMV, FLV, legacy codecs)
* and **what browsers can actually play**

without requiring:

* server-side transcoding
* preprocessing pipelines
* or format curation

---

## 2. Problem

Modern browsers support a **narrow, inconsistent subset of media formats**:

* Containers: MP4, WebM (mostly)
* Codecs: H.264, VP9, AV1 (partial), AAC, Opus
* Platform inconsistencies (especially Android vs desktop)

Meanwhile, real-world media includes:

* AVI (DivX, Xvid)
* MKV with mixed codecs
* WMV / ASF
* FLV
* MPEG-4 Part 2
* AC3, MP3, WMA, etc.

Result:

> Files that play perfectly in VLC fail, stutter, or behave unpredictably in browsers.

---

## 3. Solution

avbridge introduces a **multi-strategy media pipeline** that dynamically adapts each file:

```text
input media
  → probe
  → classify
  → select strategy (with fallback chain)
  → execute playback or transformation
```

### Strategies

| Strategy               | Purpose                                        | Result                        |
| ---------------------- | ---------------------------------------------- | ----------------------------- |
| **native**             | Use browser decoder directly                   | Fastest, hardware-accelerated |
| **remux**              | Fix container/bitstream issues                 | Preserves hardware decode     |
| **hybrid**             | libav.js demux + WebCodecs hardware decode     | Hardware decode for legacy containers |
| **fallback**           | Software decode unsupported codecs             | Universal playback            |
| **transcode** (future) | Convert to modern formats                      | Durable compatibility         |

If a strategy fails or stalls, avbridge **automatically escalates** to the next
one in the fallback chain (e.g. native → remux → hybrid → fallback). Users can
also switch backends manually at runtime.

---

## 4. Core Insight

Most failures are not because:

> "the browser can't decode the codec"

but because:

> **the media is packaged incorrectly for the browser**

avbridge optimizes for:

1. **No work (native)**
2. **Minimal work (remux)**
3. **Demux only (hybrid)** — when the container is the problem but the codec is hardware-decodable
4. **Heavy work (fallback decode)** — when the codec genuinely has no browser support
5. **Optional work (transcode)** — for durable format conversion

---

## 5. Product Pillars

### 5.1 Universal Playback

> Open and play arbitrary media files reliably.

* Local files (File, Blob)
* URLs
* Legacy formats
* Mobile and desktop

---

### 5.2 Media Transformation

> Convert incompatible media into browser-friendly formats.

* Remux (lossless, fast)
* Transcode (optional, slower)
* Export to MP4/WebM
* Enable persistent compatibility

---

### 5.3 Runtime Adaptation

> Choose the optimal path per file, per browser, per device.

* Probe and classify each file
* Detect browser capabilities (WebCodecs, MSE, native codec support)
* Automatically escalate through fallback chains on failure or stall
* Allow manual backend switching at runtime

---

### 5.4 Observability

> Make media playback transparent and debuggable.

```ts
player.getDiagnostics()
```

Includes:

* container and codecs
* chosen strategy and why
* fallback chain and strategy switch history
* runtime metrics and performance stats

---

## 6. Architecture

### Pipeline

```text
Source → Probe → Classification → Strategy → Playback/Output
                                     ↓ (on failure/stall)
                              Fallback Chain → Next Strategy
```

### Components

* **Probe layer**

  * mediabunny (MP4, MKV, WebM, Ogg, WAV, MP3, FLAC, ADTS)
  * libav.js (AVI, ASF, FLV — containers mediabunny cannot read)

* **Classification engine**

  * Rules-based decision system
  * Produces a primary strategy + ordered fallback chain
  * Checks WebCodecs availability for hybrid routing

* **Strategies**

  * native (`<video>`)
  * remux (mediabunny demux → fMP4 mux → MSE)
  * hybrid (libav.js demux → WebCodecs VideoDecoder + libav.js audio decode → canvas + Web Audio)
  * fallback (libav.js demux + decode → canvas + Web Audio)

* **Escalation**

  * Stall detection (5s timeout on native/remux)
  * Error event handling
  * onFatalError callbacks (hybrid WebCodecs failure)
  * Manual `setStrategy()` API

### Key constraint: mediabunny container support

mediabunny is excellent for modern containers (MP4, MKV, WebM, Ogg, etc.) but
**cannot read AVI, ASF, or FLV**. This is the fundamental reason the hybrid and
fallback strategies exist — they use libav.js to demux containers that
mediabunny rejects. The hybrid strategy then hands the demuxed packets to
WebCodecs for hardware decode when the codecs are browser-supported (e.g. H.264
in AVI), while the fallback strategy software-decodes everything.

### Key constraint: libav.js threading

libav.js pthreads are broken as of v6.8.8 (probe and decode both fail with race
conditions in the worker message dispatch). Performance comes from `-O3
-msimd128` compile flags instead — WASM SIMD provides substantial speedup for
video decode without requiring SharedArrayBuffer or threading.

---

## 7. Comparison: avbridge vs mediabunny

### What mediabunny is

* Demuxer/muxer library
* Works well with modern formats
* Provides structured access to media streams
* Does not handle AVI, ASF, FLV, or legacy codecs

---

### What avbridge adds

#### 1. Strategy engine (core difference)

mediabunny:

* "Here are the streams"

avbridge:

* **"Here is how to make this playable"**

---

#### 2. Multi-path execution

mediabunny:

* demux/mux only

avbridge:

* native playback
* remux pipeline
* hybrid decode (libav.js demux + WebCodecs)
* fallback decode (full WASM)
* automatic escalation between them
* (future) transcode

---

#### 3. Legacy format support

mediabunny:

* modern containers only (MP4, MKV, WebM, Ogg, WAV, MP3, FLAC, ADTS)

avbridge:

* all of the above via mediabunny, plus:
* AVI, ASF/WMV, FLV via libav.js
* MPEG-4 Part 2, WMV3, VC-1, MS-MPEG4, MPEG-1/2 via libav.js decode

---

#### 4. Playback orchestration

mediabunny:

* low-level building blocks

avbridge:

* **complete playback system**

  * video rendering (canvas + VideoFrame)
  * audio scheduling (Web Audio)
  * A/V sync (wall-clock pacing + drift correction)
  * buffering and backpressure
  * seek across all strategies

---

#### 5. Diagnostics + reliability layer

mediabunny:

* minimal runtime insight

avbridge:

* full decision trace (why this strategy was chosen)
* strategy switch history
* runtime metrics (frames decoded/painted/dropped, buffer levels)
* automatic failure recovery

---

### Summary

> mediabunny is a **toolkit**
> avbridge is a **media engine built on top of toolkits**

---

## 8. Design Philosophy

### Native-first

Always prefer browser capabilities. If the browser can play it, get out of the way.

### Remux-over-decode

Fix the container before reaching for a decoder. Remuxing preserves hardware
acceleration and costs almost nothing compared to decode.

### Hardware-decode when possible

When the container needs libav.js but the codec is browser-supported, use
WebCodecs for hardware-accelerated decode (hybrid strategy) rather than
software decode.

### Decode-as-last-resort

Software decoding via WASM is the universal fallback. It works for everything
but costs CPU. Only use it when the codec genuinely has no browser decoder.

### Automatic recovery

Don't make the user diagnose playback failures. If a strategy fails, try the
next one automatically. Expose what happened via diagnostics.

### Transparent behavior

Every decision is inspectable. The user (or developer) can see exactly what
avbridge detected, what it chose, and why.

---

## 9. Roadmap

### v1 — Playback Engine (current)

* native / remux / hybrid / fallback strategies
* automatic escalation with fallback chains
* manual backend switching (`setStrategy()`)
* subtitles (SRT, VTT)
* diagnostics with strategy history
* stable API

---

### v2 — Transformation

* remux to MP4/WebM (export/download)
* transcode via WebCodecs encoders
* progress reporting and cancellation

Complications to solve:
* Muxing encoded output — mediabunny has fMP4 mux, but a proper downloadable
  MP4 needs non-fragmented output or a finalization step
* Memory pressure for large files — need streaming output, not buffering
  the entire result in memory
* WebCodecs VideoEncoder hardware acceleration is limited on some platforms

---

### v3 — Advanced Bridge

* MediaStream output (for WebRTC, recording)
* Worker-based pipelines (decode off main thread)
* HLS/DASH input (if there's demand)

---

## 10. Long-Term Vision

avbridge becomes:

> **The standard media compatibility layer for web applications**

Used in:

* file managers
* media libraries
* NAS interfaces
* productivity apps
* developer tools

---

## 11. Tagline

> **Play and convert any video file in the browser.**

---

## 12. Summary

avbridge is not:

* just a player
* just a demuxer
* just a decoder

It is:

> **A bridge between arbitrary media formats and the constrained environment of the browser.**

---
