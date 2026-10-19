import type { SessionDO } from "../durable/SessionDO";
export interface AppEnv {
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  SESSIONS: DurableObjectNamespace<SessionDO>;
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  ENVIRONMENT: string;
  MERCHANT_ID: string;
  PAYPAL_MERCHANT_ID: string;
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  PAYPAL_WEBHOOK_ID?: string;
  OWNER_TOKEN_SIGNING_KEY: string;
  MERCHANT_ADMIN_TOKEN?: string;
  MERCHANT_COOKIE_SIGNING_KEY?: string;
}
