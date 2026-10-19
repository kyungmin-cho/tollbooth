# ADR 006 — One immutable settlement, conservative unknown-outcome recovery

- Date: 2026-10-18
- Status: Accepted.

## Context

The baseline records a successful 90-cent sandbox capture, but a lost response can make the local state ambiguous. Its generic retries, five-hour cutoff, and unconditional capture-then-void sequence should not become new guarantees.

## Decision

Close freezes usage after all reservations resolve. Persist exactly one settlement kind, amount, authorization, request ID, and payload before sending: positive usage selects final capture; zero usage selects void. Reconciliation uses provider queries and verified webhooks. An unknown mutation is not automatically resent until endpoint-specific retention/retry guarantees are established. Pending capture never yields a paid receipt.

## Alternatives

Capture per tool multiplies settlement operations. Prepaid credit changes product semantics. Retrying with a new ID risks duplicate billing. Always voiding after final capture creates an unnecessary competing action.

## Consequences and verification

Some failures will require manual review rather than automatic financial mutation. The UI distinguishes unused authorization from immediate fund availability. Preserve single logical settlement under repeated close/alarm/webhook attempts, and verify provider resources independently. See [PayPal idempotency](https://developer.paypal.com/api/rest/reference/idempotency/), [capture contract](https://developer.paypal.com/api/payments/v2/authorizations-capture), and [DESIGN section 7](../DESIGN.md).
