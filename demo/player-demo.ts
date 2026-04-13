// Player demo using <avbridge-player> — the controls-bearing element.
// Almost all UI logic is handled by the element itself. This file is
// just the file picker and diagnostics panel glue.

import "../src/player-element.js";
import type { AvbridgePlayerElement } from "../src/element/avbridge-player.js";

const fileInput = document.getElementById("file") as HTMLInputElement;
const subInput = document.getElementById("subs") as HTMLInputElement;
const diag = document.getElementById("diagnostics")!;
const errorEl = document.getElementById("error")!;

// Wait for the custom element to be defined before using its methods.
customElements.whenDefined("avbridge-player").then(() => {
  init(document.getElementById("player") as AvbridgePlayerElement);
});

function init(player: AvbridgePlayerElement): void {
  // ── Events ────────────────────────────────────────────────────────────

  player.addEventListener("error", (e) => {
    const detail = (e as unknown as CustomEvent).detail;
    errorEl.textContent = detail?.error?.message ?? String(detail?.error ?? e);
  });

  player.addEventListener("ready", () => {
    diag.textContent = JSON.stringify(player.getDiagnostics(), null, 2);
  });

  setInterval(() => {
    try {
      const d = player.getDiagnostics();
      if (d) diag.textContent = JSON.stringify(d, null, 2);
    } catch { /* element not ready yet */ }
  }, 1000);

  // ── File picker ───────────────────────────────────────────────────────

  // TODO: wire subtitle picker once <avbridge-player> exposes addTextTrack
  subInput.addEventListener("change", () => {
    console.log("[demo] subtitle selected:", subInput.files?.[0]?.name);
  });

  fileInput.addEventListener("change", async () => {
    errorEl.textContent = "";
    const file = fileInput.files?.[0];
    if (!file) return;

    try {
      (player as unknown as { source: unknown }).source = file;
      await player.play();
    } catch (err) {
      errorEl.textContent = (err as Error).message;
      try {
        const d = player.getDiagnostics();
        if (d) diag.textContent = JSON.stringify(d, null, 2);
      } catch { /* ignore */ }
    }
  });
}
