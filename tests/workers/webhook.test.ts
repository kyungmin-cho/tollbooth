import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { signAccess } from "../../src/worker/auth";
import { receivePayPalWebhook, replayWebhooks } from "../../src/worker/webhook";
import { due, setup } from "../helpers";

const hookEnv = () => ({ ...env, PAYPAL_WEBHOOK_ID: "registered-test-webhook" });
const headers = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.paypal.com/cert/test",
  "paypal-transmission-id": "transmission-1",
  "paypal-transmission-sig": "synthetic-signature",
  "paypal-transmission-time": "2026-10-18T00:00:00Z",
};
function event(
  t: Awaited<ReturnType<typeof setup>>,
  type = "PAYMENT.AUTHORIZATION.CREATED",
  id = crypto.randomUUID(),
) {
  return {
    id,
    event_type: type,
    resource: {
      id: type.startsWith("CHECKOUT.")
        ? t.payment.orderId
        : type.startsWith("PAYMENT.CAPTURE.")
          ? t.payment.orderId.replace("ORDER-", "CAP-")
          : t.payment.authId,
      custom_id: t.session.sessionId,
      supplementary_data: {
        related_ids: {
          order_id: t.payment.orderId,
          ...(t.payment.authorized ? { authorization_id: t.payment.authId } : {}),
        },
      },
    },
  };
}
function request(e: unknown, h = headers) {
  return new Request(env.APP_ORIGIN + "/webhooks/paypal", {
    method: "POST",
    headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify(e),
  });
}
it("verified webhook forwards exact verification fields and retains only minimal inbox metadata", async () => {
  const t = await setup();
  const e = { ...event(t), private_payer_email: "private@example.invalid" };
  await receivePayPalWebhook(request(e), hookEnv());
  expect(t.payment.verificationPayloads[0]).toEqual({
    auth_algo: headers["paypal-auth-algo"],
    cert_url: headers["paypal-cert-url"],
    transmission_id: headers["paypal-transmission-id"],
    transmission_sig: headers["paypal-transmission-sig"],
    transmission_time: headers["paypal-transmission-time"],
    webhook_id: "registered-test-webhook",
    webhook_event: e,
  });
  const rows = await runInDurableObject(t.stub, (_i, s) =>
    s.storage.sql.exec("SELECT * FROM webhook_inbox").toArray(),
  );
  expect(rows[0].outcome).toBe("APPLIED");
  expect(JSON.stringify(rows)).not.toContain("private@example.invalid");
});
it.each(["FAILURE", "WRONG_WEBHOOK_ID"])(
  "signature %s rejects before inbox/state mutation",
  async (mode) => {
    const t = await setup();
    t.payment.verification = "FAILURE";
    const before = await t.stub.status(t.owner, t.session.sessionId);
    const e = event(t);
    await expect(
      receivePayPalWebhook(request(e), {
        ...hookEnv(),
        PAYPAL_WEBHOOK_ID: mode === "WRONG_WEBHOOK_ID" ? "wrong-id" : "registered-test-webhook",
      }),
    ).rejects.toThrow("WEBHOOK_INVALID");
    expect(await t.stub.status(t.owner, t.session.sessionId)).toEqual(before);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) n FROM webhook_pending WHERE json_extract(metadata_json,'$.sessionId')=?",
        )
          .bind(t.session.sessionId)
          .first()
      )?.n,
    ).toBe(0);
  },
);
it("missing headers, unset registration and oversized bodies fail closed", async () => {
  const t = await setup();
  await expect(
    receivePayPalWebhook(request(event(t), {} as typeof headers), hookEnv()),
  ).rejects.toThrow("WEBHOOK_INVALID");
  await expect(
    receivePayPalWebhook(request(event(t)), { ...env, PAYPAL_WEBHOOK_ID: undefined }),
  ).rejects.toThrow("WEBHOOK_UNAVAILABLE");
  await expect(
    receivePayPalWebhook(
      new Request(env.APP_ORIGIN + "/webhooks/paypal", {
        method: "POST",
        body: "x".repeat(262145),
      }),
      hookEnv(),
    ),
  ).rejects.toThrow("BODY_TOO_LARGE");
  expect(t.payment.verificationPayloads).toHaveLength(0);
});
it("verification outage returns retryable failure and certificate URLs are never fetched", async () => {
  const t = await setup();
  t.payment.verificationUnavailable = true;
  await expect(
    receivePayPalWebhook(
      request(event(t), { ...headers, "paypal-cert-url": "http://127.0.0.1/private" }),
      hookEnv(),
    ),
  ).rejects.toThrow("WEBHOOK_UNAVAILABLE");
  expect(
    vi
      .mocked(fetch)
      .mock.calls.every(([u]) => String(u).startsWith("https://api-m.sandbox.paypal.com/")),
  ).toBe(true);
});
it("duplicate delivery is idempotent; same event ID with different hash is durable conflict", async () => {
  const t = await setup(),
    e = event(t);
  await receivePayPalWebhook(request(e), hookEnv());
  await receivePayPalWebhook(request(e), hookEnv());
  expect(
    await runInDurableObject(
      t.stub,
      (_i, s) => s.storage.sql.exec("SELECT count(*) n FROM webhook_inbox").one().n,
    ),
  ).toBe(1);
  await expect(
    receivePayPalWebhook(request({ ...e, extra: "different" }), hookEnv()),
  ).rejects.toThrow("WEBHOOK_CONFLICT");
  expect(
    (await env.DB.prepare("SELECT status FROM webhook_pending WHERE event_id=?").bind(e.id).first())
      ?.status,
  ).toBe("CONFLICT");
});
it("before-mapping verified metadata is retained and replayed by scan without opening a session", async () => {
  const t = await setup();
  await env.DB.prepare(
    "UPDATE session_index SET order_id=NULL,authorization_id=NULL WHERE session_id=?",
  )
    .bind(t.session.sessionId)
    .run();
  const e = event(t);
  delete (e.resource as { custom_id?: string }).custom_id;
  await receivePayPalWebhook(request(e), hookEnv());
  expect(
    (await env.DB.prepare("SELECT status FROM webhook_pending WHERE event_id=?").bind(e.id).first())
      ?.status,
  ).toBe("PENDING");
  await t.stub.rebuildProjection(t.owner, t.session.sessionId);
  await replayWebhooks(env);
  expect(
    (await env.DB.prepare("SELECT status FROM webhook_pending WHERE event_id=?").bind(e.id).first())
      ?.status,
  ).toBe("DELIVERED");
  expect(t.payment.createCount).toBe(1);
});
it.each(["merchant", "currency", "amount"])(
  "foreign provider %s facts cannot activate or settle",
  async (field) => {
    const t = await setup(500, false);
    t.payment.authorized = true;
    const upstream = fetch;
    vi.stubGlobal("fetch", async (u: RequestInfo | URL, init?: RequestInit) => {
      const r = await upstream(u, init);
      if (String(u).endsWith("/" + t.payment.orderId)) {
        const body = (await r.json()) as {
          purchase_units: {
            payee: { merchant_id: string };
            amount: { currency_code: string; value: string };
          }[];
        };
        if (field === "merchant") body.purchase_units[0].payee.merchant_id = "FOREIGN";
        if (field === "currency") body.purchase_units[0].amount.currency_code = "EUR";
        if (field === "amount") body.purchase_units[0].amount.value = "4.99";
        return Response.json(body);
      }
      return r;
    });
    await receivePayPalWebhook(request(event(t)), hookEnv());
    expect((await t.stub.status(t.owner, t.session.sessionId)).state).toBe("APPROVAL_PENDING");
    expect(
      await runInDurableObject(
        t.stub,
        (_i, s) => s.storage.sql.exec("SELECT outcome FROM webhook_inbox").one().outcome,
      ),
    ).toBe("REVIEW");
    expect(t.payment.captureCount + t.payment.voidCount).toBe(0);
  },
);
it("pending then completed then stale pending notifications reconcile facts without recapture", async () => {
  const t = await setup();
  t.payment.captureStatus = "PENDING";
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  await t.stub.close(t.owner, t.session.sessionId);
  await receivePayPalWebhook(request(event(t, "PAYMENT.CAPTURE.PENDING")), hookEnv());
  expect((await t.stub.status(t.owner, t.session.sessionId)).state).toBe("RECONCILING");
  t.payment.captureStatus = "COMPLETED";
  await receivePayPalWebhook(request(event(t, "PAYMENT.CAPTURE.COMPLETED")), hookEnv());
  await receivePayPalWebhook(request(event(t, "PAYMENT.CAPTURE.PENDING")), hookEnv());
  expect((await t.stub.status(t.owner, t.session.sessionId)).capturedCents).toBe(20);
  expect(t.payment.captureCount).toBe(1);
});
it("verified refund/reversal flags historical gross instead of rewriting paid state", async () => {
  const t = await setup();
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  await t.stub.close(t.owner, t.session.sessionId);
  await receivePayPalWebhook(request(event(t, "PAYMENT.CAPTURE.REVERSED")), hookEnv());
  expect(await t.stub.status(t.owner, t.session.sessionId)).toMatchObject({
    state: "CAPTURED",
    capturedCents: 20,
    postSettlementIssue: "PAYMENT.CAPTURE.REVERSED",
  });
  expect(t.payment.captureCount).toBe(1);
});
it("unknown create response can bind a verified matching order without a new POST", async () => {
  const t = await setup(500, false);
  await runInDurableObject(t.stub, (_i, s) => {
    s.storage.sql.exec("UPDATE session SET order_id=NULL,state='RECONCILING'");
    s.storage.sql.exec("UPDATE payment_operations SET status='UNKNOWN' WHERE kind='CREATE_ORDER'");
  });
  await receivePayPalWebhook(request(event(t, "CHECKOUT.ORDER.APPROVED")), hookEnv());
  expect((await t.stub.status(t.owner, t.session.sessionId)).orderId).toBe(t.payment.orderId);
  expect(t.payment.createCount).toBe(1);
  expect(t.payment.authorizeCount).toBe(0);
});
it("provider outage after durable inbox ACK survives eviction and retries without financial POST", async () => {
  const t = await setup();
  const upstream = fetch;
  vi.stubGlobal("fetch", async (u: RequestInfo | URL, init?: RequestInit) =>
    String(u).endsWith("/" + t.payment.orderId)
      ? Response.json({}, { status: 503 })
      : upstream(u, init),
  );
  await receivePayPalWebhook(request(event(t)), hookEnv());
  expect(
    await runInDurableObject(
      t.stub,
      (_i, s) => s.storage.sql.exec("SELECT outcome FROM webhook_inbox").one().outcome,
    ),
  ).toBe("PENDING");
  vi.stubGlobal("fetch", upstream);
  await evictDurableObject(t.stub);
  await t.stub.recover();
  expect(
    await runInDurableObject(
      t.stub,
      (_i, s) => s.storage.sql.exec("SELECT outcome FROM webhook_inbox").one().outcome,
    ),
  ).toBe("APPLIED");
});
it("operator audience and merchant scope are required; read-reconcile never sends settlement POST", async () => {
  const t = await setup();
  t.payment.lostCapture = true;
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  await t.stub.close(t.owner, t.session.sessionId);
  await due(t.stub);
  const claims = {
    owner: crypto.randomUUID(),
    exp: Date.now() + 60000,
    aud: "tollbooth-operator" as const,
    merchant: env.MERCHANT_ID,
    scopes: ["read", "reconcile", "rebuild"] as ("read" | "reconcile" | "rebuild")[],
  };
  async function call(c: typeof claims, action = "reconcile") {
    return exports.default.fetch(
      new Request(env.APP_ORIGIN + "/api/operator/sessions/" + t.session.sessionId + "/" + action, {
        method: "POST",
        headers: { Authorization: "Bearer " + (await signAccess(c, env.OWNER_TOKEN_SIGNING_KEY)) },
      }),
    );
  }
  expect((await call({ ...claims, merchant: "foreign" })).status).toBe(403);
  const client = await signAccess(
    {
      owner: t.owner,
      exp: Date.now() + 60000,
      aud: "tollbooth-client",
      scopes: ["read", "reconcile"],
    },
    env.OWNER_TOKEN_SIGNING_KEY,
  );
  expect(
    (
      await exports.default.fetch(
        new Request(
          env.APP_ORIGIN + "/api/operator/sessions/" + t.session.sessionId + "/reconcile",
          { method: "POST", headers: { Authorization: "Bearer " + client } },
        ),
      )
    ).status,
  ).toBe(403);
  expect((await call(claims)).status).toBe(200);
  expect((await t.stub.status(t.owner, t.session.sessionId)).capturedCents).toBe(20);
  expect(t.payment.captureCount).toBe(1);
});

