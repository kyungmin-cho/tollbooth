// Local-only test entry. Never referenced by either production Wrangler configuration.

import { SessionDO as CoreSession } from "../../src/durable/SessionDO";
import type { AppEnv } from "../../src/worker/env";
import worker from "../../src/worker/index";
import { sessionStub } from "../../src/worker/service";

interface Payment {
  id: string;
  session: string;
  auth: string;
  approved: boolean;
  authorized: boolean;
  voided: boolean;
  capture: string | null;
  amount: string;
  budget: string;
  status: string;
  lost: boolean;
}
const payments = new Map<string, Payment>();
const network = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  if (url.hostname !== "api-m.sandbox.paypal.com") return network(input, init);
  const path = url.pathname;
  if (path === "/v1/oauth2/token")
    return Response.json({ access_token: "browser-fixture-oauth", expires_in: 3600 });
  if (path === "/v2/checkout/orders") {
    const body = JSON.parse(String(init?.body)),
      u = body.purchase_units[0],
      id = "ORDER-" + crypto.randomUUID();
    const p: Payment = {
      id,
      session: u.custom_id,
      auth: "AUTH-" + crypto.randomUUID(),
      approved: false,
      authorized: false,
      voided: false,
      capture: null,
      amount: "0.00",
      budget: u.amount.value,
      status: "COMPLETED",
      lost: false,
    };
    payments.set(id, p);
    return Response.json(order(p), { status: 201 });
  }
  const p = [...payments.values()].find(
    (p) => path.includes(p.id) || path.includes(p.auth) || (p.capture && path.includes(p.capture)),
  );
  if (!p) return Response.json({}, { status: 404 });
  if (path.endsWith("/authorize")) {
    p.authorized = true;
    return Response.json(order(p), { status: 201 });
  }
  if (path.endsWith("/capture")) {
    p.capture = "CAP-" + crypto.randomUUID();
    p.amount = JSON.parse(String(init?.body)).amount.value;
    return p.lost ? Response.json({}, { status: 503 }) : Response.json(capture(p), { status: 201 });
  }
  if (path.endsWith("/void")) {
    p.voided = true;
    return new Response(null, { status: 204 });
  }
  if (path.includes("/orders/")) return Response.json(order(p));
  if (path.includes("/authorizations/")) return Response.json(auth(p));
  return Response.json(capture(p));
};
function auth(p: Payment) {
  return {
    id: p.auth,
    status: p.voided ? "VOIDED" : p.capture ? "CAPTURED" : "CREATED",
    amount: { currency_code: "USD", value: p.budget },
    expiration_time: new Date(Date.now() + 86400000).toISOString(),
  };
}
function capture(p: Payment) {
  return {
    id: p.capture,
    status: p.status,
    amount: { currency_code: "USD", value: p.amount },
    final_capture: true,
    supplementary_data: { related_ids: { order_id: p.id, authorization_id: p.auth } },
  };
}
function order(p: Payment) {
  return {
    id: p.id,
    intent: "AUTHORIZE",
    status: p.authorized ? "COMPLETED" : p.approved ? "APPROVED" : "PAYER_ACTION_REQUIRED",
    purchase_units: [
      {
        custom_id: p.session,
        payee: { merchant_id: "BROWSER-FIXTURE" },
        amount: { currency_code: "USD", value: p.budget },
        payments: {
          authorizations: p.authorized ? [auth(p)] : [],
          captures: p.capture ? [capture(p)] : [],
        },
      },
    ],
    links: [
      { rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=FIXTURE" },
    ],
  };
}
export class SessionDO extends CoreSession {
  async seed(state: string) {
    if (
      ![
        "CREATED",
        "AUTHORIZING",
        "CLOSING",
        "SETTLING",
        "RECONCILING",
        "MANUAL_REVIEW",
        "EXPIRED",
        "RESERVED",
      ].includes(state)
    )
      throw Error("unsupported fixture");
    this.ctx.storage.sql.exec(
      "UPDATE session SET state=?,reserved_cents=?",
      state === "RESERVED" ? "ACTIVE" : state,
      state === "RESERVED" ? 35 : 0,
    );
    this.ctx.storage.sql.exec("UPDATE session SET version=version+1");
  }
  async stale() {
    await this.env.DB.prepare(
      "UPDATE session_projection SET version=0,projected_at=1 WHERE session_id=(SELECT session_id FROM session_index WHERE session_id=?)",
    )
      .bind(this.ctx.storage.sql.exec("SELECT id FROM session").one().id)
      .run();
  }
}
export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext) {
    const u = new URL(request.url);
    if (u.pathname === "/__test__/reset") {
      await env.DB.exec(
        "DELETE FROM ai_runs; DELETE FROM login_attempts; DELETE FROM session_index; DELETE FROM session_projection; DELETE FROM charge_projection; DELETE FROM usage_projection; DELETE FROM projection_receipts;",
      );
      return Response.json({ ok: true });
    }
    if (u.pathname === "/__test__/pages") {
      const statements = [];
      for (let i = 0; i < 103; i++) {
        const id = crypto.randomUUID(),
          now = Date.now() - i * 1000;
        statements.push(
          env.DB.prepare(
            "INSERT INTO session_index(session_id,owner_id,merchant_id,creation_key,creation_hash,budget_cents,pricing_version,created_at,approval_deadline,recovery_due_at) VALUES(?,?,?,'page-fixture','fixture',500,'fixture-v1',?,?,9007199254740991)",
          ).bind(id, id, env.MERCHANT_ID, now, now + 1800000),
        );
        statements.push(
          env.DB.prepare("INSERT INTO session_projection VALUES(?,1,'ACTIVE',0,0,0,?,?)").bind(
            id,
            JSON.stringify({ ledger: [] }),
            now,
          ),
        );
      }
      for (let i = 0; i < statements.length; i += 40)
        await env.DB.batch(statements.slice(i, i + 40));
      return Response.json({ ok: true });
    }
    const match =
      /^\/__test__\/session\/([^/]+)\/(approve|pending|complete|unknown|stale|state)$/.exec(
        u.pathname,
      );
    if (match) {
      const p = [...payments.values()].find((p) => p.session === match[1]);
      if (!p) return Response.json({}, { status: 404 });
      if (match[2] === "approve") p.approved = true;
      if (match[2] === "pending") p.status = "PENDING";
      if (match[2] === "unknown") {
        p.status = "PENDING";
        p.lost = true;
      }
      if (match[2] === "complete") {
        p.status = "COMPLETED";
        await sessionStub(env, match[1]).reconcile(
          (await env.DB.prepare("SELECT owner_id FROM session_index WHERE session_id=?")
            .bind(match[1])
            .first<{ owner_id: string }>())!.owner_id,
          match[1],
        );
      }
      const stub = env.SESSIONS.get(
        env.SESSIONS.idFromName(`${env.ENVIRONMENT}:${env.MERCHANT_ID}:${match[1]}`),
      ) as unknown as SessionDO;
      if (match[2] === "state") await stub.seed(u.searchParams.get("value") ?? "");
      if (match[2] === "stale") await stub.stale();
      return Response.json({ ok: true });
    }
    return worker.fetch(
      request,
      {
        ...env,
        AI: {
          run: async () => ({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      function: {
                        name: "market_lookup",
                        arguments: JSON.stringify({ category: "coffee" }),
                      },
                    },
                    {
                      function: {
                        name: "landed_cost",
                        arguments: JSON.stringify({ itemUsd: 45, destination: "KR" }),
                      },
                    },
                    {
                      function: {
                        name: "landed_cost",
                        arguments: JSON.stringify({ itemUsd: 45, destination: "JP" }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        },
      },
      ctx,
    );
  },
};
