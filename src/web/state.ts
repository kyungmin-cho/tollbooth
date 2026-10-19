import type { Snapshot } from "../shared/types";
export const money = (c: number) => `USD ${(c / 100).toFixed(2)}`;
export const short = (s: string | null | undefined) => (s ? s.slice(0, 8) + "…" : "—");
export const finalStates = ["CAPTURED", "VOIDED", "EXPIRED"];
export function stateLabel(s: Snapshot) {
  if (s.state === "CAPTURED") return "Settled · payment confirmed";
  if (s.state === "VOIDED") return "Authorization voided";
  if (s.state === "EXPIRED")
    return s.authorizationId ? "Authorization expired" : "Session expired before authorization";
  if (s.state === "RECONCILING")
    return s.reservedCents ? "Tool call unresolved" : "Settlement pending · checking payment";
  return (
    (
      {
        CREATED: "Opening session",
        APPROVAL_PENDING: "Awaiting wallet approval",
        AUTHORIZING: "Checking authorization",
        ACTIVE: "Active",
        CLOSING: "Closing · waiting for calls",
        SETTLING: "Settlement pending",
        MANUAL_REVIEW: "Review required · spending paused",
      } as Record<string, string>
    )[s.state] ?? s.state
  );
}
export function safeApproval(url: string | null) {
  try {
    const u = new URL(url ?? "");
    return u.origin === "https://www.sandbox.paypal.com" && !u.username && !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
