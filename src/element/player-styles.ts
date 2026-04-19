/**
 * Shadow DOM CSS for <avbridge-player>.
 * YouTube-inspired dark theme. All controls use ::part() for external styling.
 */

export const PLAYER_STYLES = /* css */ `
:host {
  display: block;
  position: relative;
  width: 100%;
  background: #000;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #fff;
  line-height: 1;
}

:host(:fullscreen),
:host(:fullscreen) .avp {
  width: 100vw;
  height: 100vh;
}

/* ── Container ────────────────────────────────────────────────────────── */

:host {
  -webkit-tap-highlight-color: transparent;
  outline: none;
}

.avp {
  position: relative;
  width: 100%;
  height: 100%;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}

.avp avbridge-video {
  display: block;
  width: 100%;
  height: 100%;
}

/* Drag-and-drop file target highlight. */
.avp.avp-dragover::after {
  content: "";
  position: absolute;
  inset: 8px;
  border: 2px dashed rgba(255, 255, 255, 0.75);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.25);
  pointer-events: none;
  z-index: 10;
}

/* ── Center overlay ───────────────────────────────────────────────────── */

.avp-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  z-index: 2;
}

.avp-overlay-btn {
  width: 68px;
  height: 68px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  border: none;
  color: #fff;
  cursor: pointer;
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.2s, transform 0.15s;
  opacity: 0;
  transform: scale(0.9);
}

.avp-overlay-btn svg {
  width: 36px;
  height: 36px;
}

.avp-overlay-btn:hover {
  background: rgba(0, 0, 0, 0.75);
  transform: scale(1);
}

:host([data-state="idle"]) .avp-overlay-btn,
:host([data-state="paused"]) .avp-overlay-btn {
  opacity: 1;
  transform: scale(1);
}

/* ── Loading spinner ──────────────────────────────────────────────────── */

.avp-spinner {
  width: 48px;
  height: 48px;
  border: 4px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  display: none;
  pointer-events: none;
}

:host([data-state="loading"]) .avp-spinner,
:host([data-state="buffering"]) .avp-spinner {
  display: block;
  animation: avp-spin 0.8s linear infinite;
}

:host([data-state="loading"]) .avp-overlay-btn,
:host([data-state="buffering"]) .avp-overlay-btn {
  display: none;
}

@keyframes avp-spin {
  to { transform: rotate(360deg); }
}

/* ── Double-tap ripple ────────────────────────────────────────────────── */

.avp-ripple {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 100px;
  height: 100px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  opacity: 0;
  z-index: 3;
}

.avp-ripple svg { width: 28px; height: 28px; }
.avp-ripple-left { left: 15%; }
.avp-ripple-right { right: 15%; }

.avp-ripple.active {
  animation: avp-ripple 0.5s ease-out;
}

@keyframes avp-ripple {
  0% { opacity: 1; transform: translateY(-50%) scale(0.5); }
  100% { opacity: 0; transform: translateY(-50%) scale(1.5); }
}

/* ── Speed indicator (tap-and-hold) ───────────────────────────────────── */

.avp-speed-indicator {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.7);
  padding: 6px 16px;
  border-radius: 20px;
  font-size: 14px;
  font-weight: 600;
  pointer-events: none;
  opacity: 0;
  z-index: 4;
  transition: opacity 0.15s;
}

.avp-speed-indicator.active { opacity: 1; }

/* ── Controls bar ─────────────────────────────────────────────────────── */

.avp-controls {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 5;
  padding: 0 12px 8px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.7));
  display: flex;
  flex-direction: column;
  gap: 4px;
  opacity: 1;
  transition: opacity 0.25s;
}

:host([data-controls-hidden]) .avp-controls {
  opacity: 0;
  pointer-events: none;
}

:host([data-controls-hidden]) { cursor: none; }

/* ── Top toolbar (slotted consumer chrome) ─────────────────────────────
   Two named slots (top-left, top-right) let consumers place back / title /
   translate buttons inside the auto-hide chrome. Wrapper has
   pointer-events:none so empty slots don't block container clicks; each
   side re-enables pointer-events so real buttons remain interactive. */

.avp-toolbar-top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 5;
  padding: 8px 12px 24px;
  background: linear-gradient(rgba(0, 0, 0, 0.6), transparent);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  opacity: 1;
  pointer-events: none;
  transition: opacity 0.25s;
}

.avp-toolbar-top-left,
.avp-toolbar-top-right {
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: auto;
}

/* Left slot fills remaining space so slotted text/content can grow.
   min-width: 0 prevents flex children from overflowing the toolbar. */
.avp-toolbar-top-left {
  flex: 1;
  min-width: 0;
}

.avp-toolbar-top-right { margin-left: auto; flex-shrink: 0; }

/* Hide the gradient band when no consumer has slotted anything — we
   toggle data-toolbar-empty from JS via slotchange. */
:host([data-toolbar-empty]) .avp-toolbar-top {
  background: none;
}

:host([data-controls-hidden]) .avp-toolbar-top {
  opacity: 0;
  pointer-events: none;
}

/* ── Content overlay ─────────────────────────────────────────────────── */
/* Consumer-provided rich content (tweet cards, media info, annotations).
   Sits above the video, below the play-button overlay and controls in
   z-order. Auto-hides with the chrome. The wrapper is pointer-events:none
   so taps fall through to the video; consumers opt in on their content
   with pointer-events:auto. */

.avp-content-overlay {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  opacity: 1;
  transition: opacity 0.25s;
}

.avp-content-overlay ::slotted(*) {
  pointer-events: auto;
}

:host([data-controls-hidden]) .avp-content-overlay {
  opacity: 0;
}

/* ── Seek bar ─────────────────────────────────────────────────────────── */

.avp-seek {
  position: relative;
  height: 20px;
  display: flex;
  align-items: center;
  cursor: pointer;
}

.avp-seek-track {
  position: absolute;
  left: 0;
  right: 0;
  height: 3px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
  overflow: hidden;
  transition: height 0.1s;
}

.avp-seek:hover .avp-seek-track { height: 5px; }

.avp-seek-buffered {
  position: absolute;
  left: 0;
  height: 100%;
  background: rgba(255, 255, 255, 0.35);
  border-radius: inherit;
}

.avp-seek-progress {
  position: absolute;
  left: 0;
  height: 100%;
  background: #f00;
  border-radius: inherit;
}

.avp-seek-input {
  position: absolute;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  /* Disable pointer events — we handle clicks/drags manually on .avp-seek
   * so the click position maps linearly across the full track width.
   * The input is still used for keyboard accessibility. */
  pointer-events: none;
  z-index: 1;
}

.avp-seek-thumb {
  position: absolute;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #f00;
  top: 50%;
  /* Thumb center follows the cursor exactly: left = pct% of track width,
   * then translate(-50%) centers the thumb on that point. Matches the
   * manual pointer-to-time mapping in _timeFromSeekPointer which is
   * also linear from 0% to 100% of the track width. */
  left: calc(var(--pct, 0) * 1%);
  transform: translate(-50%, -50%) scale(0);
  transition: transform 0.1s;
  pointer-events: none;
}

.avp-seek:hover .avp-seek-thumb { transform: translate(-50%, -50%) scale(1); }

.avp-seek-tooltip {
  position: absolute;
  bottom: 24px;
  background: rgba(0, 0, 0, 0.8);
  padding: 4px 8px;
  border-radius: 3px;
  font-size: 12px;
  white-space: nowrap;
  transform: translateX(-50%);
  pointer-events: none;
  display: none;
}

.avp-seek:hover .avp-seek-tooltip { display: block; }

/* Show tooltip during active drag (touch or mouse). The JS side sets
   data-seeking on .avp-seek while the user is scrubbing. */
.avp-seek[data-seeking] .avp-seek-tooltip { display: block; }

/* Enlarge thumb while scrubbing. */
.avp-seek[data-seeking] .avp-seek-thumb {
  transform: translate(-50%, -50%) scale(1.4);
}

/* ── Bottom row ───────────────────────────────────────────────────────── */

.avp-bottom {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
}

.avp-btn {
  background: none;
  border: none;
  color: #fff;
  padding: 4px;
  cursor: pointer;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.9;
  transition: opacity 0.1s;
}

.avp-btn:hover { opacity: 1; }
.avp-btn svg { width: 24px; height: 24px; }

/* ── Volume ───────────────────────────────────────────────────────────── */

.avp-volume {
  display: flex;
  align-items: center;
  gap: 0;
}

.avp-volume-slider {
  width: 0;
  overflow: hidden;
  transition: width 0.15s;
  display: flex;
  align-items: center;
  /* Extra padding so the thumb isn't clipped at track edges */
  padding: 6px 0;
  margin: -6px 0;
}

.avp-volume:hover .avp-volume-slider { width: 68px; }

.avp-volume-input {
  width: 60px;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: rgba(255, 255, 255, 0.3);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
  /* Prevent thumb clipping — the thumb is taller than the track */
  overflow: visible;
  margin: 0;
}

.avp-volume-input::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  cursor: pointer;
}

.avp-volume-input::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  border: none;
  cursor: pointer;
}

/* ── Time display ─────────────────────────────────────────────────────── */

.avp-time {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  opacity: 0.9;
}

/* ── Strategy badge ───────────────────────────────────────────────────── */

.avp-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.15);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  opacity: 0.8;
}

.avp-badge[data-strategy="native"] { background: rgba(45, 106, 79, 0.7); }
.avp-badge[data-strategy="remux"] { background: rgba(30, 96, 145, 0.7); }
.avp-badge[data-strategy="hybrid"] { background: rgba(199, 125, 255, 0.4); }
.avp-badge[data-strategy="fallback"] { background: rgba(157, 78, 221, 0.5); }

/* ── Spacer ───────────────────────────────────────────────────────────── */

.avp-spacer { flex: 1; }

/* ── Settings bottom sheet ────────────────────────────────────────────── */

/* Scrim — semi-transparent overlay behind the sheet, above the video.
   Tapping it dismisses the sheet. */
.avp-settings-scrim {
  position: absolute;
  inset: 0;
  z-index: 9;
  background: rgba(0, 0, 0, 0.4);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s;
}

.avp-settings-scrim.open {
  opacity: 1;
  pointer-events: auto;
}

/* Sheet container — slides up from the bottom. Height is content-driven
   up to a JS-measured max (set on open via style.maxHeight). */
.avp-settings {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 10;
  background: rgba(28, 28, 28, 0.97);
  border-radius: 12px 12px 0 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  transform: translateY(100%);
  transition: transform 0.2s ease-out;
  max-height: 70%;
  padding-bottom: 52px;
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.5);
}

.avp-settings.open {
  transform: translateY(0);
}

/* Drag handle indicator at top of sheet. */
.avp-settings-handle {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.3);
  margin: 8px auto 4px;
}

/* ── Accordion sections ──────────────────────────────────────────────── */

.avp-settings-section {
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.avp-settings-section:last-child { border-bottom: none; }

/* Section header — clickable row showing label + current value. */
.avp-settings-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  cursor: pointer;
  font-size: 14px;
  transition: background 0.1s;
}

.avp-settings-header:hover { background: rgba(255, 255, 255, 0.06); }

.avp-settings-header-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}

.avp-settings-header-value {
  margin-left: auto;
  opacity: 0.6;
  font-size: 13px;
  text-align: right;
}

/* Invisible native <select> layered over the value portion of the row.
   Covers from the value text to the right edge so tapping the value
   opens the OS picker. The label side remains inert. */
.avp-settings-select {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 50%;
  opacity: 0;
  cursor: pointer;
  font-size: 16px;
  direction: rtl;
}

/* Toggle-style rows (Stats for Nerds) — no select, just clickable. */
.avp-settings-toggle {
  cursor: pointer;
}
.avp-settings-toggle:hover { background: rgba(255, 255, 255, 0.06); }

/* ── Stats for nerds ──────────────────────────────────────────────────── */

.avp-stats {
  position: absolute;
  top: 12px;
  left: 12px;
  background: rgba(0, 0, 0, 0.8);
  padding: 12px 16px;
  border-radius: 6px;
  font-size: 12px;
  font-family: "SF Mono", "Menlo", "Consolas", monospace;
  line-height: 1.6;
  white-space: pre;
  pointer-events: auto;
  z-index: 6;
  max-width: 400px;
  overflow: auto;
  display: none;
}

.avp-stats.open { display: block; }

/* ── Mobile adjustments ───────────────────────────────────────────────── */

@media (pointer: coarse) {
  .avp-btn svg { width: 28px; height: 28px; }
  .avp-btn { padding: 8px; }

  /* Taller touch target on mobile (44px, matching YouTube Mobile)
     while keeping the visual track thin. Negative margin collapses
     the extra space so the controls layout doesn't shift. */
  .avp-seek { height: 44px; margin-top: -12px; margin-bottom: -12px; }
  .avp-seek-track { height: 4px; }
  .avp-seek:hover .avp-seek-track { height: 4px; }
  .avp-seek-thumb {
    transform: translate(-50%, -50%) scale(1);
    width: 16px;
    height: 16px;
  }
  .avp-seek[data-seeking] .avp-seek-thumb {
    transform: translate(-50%, -50%) scale(1.5);
  }
  /* Move tooltip above the taller touch zone. */
  .avp-seek-tooltip { bottom: 32px; }

  .avp-volume:hover .avp-volume-slider { width: 0; }
  .avp-overlay-btn { width: 56px; height: 56px; }
  .avp-overlay-btn svg { width: 30px; height: 30px; }
}
`;
