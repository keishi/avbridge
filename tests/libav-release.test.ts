import { describe, it, expect, vi } from "vitest";
import { releaseLibav, trackCalls } from "../src/strategies/fallback/libav-loader.js";

/** A libav.js-shaped instance whose calls never answer, as when a read stalls. */
function stuckInstance() {
  const inst = {
    c: vi.fn((..._args: unknown[]) => new Promise<unknown>(() => {})),
    terminate: vi.fn(),
    ff_read_frame_multi(...args: unknown[]) { return inst.c("ff_read_frame_multi", ...args); },
  };
  trackCalls(inst);
  return inst;
}

describe("releaseLibav", () => {
  it("fails a call stuck in flight, terminates the workers, and fails every call after", async () => {
    const inst = stuckInstance();
    const stuck = inst.ff_read_frame_multi(1, 2);
    releaseLibav(inst);
    await expect(stuck).rejects.toThrow("libav released");
    expect(inst.terminate).toHaveBeenCalledOnce();
    await expect(inst.ff_read_frame_multi(1, 2)).rejects.toThrow("libav released");
  });

  it("is safe to call twice", () => {
    const inst = stuckInstance();
    releaseLibav(inst);
    releaseLibav(inst);
    expect(inst.terminate).toHaveBeenCalledOnce();
  });

  it("passes answers and errors through while live", async () => {
    const inst = { c: (op: string) => (op === "ok" ? Promise.resolve(7) : Promise.reject(new Error("nope"))) };
    trackCalls(inst);
    await expect(inst.c("ok")).resolves.toBe(7);
    await expect(inst.c("bad")).rejects.toThrow("nope");
  });
});
