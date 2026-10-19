import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const output = process.argv[2];
if (!output) throw new Error("Pass a private output file");
const origin = "http://127.0.0.1:8787";
function cpu() {
  const rows = execFileSync("ps", ["-axo", "pid=,time=,comm="], { encoding: "utf8" })
    .split("\n")
    .filter((x) => x.includes(process.cwd()) && x.endsWith("/workerd"));
  return rows.map((row) => {
    const [pid, time] = row.trim().split(/\s+/);
    const [min, sec] = time.split(":").map(Number);
    return { pid: Number(pid), cpuMs: (min * 60 + sec) * 1000 };
  });
}
const c = new Client(
  { name: "tollbooth-local-benchmark", version: "0.1.0" },
  { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
const before = cpu(),
  start = performance.now();
await c.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin)));
const coldConnectMs = performance.now() - start;
const samples = [];
for (let i = 0; i < 100; i++) {
  const at = performance.now();
  await c.listTools(undefined, { cacheMode: "bypass" });
  samples.push(performance.now() - at);
}
const invalid = await Promise.all(
  Array.from({ length: 20 }, () =>
    fetch(origin + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).then((r) => r.status),
  ),
);
await c.close();
const after = cpu();
samples.sort((a, b) => a - b);
const results = {
  label: "local-runtime process CPU approximation; not per-request Worker billing CPU",
  at: new Date().toISOString(),
  coldConnectWallMs: coldConnectMs,
  samples: 100,
  p50WallMs: samples[49],
  p95WallMs: samples[94],
  invalidConcurrent: 20,
  invalidStatuses: [...new Set(invalid)],
  processCpu: after.map((p) => ({
    ...p,
    deltaMs: p.cpuMs - (before.find((b) => b.pid === p.pid)?.cpuMs ?? p.cpuMs),
  })),
  limitations:
    "Aggregate workerd process includes local runtime overhead/other workers; ps resolution 10 ms. No DO duration or Free 10 ms verdict. No sandbox/paid calls.",
};
writeFileSync(output, JSON.stringify(results, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(results));
