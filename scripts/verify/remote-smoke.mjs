import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const arg = process.argv.indexOf("--evidence");
assert.ok(arg >= 0, "An evidence directory is required");
const evidence = resolve(process.argv[arg + 1]);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const config = JSON.parse(readFileSync("wrangler.remote.jsonc", "utf8"));
const origin = config.vars.APP_ORIGIN;
let operation = "SPA",
  era;
async function measured(input, init) {
  const label = operation,
    requestEra = era;
  if (process.argv.includes("--paced")) await new Promise((resolve) => setTimeout(resolve, 1000));
  const at = Date.now();
  const request = new Request(input, init);
  request.headers.set("X-Tollbooth-Measurement", `${label}_${requestEra ?? "NONE"}`);
  const r = await fetch(request);
  appendFileSync(
    join(evidence, "request-timings.jsonl"),
    JSON.stringify({
      at,
      operation: label,
      era: requestEra,
      method: request.method,
      path: new URL(request.url).pathname,
      ray: r.headers.get("cf-ray"),
      status: r.status,
      clientElapsedMs: Date.now() - at,
    }) + "\n",
    { mode: 0o600 },
  );
  return r;
}
try {
  const spa = await measured(origin);
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /<div id="root">/);
  operation = "INVALID_BEARER";
  const bad = await measured(origin + "/api/tools", {
    headers: { Authorization: "Bearer deliberately-invalid" },
  });
  assert.equal(bad.status, 401);
  for (era of process.argv.includes("--legacy-first")
    ? ["legacy", "modern"]
    : ["modern", "legacy"]) {
    operation = "CONNECT";
    const c = new Client(
      { name: "remote-smoke", version: "0.1.0" },
      {
        capabilities: {},
        versionNegotiation: { mode: era === "modern" ? { pin: "2026-07-28" } : "legacy" },
      },
    );
    try {
      await c.connect(
        new StreamableHTTPClientTransport(new URL("/mcp", origin), { fetch: measured }),
        era === "legacy" ? { prior: { kind: "legacy" } } : undefined,
      );
      operation = "TOOLS_LIST";
      for (let i = 0; i < 5; i++) {
        // Keep this tiny sample below live-tail throughput sampling thresholds.
        await new Promise((resolve) => setTimeout(resolve, 300));
        const list = await c.listTools();
        assert.ok(list.tools.some((t) => t.name === "market_lookup"));
        assert.ok(list.tools.some((t) => t.name === "landed_cost"));
      }
      operation = "PAYMENT_REQUIRED";
      const offer = await c.callTool({ name: "market_lookup", arguments: { category: "coffee" } });
      assert.equal(offer.isError, true);
      assert.equal(offer.structuredContent.code, "PAYMENT_REQUIRED");
      assert.equal(offer.structuredContent.status, 402);
    } finally {
      await c.close();
    }
  }
  writeFileSync(
    join(evidence, "smoke.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        origin,
        spa: 200,
        invalidBearer: 401,
        modern: "PASS",
        legacy: "PASS",
        toolsListSamplesPerLane: 5,
        paymentRequired: "PASS",
        newSessions: 0,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.log(
    "PASS: deployed SPA, modern/legacy tools/list and payment-required, invalid bearer. No sessions opened.",
  );
} catch {
  console.error("Remote smoke failed at " + operation + "; no sensitive response printed.");
  process.exitCode = 1;
}
