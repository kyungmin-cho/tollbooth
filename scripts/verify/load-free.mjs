// Bounded read-only load: no session, inference, provider or settlement calls.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const i = process.argv.indexOf("--evidence");
assert.ok(i >= 0);
const evidence = resolve(process.argv[i + 1]);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const origin = "https://tollbooth.arcsolve.workers.dev";
const samples = [];
await Promise.all(
  Array.from({ length: 20 }, async (_, lane) => {
    const c = new Client(
      { name: "bounded-free-load", version: "1" },
      { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await c.connect(
        new StreamableHTTPClientTransport(new URL("/mcp", origin), {
          fetch: (input, init) => {
            const r = new Request(input, init);
            r.headers.set("X-Tollbooth-Measurement", "HARDEN_LOAD_MCP");
            return fetch(r);
          },
        }),
      );
      for (let n = 0; n < 15; n++) {
        const route = n % 3 === 0 ? "rehearsal" : "tools/list",
          start = performance.now();
        let ok = false;
        try {
          if (route === "tools/list") ok = (await c.listTools()).tools.length === 5;
          else {
            const r = await fetch(origin + "/api/demo/merchant", {
              headers: { "X-Tollbooth-Measurement": "HARDEN_LOAD_REHEARSAL" },
            });
            await r.arrayBuffer();
            ok = r.ok;
          }
        } catch {
          /* Count failures without logging payloads. */
        }
        samples.push({ lane, route, ms: Math.round((performance.now() - start) * 100) / 100, ok });
      }
    } catch {
      samples.push({ lane, route: "connect", ms: 0, ok: false });
    } finally {
      await c.close().catch(() => {});
    }
  }),
);
const quantile = (a, p) => a[Math.max(0, Math.ceil(a.length * p) - 1)] ?? null;
const summary = {
  concurrency: 20,
  plannedRequests: 300,
  actualRequests: samples.length,
  errors: samples.filter((s) => !s.ok).length,
  routes: {},
};
for (const route of new Set(samples.map((s) => s.route))) {
  const rows = samples.filter((s) => s.route === route),
    ms = rows.map((s) => s.ms).sort((a, b) => a - b);
  summary.routes[route] = {
    n: rows.length,
    p50: quantile(ms, 0.5),
    p95: quantile(ms, 0.95),
    max: ms.at(-1),
    errors: rows.filter((s) => !s.ok).length,
  };
}
summary.errorRate = summary.errors / summary.actualRequests;
writeFileSync(
  join(evidence, "load-free.json"),
  JSON.stringify({ summary, samples }, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(JSON.stringify(summary));
if (summary.errors) process.exitCode = 1;
