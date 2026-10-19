// Inference/read-only measurement on the two already-prepared sessions. No wallet mutation.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

const dir = resolve(process.argv[process.argv.indexOf("--evidence") + 1]);
const origin = JSON.parse(readFileSync("wrangler.remote.jsonc", "utf8")).vars.APP_ORIGIN;
const key = parseEnv(readFileSync(".dev.vars.remote", "utf8")).OWNER_TOKEN_SIGNING_KEY;
const results = [];
for (const prefix of ["", "zero-"]) {
  const s = JSON.parse(readFileSync(join(dir, prefix + "session-private.json"), "utf8"));
  assert.equal(s.origin, origin);
  const data = Buffer.from(
    JSON.stringify({
      owner: s.owner,
      exp: Date.now() + 600000,
      aud: "tollbooth-client",
      scopes: ["read", "call"],
    }),
  ).toString("base64url");
  const token = data + "." + createHmac("sha256", key).update(data).digest("base64url");
  async function call(suffix, method, label) {
    await new Promise((r) => setTimeout(r, 1500));
    const started = Date.now();
    const r = await fetch(origin + "/api/sessions/" + s.sessionId + suffix, {
      method,
      headers: { Authorization: "Bearer " + token, "X-Tollbooth-Measurement": label },
    });
    assert.equal(r.status, 200);
    const result = await r.json();
    results.push({ prefix, method, label, status: r.status, elapsedMs: Date.now() - started });
    return result;
  }
  const before = await call("", "GET", "M5_STATUS");
  assert.equal(before.state, "APPROVAL_PENDING");
  assert.equal(before.usedCents, 0);
  const existing = await call("/ai", "GET", "M5_AI_READ");
  // Zero-use remains zero-use: planning never executes or authorizes any tool.
  const plan = await call("/ai", "POST", existing ? "M5_AI_REPLAY" : "M5_AI_INFER");
  assert.equal(plan.status, "READY");
  assert.equal(plan.calls.length, 3);
  for (let i = 0; i < 10; i++)
    assert.deepEqual(
      await call("/ai", i % 2 ? "POST" : "GET", i % 2 ? "M5_AI_REPLAY" : "M5_AI_READ"),
      plan,
    );
  const after = await call("", "GET", "M5_STATUS");
  assert.equal(after.usedCents, 0);
  assert.equal(after.capturedCents, 0);
  assert.equal(after.authorizationId, null);
  assert.deepEqual(after.ledger, []);
  writeFileSync(
    join(dir, prefix + "ai-proof.json"),
    JSON.stringify(
      { status: "PASS", model: plan.model, calls: plan.calls, usedCents: 0, authorized: false },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}
writeFileSync(join(dir, "ai-request-timings.json"), JSON.stringify(results, null, 2) + "\n", {
  mode: 0o600,
});
console.log(
  "PASS: real AI plans and idempotent reads/replays; both orders still unapproved with zero usage.",
);
