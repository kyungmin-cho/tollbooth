import { z } from "zod";
import { cents, Fault, money } from "../domain/contracts";
import type { AppEnv } from "../worker/env";
export const BASE = "https://api-m.sandbox.paypal.com";
const amountSchema = z.object({ currency_code: z.literal("USD"), value: z.string() });
const authorizationSchema = z.object({
  id: z.string(),
  status: z.string(),
  amount: amountSchema,
  expiration_time: z.string().optional(),
});
const captureSchema = z.object({
  id: z.string(),
  status: z.string(),
  amount: amountSchema,
  final_capture: z.boolean(),
  supplementary_data: z
    .object({
      related_ids: z.object({
        order_id: z.string().optional(),
        authorization_id: z.string().optional(),
      }),
    })
    .optional(),
});
const orderSchema = z.object({
  id: z.string(),
  status: z.string(),
  intent: z.literal("AUTHORIZE"),
  purchase_units: z
    .array(
      z.object({
        reference_id: z.string().optional(),
        custom_id: z.string(),
        amount: amountSchema,
        payee: z.object({ merchant_id: z.string() }),
        payments: z
          .object({
            authorizations: z.array(authorizationSchema).optional(),
            captures: z.array(captureSchema).optional(),
          })
          .optional(),
      }),
    )
    .length(1),
  links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
});
export type Order = z.infer<typeof orderSchema>;
export type Authorization = z.infer<typeof authorizationSchema>;
export type Capture = z.infer<typeof captureSchema>;
export interface PaymentContext {
  callbackState?: string;
  id: string;
  budget_cents: number;
  order_id: string | null;
  authorization_id: string | null;
}
export class PayPal {
  private cached?: { token: string; until: number };
  private refresh?: Promise<string>;
  constructor(
    private env: Pick<
      AppEnv,
      "PAYPAL_CLIENT_ID" | "PAYPAL_CLIENT_SECRET" | "PAYPAL_MERCHANT_ID" | "APP_ORIGIN"
    >,
  ) {}
  private token(): Promise<string> {
    if (this.cached && this.cached.until > Date.now()) return Promise.resolve(this.cached.token);
    if (this.refresh) return this.refresh;
    this.refresh = (async () => {
      const r = await fetch(`${BASE}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${this.env.PAYPAL_CLIENT_ID}:${this.env.PAYPAL_CLIENT_SECRET}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Fault("PAYMENT_RECONCILING", 202);
      const v = z
        .object({ access_token: z.string(), expires_in: z.number() })
        .parse(await r.json());
      this.cached = {
        token: v.access_token,
        until: Date.now() + Math.max(0, v.expires_in - 60) * 1000,
      };
      return v.access_token;
    })().finally(() => {
      this.refresh = undefined;
    });
    return this.refresh;
  }
  async request(path: string, method = "GET", payload?: string, key?: string): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token();
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
          ...(key ? { "PayPal-Request-Id": key } : {}),
        },
        body: payload,
        signal: AbortSignal.timeout(10000),
      });
      if (r.status === 401 && attempt === 0) {
        this.cached = undefined;
        continue;
      }
      if (r.status === 429) {
        const header = r.headers.get("Retry-After") ?? "2";
        const delay = /^\d+$/.test(header)
          ? Number(header) * 1000
          : Date.parse(header) - Date.now();
        throw new Fault(
          "PAYMENT_RECONCILING",
          202,
          Number.isFinite(delay) ? Math.max(2000, delay) : 2000,
        );
      }
      if (!r.ok) throw new Fault("PAYMENT_RECONCILING", 202);
      if (r.status === 204) return null;
      return r.json();
    }
    throw new Fault("PAYMENT_RECONCILING", 202);
  }
  async verifyWebhook(headers: Headers, event: unknown, webhookId: string) {
    const fields = {
      auth_algo: "paypal-auth-algo",
      cert_url: "paypal-cert-url",
      transmission_id: "paypal-transmission-id",
      transmission_sig: "paypal-transmission-sig",
      transmission_time: "paypal-transmission-time",
    };
    const values: Record<string, string> = {};
    for (const [key, name] of Object.entries(fields)) {
      const value = headers.get(name);
      if (!value || value.length > 2048) throw new Fault("WEBHOOK_INVALID", 400);
      values[key] = value;
    }
    let result: unknown;
    try {
      result = await this.request(
        "/v1/notifications/verify-webhook-signature",
        "POST",
        JSON.stringify({ ...values, webhook_id: webhookId, webhook_event: event }),
      );
    } catch {
      throw new Fault("WEBHOOK_UNAVAILABLE", 503);
    }
    if (!result || typeof result !== "object" || !("verification_status" in result))
      throw new Fault("WEBHOOK_UNAVAILABLE", 503);
    if (result.verification_status !== "SUCCESS") throw new Fault("WEBHOOK_INVALID", 400);
  }
  createPayload(s: PaymentContext, mode = "authorize") {
    if (mode !== "authorize") throw new Fault("INVALID_INPUT", 400);
    if (
      !this.env.PAYPAL_MERCHANT_ID ||
      !this.env.PAYPAL_CLIENT_ID ||
      !this.env.PAYPAL_CLIENT_SECRET
    )
      throw new Fault("PAYMENT_CONFIG_REQUIRED", 503);
    return JSON.stringify({
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: s.id,
          custom_id: s.id,
          invoice_id: s.id,
          amount: { currency_code: "USD", value: money(s.budget_cents) },
          payee: { merchant_id: this.env.PAYPAL_MERCHANT_ID },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            shipping_preference: "NO_SHIPPING",
            user_action: "CONTINUE",
            return_url: `${this.env.APP_ORIGIN}/paypal/return${s.callbackState ? "?state=" + encodeURIComponent(s.callbackState) : ""}`,
            cancel_url: `${this.env.APP_ORIGIN}/paypal/cancel${s.callbackState ? "?state=" + encodeURIComponent(s.callbackState) : ""}`,
          },
        },
      },
    });
  }
  capturePayload(s: PaymentContext, amount: number) {
    return JSON.stringify({
      amount: { currency_code: "USD", value: money(amount) },
      final_capture: true,
      invoice_id: s.id,
    });
  }
  validateOrder(raw: unknown, s: PaymentContext): Order {
    const parsed = orderSchema.safeParse(raw);
    if (!parsed.success) throw new Fault("PAYMENT_REVIEW_REQUIRED");
    const o = parsed.data,
      p = o.purchase_units[0];
    if (
      p.custom_id !== s.id ||
      p.payee.merchant_id !== this.env.PAYPAL_MERCHANT_ID ||
      cents(p.amount.value) !== s.budget_cents ||
      (s.order_id && o.id !== s.order_id)
    )
      throw new Fault("PAYMENT_REVIEW_REQUIRED", 409);
    return o;
  }
  async order(s: PaymentContext) {
    return this.validateOrder(await this.request(`/v2/checkout/orders/${s.order_id}`), s);
  }
  async create(s: PaymentContext, payload: string, key: string) {
    const o = this.validateOrder(
      await this.request("/v2/checkout/orders", "POST", payload, key),
      s,
    );
    const link = o.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
    if (!link) throw new Fault("PAYMENT_REVIEW_REQUIRED");
    const u = new URL(link);
    if (u.origin !== "https://www.sandbox.paypal.com" || u.username || u.password)
      throw new Fault("PAYMENT_REVIEW_REQUIRED");
    return { id: o.id, url: link };
  }
  validateAuthorization(o: Order, s: PaymentContext) {
    const list = o.purchase_units[0].payments?.authorizations ?? [];
    if (list.length !== 1 || o.purchase_units[0].payments?.captures?.length)
      throw new Fault("PAYMENT_REVIEW_REQUIRED");
    const a = list[0];
    if (
      a.status !== "CREATED" ||
      cents(a.amount.value) !== s.budget_cents ||
      !a.expiration_time ||
      !Number.isFinite(Date.parse(a.expiration_time)) ||
      Date.parse(a.expiration_time) - 60000 <= Date.now()
    )
      throw new Fault("PAYMENT_REVIEW_REQUIRED");
    return a;
  }
  async authorize(s: PaymentContext, payload: string, key: string) {
    return this.validateAuthorization(
      this.validateOrder(
        await this.request(`/v2/checkout/orders/${s.order_id}/authorize`, "POST", payload, key),
        s,
      ),
      s,
    );
  }
  async authorization(id: string) {
    return authorizationSchema.parse(await this.request(`/v2/payments/authorizations/${id}`));
  }
  async capture(s: PaymentContext, payload: string, key: string) {
    return captureSchema.parse(
      await this.request(
        `/v2/payments/authorizations/${s.authorization_id}/capture`,
        "POST",
        payload,
        key,
      ),
    );
  }
  async captureDetail(id: string) {
    return captureSchema.parse(await this.request(`/v2/payments/captures/${id}`));
  }
  async void(s: PaymentContext, key: string) {
    await this.request(`/v2/payments/authorizations/${s.authorization_id}/void`, "POST", "{}", key);
  }
  validateCapture(c: Capture, s: PaymentContext, amount: number) {
    const ids = c.supplementary_data?.related_ids;
    if (
      cents(c.amount.value) !== amount ||
      !c.final_capture ||
      ids?.order_id !== s.order_id ||
      ids.authorization_id !== s.authorization_id
    )
      throw new Fault("PAYMENT_REVIEW_REQUIRED");
    if (!["COMPLETED", "PENDING"].includes(c.status)) throw new Fault("PAYMENT_REVIEW_REQUIRED");
    return c;
  }
}
