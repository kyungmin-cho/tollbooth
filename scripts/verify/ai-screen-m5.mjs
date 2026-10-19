import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { chromium } from "@playwright/test";

const dir = resolve(process.argv[process.argv.indexOf("--evidence") + 1]);
const state = JSON.parse(readFileSync(join(dir, "session-private.json"), "utf8"));
const origin = JSON.parse(readFileSync("wrangler.remote.jsonc", "utf8")).vars.APP_ORIGIN;
assert.equal(state.origin, origin);
const key = parseEnv(readFileSync(".dev.vars.remote", "utf8")).OWNER_TOKEN_SIGNING_KEY;
const data = Buffer.from(
  JSON.stringify({
    aud: "visitor",
    owner: state.owner,
    csrf: randomUUID(),
    exp: Date.now() + 600000,
  }),
).toString("base64url");
const value = data + "." + createHmac("sha256", key).update(data).digest("base64url");
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  await context.addCookies([
    { name: "tb_owner", value, url: origin, httpOnly: true, secure: true, sameSite: "Lax" },
  ]);
  const page = await context.newPage();
  await page.goto(origin + "/run/" + state.sessionId);
  await page.getByText(/Real AI plan saved/).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Run AI plan through MCP" }).isDisabled(),
    true,
  );
  await page.screenshot({ path: join(dir, "remote-ai-plan.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(dir, "remote-ai-plan-390.png"), fullPage: true });
  console.log("Remote real AI saved plan screenshots captured; no wallet approval or execution.");
} finally {
  await browser.close();
}
