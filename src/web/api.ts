let csrf = "",
  merchantCsrf = "";
let boot: Promise<void> | undefined;
export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
    public retryAfterSeconds = 0,
  ) {
    super(code);
  }
}
export async function bootstrap() {
  if (!boot)
    boot = fetch("/api/visitor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
      .then(async (r) => {
        if (!r.ok) throw new ApiError("ACCESS_UNAVAILABLE", r.status);
        csrf = ((await r.json()) as { csrf: string }).csrf;
      })
      .catch((e) => {
        boot = undefined;
        throw e;
      });
  return boot;
}
export async function api<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  await bootstrap();
  if (
    path.startsWith("/api/merchant/") &&
    path !== "/api/merchant/login" &&
    method !== "GET" &&
    !merchantCsrf
  ) {
    const r = await api<{ csrf: string }>("/api/merchant/access");
    merchantCsrf = r.csrf;
  }
  const r = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token":
        path.startsWith("/api/merchant/") && path !== "/api/merchant/login" ? merchantCsrf : csrf,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const value = (await r.json()) as { code?: string; csrf: string };
  if (!r.ok)
    throw new ApiError(
      value.code ?? "UNAVAILABLE",
      r.status,
      Number(r.headers.get("Retry-After")) || 0,
    );
  if (path === "/api/merchant/login") merchantCsrf = value.csrf;
  if (path === "/api/merchant/logout") merchantCsrf = "";
  return value as T;
}
export function errorText(e: unknown) {
  if (e instanceof ApiError && e.status === 429 && e.retryAfterSeconds > 0)
    return `Too many attempts. Try again in ${Math.ceil(e.retryAfterSeconds / 60)} minute(s).`;
  const c = e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : "OFFLINE";
  const messages: Record<string, string> = {
    UNAUTHENTICATED:
      "Access is missing or expired. Return to the browser that opened this session, or sign in again.",
    FORBIDDEN:
      "This browser cannot access this session. Use the original browser. No payment has been started here.",
    NOT_FOUND: "This session could not be found. Check the link and your browser access.",
    OFFLINE: "Connection unavailable. Values may be stale. Retry when you are online.",
    MERCHANT_ACCESS_UNAVAILABLE:
      "Merchant access is not configured on this deployment. The simulated dashboard is available.",
    RATE_LIMITED: "Too many attempts. Wait for the retry period, then try again.",
    ADMISSION_LIMIT: "Session limit reached. Try again in one hour.",
    SESSION_EXPIRED: "Approval expired. Open a new session to continue.",
    BUDGET_EXHAUSTED: "Budget used up. Finish this session to see your receipt.",
    PROVIDER_UNAVAILABLE: "PayPal is unavailable. Check this session again shortly.",
    INTERNAL_ERROR: "Service unavailable. Refresh this session before retrying.",
    LOGIN_LIMIT: "Too many sign-in attempts. Try again in ten minutes.",
    PAYMENT_RECONCILING:
      "Payment is unresolved. We are checking the existing payment; do not create another one.",
    PAYMENT_REVIEW_REQUIRED: "Provider evidence needs review. New spending is paused.",
    PAYMENT_CONFIG_REQUIRED:
      "Sandbox payments are not configured. No simulated payment has been substituted.",
    AWAITING_BUYER_APPROVAL:
      "Wallet approval is not confirmed yet. Complete approval in PayPal, then check again.",
    HUMAN_DECLINED: "Call declined. No usage was added.",
    PER_CALL_CAP_EXCEEDED: "Blocked by your per-call cap. Choose a lower-priced tool.",
    SESSION_CAP_EXCEEDED: "Budget exceeds your session policy. Lower the requested budget.",
    MERCHANT_NOT_ALLOWED: "This seller is not allowed. Review your merchant policy.",
  };
  return (
    messages[c] ?? `Request could not complete (${c}). Refresh to check the authoritative state.`
  );
}
