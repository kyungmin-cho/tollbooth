import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import {
  assertEvidenceOrigin,
  assertUsdAmount,
  awaitEvidence,
  diagnosticCode,
  EvidencePending,
  fixtureConsentFlag,
  needsCallConsent,
  preparedRunMode,
  requireActive,
  requireAiReady,
  requireProviderVisibility,
  sandboxTarget,
} from "./support.ts";

const args = process.argv.slice(2);
const preapprovedCalls = fixtureConsentFlag(args);
const aiMode = args.includes("--ai");
const aiConsent = args.includes("--approve-ai-calls");
let stage = "CONNECT";
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const evidence = resolve(option("--evidence", "_runs/m1-sandbox"));
const origin = option("--origin", "http://127.0.0.1:8787");
const deployment = JSON.parse(readFileSync("wrangler.remote.jsonc", "utf8"));
const remote = sandboxTarget(origin, deployment.vars.APP_ORIGIN) === "remote";
assert.ok(
  !remote || args.includes("--evidence"),
  "Remote runs require a separate evidence directory",
);
const zero = args.includes("--zero-use"),
  prefix = zero ? "zero-" : "",
  file = join(evidence, `${prefix}session-private.json`);
const runtime = parseEnv(readFileSync(remote ? ".dev.vars.remote" : ".dev.vars", "utf8"));
const source = parseEnv(
  readFileSync(join(homedir(), ".config/paypal-hackathon/sandbox.env"), "utf8"),
);
const secrets = {
  OWNER_TOKEN_SIGNING_KEY: runtime.OWNER_TOKEN_SIGNING_KEY,
  PAYPAL_CLIENT_ID: source.PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET: source.PAYPAL_CLIENT_SECRET,
  PAYPAL_MERCHANT_ID: source.PAYPAL_MERCHANT_ID,
};
assert.ok(
  secrets.PAYPAL_MERCHANT_ID,
  "Configure PAYPAL_MERCHANT_ID in the external sandbox runtime source",
);
assert.ok(
  args.includes("--prepare") || args.includes("--resume") || args.includes("--verify"),
  "Choose --prepare, --resume or --verify",
);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
chmodSync(evidence, 0o700);
function save(path, data) {
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}
let state = existsSync(file)
  ? JSON.parse(readFileSync(file, "utf8"))
  : {
      owner: randomUUID(),
      creationKey: randomUUID(),
      zeroUse: zero,
      createdAt: new Date().toISOString(),
      origin,
    };
assert.equal(state.zeroUse, zero);
assertEvidenceOrigin(state.origin, origin, remote);
state.origin = origin;
if (state.ai) assert.ok(aiMode, "AI sessions require --ai on prepare/resume/verify");
if (aiMode && !zero) state.ai = true;
save(file, state);
const claims = {
  owner: state.owner,
  exp: Date.now() + 3500000,
  aud: "tollbooth-client",
  scopes: ["open", "read", "call", "close"],
};
const data = Buffer.from(JSON.stringify(claims)).toString("base64url");
const bearer =
  data +
  "." +
  createHmac("sha256", secrets.OWNER_TOKEN_SIGNING_KEY).update(data).digest("base64url");