it("D1 ingress outage may ACK an existing DO inbox but never an unknown session", async () => {
  const t = await setup();
  await env.DB.exec("ALTER TABLE webhook_pending RENAME TO hidden_pending");
  try {
    await expect(receivePayPalWebhook(request(event(t)), hookEnv())).resolves.toEqual({
      accepted: true,
    });
    expect(
      await runInDurableObject(
        t.stub,
        (_i, s) => s.storage.sql.exec("SELECT count(*) n FROM webhook_inbox").one().n,
      ),
    ).toBe(1);
    const unknown = event(t);
    unknown.resource.custom_id = crypto.randomUUID();
    await expect(receivePayPalWebhook(request(unknown), hookEnv())).rejects.toThrow(
      "WEBHOOK_UNAVAILABLE",
    );
  } finally {
    await env.DB.exec("ALTER TABLE hidden_pending RENAME TO webhook_pending");
  }
});

it("operator inspection exposes recovery identities without raw payloads or owner credentials", async () => {
  const t = await setup();
  const token = await signAccess(
    {
      owner: crypto.randomUUID(),
      exp: Date.now() + 60000,
      aud: "tollbooth-operator",
      merchant: env.MERCHANT_ID,
      scopes: ["read"],
    },
    env.OWNER_TOKEN_SIGNING_KEY,
  );
  const r = await exports.default.fetch(
    new Request(env.APP_ORIGIN + "/api/operator/sessions/" + t.session.sessionId, {
      headers: { Authorization: "Bearer " + token },
    }),
  );
  expect(r.status).toBe(200);
  const body = (await r.json()) as { operations: unknown[] };
  expect(body.operations).toHaveLength(2);
  expect(JSON.stringify(body)).not.toContain("payload_json");
  expect(JSON.stringify(body)).not.toContain(env.PAYPAL_MERCHANT_ID);
});

it("a refund resource ID maps through its capture reference without following arbitrary URLs", async () => {
  const t = await setup();
  await t.stub.call(t.owner, "market_lookup", { category: "coffee" }, t.meta());
  await t.stub.close(t.owner, t.session.sessionId);
  const captureId = t.payment.orderId.replace("ORDER-", "CAP-");
  const e = {
    id: crypto.randomUUID(),
    event_type: "PAYMENT.CAPTURE.REFUNDED",
    resource: {
      id: "REFUND-separate-id",
      links: [
        { rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` },
      ],
    },
  };
  await receivePayPalWebhook(request(e), hookEnv());
  expect(await t.stub.status(t.owner, t.session.sessionId)).toMatchObject({
    state: "CAPTURED",
    capturedCents: 20,
    postSettlementIssue: "PAYMENT.CAPTURE.REFUNDED",
  });
  expect(t.payment.captureCount).toBe(1);
  expect(
    vi
      .mocked(fetch)
      .mock.calls.every(([u]) => String(u).startsWith("https://api-m.sandbox.paypal.com/")),
  ).toBe(true);
});
