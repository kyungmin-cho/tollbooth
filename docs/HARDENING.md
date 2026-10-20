# Hardening stage A — 2026-10-19

Historical scope: the then-existing Free-plan `tollbooth-m1` Worker (deleted on 2026-10-19) and retained D1 on the approved account. The current Worker target is `tollbooth`; D1 retains its original name and ID. No plan change, new resources, paid model, buyer login, or new payment outside the two approval preparations.

## Admission and abuse controls

| Path | Durable limits |
|---|---|
| Session creation (HTTP and MCP open) | 30 attempts/hour per IP and per owner; existing 5 new sessions/hour/owner and 100/day/deployment remain authoritative admission caps |
| AI plan POST | 6 attempts/hour per IP and per owner; existing 3 inferences/day/owner and 20/day/deployment, saved inference identity, token cap and fallback remain |
| Merchant login | 5 attempts/10 minutes per IP and per visitor owner; changing browser or IP alone cannot bypass both dimensions |
| Webhook | Streaming 256 KiB bound before signature verification; missing/invalid signature fails closed; verified durable inbox deduplication |

D1 `login_attempts` is reused for namespaced SHA-256 fixed-window counters. Atomic batch increments are capped at limit + 1. Each admission deletes at most 100 expired keys. Raw IPs and credentials are never stored. Requests denied by either dimension consume both attempt counters. HTTP 429 includes `Retry-After` to the fixed-window boundary; existing session admission uses a conservative one-hour retry. Reads, settlement, recovery and existing AI plan GET remain available. These are abuse controls, not monetary accounting; financial idempotency and the DO reservation ledger are unchanged. Distributed IP/owner rotation can still consume the global free allowance; global admission caps fail closed.

Workers-runtime regressions exercise 20 concurrent attempts, IP rotation with the same owner, window expiry, and HTTP rejection before provider work with Retry-After. Existing webhook size/signature and AI quota/crash tests remain.

## Errors and recovery

Buyer and merchant errors use shadcn Alert. Rate limiting gives the retry time and preserves the submit action. Offline state retains stale labeling and Refresh status. Expired approval instructs opening a new session; exhausted budget instructs finishing for a receipt. Policy blocks cannot be overridden by human consent. PayPal uncertain outcomes retain the existing payment and reconciliation path. AI exhaustion/unavailable/invalid output uses an explicit scripted-fallback Alert and rehearsal link; no inference or paid call is silently substituted.

## Cold path and measurement

MCP remains the Agents stateless createMcpHandler on both wire eras. The SDK already preloads wire schema construction in its workerd shim. Stage A additionally validates public discovery schemas during module startup and precomputes the immutable tools list. Discovery-only servers skip installing paid tool callbacks; calls still use the complete server and validations. Each request still gets its own server/transport; no principal or business metadata is cached. No wire protocol shortcut, lazy SDK import, or financial validation bypass was introduced.

Measure each fresh deployment with `scripts/verify/tail-metrics.mjs --evidence <dir>` and `scripts/verify/remote-smoke.mjs --paced --evidence <dir>`, then `scripts/verify/summarize-cpu.mjs --evidence <dir>`. Include first requests and outliers. A new deployment encourages a fresh isolate but does not prove every request is cold; live tail can sample/drop events. Startup time and client latency are not request CPU. Free HTTP CPU remains 10 ms; occasional platform burst tolerance is not a higher guarantee. [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time).

`scripts/verify/load-free.mjs` uses 20 concurrent clients and 300 planned reads: 200 MCP tools/list and 100 public simulated merchant projections. Connect requests are additional transport overhead. It never opens a session, invokes AI, executes a paid tool, or contacts PayPal. Report nearest-rank p50/p95 latency, errors and observed tail CPU exceed outcomes separately; missing tail samples are not zero CPU.

## Real webhook handoff

