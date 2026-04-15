// Test harness module for Playwright cross-browser tests.
// Exposes probe, classify, and a loadAndPlay helper on window.avbridge
// so tests can drive a real <avbridge-player> from page.evaluate().
//
// Companion to demo/tests-harness.html. Not shipped in production builds.

import { probe, classify } from "../src/index.js";
import { AvbridgePlayerElement } from "../src/player-element.js";
import type { DiagnosticsSnapshot } from "../src/types.js";

if (!customElements.get("avbridge-player")) {
  customElements.define("avbridge-player", AvbridgePlayerElement);
}

interface LoadAndPlayResult {
  strategy: string | null;
  strategyClass: string | null;
  timeAdvanced: number;
  framesPainted: number;
  durationSec: number | null;
  playError: string | null;
  fallbackReason: string | null;
}

async function loadAndPlay(
  fixtureUrl: string,
  opts: { playMs?: number; readyTimeoutMs?: number } = {},
): Promise<LoadAndPlayResult> {
  const playMs = opts.playMs ?? 2000;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 15000;

  const mount = document.getElementById("player-mount");
  if (!mount) throw new Error("#player-mount not found");
  mount.innerHTML = "";
  const player = document.createElement("avbridge-player") as AvbridgePlayerElement;
  mount.appendChild(player);
  await customElements.whenDefined("avbridge-player");

  // Mute before attaching source so autoplay-on-bootstrap (if any)
  // isn't blocked by browser audio policy. Tests measure playback
  // advance, not audible output.
  (player as unknown as { muted: boolean }).muted = true;

  const resp = await fetch(fixtureUrl);
  if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
  const blob = await resp.blob();
  (player as unknown as { source: Blob }).source = blob;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`ready timeout after ${readyTimeoutMs}ms`)),
      readyTimeoutMs,
    );
    player.addEventListener("ready", () => { clearTimeout(timer); resolve(); }, { once: true });
    player.addEventListener("error", (e) => {
      clearTimeout(timer);
      const err = e.detail?.error ?? new Error("player dispatched error");
      reject(err);
    }, { once: true });
  });

  const initialTime = player.currentTime ?? 0;
  const initialDiag = player.getDiagnostics() as DiagnosticsSnapshot | null;
  const initialFrames = Number(
    (initialDiag?.runtime as Record<string, unknown> | undefined)?.framesPainted ?? 0,
  );

  let playError: string | null = null;
  try {
    await player.play();
  } catch (err) {
    playError = (err as Error).message ?? String(err);
  }

  await new Promise((r) => setTimeout(r, playMs));

  const finalTime = player.currentTime ?? 0;
  const finalDiag = player.getDiagnostics() as DiagnosticsSnapshot | null;
  const finalFrames = Number(
    (finalDiag?.runtime as Record<string, unknown> | undefined)?.framesPainted ?? 0,
  );

  const result: LoadAndPlayResult = {
    strategy: finalDiag?.strategy ?? null,
    strategyClass: (finalDiag?.strategyClass as string | undefined) ?? null,
    timeAdvanced: finalTime - initialTime,
    framesPainted: finalFrames - initialFrames,
    durationSec: player.duration ?? null,
    playError,
    fallbackReason: (finalDiag as unknown as { fallbackReason?: string } | null)?.fallbackReason ?? null,
  };

  try {
    if (typeof (player as unknown as { destroy?: () => Promise<void> }).destroy === "function") {
      await (player as unknown as { destroy: () => Promise<void> }).destroy();
    }
  } catch { /* ignore */ }
  mount.innerHTML = "";

  return result;
}

(window as unknown as { avbridge: unknown }).avbridge = { probe, classify, loadAndPlay };
(window as unknown as { __avbridgeReady: boolean }).__avbridgeReady = true;
