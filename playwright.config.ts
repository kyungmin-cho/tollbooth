import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  testMatch: "**/*.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 45000,
  expect: { timeout: 10000 },
  use: {
    baseURL: "http://127.0.0.1:8790",
    ...devices["Desktop Chrome"],
    trace: "off",
    screenshot: "off",
  },
  reporter: [
    ["list"],
    ["json", { outputFile: "../paypal-ai-hackathon/_runs/2026-10-19-harden/browser-results.json" }],
  ],
  webServer: {
    command:
      "pnpm exec wrangler d1 migrations apply tollbooth-local --local --config tests/browser/wrangler.jsonc --persist-to .wrangler/browser-m4 && pnpm exec wrangler dev --local --config tests/browser/wrangler.jsonc --persist-to .wrangler/browser-m4 --ip 127.0.0.1 --port 8790 --inspector-port 9232",
    url: "http://127.0.0.1:8790",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
