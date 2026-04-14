// Player demo using <avbridge-player> — the controls-bearing element.
// Almost all UI logic is handled by the element itself. This file is
// just the file picker and diagnostics panel glue.

// Import the class and register it directly — Rollup tree-shakes
// side-effect-only imports, so we must use the import concretely.
import { AvbridgePlayerElement } from "../src/player-element.js";
if (!customElements.get("avbridge-player")) {
  customElements.define("avbridge-player", AvbridgePlayerElement);
}

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

  // Track the subtitle file separately so we can pass it when the user
  // picks a video file.
  let pendingSubtitle: { url: string; format: "srt" | "vtt"; name: string } | null = null;

  subInput.addEventListener("change", async () => {
    // Revoke any previous subtitle blob URL
    if (pendingSubtitle) {
      try { URL.revokeObjectURL(pendingSubtitle.url); } catch { /* ignore */ }
      pendingSubtitle = null;
    }
    const f = subInput.files?.[0];
    if (!f) return;
    const format = f.name.toLowerCase().endsWith(".srt") ? "srt" : "vtt";
    pendingSubtitle = {
      url: URL.createObjectURL(f),
      format,
      name: f.name,
    };
    console.log("[demo] subtitle queued:", pendingSubtitle);

    // If a video is already loaded, attach the subtitle dynamically.
    // Otherwise it'll be picked up on the next source change.
    if (player.source || player.src) {
      try {
        await (player as unknown as { addSubtitle: (s: unknown) => Promise<void> })
          .addSubtitle({ url: pendingSubtitle.url, format });
        console.log("[demo] subtitle attached dynamically");
      } catch (err) {
        showError(`subtitle attach failed: ${(err as Error).message}`);
      }
    }
  });

  fileInput.addEventListener("change", async () => {
    errorEl.textContent = "";
    const file = fileInput.files?.[0];
    if (!file) return;

    try {
      // Pass subtitles via the element — must be set BEFORE source so
      // the bootstrap picks them up.
      (player as unknown as { subtitles: unknown }).subtitles = pendingSubtitle
        ? [{ url: pendingSubtitle.url, format: pendingSubtitle.format }]
        : null;
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
