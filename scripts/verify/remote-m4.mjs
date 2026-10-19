// Remote measurement uses existing terminal sessions only. No new order or payable call.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const args = process.argv.slice(2),
  dir = resolve(args[args.indexOf("--evidence") + 1]);
const old = resolve(args[args.indexOf("--settled-evidence") + 1]);
const config = JSON.parse(readFileSync("wrangler.remote.jsonc", "utf8"));
assert.equal(config.account_id, "8fb5f047b64293ae01e681d28c503798");
const origin = config.vars.APP_ORIGIN;
const state = JSON.parse(readFileSync(join(old, "session-private.json"), "utf8"));
assert.equal(state.origin, origin);
const signing = parseEnv(readFileSync(".dev.vars.remote", "utf8")).OWNER_TOKEN_SIGNING_KEY;
const data = Buffer.from(
  JSON.stringify({
    owner: state.owner,
    exp: Date.now() + 3500000,
    aud: "tollbooth-client",
    scopes: ["open", "read", "call", "close"],
  }),
).toString("base64url");
const token = data + "." + createHmac("sha256", signing).update(data).digest("base64url");
let label = "M4_STATUS",
  stage = "PREFLIGHT";
const records = [];
async function measured(input, init) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const r = new Request(input, init);
  r.headers.set("X-Tollbooth-Measurement", label);
  const t = performance.now();
  const response = await fetch(r);
  const row = {
    label,
    status: response.status,
    clientElapsedMs: performance.now() - t,
    at: Date.now(),
  };
  records.push(row);
  appendFileSync(join(dir, "m4-request-timings.jsonl"), JSON.stringify(row) + "\n", {
    mode: 0o600,
  });
  return response;
}
const status = async () => {
  const r = await measured(origin + "/api/sessions/" + state.sessionId, {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(r.status, 200);
  return r.json();
};
try {
  const before = await status();
  assert.equal(before.state, "CAPTURED");
  assert.equal(before.usedCents, 90);
  assert.equal(before.ledger.length, 3);
  for (const era of ["modern", "legacy"]) {
    stage = era;
    for (let i = 0; i < 12; i++) {
      label = "M4_CONNECT_" + era.toUpperCase();
      const c = new Client(
        { name: "m4-cpu", version: "0.1.0" },
        {
          capabilities: {},
          versionNegotiation: { mode: era === "modern" ? { pin: "2026-07-28" } : "legacy" },
        },
      );
      await c.connect(
        new StreamableHTTPClientTransport(new URL("/mcp", origin), {
          fetch: measured,
          requestInit: { headers: { Authorization: "Bearer " + token } },
        }),
        era === "legacy" ? { prior: { kind: "legacy" } } : undefined,
      );
      label = "M4_LIST_" + era.toUpperCase();
      assert.equal((await c.listTools()).tools.length, 5);
      label = "M4_REPLAY_" + era.toUpperCase();
      const r = await c.callTool({
        name: "market_lookup",
        arguments: { category: "coffee" },
        _meta: {
          tollbooth: {
            sessionId: state.sessionId,
            callKey: "coffee",
            maxPriceCents: 20,
            pricingVersion: "fixture-v1",
          },
        },
      });
      assert.equal(r.structuredContent.replayed, true);
      assert.equal(r.structuredContent.additionalAccruedCents, 0);
      await c.close();
      await new Promise((r) => setTimeout(r, 160));
    }
  }
  for (let i = 0; i < 12; i++) {
    label = "M4_STATUS";
    await status();
    label = "M4_CLOSE_TERMINAL";
    const closed = await measured(origin + "/api/sessions/" + state.sessionId + "/close", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
    });
    assert.equal(closed.status, 200);
    label = "M4_DEMO";
    assert.equal((await measured(origin + "/api/demo/merchant")).status, 200);
    label = "M4_VISITOR";
    assert.equal(
      (await measured(origin + "/api/visitor", { method: "POST", headers: { Origin: origin } }))
        .status,
      200,
    );
    label = "M4_CATALOG";
    assert.equal((await measured(origin + "/api/tools")).status, 200);
  }
  label = "M4_STATUS";
  const after = await status();
  assert.equal(after.usedCents, before.usedCents);
  assert.equal(after.capturedCents, before.capturedCents);
  assert.deepEqual(after.ledger, before.ledger);
  assert.deepEqual(after.settlement, before.settlement);
  writeFileSync(
    join(dir, "remote-m4.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        origin,
        samples: records.length,
        existingTerminalReplay: "PASS",
        newOrders: 0,
        additionalUsageCents: 0,
        settlementUnchanged: true,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    "PASS: remote M4 measurements saved; existing settlement/ledger unchanged; no new orders.",
  );
} catch {
  console.error("Remote M4 measurement failed at " + stage + "; sensitive values suppressed.");
  process.exitCode = 1;
}
