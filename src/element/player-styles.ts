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

.avp {
  position: relative;
  width: 100%;
  height: 100%;
  cursor: pointer;
}

.avp avbridge-video {
  display: block;
  width: 100%;
  height: 100%;
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
  cursor: pointer;
  z-index: 1;
}

.avp-seek-thumb {
  position: absolute;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #f00;
  top: 50%;
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
}

.avp-volume:hover .avp-volume-slider { width: 60px; }

.avp-volume-input {
  width: 60px;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: rgba(255, 255, 255, 0.3);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}

.avp-volume-input::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
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

/* ── Settings menu ────────────────────────────────────────────────────── */

.avp-settings {
  position: absolute;
  bottom: 52px;
  right: 12px;
  background: rgba(28, 28, 28, 0.95);
  border-radius: 8px;
  min-width: 220px;
  max-height: 300px;
  overflow-y: auto;
  display: none;
  z-index: 10;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
}

.avp-settings.open { display: block; }

.avp-settings-section {
  padding: 8px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.avp-settings-section:last-child { border-bottom: none; }

.avp-settings-label {
  padding: 4px 16px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  opacity: 0.5;
}

.avp-settings-item {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.1s;
}

.avp-settings-item:hover { background: rgba(255, 255, 255, 0.1); }

.avp-settings-item.active {
  color: #3ea6ff;
}

.avp-settings-item.active::before {
  content: "\\2713";
  margin-right: 8px;
  font-weight: bold;
}

/* ── Mobile adjustments ───────────────────────────────────────────────── */

@media (pointer: coarse) {
  .avp-btn svg { width: 28px; height: 28px; }
  .avp-btn { padding: 8px; }
  .avp-seek-track { height: 4px; }
  .avp-seek:hover .avp-seek-track { height: 4px; }
  .avp-seek-thumb { transform: translate(-50%, -50%) scale(1); }
  .avp-volume:hover .avp-volume-slider { width: 0; }
  .avp-overlay-btn { width: 56px; height: 56px; }
  .avp-overlay-btn svg { width: 30px; height: 30px; }
}
`;
