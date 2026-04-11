#!/usr/bin/env node
/**
 * Lifecycle correctness tests for `<avbridge-video>`.
 *
 * Drives `demo/element-test.html` via Puppeteer. Each test exercises one
 * of the P0 cases from docs/dev/WEB_COMPONENT_SPEC.md and verifies that the element
 * preserves the lifecycle invariants under adversarial conditions.
 *
 * P0 cases (must pass before Phase A is "done"):
 *
 *   1. Disconnect during bootstrap
 *   3. Rapid src reassignment in same tick
 *   4. src reassignment during bootstrap (race)
 *   8. Move within DOM (full teardown + recreate)
 *  13. play() before ready
 *
 * Run:
 *   npm run demo                  # in another terminal
 *   npm run test:element
 */
import puppeteer from "puppeteer";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    port:    { type: "string", default: "5173" },
    timeout: { type: "string", default: "30" },
    json:    { type: "boolean", default: false },
  },
});

const PORT = Number(opts.port);
const TIMEOUT_SEC = Number(opts.timeout);
const JSON_OUTPUT = opts.json;
const BASE_URL = `http://localhost:${PORT}/element-test.html`;

// The fixture used as a "happy path" video. Vite's `@fs/` prefix lets us
// serve files outside the dev root (`demo/`) without copying. The
// `server.fs.allow` config already includes the project root.
import { resolve as pathResolve } from "node:path";
const FIXTURE_PATH = pathResolve("tests/fixtures/big-buck-bunny-480p-30sec.mp4");
const FIXTURE_URL = `/@fs${FIXTURE_PATH}`;

// ── Test runner ─────────────────────────────────────────────────────────────

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

async function main() {
  let puppeteerLib;
  try {
    puppeteerLib = puppeteer;
  } catch {
    console.error("[test] puppeteer is required.");
    process.exit(1);
  }

  const browser = await puppeteerLib.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--autoplay-policy=no-user-gesture-required",
      "--enable-features=SharedArrayBuffer",
    ],
  });

  const results = [];
  let failures = 0;

  for (const t of tests) {
    if (!JSON_OUTPUT) process.stdout.write(`\n[element] ${t.name} ... `);
    const page = await browser.newPage();
    page.on("pageerror", (err) => {
      results.push({ name: t.name, status: "FAIL", error: `pageerror: ${err.message}` });
    });

    try {
      await page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 15000 });
      await page.waitForFunction(() => !!window.harness, { timeout: 5000 });

      const start = Date.now();
      await Promise.race([
        t.fn(page),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`timeout after ${TIMEOUT_SEC}s`)), TIMEOUT_SEC * 1000),
        ),
      ]);
      const elapsed = ((Date.now() - start) / 1000).toFixed(2);
      results.push({ name: t.name, status: "PASS", elapsedSec: parseFloat(elapsed) });
      if (!JSON_OUTPUT) process.stdout.write(`PASS (${elapsed}s)\n`);
    } catch (err) {
      failures++;
      const msg = err.message ?? String(err);
      results.push({ name: t.name, status: "FAIL", error: msg });
      if (!JSON_OUTPUT) process.stdout.write(`FAIL: ${msg}\n`);
    } finally {
      await page.close().catch(() => {});
    }
  }

  await browser.close();

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`\n[element] ${tests.length} tests, ${failures} failed.`);
  }
  process.exit(failures > 0 ? 1 : 0);
}

// ── P0 tests ────────────────────────────────────────────────────────────────

