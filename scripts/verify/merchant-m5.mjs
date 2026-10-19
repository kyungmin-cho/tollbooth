import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { chromium } from "@playwright/test";

const dir = resolve(process.argv[process.argv.indexOf("--evidence") + 1]);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const origin = JSON.parse(readFileSync("wrangler.remote.jsonc", "utf8")).vars.APP_ORIGIN;
const keys = parseEnv(
  readFileSync(join(homedir(), ".config/paypal-hackathon/sandbox.env"), "utf8"),
);
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    extraHTTPHeaders: { "X-Tollbooth-Measurement": "M5_MERCHANT" },
  });
  const page = await context.newPage();
  await page.goto(origin + "/merchant/login");
  await page.getByLabel("Admin access secret").fill(keys.MERCHANT_ADMIN_TOKEN);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/merchant");
  const rows = [];
  for (const route of ["/merchant", "/merchant/sessions", "/merchant/charges"]) {
    await page.goto(origin + route);
    await page.waitForSelector(".ag-root");
    assert.equal(await page.getByRole("alert").count(), 0);
    await page.screenshot({
      path: join(dir, "remote-" + route.split("/").filter(Boolean).join("-") + ".png"),
      fullPage: true,
    });
    rows.push({ route, status: "PASS" });
  }
  for (let i = 0; i < 10; i++) {
    for (const path of [
      "/api/merchant/summary",
      "/api/merchant/sessions",
      "/api/merchant/charges",
    ]) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const r = await context.request.get(origin + path);
      assert.equal(r.status(), 200);
    }
  }
  writeFileSync(
    join(dir, "merchant-proof.json"),
    JSON.stringify({ authenticated: true, routes: rows, at: new Date().toISOString() }, null, 2) +
      "\n",
    { mode: 0o600 },
  );
  console.log("Remote merchant authentication and all three views PASS.");
} finally {
  await browser.close();
}
