import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[process.argv.indexOf("--evidence") + 1]);
const rows = readFileSync(join(dir, "tail-metrics.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((s) => JSON.parse(s));
const groups = new Map();
for (const r of rows) {
  if (typeof r.timing?.cpuTime !== "number") continue;
  const group =
    r.eventType === "rpc"
      ? "DO " + r.rpcMethod
      : r.measurement === "M5_MERCHANT"
        ? r.path
        : (r.measurement ?? r.path ?? r.eventType);
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push(r);
}
const summary = [...groups].map(([route, r]) => {
  const cpu = r.map((x) => x.timing.cpuTime).sort((a, b) => a - b);
  return {
    route,
    n: r.length,
    p50: cpu[Math.ceil(cpu.length * 0.5) - 1],
    p95: cpu[Math.ceil(cpu.length * 0.95) - 1],
    max: cpu.at(-1),
    wallMax: Math.max(...r.map((x) => x.timing.wallTime ?? 0)),
    outcomes: [...new Set(r.map((x) => x.outcome))],
  };
});
writeFileSync(join(dir, "cpu-summary.json"), JSON.stringify(summary, null, 2) + "\n", {
  mode: 0o600,
});
console.log(JSON.stringify(summary));
