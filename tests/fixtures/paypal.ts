import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { money } from "../../src/domain/contracts";
import { BASE } from "../../src/payments/paypal";
export interface FakePayment {
  orderId: string;
  authId: string;
  sessionId: string;
  budget: number;
  approved: boolean;
  authorized: boolean;
  voided: boolean;
  captureStatus: string;
  captureAmount?: number;
  final: boolean;
  lostCapture: boolean;
  lostVoid: boolean;
  lostCreate?: boolean;
  lostAuthorize?: boolean;
  authorizationExpiry?: string;
  authorizationStatus?: string;
  extraCapture?: boolean;
  verification?: string;
  verificationUnavailable?: boolean;
  verificationPayloads: unknown[];
  createCount: number;
  authorizeCount: number;
  captureCount: number;
  voidCount: number;
  oauthCount: number;
  keys: string[];
  payloads: unknown[];
}
export function paypalFake(): FakePayment {
  const suffix = crypto.randomUUID();
  const p: FakePayment = {
    orderId: `ORDER-${suffix}`,
    authId: `AUTH-${suffix}`,
    sessionId: "",
    budget: 500,
    approved: false,
    authorized: false,
    voided: false,
    captureStatus: "COMPLETED",
    final: true,
    lostCapture: false,
    lostVoid: false,
    createCount: 0,
    authorizeCount: 0,
    captureCount: 0,
    voidCount: 0,
    oauthCount: 0,
    keys: [],
    payloads: [],
    verificationPayloads: [],
  };
  const authorization = () => ({
    id: p.authId,
    status:
      p.authorizationStatus ?? (p.voided ? "VOIDED" : p.captureCount ? "CAPTURED" : "CREATED"),
    amount: { currency_code: "USD", value: money(p.budget) },
    expiration_time: p.authorizationExpiry ?? new Date(Date.now() + 86400000).toISOString(),
  });
  const capture = () => ({
    id: `CAP-${suffix}`,
    status: p.captureStatus,
    amount: { currency_code: "USD", value: money(p.captureAmount ?? 0) },
    final_capture: p.final,
    supplementary_data: { related_ids: { order_id: p.orderId, authorization_id: p.authId } },
  });
  const order = () => ({
    id: p.orderId,
    intent: "AUTHORIZE",
    status: p.authorized ? "COMPLETED" : p.approved ? "APPROVED" : "PAYER_ACTION_REQUIRED",
    purchase_units: [
      {
        custom_id: p.sessionId,
        amount: { currency_code: "USD", value: money(p.budget) },
        payee: { merchant_id: env.PAYPAL_MERCHANT_ID },
        payments: {
          authorizations: p.authorized ? [authorization()] : [],
          captures: p.captureCount
            ? [capture(), ...(p.extraCapture ? [{ ...capture(), id: "EXTRA" }] : [])]
            : [],
        },
      },
    ],
    links: [
      {
        rel: "payer-action",
        href: `https://www.sandbox.paypal.com/checkoutnow?token=${p.orderId}`,
      },
    ],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.origin !== BASE) throw new Error("Unexpected external network request");
      const path = url.pathname,
        method = init?.method ?? "GET";
      const response = (data: unknown, status = 200) =>
        status === 204 ? new Response(null, { status }) : Response.json(data, { status });
      if (path === "/v1/oauth2/token") {
        p.oauthCount++;
        return response({ access_token: "fake-oauth-token", expires_in: 3600 });
      }
      if (path === "/v1/notifications/verify-webhook-signature") {
        p.verificationPayloads.push(JSON.parse(String(init?.body)));
        return response(
          { verification_status: p.verification ?? "SUCCESS" },
          p.verificationUnavailable ? 503 : 200,
        );
      }
      if (path === "/v2/checkout/orders" && method === "POST") {
        p.createCount++;
        const payload = JSON.parse(String(init?.body));
        p.sessionId = payload.purchase_units[0].custom_id;
        p.budget = Number(payload.purchase_units[0].amount.value.replace(".", ""));
        p.payloads.push(payload);
        return response(p.lostCreate ? {} : order(), p.lostCreate ? 503 : 201);
      }
      if (path === `/v2/checkout/orders/${p.orderId}`) return response(order());
      if (path === `/v2/checkout/orders/${p.orderId}/authorize`) {
        p.authorizeCount++;
        p.authorized = true;
        return response(p.lostAuthorize ? {} : order(), p.lostAuthorize ? 503 : 201);
      }
      if (path === `/v2/payments/authorizations/${p.authId}/capture`) {
        p.captureCount++;
        const payload = JSON.parse(String(init?.body));
        p.captureAmount ??= Number(payload.amount.value.replace(".", ""));
        p.payloads.push(payload);
        p.keys.push(new Headers(init?.headers).get("PayPal-Request-Id") ?? "");
        return response(p.lostCapture ? {} : capture(), p.lostCapture ? 503 : 201);
      }
      if (path === `/v2/payments/authorizations/${p.authId}/void`) {
        p.voidCount++;
        p.voided = true;
        return response({}, p.lostVoid ? 503 : 204);
      }
      if (path === `/v2/payments/authorizations/${p.authId}`) return response(authorization());
      if (path === `/v2/payments/captures/CAP-${suffix}`) return response(capture());
      throw new Error("Unexpected provider resource");
    }),
  );
  return p;
}
