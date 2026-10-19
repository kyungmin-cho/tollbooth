import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const i = process.argv.indexOf("--evidence");
assert.ok(i >= 0, "Evidence directory required");
const evidence = resolve(process.argv[i + 1]);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const child = spawn(
  "pnpm",
  ["exec", "wrangler", "tail", "--config", "wrangler.remote.jsonc", "--format", "json"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let buffer = "",
  depth = 0,
  quoted = false,
  escaped = false;
function accept(raw) {
  try {
    const v = JSON.parse(raw);
    const url = v.event?.request?.url;
    const label = v.event?.request?.headers?.["x-tollbooth-measurement"];
    const timing = {};
    function walk(x, path = "") {
      if (!x || typeof x !== "object") return;
      for (const [key, value] of Object.entries(x)) {
        const p = path ? path + "." + key : key;
        if (/cpu|wall|duration/i.test(key) && typeof value === "number") timing[p] = value;
        else if (typeof value === "object" && !["headers", "logs", "exceptions"].includes(key))
          walk(value, p);
      }
    }
    walk(v);
    const proof = {
      at: new Date().toISOString(),
      eventTimestamp: v.eventTimestamp,
      measurement:
        typeof label === "string" &&
        /^(SPA_NONE|INVALID_BEARER_NONE|CONNECT(?:_(?:modern|legacy))?|TOOLS_LIST_(?:modern|legacy)|PAYMENT_REQUIRED_(?:modern|legacy)|DISCOVER_TOOLS|OPEN_SESSION|READ_SESSION|ACTIVATE|RUN_FIXTURE_CALLS|CLOSE_SESSION|AI_PLAN|VERIFY_AI_PLAN|RUN_AI_CALLS|M[45]_[A-Z_]+|HARDEN_[A-Z_]+)$/.test(
          label,
        )
          ? label
          : undefined,
      outcome: v.outcome,
      eventType: url
        ? "fetch"
        : v.event?.rpcMethod
          ? "rpc"
          : v.event?.scheduledTime
            ? "alarm"
            : "other",
      entrypoint: v.entrypoint === "SessionDO" ? "SessionDO" : undefined,
      rpcMethod: [
        "open",
        "status",
        "call",
        "activate",
        "close",
        "recover",
        "initialize",
        "inspect",
      ].includes(v.event?.rpcMethod)
        ? v.event.rpcMethod
        : undefined,
      path: url
        ? new URL(url).pathname.replace(
            /\/api\/(?:merchant\/)?sessions\/[^/]+/,
            "/api/sessions/:id",
          )
        : undefined,
      status: v.event?.response?.status,
      timing,
    };
    appendFileSync(join(evidence, "tail-metrics.jsonl"), JSON.stringify(proof) + "\n", {
      mode: 0o600,
    });
    writeFileSync(
      join(evidence, "tail-field-names.json"),
      JSON.stringify(
        {
          top: Object.keys(v),
          event: Object.keys(v.event ?? {}),
          timingPaths: Object.keys(timing),
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    console.log(
      "Tail event saved: " +
        proof.eventType +
        ", " +
        (proof.outcome ?? "unknown") +
        ", timing fields " +
        Object.keys(timing).length,
    );
  } catch {
    console.error("Tail record could not be parsed; raw content discarded.");
  }
}
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  for (const c of chunk) {
    if (depth === 0) {
      if (c !== "{") continue;
      buffer = "{";
      depth = 1;
      quoted = false;
      escaped = false;
      continue;
    }
    buffer += c;
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      accept(buffer);
      buffer = "";
    }
  }
});
child.stderr.on("data", () => {
  console.error("Wrangler tail diagnostic received; contents suppressed.");
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  console.log("Tail stopped, exit " + code);
  process.exitCode = code ?? 0;
});
console.log(
  "Tail collector started; only sanitized paths/status and numeric runtime timing fields are retained.",
);
