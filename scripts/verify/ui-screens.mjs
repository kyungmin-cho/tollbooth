// Read-only deployed UI capture. No order creation, model inference, buyer login or settlement.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2),
  dir = resolve(args[args.indexOf("--evidence") + 1]);
const old = resolve(args[args.indexOf("--buyer-evidence") + 1]);
const origin = JSON.parse(readFileSync("wrangler.remote.jsonc", "utf8")).vars.APP_ORIGIN;
mkdirSync(join(dir, "remote"), { recursive: true, mode: 0o700 });
const keys = parseEnv(
  readFileSync(join(homedir(), ".config/paypal-hackathon/sandbox.env"), "utf8"),
);
const signing = parseEnv(readFileSync(".dev.vars.remote", "utf8")).OWNER_TOKEN_SIGNING_KEY;
const state = JSON.parse(readFileSync(join(old, "session-private.json"), "utf8"));
assert.equal(state.origin, origin);
const c = Buffer.from(
  JSON.stringify({
    aud: "visitor",
    owner: state.owner,
    csrf: randomUUID(),
    exp: Date.now() + 3600000,
  }),
).toString("base64url");
const cookie = c + "." + createHmac("sha256", signing).update(c).digest("base64url");
const browser = await chromium.launch();
const proof = [];
const errors = [];
try {
  const context = await browser.newContext();
  await context.addCookies([
    { name: "tb_owner", value: cookie, url: origin, secure: true, httpOnly: true, sameSite: "Lax" },
  ]);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.name));
  const paths = [
    ["landing", "/"],
    ["connect", "/connect"],
    ["judge", "/judge"],
    ["rehearsal", "/run/rehearsal"],
    ["rehearsal-receipt", "/receipts/rehearsal"],
    ["demo-merchant", "/demo/merchant"],
    ["merchant-login", "/merchant/login"],
    ["buyer", "/run/" + state.sessionId],
    ["receipt", "/receipts/" + state.sessionId],
  ];
  async function shot(name, path, width) {
    await page.setViewportSize({ width, height: 900 });
    const r = await page.goto(origin + path);
    assert.equal(r.status(), 200);
    await page.getByRole("heading").first().waitFor();
    if (path.includes("merchant") && !path.endsWith("login"))
      await page.locator(".ag-root").waitFor();
    if (["/", "/run/" + state.sessionId].includes(path))
      await page.locator('[data-slot="card"]').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => scrollTo(0, 0));
    assert.equal(await page.locator("footer,.eyebrow,.brand-icon").count(), 0);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({
      path: join(dir, "remote", name + "-" + width + ".png"),
      fullPage: true,
      animations: "disabled",
    });
    proof.push({
      route: path.replace(state.sessionId, ":owned-session"),
      width,
      status: 200,
      file: "remote/" + name + "-" + width + ".png",
    });
  }
  for (const width of [1280, 390]) for (const [name, path] of paths) await shot(name, path, width);
  await page.goto(origin + "/merchant/login");
  await page.getByLabel("Admin access secret").fill(keys.MERCHANT_ADMIN_TOKEN);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/merchant");
  for (const width of [1280, 390])
    for (const [name, path] of [
      ["merchant", "/merchant"],
      ["sessions", "/merchant/sessions"],
      ["charges", "/merchant/charges"],
    ])
      await shot(name, path, width);
  // Existing records only; no reconcile action.
  const link = page.locator('a[href^="/merchant/sessions/"]').first();
  if (await link.count()) {
    const path = await link.getAttribute("href");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(origin + path);
      await page.getByRole("heading", { name: "Timeline and provider evidence" }).waitFor();
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: join(dir, "remote", "merchant-detail-" + width + ".png"),
        fullPage: true,
        animations: "disabled",
      });
      proof.push({
        route: "/merchant/sessions/:owned-session",
        width,
        file: "remote/merchant-detail-" + width + ".png",
      });
    }
  }
  assert.deepEqual(errors, []);
  writeFileSync(
    join(dir, "remote-screens.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        proof,
        pageErrors: errors,
        newOrders: 0,
        buyerApproval: false,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.log(`PASS: ${proof.length} deployed screenshots, desktop and 390px; no payment actions.`);
} catch {
  console.error("Deployed UI capture failed; credentials suppressed.");
  process.exitCode = 1;
} finally {
  await browser.close();
}