// #13 — play() before ready: must resolve and (eventually) actually play.
test("P0 #13: play() before ready resolves and plays", async (page) => {
  await page.evaluate(async (url) => {
    const el = window.harness.reset();
    el.src = url;
    // play() called immediately after src — before bootstrap is anywhere
    // close to ready. Should NOT throw, should resolve, should eventually play.
    await el.play();
  }, FIXTURE_URL);
  // Wait for the element to actually advance.
  const ok = await page.evaluate(async () => {
    const el = window.harness.get();
    if (!el) return false;
    const start = performance.now();
    while (performance.now() - start < 15_000) {
      if (el.player && el.currentTime > 0.05 && !el.paused) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  });
  if (!ok) {
    const state = await page.evaluate(() => window.harness.state());
    throw new Error(`element did not start playing — state=${JSON.stringify(state)}`);
  }
});

// #1 — disconnect during bootstrap: element removed from DOM mid-bootstrap
// must not leak resources or throw.
test("P0 #1: disconnect during bootstrap discards the player cleanly", async (page) => {
  const result = await page.evaluate(async (url) => {
    const el = window.harness.reset();
    el.src = url;
    // Disconnect immediately, before bootstrap completes.
    setTimeout(() => el.remove(), 5);
    // Wait long enough that any in-flight bootstrap would have settled.
    await new Promise((r) => setTimeout(r, 3000));
    return {
      hasPlayer: el.player != null,
      isConnected: el.isConnected,
      events: window.harness.events().map((e) => e.type),
    };
  }, FIXTURE_URL);
  if (result.hasPlayer) {
    throw new Error(`player was not destroyed after disconnect: ${JSON.stringify(result)}`);
  }
  if (result.isConnected) {
    throw new Error(`element should be disconnected: ${JSON.stringify(result)}`);
  }
  // The element should NOT have fired a `ready` event since the bootstrap
  // was abandoned.
  if (result.events.includes("ready")) {
    throw new Error(`unexpected ready event after disconnect: ${JSON.stringify(result)}`);
  }
});

// #3 — rapid src reassignment in same tick: only the final value should win,
// and only one player should be created.
test("P0 #3: rapid src reassignment lets the final value win", async (page) => {
  const result = await page.evaluate(async (url) => {
    const el = window.harness.reset();
    // Three rapid assignments. Only the third should produce a player.
    el.src = "/nope-1.mp4";
    el.src = "/nope-2.mp4";
    el.src = url;
    // Wait for ready (or timeout).
    const readyEvent = await window.harness.waitForEvent("ready", 15_000);
    return {
      finalSrc: el.src,
      hasPlayer: el.player != null,
      strategy: el.strategy,
      readyFired: readyEvent != null,
      eventCounts: window.harness.events().reduce((acc, e) => {
        acc[e.type] = (acc[e.type] ?? 0) + 1;
        return acc;
      }, {}),
    };
  }, FIXTURE_URL);
  if (result.finalSrc !== FIXTURE_URL) {
    throw new Error(`final src should be the fixture, got ${result.finalSrc}`);
  }
  if (!result.hasPlayer || !result.readyFired) {
    throw new Error(`final player did not become ready: ${JSON.stringify(result)}`);
  }
  // We should have exactly one ready event (the others should have errored
  // and been discarded by the bootstrap token).
  if (result.eventCounts.ready !== 1) {
    throw new Error(`expected exactly one ready event, got ${JSON.stringify(result.eventCounts)}`);
  }
});

// #4 — src reassignment during bootstrap: A starts, then B replaces A
// before A resolves. Only B should produce a player.
test("P0 #4: src reassignment during bootstrap lets the latest source win", async (page) => {
  const result = await page.evaluate(async (url) => {
    const el = window.harness.reset();
    el.src = "/nope-during-bootstrap.mp4"; // will fail to fetch
    // Yield once so the bootstrap microtask runs.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    el.src = url;
    const readyEvent = await window.harness.waitForEvent("ready", 15_000);
    return {
      finalSrc: el.src,
      hasPlayer: el.player != null,
      strategy: el.strategy,
      readyFired: readyEvent != null,
      eventCounts: window.harness.events().reduce((acc, e) => {
        acc[e.type] = (acc[e.type] ?? 0) + 1;
        return acc;
      }, {}),
    };
  }, FIXTURE_URL);
  if (!result.hasPlayer || !result.readyFired) {
    throw new Error(`final player did not become ready: ${JSON.stringify(result)}`);
  }
  if (result.eventCounts.ready !== 1) {
    throw new Error(`expected exactly one ready event, got ${JSON.stringify(result.eventCounts)}`);
  }
});

// #8 — move within DOM: appendChild to a different parent triggers
// disconnect + reconnect. The element should fully tear down and rebuild.
test("P0 #8: DOM move triggers full teardown + recreate", async (page) => {
  // Create a second container in the page first.
  await page.evaluate(() => {
    if (!document.getElementById("second-container")) {
      const c = document.createElement("div");
      c.id = "second-container";
      document.body.appendChild(c);
    }
  });

  const result = await page.evaluate(async (url) => {
    const el = window.harness.reset();
    el.src = url;
    // Wait for the first ready.
    await window.harness.waitForEvent("ready", 15_000);
    const firstPlayer = el.player;
    // Move to a new parent. This fires disconnect + reconnect.
    window.harness.moveTo("second-container");
    // Wait for the SECOND ready event.
    const before = window.harness.events().length;
    const start = performance.now();
    while (performance.now() - start < 15_000) {
      const events = window.harness.events();
      if (events.length > before && events.slice(before).some((e) => e.type === "ready")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return {
      stillConnected: el.isConnected,
      parentId: el.parentElement?.id,
      hasPlayer: el.player != null,
      sameInstance: el.player === firstPlayer,
      eventTypes: window.harness.events().map((e) => e.type),
    };
  }, FIXTURE_URL);

  if (!result.stillConnected) {
    throw new Error("element should be connected to second container");
  }
  if (result.parentId !== "second-container") {
    throw new Error(`expected parent=second-container, got ${result.parentId}`);
  }
  if (!result.hasPlayer) {
    throw new Error("element should have a player after reconnect");
  }
  if (result.sameInstance) {
    throw new Error("player instance should have been recreated, not reused");
  }
  // We should see at least 2 ready events (one before move, one after).
  const readyCount = result.eventTypes.filter((t) => t === "ready").length;
  if (readyCount < 2) {
    throw new Error(`expected at least 2 ready events, got ${readyCount} (events: ${result.eventTypes.join(",")})`);
  }
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