The sandbox webhook is registered for the eight exact events in [M2-M3](M2-M3.md#webhook-registration). ID lives only in external `sandbox.env` (0600) and Worker secret `PAYPAL_WEBHOOK_ID`. Registration is not proof of genuine event delivery. No simulator was used. After the two prepared wallet approvals, run resume and verify with the same origin/evidence directory; inspect verified webhook inbox/delivery separately from successful settlement. Preparation may use `--ai --allow-scripted-fallback`: only a terminal FALLBACK switches the existing session to explicitly labeled fixtures; PENDING or malformed state still stops. A fallback resumes without `--ai`, using `--approve-fixture-calls`. Approval and signed real-transaction delivery remain human-dependent acceptance gates.

Private run measurements, deployment versions, test totals and exact approval/resume commands are in `_runs/2026-10-19-harden/RESULT.md` outside Git.

## Stage A observed outcome

Local validation: 177 Vitest tests (13 files), 15 Playwright tests, typecheck/lint/build/secret scan passed. Two initial cold batches improved modern connect/list, but later paced measurements still found legacy initialize 11 ms and initialized notification 15 ms. After adding module-scope validation of the legacy JSON-RPC wrapper and initialize response, two fresh deployments measured first legacy initialize at 10 and 8 ms. Retain all earlier outliers; the observed improvement does not guarantee every isolate remains below 10 ms. No observed `exceededCpu` outcome occurred. Final deployment: `74f61093-6193-4147-a28a-363bff4d31e7` (runtime `a992f72`). Startup 52 ms is separate from billed request CPU.

Each of two free-endpoint load batches completed 300 reads at concurrency 20 with zero errors. Final batch tools/list p50/p95 12.44/22.06 ms, rehearsal projection 11.92/97.58 ms, including network time. Tail observed only a subset at this burst rate; do not infer the unobserved CPU. The final burst overlapped the latter portion of cold batch 6, after its first legacy initialize; batch 5 is the isolated paced comparator.

The fresh normal order has a READY real Workers AI plan (three tools, 90 cents if approved and successfully executed); the separate zero-use order has no authorization yet. Both remain PAYER_ACTION_REQUIRED. Human approval, real signed transaction webhook delivery, three-call settlement and zero-use void on this build are pending. Private IDs/approval URLs and exact commands remain outside Git.

## Stage B — approved sandbox acceptance (2026-10-19)

All four existing-session resume/verify commands passed. The real saved Workers AI plan executed three calls for 90 cents, replay added no usage, and the normal session has one completed final capture for USD 0.90. The zero-use session has a VOIDED authorization, zero ledger entries and no capture. No replacement order, new inference, or buyer login was performed. Browser return refusal was the expected ownership boundary; provider GET confirmed approval independently.

Six genuine transaction events reached the registered endpoint: CHECKOUT.ORDER.APPROVED ×2, PAYMENT.AUTHORIZATION.CREATED ×2, PAYMENT.CAPTURE.COMPLETED ×1, PAYMENT.AUTHORIZATION.VOIDED ×1. D1 ingress has six DELIVERED rows and the authoritative DO inboxes have three APPLIED entries each, with no pending outbox. SUCCESS is established by the deployed fail-closed verification-before-insert path, not a persisted raw verifier response. These were real sandbox transaction notifications, not simulator payloads or locally replayed fixtures.

PayPal event-list and per-event GET confirmed all six event identities. This app's public REST responses omitted status/transmissions fields, so provider-side delivery status is unavailable from those responses; DELIVERED here denotes our durable ingress status. Event-list visibility varied between reads, so individual GETs were also checked. See the [PayPal event API](https://developer.paypal.com/api/webhooks/v1/) and private Stage B evidence for the exact fields returned.

One already-delivered PAYMENT.AUTHORIZATION.VOIDED event was resent once through PayPal's resend API, scoped to the registered webhook ID; PayPal returned 202 at 01:59:12 UTC. Polling continued until after 02:09:12 UTC. No new `/webhooks/paypal` request appeared in the sanitized live tail, and authoritative inspections stayed byte-for-byte equivalent (inbox 3+3, ledger 3/0, capture 90/0 cents, reserved zero, no pending outbox). D1 projections independently matched both terminal outcomes. A 202 acceptance and unchanged inbox do **not** prove redelivery deduplication: that deployed acceptance gate remains BLOCKED pending actual delivery evidence. No second resend or replacement order was issued. Tail can omit requests, so absence is an evidence limitation, not proof that PayPal never sent it.

Stage B changed documentation only; no runtime code or deployment changed and no new test run was needed. The four deployed financial acceptance commands and the real webhook inspections are the new evidence; Stage A's 177 Vitest / 15 Playwright passes remain the last code test gate.

## Redelivery tests — 2026-10-20

The code already deduplicated by PayPal event ID at both ingress layers, after signature verification: D1 `webhook_pending` and the session DO `webhook_inbox`. The same ID with a different body hash is a durable 409 conflict. No runtime code, configuration or migration changed.

The earlier duplicate test counted inbox rows after two deliveries. Five Workers-runtime tests now deliver one event three times and compare every observable effect with the state after the first delivery: session status, both inboxes, ledger, settlement, provider GETs and financial POST counts. They cover an authorization event, a capture-completed event, three concurrent deliveries, a D1 ingress outage where only the DO inbox deduplicates, and a redelivery whose signature fails, which is rejected rather than accepted as a duplicate. With both dedup checks temporarily disabled, all five failed and the earlier row-count test still passed.

Local result: 182 Vitest tests (13 files), 15 Playwright tests, typecheck, lint and build passed. This changed tests and documentation only, so there is nothing new to deploy. The deployed live-redelivery gate from Stage B remains BLOCKED.
