import { describe, it, expect } from "vitest";
import {
  AvbridgeError,
  ERR_PROBE_FAILED,
  ERR_PLAYER_NOT_READY,
  ERR_PROBE_FETCH_FAILED,
  ERR_ALL_STRATEGIES_EXHAUSTED,
  ERR_MSE_NOT_SUPPORTED,
} from "../src/errors.js";

describe("AvbridgeError", () => {
  it("is an instance of Error", () => {
    const err = new AvbridgeError(ERR_PROBE_FAILED, "test");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AvbridgeError);
  });

  it("carries code, message, and recovery", () => {
    const err = new AvbridgeError(
      ERR_PROBE_FAILED,
      "Probe failed for AVI file.",
      "Check that the file is not corrupt.",
    );
    expect(err.code).toBe("ERR_AVBRIDGE_PROBE_FAILED");
    expect(err.message).toBe("Probe failed for AVI file.");
    expect(err.recovery).toBe("Check that the file is not corrupt.");
    expect(err.name).toBe("AvbridgeError");
  });

  it("recovery is optional", () => {
    const err = new AvbridgeError(ERR_PLAYER_NOT_READY, "not ready");
    expect(err.recovery).toBeUndefined();
  });

  it("supports cause via ErrorOptions", () => {
    const cause = new Error("original");
    const err = new AvbridgeError(ERR_PROBE_FETCH_FAILED, "fetch failed", undefined, { cause });
    expect(err.cause).toBe(cause);
  });

  it("all error codes have the ERR_AVBRIDGE_ prefix", () => {
    const codes = [
      ERR_PROBE_FAILED,
      ERR_PLAYER_NOT_READY,
      ERR_PROBE_FETCH_FAILED,
      ERR_ALL_STRATEGIES_EXHAUSTED,
      ERR_MSE_NOT_SUPPORTED,
    ];
    for (const code of codes) {
      expect(code).toMatch(/^ERR_AVBRIDGE_/);
    }
  });

  it("can be caught and switched on by code", () => {
    const err = new AvbridgeError(ERR_PLAYER_NOT_READY, "not ready");
    try {
      throw err;
    } catch (e) {
      if (e instanceof AvbridgeError) {
        expect(e.code).toBe(ERR_PLAYER_NOT_READY);
      } else {
        throw new Error("expected AvbridgeError");
      }
    }
  });
});
