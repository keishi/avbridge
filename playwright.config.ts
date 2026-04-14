/**
 * Playwright configuration for the cross-browser test tier.
 *
 * Tier 4 in the testing model (see docs/dev/TESTING.md):
 * - Tier 1: vitest unit tests (jsdom, deterministic boundary logic)
 * - Tier 2: Puppeteer browser scripts (Chromium, timing-sensitive playback)
 * - Tier 3: Puppeteer element-lifecycle harness (Chromium)
 * - Tier 4: Playwright cross-browser (THIS) — Chromium + Firefox + WebKit
 *
 * The goal is narrow: validate that avbridge **picks the right strategy**
 * per browser, not that every browser plays every fixture. Specific claims
 * are codified in tests/browser/_expectations.ts.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",

  // Auto-start the Vite dev server. Developers with `npm run demo` already
  // running get that session reused; CI always starts fresh.
  webServer: {
    command: "npm run demo",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },

  use: {
    baseURL: "http://localhost:5173",
    // Default navigation timeout — probe + bootstrap can take a couple of
    // seconds on a cold libav load in WebKit.
    navigationTimeout: 15_000,
    actionTimeout: 10_000,
    trace: "retain-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox",  use: { ...devices["Desktop Firefox"] } },
    { name: "webkit",   use: { ...devices["Desktop Safari"] } },
  ],
});
