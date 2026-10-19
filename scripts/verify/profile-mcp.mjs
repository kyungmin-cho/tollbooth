// Local CPU profiler: records stack samples only, never request bodies, headers or credentials.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { WebSocket } from "ws";

const index = process.argv.indexOf("--evidence");
assert.ok(index >= 0);
const evidence = resolve(process.argv[index + 1]);
const [target] = await (await fetch("http://127.0.0.1:9232/json/list")).json();
const ws = new WebSocket(target.webSocketDebuggerUrl, { headers: { Origin: "http://localhost" } });
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const d = JSON.parse(String(e.data));
  if (d.id) {
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.error) p.reject(new Error("Profiler command failed: " + d.error.code));
    else p.resolve(d.result);
  }
};
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
await command("Profiler.enable");
await command("Profiler.setSamplingInterval", { interval: 100 });
await command("Profiler.start");
for (let i = 0; i < 30; i++) {
  const c = new Client(
    { name: "local-profile", version: "0.1.0" },
    { capabilities: {}, versionNegotiation: { mode: "legacy" } },
  );
  await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8790/mcp")), {
    prior: { kind: "legacy" },
  });
  await c.listTools();
  await c.close();
}
const { profile } = await command("Profiler.stop");
ws.close();
writeFileSync(join(evidence, "mcp.cpuprofile"), JSON.stringify(profile), { mode: 0o600 });
const counts = new Map();
for (let i = 0; i < (profile.samples?.length ?? 0); i++)
  counts.set(
    profile.samples[i],
    (counts.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0),
  );
const rows = profile.nodes
  .map((n) => ({
    function: n.callFrame.functionName || "anonymous",
    url: n.callFrame.url.replace(/^.*\//, ""),
    selfMs: (counts.get(n.id) ?? 0) / 1000,
  }))
  .sort((a, b) => b.selfMs - a.selfMs)
  .slice(0, 30);
writeFileSync(
  join(evidence, "profile-summary.json"),
  JSON.stringify(
    { requests: "30 legacy connections + tools/list; local workerd; 100us sampling", rows },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log("CPU profile saved; no financial request or credential capture.");
