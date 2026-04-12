import { describe, it, expect, vi } from "vitest";
import { TypedEmitter } from "../src/events.js";

type TestEvents = {
  foo: string;
  bar: number;
  ready: undefined;
};

describe("TypedEmitter", () => {
  it("delivers events to subscribers", () => {
    const emitter = new TypedEmitter<TestEvents>();
    const calls: string[] = [];
    emitter.on("foo", (v) => calls.push(v));
    emitter.emit("foo", "hello");
    emitter.emit("foo", "world");
    expect(calls).toEqual(["hello", "world"]);
  });

  it("supports multiple listeners on the same event", () => {
    const emitter = new TypedEmitter<TestEvents>();
    const a: string[] = [];
    const b: string[] = [];
    emitter.on("foo", (v) => a.push(v));
    emitter.on("foo", (v) => b.push(v));
    emitter.emit("foo", "x");
    expect(a).toEqual(["x"]);
    expect(b).toEqual(["x"]);
  });

  it("unsubscribes via the returned function", () => {
    const emitter = new TypedEmitter<TestEvents>();
    const calls: string[] = [];
    const unsub = emitter.on("foo", (v) => calls.push(v));
    emitter.emit("foo", "a");
    unsub();
    emitter.emit("foo", "b");
    expect(calls).toEqual(["a"]);
  });

  it("unsubscribes via off()", () => {
    const emitter = new TypedEmitter<TestEvents>();
    const calls: string[] = [];
    const fn = (v: string) => calls.push(v);
    emitter.on("foo", fn);
    emitter.emit("foo", "a");
    emitter.off("foo", fn);
    emitter.emit("foo", "b");
    expect(calls).toEqual(["a"]);
  });

  it("off() is a no-op for unknown listeners", () => {
    const emitter = new TypedEmitter<TestEvents>();
    // Should not throw
    emitter.off("foo", () => {});
    emitter.off("bar", () => {});
  });

  it("replays sticky value to late subscribers", () => {
    const emitter = new TypedEmitter<TestEvents>();
    emitter.emitSticky("foo", "early");

    const calls: string[] = [];
    emitter.on("foo", (v) => calls.push(v));
    expect(calls).toEqual(["early"]);
  });

  it("replays sticky undefined value (e.g. ready event)", () => {
    const emitter = new TypedEmitter<TestEvents>();
    emitter.emitSticky("ready", undefined);

    let replayed = false;
    emitter.on("ready", () => { replayed = true; });
    expect(replayed).toBe(true);
  });

  it("updates sticky value on re-emit", () => {
    const emitter = new TypedEmitter<TestEvents>();
    emitter.emitSticky("foo", "first");
    emitter.emitSticky("foo", "second");

    const calls: string[] = [];
    emitter.on("foo", (v) => calls.push(v));
    // Late subscriber gets the latest sticky value
    expect(calls).toEqual(["second"]);
  });

  it("non-sticky emit does not replay to late subscribers", () => {
    const emitter = new TypedEmitter<TestEvents>();
    emitter.emit("foo", "ephemeral");

    const calls: string[] = [];
    emitter.on("foo", (v) => calls.push(v));
    expect(calls).toEqual([]);
  });

  it("isolates listener errors during emit", () => {
    const emitter = new TypedEmitter<TestEvents>();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const calls: string[] = [];
    emitter.on("foo", () => { throw new Error("boom"); });
    emitter.on("foo", (v) => calls.push(v));
    emitter.emit("foo", "ok");

    expect(calls).toEqual(["ok"]);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("isolates listener errors during sticky replay", () => {
    const emitter = new TypedEmitter<TestEvents>();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    emitter.emitSticky("foo", "val");
    // This subscriber throws on replay — should not prevent future operations
    emitter.on("foo", () => { throw new Error("replay boom"); });

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("allows self-unsubscription during emit", () => {
    const emitter = new TypedEmitter<TestEvents>();
    const calls: string[] = [];
    let unsub: () => void;
    unsub = emitter.on("foo", (v) => {
      calls.push(v);
      unsub();
    });
    emitter.on("foo", (v) => calls.push(`second:${v}`));
    emitter.emit("foo", "x");
    emitter.emit("foo", "y");
    // First listener saw "x" then unsubscribed; second listener saw both
    expect(calls).toEqual(["x", "second:x", "second:y"]);
  });

  it("removeAll() clears listeners and sticky values", () => {
    const emitter = new TypedEmitter<TestEvents>();
    const calls: string[] = [];
    emitter.on("foo", (v) => calls.push(v));
    emitter.emitSticky("bar", 42);
    emitter.removeAll();

    emitter.emit("foo", "after");
    expect(calls).toEqual([]);

    // Sticky value should not replay after removeAll
    const barCalls: number[] = [];
    emitter.on("bar", (v) => barCalls.push(v));
    expect(barCalls).toEqual([]);
  });

  it("emit is a no-op with no subscribers", () => {
    const emitter = new TypedEmitter<TestEvents>();
    // Should not throw
    emitter.emit("foo", "nobody listening");
  });
});
