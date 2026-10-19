import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { BASE, PayPal } from "../../src/payments/paypal";
import { paypalFake } from "../fixtures/paypal";

it("remote wallet return/cancel URLs use the deployed origin and retain AUTHORIZE", () => {
  const origin = "https://tollbooth.arcsolve.workers.dev";
  const api = new PayPal({ ...env, APP_ORIGIN: origin });
  const payload = JSON.parse(
    api.createPayload({ id: "session", budget_cents: 500, order_id: null, authorization_id: null }),
  );
  expect(payload.intent).toBe("AUTHORIZE");
  expect(payload.payment_source.paypal.experience_context).toMatchObject({
    return_url: `${origin}/paypal/return`,
    cancel_url: `${origin}/paypal/cancel`,
  });
});

it("P01 OAuth refresh is single flight and cached, token stays outside returned data", async () => {
  const p = paypalFake(),
    api = new PayPal(env);
  await Promise.all(
    Array.from({ length: 8 }, () => api.request(`/v2/checkout/orders/${p.orderId}`)),
  );
  expect(p.oauthCount).toBe(1);
  const data = await api.request(`/v2/checkout/orders/${p.orderId}`);
  expect(JSON.stringify(data)).not.toContain("fake-oauth-token");
  expect(p.oauthCount).toBe(1);
});
it("P07 CAPTURE intent rejected before OAuth or network", () => {
  const p = paypalFake(),
    api = new PayPal(env);
  expect(() =>
    api.createPayload(
      { id: "s", budget_cents: 500, order_id: null, authorization_id: null },
      "prepaid",
    ),
  ).toThrow("INVALID_INPUT");
  expect(p.oauthCount + p.createCount).toBe(0);
});
it("one definitive 401 refresh retains identical mutation body and request ID", async () => {
  const calls: { key: string | null; body: unknown }[] = [];
  let oauth = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input === `${BASE}/v1/oauth2/token`) {
        oauth++;
        return Response.json({ access_token: `fake-${oauth}`, expires_in: 3600 });
      }
      calls.push({ key: new Headers(init?.headers).get("PayPal-Request-Id"), body: init?.body });
      return calls.length === 1 ? Response.json({}, { status: 401 }) : Response.json({ ok: true });
    }),
  );
  const api = new PayPal(env);
  await api.request("/test", "POST", '{"same":true}', "stable-key");
  expect(oauth).toBe(2);
  expect(calls).toEqual([
    { key: "stable-key", body: '{"same":true}' },
    { key: "stable-key", body: '{"same":true}' },
  ]);
});
it("foreign merchant, non-USD, wrong budget and CAPTURE order fail validation", () => {
  const api = new PayPal(env),
    s = { id: "session", budget_cents: 500, order_id: "order", authorization_id: null };
  const unit = {
    custom_id: s.id,
    amount: { currency_code: "USD", value: "5.00" },
    payee: { merchant_id: env.PAYPAL_MERCHANT_ID },
  };
  for (const change of [
    { ...unit, payee: { merchant_id: "FOREIGN" } },
    { ...unit, amount: { currency_code: "EUR", value: "5.00" } },
    { ...unit, amount: { currency_code: "USD", value: "4.99" } },
  ])
    expect(() =>
      api.validateOrder(
        { id: "order", status: "APPROVED", intent: "AUTHORIZE", purchase_units: [change] },
        s,
      ),
    ).toThrow();
  expect(() =>
    api.validateOrder(
      { id: "order", status: "COMPLETED", intent: "CAPTURE", purchase_units: [unit] },
      s,
    ),
  ).toThrow();
});

it("missing configured merchant fails before a sandbox financial POST", () => {
  const p = paypalFake();
  const api = new PayPal({ ...env, PAYPAL_MERCHANT_ID: "" });
  expect(() =>
    api.createPayload({ id: "session", budget_cents: 500, order_id: null, authorization_id: null }),
  ).toThrow("PAYMENT_CONFIG_REQUIRED");
  expect(p.createCount + p.oauthCount).toBe(0);
});