async function workerFetch(input, init) {
  const started = Date.now();
  const operation = stage;
  const request = new Request(input, init);
  if (remote) request.headers.set("X-Tollbooth-Measurement", operation);
  const r = await fetch(request);
  if (remote)
    appendFileSync(
      join(evidence, "request-timings.jsonl"),
      JSON.stringify({
        at: started,
        operation,
        zeroUse: zero,
        ray: r.headers.get("cf-ray"),
        status: r.status,
        clientElapsedMs: Date.now() - started,
      }) + "\n",
      { mode: 0o600 },
    );
  return r;
}
async function api(path, method = "GET", body) {
  const r = await workerFetch(origin + path, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
  });
  const v = await r.json();
  assert.ok(r.ok, typeof v.code === "string" ? v.code : `HTTP ${r.status}`);
  return v;
}
const client = new Client(
  { name: "tollbooth-sandbox-driver", version: "0.1.0" },
  { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
async function tool(name, args, meta) {
  const r = await client.callTool({
    name,
    arguments: args,
    ...(meta ? { _meta: { tollbooth: meta } } : {}),
  });
  if (r.isError)
    throw new Error(
      typeof r.structuredContent?.code === "string" ? r.structuredContent.code : "TOOL_ERROR",
    );
  return r.structuredContent;
}
async function provider(path) {
  if (!provider.token) {
    const r = await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(secrets.PAYPAL_CLIENT_ID + ":" + secrets.PAYPAL_CLIENT_SECRET).toString(
            "base64",
          ),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 429 || r.status >= 500) throw new EvidencePending();
    assert.ok(r.ok, `OAuth HTTP ${r.status}`);
    provider.token = (await r.json()).access_token;
  }
  const r = await fetch("https://api-m.sandbox.paypal.com" + path, {
    headers: { Authorization: `Bearer ${provider.token}` },
    signal: AbortSignal.timeout(10000),
  }).catch(() => {
    throw new EvidencePending();
  });
  if (r.status === 404 || r.status === 429 || r.status >= 500) throw new EvidencePending();
  assert.ok(r.ok, `Provider GET HTTP ${r.status}`);
  return r.json();
}
async function verifyOnce(s) {
  stage = "VERIFY_DO_LEDGER";
  assert.equal(s.usedCents, zero ? 0 : 90);
  assert.equal(s.reservedCents, 0);
  assert.equal(s.ledger.length, zero ? 0 : 3);
  assert.deepEqual(
    [...s.ledger].sort((a, b) => a.callKey.localeCompare(b.callKey)),
    zero
      ? []
      : state.aiPlan
        ? state.aiPlan.calls
            .map((c) => ({ callKey: c.key, amountCents: c.price }))
            .sort((a, b) => a.callKey.localeCompare(b.callKey))
        : [
            { callKey: "coffee", amountCents: 20 },
            { callKey: "jp", amountCents: 35 },
            { callKey: "kr", amountCents: 35 },
          ],
  );
  assert.equal(s.state, zero ? "VOIDED" : "CAPTURED");
  assert.equal(s.budgetCents, 500);
  assert.equal(s.capturedCents, zero ? 0 : 90);
  assert.equal(s.settlement.kind, zero ? "VOID" : "CAPTURE");
  assert.equal(s.settlement.status, "SUCCEEDED");
  assert.equal(s.settlement.amountCents, zero ? 0 : 90);
  assert.equal(s.settlement.releaseEvidence, zero ? "VOIDED" : "FINAL_CAPTURE");
  stage = "VERIFY_PROVIDER_ORDER";
  const o = await provider(`/v2/checkout/orders/${s.orderId}`);
  assert.equal(o.id, s.orderId);
  assert.equal(o.intent, "AUTHORIZE");
  assert.equal(o.purchase_units.length, 1);
  const p = o.purchase_units[0];
  assert.equal(p.custom_id, s.sessionId);
  assert.equal(p.payee.merchant_id, secrets.PAYPAL_MERCHANT_ID);
  assertUsdAmount(p.amount, 500);
  const captures = p.payments?.captures ?? [];
  stage = "VERIFY_PROVIDER_AUTHORIZATION";
  const a = await provider(`/v2/payments/authorizations/${s.authorizationId}`);
  assert.equal(a.id, s.authorizationId);
  assertUsdAmount(a.amount, 500);
  // Independent provider views may lag the facts already confirmed by the DO.
  // Retry reads only; ownership, amounts, extra captures and other contradictions stay fatal.
  stage = "VERIFY_PROVIDER_VISIBILITY";
  requireProviderVisibility(o.status, a.status, captures.length, zero);
  assert.equal(a.status, s.authorizationStatus);
  if (zero) {
    assert.equal(s.settlement.captureId, null);
    assert.equal(captures.length, 0);
    assert.equal(a.status, "VOIDED");
  } else {
    assert.equal(a.status, "CAPTURED");
    assert.equal(captures.length, 1);
    stage = "VERIFY_PROVIDER_CAPTURE";
    const c = await provider(`/v2/payments/captures/${captures[0].id}`);
    assert.equal(c.id, s.settlement.captureId);
    if (c.status === "PENDING") throw new EvidencePending();
    assert.equal(c.status, "COMPLETED");
    assert.equal(c.final_capture, true);
    assertUsdAmount(c.amount, 90);
    assert.equal(c.supplementary_data.related_ids.order_id, s.orderId);
    assert.equal(c.supplementary_data.related_ids.authorization_id, s.authorizationId);
  }
  const proof = {
    environment: remote ? "real-sandbox-deployed-worker" : "real-sandbox-local-worker",
    at: new Date().toISOString(),
    sessionId: s.sessionId,
    orderId: o.id,
    orderStatus: o.status,
    authorizationId: a.id,
    authorizationStatus: a.status,
    captureId: s.settlement.captureId,
    captureCount: captures.length,
    usedCents: s.usedCents,
    capturedCents: s.capturedCents,
    unusedCents: 500 - s.usedCents,
    ledgerEntries: s.ledger.length,
    releaseEvidence: s.settlement.releaseEvidence,
  };
  save(join(evidence, `${prefix}verified.json`), proof);
  console.log("PASS: independent sandbox GET verification saved.");
}
async function verify(s) {
  return awaitEvidence(async () => verifyOnce(await api(`/api/sessions/${s.sessionId}`)));
}
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", origin), {
      fetch: workerFetch,
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    }),
  );
  stage = "DISCOVER_TOOLS";
  const listed = await client.listTools();
  assert.ok(listed.tools.some((t) => t.name === "market_lookup"));
  if (args.includes("--prepare")) {
    stage = "OPEN_SESSION";
    const s = await tool("tollbooth_open", { budgetCents: 500, creationKey: state.creationKey });
    state = {
      ...state,
      sessionId: s.sessionId,
      orderId: s.orderId,
      approvalDeadline: s.approvalDeadline,
    };
    save(file, state);
    stage = "CHECK_APPROVAL_STATE";
    assert.equal(
      s.state,
      "APPROVAL_PENDING",
      "Existing session is not awaiting approval; inspect private state, do not silently create another order",
    );
    const u = new URL(s.approvalUrl);
    assert.equal(u.origin, "https://www.sandbox.paypal.com");
    stage = "VERIFY_PREPARED_ORDER";
    const o = await provider(`/v2/checkout/orders/${s.orderId}`);
    assert.equal(o.intent, "AUTHORIZE");
    assert.equal(o.status, "PAYER_ACTION_REQUIRED");
    assert.equal(o.purchase_units.length, 1);
    assert.equal(o.purchase_units[0].custom_id, s.sessionId);
    assert.equal(o.purchase_units[0].amount.currency_code, "USD");
    assert.equal(o.purchase_units[0].payments?.captures?.length ?? 0, 0);
    assert.equal(o.purchase_units[0].payee.merchant_id, secrets.PAYPAL_MERCHANT_ID);
    assert.equal(o.purchase_units[0].amount.value, "5.00");
    assert.equal(o.purchase_units[0].payments?.authorizations?.length ?? 0, 0);
    save(join(evidence, `${prefix}approve-url${remote ? "-remote" : ""}.txt`), u.href + "\n");
    if (remote) save(join(evidence, `${prefix}approve-url.txt`), u.href + "\n");
    save(join(evidence, `${prefix}prepared.json`), {
      orderId: o.id,
      status: o.status,
      intent: o.intent,
      budgetCents: 500,
      approvalDeadline: s.approvalDeadline,
      authorizationCount: 0,
    });
    if (aiMode && !zero) {
      stage = "AI_PLAN";
      state.aiPlan = await api(`/api/sessions/${state.sessionId}/ai`, "POST");
      save(file, state);
      save(join(evidence, "ai-plan.json"), state.aiPlan);
      const mode = preparedRunMode(state.aiPlan.status, args.includes("--allow-scripted-fallback"));
      if (mode === "scripted") {
        state.aiFallbackReason = state.aiPlan.reason;
        state.ai = false;
        delete state.aiPlan;
        save(file, state);
        console.log(
          "SCRIPTED_FALLBACK: AI unavailable; existing session uses fixture calls. Resume without --ai and with --approve-fixture-calls.",
        );
      } else {
        assert.equal(
          state.aiPlan.calls.reduce((n, c) => n + c.price, 0),
          90,
        );
      }
    }
    console.log(
      "AWAITING_APPROVAL: private approval URL saved. No buyer approval or authorization performed.",
    );
  } else {
    assert.ok(state.sessionId, "Run --prepare first");
    if (state.ai) {
      stage = "VERIFY_AI_PLAN";
      const authoritative = requireAiReady(await api(`/api/sessions/${state.sessionId}/ai`));
      if (state.aiPlan) assert.deepEqual(state.aiPlan, authoritative);
      state.aiPlan = authoritative;
      save(file, state);
    }
    stage = "READ_SESSION";
    let s = await api(`/api/sessions/${state.sessionId}`);
    if (args.includes("--verify")) {
      await verify(s);
    } else {
      if (!["CAPTURED", "VOIDED"].includes(s.state)) {
        stage = "ACTIVATE";
        s = await api(`/api/sessions/${state.sessionId}/activate`, "POST");
        s = await awaitEvidence(async () =>
          requireActive(await api(`/api/sessions/${state.sessionId}`)),
        );
        if (!zero) {
          const calls = state.aiPlan
            ? state.aiPlan.calls.map((c) => [c.name, c.args, c.key, c.price])
            : [
                ["market_lookup", { category: "coffee" }, "coffee", 20],
                ["landed_cost", { itemUsd: 45, destination: "KR" }, "kr", 35],
                ["landed_cost", { itemUsd: 45, destination: "JP" }, "jp", 35],
              ];
          stage = state.ai ? "RUN_AI_CALLS" : "RUN_FIXTURE_CALLS";
          for (const [name, input, key, price] of calls) {
            if (needsCallConsent(price, key, s.ledger, state.ai ? aiConsent : preapprovedCalls)) {
              assert.ok(
                process.stdin.isTTY,
                "Use a TTY or --approve-ai-calls for the saved AI plan (--approve-fixture-calls only for scripted runs)",
              );
              const rl = createInterface({ input: process.stdin, output: process.stdout });
              const reply = await rl.question(
                `Approve ${name} ${key.toUpperCase()} for USD 0.35? Type yes: `,
              );
              rl.close();
              assert.equal(reply.trim().toLowerCase(), "yes", "Human declined; call not sent");
            }
            await tool(name, input, {
              sessionId: state.sessionId,
              callKey: key,
              maxPriceCents: price,
              pricingVersion: "fixture-v1",
            });
          }
          const replay = await tool(calls[0][0], calls[0][1], {
            sessionId: state.sessionId,
            callKey: calls[0][2],
            maxPriceCents: calls[0][3],
            pricingVersion: "fixture-v1",
          });
          assert.equal(replay.replayed, true);
          assert.equal(replay.additionalAccruedCents, 0);
          s = await api(`/api/sessions/${state.sessionId}`);
          assert.equal(s.usedCents, 90);
          assert.equal(s.ledger.length, 3);
        }
        stage = "CLOSE_SESSION";
        await Promise.all([
          api(`/api/sessions/${state.sessionId}/close`, "POST"),
          api(`/api/sessions/${state.sessionId}/close`, "POST"),
        ]);
        const deadline = Date.now() + 60000;
        do {
          s = await api(`/api/sessions/${state.sessionId}`);
          if (["CAPTURED", "VOIDED", "MANUAL_REVIEW"].includes(s.state)) break;
          await new Promise((r) => setTimeout(r, 2000));
        } while (Date.now() < deadline);
      }
      await verify(s);
    }
  }
} catch (error) {
  console.error(
    "Sandbox run stopped:",
    `stage=${stage}; code=${diagnosticCode(error)}. Inspect private state; no replacement session was created.`,
  );
  process.exitCode = 1;
} finally {
  await client.close();
}
