# avbridge — Resilient Playback & Media Repair Vision

## 1. Overview

Beyond playback and transcoding, **avbridge** aims to become:

> **A resilient media engine that can recover, repair, and play damaged or malformed media files in the browser.**

Real-world media is often imperfect:

* incomplete downloads
* bit rot
* malformed containers
* legacy encoding quirks
* inconsistent timestamps

Traditional browser playback fails fast.

avbridge takes the opposite approach:

> **Best-effort playback over strict correctness.**

---

## 2. Problem

Most browser media pipelines assume:

* valid container structure
* correct timestamps
* properly formatted bitstreams
* complete file data

In reality:

* AVI files often lack proper indexes
* DivX-era files use packed B-frames
* MP3 streams may have broken headers
* MKV/MP4 metadata may be inconsistent
* files may be truncated mid-stream

Result:

> Browsers reject or fail to play media that desktop players (e.g., VLC) handle gracefully.

---

## 3. Goal

avbridge should:

* **maximize successful playback**
* **recover from corruption when possible**
* **degrade gracefully when not**
* **never fail prematurely if recovery is possible**

---

## 4. Design Principle

### Fail late, recover early

Instead of:

```text
invalid input → throw error → stop
```

avbridge uses:

```text
invalid input → attempt repair → continue → degrade if needed
```

---

## 5. Resilience Pipeline

The playback pipeline becomes:

```text id="k9w9kx"
source
  → probe
  → detect anomalies
  → apply repair strategies
  → classify
  → playback strategy (native / remux / fallback)
  → runtime recovery (if needed)
```

---

## 6. Classes of Media Issues

### 6.1 Container-level issues

* missing or corrupted indexes (AVI, MKV)
* incorrect duration metadata
* broken seek tables
* packet boundary inconsistencies
* truncated files

---

### 6.2 Bitstream-level issues

* packed B-frames (DivX / MPEG-4 Part 2)
* incorrect or missing headers
* malformed extradata
* Annex B vs AVCC mismatches
* invalid start codes
* partial frame corruption

---

### 6.3 Decode-level issues

* corrupt frames
* invalid packets
* partial audio frames
* sync loss

---

### 6.4 Playback-level issues

* timestamp drift
* non-monotonic PTS/DTS
* discontinuities
* A/V desync caused by errors

---

## 7. Repair & Recovery Strategies

### 7.1 Container Repair

* reconstruct missing indexes via linear scan
* infer duration from stream
* rebuild packet ordering heuristically
* fallback to sequential playback when seeking is unreliable

---

### 7.2 Bitstream Fixups

Apply known transformations:

* `mpeg4_unpack_bframes`
* H.264 Annex B ↔ AVCC normalization
* inject missing SPS/PPS where possible
* MP3 frame resynchronization
* sanitize malformed headers

---

### 7.3 Decode Tolerance

* skip corrupt frames
* resume decoding at next valid boundary
* tolerate partial frames
* continue on recoverable errors

---

### 7.4 Playback Recovery

* drop visibly broken frames
* maintain audio continuity
* re-sync clocks after discontinuities
* recover from timestamp jumps

---

## 8. Resilience Modes

Expose configurable behavior:

```ts id="p5m3hz"
createPlayer({
  source,
  resilience: "max", // "strict" | "normal" | "max"
});
```

### Modes

| Mode       | Behavior                                  |
| ---------- | ----------------------------------------- |
| **strict** | Fail on invalid input                     |
| **normal** | Apply safe fixups                         |
| **max**    | Aggressive recovery, best-effort playback |

---

## 9. Diagnostics

Expose repair behavior:

```ts id="2l8h7k"
player.getDiagnostics();
```

Example:

```json id="4q1k9l"
{
  "strategy": "fallback",
  "repairsApplied": [
    "avi_index_reconstructed",
    "mpeg4_unpack_bframes",
    "mp3_resync"
  ],
  "recoverableErrors": 18,
  "unrecoverableErrors": 1
}
```

---

## 10. Degradation Strategy

When full recovery is not possible:

* disable seeking but allow playback
* skip damaged segments
* preserve audio when video is compromised
* fallback to lower fidelity

---

## 11. Non-Goals

* Perfect recovery of all corrupted media
* Bit-exact reconstruction of original streams
* Full repair of severely damaged files

---

## 12. Comparison to Existing Tools

### Browsers

* strict
* fail fast
* limited recovery

---

### VLC

* tolerant
* aggressive recovery
* desktop-native

---

### avbridge

> **VLC-like resilience, adapted to browser constraints**

---

## 13. Strategic Value

This capability:

* dramatically increases real-world success rate
* differentiates avbridge from pure media toolkits
* aligns with “play anything” promise
* reduces user frustration with legacy media

---

## 14. Future Extensions

* heuristic-based repair improvements
* adaptive strategies based on file patterns
* dataset-driven tuning (real-world media corpus)
* optional “repair-only” mode (no playback)

---

## 15. Summary

Resilient playback transforms avbridge from:

> a compatibility layer

into:

> **a media recovery engine for the browser**

It ensures that:

> **media that *should* play, *does* play — even when imperfect.**

---
