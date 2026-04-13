// Player demo using <avbridge-player> — the controls-bearing element.
// Almost all UI logic is handled by the element itself. This file is
// just the file picker and diagnostics panel glue.

import "../src/player-element.js";
import type { AvbridgePlayerElement } from "../src/element/avbridge-player.js";

const fileInput = document.getElementById("file") as HTMLInputElement;
const subInput = document.getElementById("subs") as HTMLInputElement;
const diag = document.getElementById("diagnostics")!;
const errorEl = document.getElementById("error")!;

function showError(msg: string): void {
  errorEl.textContent = msg;
  console.error("[demo]", msg);
}

// Wait for the custom element to be defined before using its methods.
customElements.whenDefined("avbridge-player").then(() => {
  const player = document.getElementById("player") as AvbridgePlayerElement;
  if (!player || typeof player.play !== "function") {
    showError("avbridge-player element not upgraded — check that the registration ran.");
    return;
  }
  init(player);
}).catch((err) => showError(`whenDefined failed: ${err}`));

function init(player: AvbridgePlayerElement): void {
  player.addEventListener("error", (e) => {
    const detail = (e as unknown as CustomEvent).detail;
    showError(detail?.error?.message ?? String(detail?.error ?? e));
  });

  player.addEventListener("ready", () => {
    try {
      diag.textContent = JSON.stringify(player.getDiagnostics(), null, 2);
    } catch { /* ignore */ }
  });

  setInterval(() => {
    try {
      const d = player.getDiagnostics();
      if (d) diag.textContent = JSON.stringify(d, null, 2);
    } catch { /* element not ready yet */ }
  }, 1000);

  subInput.addEventListener("change", () => {
    console.log("[demo] subtitle selected:", subInput.files?.[0]?.name);
  });

  fileInput.addEventListener("change", async () => {
    errorEl.textContent = "";
    const file = fileInput.files?.[0];
    if (!file) return;

    try {
      player.source = file;
      await player.play();
    } catch (err) {
      showError((err as Error).message ?? String(err));
      try {
        const d = player.getDiagnostics();
        if (d) diag.textContent = JSON.stringify(d, null, 2);
      } catch { /* ignore */ }
    }
  });
}
