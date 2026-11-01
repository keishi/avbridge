/**
 * Screen Wake Lock manager.
 *
 * Keeps the device screen awake while media is playing. This matters most
 * for the hybrid and fallback strategies: they render decoded frames to a
 * `<canvas>`, so the inner `<video>` element never actually plays and the
 * OS never sees "active media" — without an explicit lock the phone dims
 * and sleeps mid-playback. Native/remux paths keep the screen awake on
 * their own, but requesting the lock there too is harmless and keeps
 * behavior uniform across strategies.
 *
 * Two platform quirks this wraps:
 *  - `request()` rejects on insecure contexts, when the document is hidden,
 *    or where the API is unsupported (older iOS). All failures are swallowed
 *    — a missing wake lock degrades gracefully to "screen may sleep".
 *  - The browser auto-releases the lock when the tab is backgrounded. We
 *    listen for `visibilitychange` and re-acquire when the page is visible
 *    again, as long as the caller still wants the lock held.
 */

// Minimal structural types so this compiles even on TS lib targets that
// predate the Wake Lock DOM typings. They mirror the spec shape.
interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}
interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

function getWakeLock(): WakeLockLike | undefined {
  const nav = navigator as unknown as { wakeLock?: WakeLockLike };
  return nav.wakeLock;
}

export class WakeLockManager {
  /** Whether the caller currently wants the screen kept awake. */
  private _desired = false;
  /** The active sentinel, if the lock is currently held. */
  private _sentinel: WakeLockSentinelLike | null = null;
  /** Guards against overlapping acquire() calls racing each other. */
  private _acquiring = false;

  private readonly _onVisibilityChange = (): void => {
    // The OS drops the lock when we go to the background. Re-acquire when we
    // come back, but only if playback still wants it.
    if (this._desired && document.visibilityState === "visible") {
      void this._acquire();
    }
  };

  constructor() {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this._onVisibilityChange);
    }
  }

  /** Request the screen stay awake. Idempotent while held. */
  request(): void {
    this._desired = true;
    void this._acquire();
  }

  /** Release the lock and stop re-acquiring it. Idempotent. */
  release(): void {
    this._desired = false;
    void this._release();
  }

  /** Tear down for good — release the lock and unhook the visibility listener. */
  dispose(): void {
    this.release();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this._onVisibilityChange);
    }
  }

  private async _acquire(): Promise<void> {
    if (this._acquiring) return;
    if (this._sentinel && !this._sentinel.released) return;
    const wakeLock = getWakeLock();
    // request() only succeeds while the document is visible.
    if (!wakeLock || document.visibilityState !== "visible") return;
    this._acquiring = true;
    try {
      const sentinel = await wakeLock.request("screen");
      // A release() may have raced in while we were awaiting; honor it.
      if (!this._desired) {
        void sentinel.release().catch(() => { /* ignore */ });
        return;
      }
      this._sentinel = sentinel;
      sentinel.addEventListener("release", () => {
        if (this._sentinel === sentinel) this._sentinel = null;
      });
    } catch {
      // Unsupported, insecure context, hidden, or permission denied — the
      // screen may sleep, but that's a tolerable degradation.
    } finally {
      this._acquiring = false;
    }
  }

  private async _release(): Promise<void> {
    const sentinel = this._sentinel;
    this._sentinel = null;
    if (sentinel && !sentinel.released) {
      try { await sentinel.release(); } catch { /* ignore */ }
    }
  }
}
