# Implementation plan and verification

**Design date:** 2026-10-18 KST. **Implementation note:** the subsequent owner task authorized the local M1 spike; see [M1 status and boundaries](M1.md) and the subsequent [M2/M3 backend implementation](M2-M3.md) and [M4 UI acceptance](M4.md). One implementer. This document authorizes no implementation, installation, provisioning, deployment, publication, or payment. It describes a later authorized build. Expected effort: **18–22 focused development days** (including planned weekend work), leaving 3–7 calendar days for contingency/submission within the 25-day October 19–November 12 window. Dates below assume implementation starts October 19 and external decisions are made in time.

## 1. Repository structure

Use **one pnpm package, not a pnpm workspace**. A single Worker deployment and SPA do not justify separate publishable packages yet. Keep domain/transport/UI boundaries in directories so the adapter can be extracted later. Do not copy the old `app` folder or its lockfile wholesale.

```text
tollbooth/
  README.md                     existing design index; later add run instructions
  AGENTS.md                     coding and evidence rules
  .gitignore
  docs/
    DESIGN.md
    UI.md
    PLAN.md
    ADR/001-... through 006-...
  # Below was future work at the design commit; see M1.md for the local implemented subset:
  package.json                  one pnpm project; pinned packageManager
  pnpm-lock.yaml
  wrangler.jsonc                bindings, assets, SQLite class declaration, cron; no secrets
  vite.config.ts
  tsconfig*.json
  src/
    domain/                     amounts, policy, call fingerprint, state transitions
    worker/                     entry, routing, auth, public contracts, webhook ingress
    durable/                    SessionDO, local schema migrations, jobs/outbox
    payments/                   sandbox PayPal REST adapter and provider schemas
    mcp/                        server factory, paid tools, fixture catalog
    client/                     reusable policy/payment adapter; external host bridge
    web/                        React routes, buyer UI, merchant UI, shadcn Base UI
    shared/                     safe DTOs/schema versions; no secret-bearing types
  policies/default.json
  migrations/d1/                ordered forward SQL migrations
  tests/
    unit/                       policy, money, fingerprints, pure transitions
    workers/                    real local Workers runtime, DO, D1, alarms
    contract/                   MCP modern/legacy and PayPal response contracts
    browser/                    buyer/merchant Playwright scenarios
    fixtures/                   synthetic and redacted HTTP fixtures
  scripts/
    e2e-sandbox/                later explicit prepare/resume/verify commands
    verify/                     later lint/typecheck/test/build/doc checks
  _runs/                        ignored private runtime evidence
  LICENSE                       MIT proposed; preserve upstream attributions
```

Future package scripts should separate `test:unit`, `test:workers`, `test:contract`, `test:browser`, `typecheck`, `lint`, and `build`. Remote sandbox verification is an explicit command requiring test credentials and human approval; never part of an ordinary offline unit test. No npm package publication is necessary for the entry.

## 2. Milestones and deadline (all dates KST)

| Milestone | Dates | Work | Completion gate |
|---|---|---|---|
| M0 design freeze | Oct 18 | Review this document set and owner decisions | Documents consistent; 57-case migration accounted for; risks and unknowns visible. This task ends here. |
| M1 feasibility spike | Oct 19–20 | Minimal Worker/SQLite DO/stateless MCP, Static Assets routing, chosen client bridge, PayPal sandbox path, deployed CPU measurements | Local runtime and **authorized actual Free deployment** show tools/list/call, ownership, one wallet authorization, exact partial final capture, zero-use void, alarm wakeup, concurrent reservation rejection, and persistence. Modern + legacy wire matrix tested. Record versions, CPU/duration, actual client version. If signup/deployment not approved, local progress is possible but remote gate is BLOCKED, not passed. |
| M2 durable core | Oct 21–25 | Port policy/fixtures, reservation ledger, close barrier, fixed operations, crash recovery, alarm jobs | Domain baseline mapping plus new crash/interleaving cases pass in Workers runtime. Unknown outcomes never produce a fresh key or an unsupported re-execution. |
| M3 projection and provider recovery | Oct 26–28 | D1 admission/index/outbox, recovery scan, PayPal signature verification/inbox, scoped access, operator read-reconcile | Fault matrix passes; D1 unavailable does not break active-session budget; sandbox three-call E2E rerun against deployed build; verified webhook path and reverse-order events tested. |
| M4 complete UI | Oct 29–Nov 2 | Buyer workspace/consent/receipt, merchant login/grids/detail, mobile states | All UI.md routes and state variants work with real APIs; accessibility/390px/reload tests; no required Enterprise module or simulated/live ambiguity. |
| M5 AI and hardening ([implementation](M5.md)) | Nov 3–6 | Actual AI host/adapter end-to-end, quotas, bounded logs, stale projection, failure UX, judge onboarding | Real model chooses tools under deterministic policy; rejection, replay, close, disconnect/alarm proven. Free load budget measured. Public rehearsal works without judges supplying secrets; real sandbox instructions are honest. |
| M6 submission package | Nov 7–10 | English README/run guide, open-source license/attribution, reproducible demo, video, owner-reviewed public release | Fresh checkout/local reproduction, credential scan, recorded demo <3 min, required entry fields and working links ready. Publication/deployment/upload only after the applicable authorization. |
| M7 early submission | Nov 11, target 18:00 | Owner-approved Devpost submission and link checks | Actual submission receipt and accessible demo/video/repo; no claims from drafts alone. |
| Buffer / freeze | Nov 12 until 23:00 | Fix only blocking reproducibility issues; recheck links/status | Preserve a known working build; no late stack changes. |
| Hard deadline | **Nov 13, 05:00** | Absolute submission cutoff | All artifacts already submitted, not an upload beginning at cutoff. |
| Judging maintenance | Nov 13–Dec 16 | Weekly availability/quota/credential/expiry checks and recovery review | Demo and local instructions remain usable; no trial-dependent feature expires. |

The official deadline is Nov 12 at noon Pacific (Nov 13 05:00 KST); judging ends Dec 15 08:00 Pacific (Dec 16 01:00 KST). The entry requires meaningful PayPal sandbox and AI usage, an English description, public open-source repository with license/instructions, a working demonstration, and a short public video. The five equally weighted criteria are technical implementation, design, impact, innovation, and presentation. Our evidence is respectively durable/payment tests, coherent UI, the small-provider use case, policy-aware MCP metering, and the concise real flow. [Official rules](https://paypalaihackathon.devpost.com/rules).

M1 is a go/no-go gate for the chosen free deployment, not permission to switch stacks. If it fails, first reduce CPU/serialization overhead, pin compatible SDK versions, and retest. A paid plan or scope change requires the owner; do not quietly adopt Render, Next.js, prepaid, or a fake AI run. Prioritize payment correctness and a small actual-AI path over extra tools, charts, or sponsor features.

## 3. Port, rewrite, and discard inventory

| Baseline | Preserve | Replace/discard |
|---|---|---|
| `src/types.ts` | Integer cents, explicit public DTOs, gateway/provider separation | Prepaid mode; overly coarse status union; tokens in offer data |
| `src/policy.ts`, `policies/default.json` | Strict schema; 50/500/30 caps; allowlist; human threshold strict greater-than | Framework imports only as required; never turn approval into cap override |
| `src/tollbooth.ts` | Approval before use, same-key replay, input conflict, exact amounts, no pending-as-paid, closed replay, sanitized errors | Memory Promise map, pending money in usedCents, full-session stale writes, process sweep, automatic capture-then-void; replace with DESIGN transactions, reserved cents, fences, alarms |
| `src/store.ts` | Durable result/ledger intent and transaction assertions | `node:sqlite`, local file paths/WAL/BEGIN IMMEDIATE, JSON-only session blob, full scans; use normalized DO SQLite + D1 projections |
| `src/paypal.ts` | Sandbox REST endpoints, OAuth cache expiry, wallet/amount validation, stable request identities, GET reconciliation, 204 void handling | `process.env`/Buffer assumptions, generic sleep/retry loop, unsupported five-hour “safe” window, prepaid create intent. New response schemas and refresh single-flight required. |
| `src/tools.ts` | Two fixture tools, schema validation, fixed prices, synthetic labels, structured tool errors | v1 server transport coupling, shared default call key, implicit order on unpaid call, secret capability in result |
| `src/client.ts` | Policy before spending, real human hooks, trusted approval origin, same-key retry, explicit close separate from disconnect | SDK package/wire adapter, 1.5-second authorize polling, exposed access metadata; add bridge credential injection and bounded status polling |
| `src/server.ts` | Exact host/origin, body limits, no-store for private APIs, sandbox/demo distinction | Express, process timers/listener, memory rate map as authority, global store reads, header admin token on every view |
| `web/` | User concepts: execution, consent, usage, receipt, merchant | Vanilla DOM/CSS implementation; replace with React/Base UI/Community grid |
| `scripts/e2e-sandbox*`, README | Prepare/resume/manual approval and independent PayPal GET assertions; clear mock labels | Node server bootstrap, port 3101, fixed private output path, approval/capability publication, instant-release interpretation |
| Dockerfile / render.yaml / old lockfile | Historical reference only | No port into Worker repo; do not create Docker/Render deployment |

Do not migrate live old sessions into a new DO. Let any old active session finish under its original runtime; redesigned tests create fresh sandbox orders. Import only synthetic/redacted fixtures and rule assertions. Preserve old MIT attribution when reusing code later; choose the new repository license before public release.

## 4. Test strategy and runtime tooling

Use Vitest for pure logic and Cloudflare's Workers integration for actual local DO/D1 semantics. **Current official docs recommend `@cloudflare/vitest-plugin`; `@cloudflare/vitest-pool-workers` is the older integration with a migration guide.** M1 must check compatible Vitest/Vite/Wrangler/Agents versions and pin the resulting lockfile; the official rename guide says its package API/configuration remain unchanged, but imports/types must match the pinned package rather than mixing legacy examples. If a compatible older pool is deliberately retained, document why and run the same behavioral suite. No package was installed in this design task. [Integration](https://developers.cloudflare.com/workers/testing/vitest-integration/), [pool-to-plugin migration](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/).

The documented test APIs include `runInDurableObject`, `runDurableObjectAlarm`, and `evictDurableObject`. Use them according to the selected integration to observe persisted state and force alarm/eviction boundaries. Storage isolation, fake timers, and mocks do not prove deployment CPU or real PayPal behavior. [Test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/).

- Unit: money parsing/formatting without floating billing arithmetic; canonical hashes; strict policy; state transition guards; no secrets in error serializers.
- Workers integration: actual SQLite/D1 migrations and constraints, concurrent reservations, restart/eviction, lease fencing, close barrier, alarm job multiplexing, durable outbox and scans.
- Contract: PayPal schema/status/error fixtures with a controlled fetch stub; modern MCP and legacy ordinary tools through the real handler, schema failures, version headers and authentication.
- Browser: Playwright against built SPA/Worker preview, real UI state and response assertions; no internal-only claim of successful approval or receipt.
- Remote acceptance: actual authorized Free deployment and separate human-approved sandbox E2E; record evidence per build and environment.

### Exact disposition of the existing 57 cases

`T` = `tests/tollbooth.test.ts` (41 expanded cases), `P` = `tests/paypal.test.ts` (8), `M` = `tests/mcp.test.ts` (8). Numbers below follow source order, expanding `it.each` into seven cases. **53 behaviors are retained or rewritten; four prepaid cases are retired and replaced by four explicit AUTHORIZE-only rejection tests.** This keeps all 57 baseline slots accountable; the new safety matrix adds tests beyond that floor. “Port” means preserve the observable assertion, not copy a runtime-specific harness.

| ID | Original test name | Disposition / target suite | Required assertion or deliberate change |
|---|---|---|---|
| T01 | offers 402 before payment | Port: `contract/payment-offer` | Semantic 402 tool error, no literal HTTP 402 requirement. |
| T02 | does not execute or debit before approval | Port: `workers/reservations` | No execute, ledger append, or reservation before authorization. |
| T03 | uses integer cents without rounding drift | Port: `unit/money + workers/ledger` | Twenty 7-cent fixture calls total exactly 140. |
| T04 | replays identical requests without invoking or charging twice | Port: `workers/idempotency` | One execution/ledger row; replay returns stored result. |
| T05 | rejects reuse of key with changed arguments | Port: `workers/idempotency` | Changed canonical input under a key conflicts. |
| T06 | serializes concurrent duplicates and budget reservations | Rewrite: `workers/concurrency` | Concurrent duplicate returns in-progress or stored result; exactly one execution and no overspend. |
| T07 | refuses a call that would exceed budget without invoking | Port: `workers/reservations` | Budget rejection does not invoke handler. |
| T08 | releases reservation on handler failure and rejects ambiguous retries | Rewrite: `workers/call-recovery` | Known failure releases reservation; uncertain failure stays UNKNOWN until safe fixture recovery/review. |
| T09 | fails closed on crash-pending calls and prevents settlement | Rewrite: `workers/eviction` | Unknown unsafe execution blocks settlement; pure fixture recovery requires a new fence. |
| T10 | requires session bearer capability | Rewrite: `workers/auth` | Owner cookie/scoped bearer required; handle alone grants nothing. |
| T11 | rejects invalid budget 0 | Port: `unit/budget + workers/admission` | Reject before order creation; preserve this exact parameter case. |
| T12 | rejects invalid budget -1 | Port: `unit/budget + workers/admission` | Reject before order creation; preserve this exact parameter case. |
| T13 | rejects invalid budget 49 | Port: `unit/budget + workers/admission` | Reject before order creation; preserve this exact parameter case. |
| T14 | rejects invalid budget 501 | Port: `unit/budget + workers/admission` | Reject before order creation; preserve this exact parameter case. |
| T15 | rejects invalid budget 1.5 | Port: `unit/budget + workers/admission` | Reject before order creation; preserve this exact parameter case. |
| T16 | rejects invalid budget NaN | Port: `unit/budget + workers/admission` | Reject before order creation; preserve this exact parameter case. |
| T17 | rejects invalid budget Infinity | Port: `unit/budget + workers/admission` | Reject before order creation; preserve this exact parameter case. |
| T18 | captures once at close, then voids, even under concurrent closes | Rewrite: `workers/settlement` | Concurrent closes yield one final capture; remove unconditional post-capture void expectation. |
| T19 | zero usage voids without capture | Port: `workers/settlement` | Zero usage performs only void; no capture. |
| T20 | retries failed void without recapturing | Rewrite: `workers/settlement-recovery` | Lost zero-use void response reconciles without capture; retry only when eligible with original key. |
| T21 | accepts final-capture release only with verified amount and final flag | Port: `workers/receipt` | FINAL_CAPTURE evidence requires exact amount and final flag, without bank-release promise. |
| T22 | does not claim a release when final capture cannot be verified | Port: `workers/receipt` | Unverified evidence never becomes a paid/final receipt. |
| T23 | pending capture keeps session frozen and ledger unavailable | Rewrite: `workers/settlement` | PENDING freezes new spending; read-only ledger remains visible. |
| T24 | rejects incorrect captured amount | Port: `workers/settlement` | Mismatched capture amount enters review. |
| T25 | prepaid captures budget once and closes with explicit credit, no void | Replace prepaid: `unit/contracts` | AUTHORIZE-only session schema rejects prepaid before storage/payment. |
| T26 | expired session refuses new calls and sweep settles usage | Rewrite: `workers/alarms` | Expired session rejects new calls; alarm settles prior usage. |
| T27 | exhausted budget is settled by sweep | Rewrite: `workers/alarms` | Exhaustion schedules close after pending calls resolve. |
| T28 | reconstructs service from SQLite and preserves idempotency | Rewrite: `workers/eviction` | New DO instance returns durable cached result. |
| T29 | closed session allows only previously completed replay | Port: `workers/idempotency` | Closed completed replay allowed; new key denied. |
| T30 | prepaid pending payment does not activate | Replace prepaid: `workers/activation` | Unexpected prepayment/capture resource cannot activate an AUTHORIZE session. |
| T31 | never logs arbitrary upstream errors | Port: `unit/redaction` | Arbitrary upstream exception contents are never exposed. |
| T32 | requires a human above threshold | Port: `unit/policy` | 35 cents needs human consent under threshold 30. |
| T33 | allows price equal to threshold | Port: `unit/policy` | 30 cents equals threshold, so no extra prompt. |
| T34 | rejects per-call cap regardless of human approval | Port: `unit/policy` | 51 cents exceeds hard per-call cap even if human says yes. |
| T35 | rejects excessive session budget | Port: `unit/policy` | 501-cent budget exceeds session cap. |
| T36 | rejects unknown merchant | Port: `unit/policy` | Unknown merchant rejected. |
| T37 | rejects negative quote | Port: `unit/policy` | Negative quote rejected. |
| T38 | rejects malformed policy file | Port: `unit/policy` | Malformed strict policy rejected. |
| T39 | expired approved order is reconciled and voided after abandoned checkout | Rewrite: `workers/abandoned-approval` | Existing orphan authorization is voided at zero use; approved-only order without authorization creates no new hold. |
| T40 | unapproved expired order becomes expired without capture | Port: `workers/abandoned-approval` | Unapproved expired order closes without capture. |
| T41 | filesystem SQLite survives close and reopen with recorded result | Rewrite: `workers/persistence` | Eviction/restart against persisted DO storage preserves result and cents; add deployed restart proof. |
| P01 | uses sandbox OAuth and caches token without leaking it | Port + extend: `contract/paypal-oauth` | Reuse expiry-based cache; add parallel refresh and token-redaction cases. |
| P02 | retries transient capture with identical key and final_capture true | Rewrite: `contract/paypal-retry` | Same key/body/final flag for eligible retry; ambiguous 503 defaults to reconciliation until retention is proven. |
| P03 | reconciles completed capture from order after lost response, without POST | Port: `contract/paypal-reconcile` | Lost response recovered by GET; no additional capture POST. |
| P04 | will not resend ambiguous capture outside safe idempotency window | Rewrite: `contract/paypal-reconcile` | No unproven five-hour safe window; unknown retention means no automatic ambiguous POST retry. |
| P05 | requires buyer approval before authorize | Port: `contract/paypal-authorize` | Wallet approval required before authorization. |
| P06 | creates wallet-only AUTHORIZE order with stable request id | Port: `contract/paypal-order` | AUTHORIZE, one wallet purchase unit, exact amount and stable request ID. |
| P07 | prepaid fallback uses CAPTURE intent | Replace prepaid: `contract/paypal-order` | Unsupported CAPTURE-intent creation is rejected before network. |
| P08 | void accepts 204 with no invented transaction id | Port: `contract/paypal-void` | 204 body is not parsed; no invented void ID. |
| M01 | real MCP Streamable HTTP adapter handles 402, approval, retry, three calls, replay and close | Rewrite: `contract/mcp + browser/buyer` | Actual handler + adapter: approval, 3 calls, replay, close, 90-cent final capture; modern and legacy lanes. |
| M02 | policy rejects before creating a session or executing MCP tool | Port: `contract/client-policy` | Policy block precedes creation and execution. |
| M03 | human rejection leaves no charge | Port: `contract/client-policy` | Human decline creates no charge/order for that first call. |
| M04 | HTTP session endpoint refuses wrong bearer and foreign origins | Port + extend: `workers/security` | Wrong credential/foreign Origin rejected; add cross-owner and CSRF. |
| M05 | merchant demo view excludes sandbox identifiers | Port: `workers/merchant` | Public demo projection excludes all sandbox identifiers. |
| M06 | MCP schema validation rejects invalid tool input without debiting | Port: `contract/mcp-schema` | Invalid tool input causes no debit/order. |
| M07 | prepaid transport captures once and exposes unused credit | Replace prepaid: `contract/mcp-mode` | MCP/session mode override is rejected; no prepaid balance/credit path. |
| M08 | an unpaid raw MCP call carries session, approval URL, USD offer and bearer capability | Rewrite: `contract/mcp-offer` | Unauthenticated quote has no order or secret; explicit authenticated open returns own approval URL without token in result. |

### New safety matrix (mandatory additions)

| Family | Cases and observable invariant |
|---|---|
| Reservation/close races | Ten unique calls compete for a 50-cent budget; duplicated same key; close during a deferred tool; late success after lease fencing; changed quote/version/key ordering; result persisted before response lost. Assert used+reserved never exceeds approved budget, one result/ledger row, no omitted in-flight cost. |
| Crash boundaries | Evict after D1 registration, before order response storage, after authorize success, after reserve, after execution before finalize, after settlement freeze, after successful capture before local commit, after D1 batch before ACK. Assert recovery uses stored identities and never invents a new charge. |
| Alarm continuity | Two job kinds compete for one alarm; stale scheduling continuation; duplicate alarm; thrown handler; all platform retries exhausted; watchdog restore via scan; no incoming request after browser close. Assert durable due jobs remain discoverable. |
| D1 consistency | Outage before registration, during projection, partial batch failure, out-of-order versions, duplicate delivery, ACK loss, rebuild from index, concurrent admission duplicates/cap boundary. Assert admission fails safely and latest projection cannot regress/double revenue. |
| Provider/webhook | Wrong signatures, wrong webhook ID, foreign merchant/currency, duplicate event ID/different hash, webhook before mapping, reverse order, pending→completed, multiple captures, wrong amount/final flag, expired authorization, revoked credentials. Assert verified ownership and no blind terminal overwrite. |
| Auth/privacy | Cross-owner reads/calls/close, session-ID guessing, expired signed client credential, CSRF, callback-state reuse, Host/Origin mismatch including port/scheme, no credential in tool outputs/logs/static bundle, public demo isolation. |
| Transport compatibility | Modern version/header mismatch, unsupported version, method/name headers, legacy tools/list/call, GET/DELETE 405, JSON tool errors, disconnect without settlement loss, same business key/new JSON-RPC ID. Optional MRTR capability only if implemented. |
| UI and product | Every state in UI.md, reload after pending/complete, stale D1 alongside fresh DO, reserved budget, per-call refusal, zero-use receipt, unknown capture, 390px/keyboard/200% zoom, no Enterprise warnings or license dependency. |
| Cost/abuse | Maximum JSON/result limits, open/day caps, invalid-input load, repeated pending polls, hidden-tab stop, bounded recovery scan/subrequests, DO residency measurements. Assert new-work throttles preserve existing recovery. |

No test may substitute a local ledger's capture ID for independent provider verification. Tests asserting the old unconditional capture→void sequence are rewritten because the new financial contract deliberately chooses final capture OR zero-use void. Keep the safety purpose (single charge and honest release evidence) stronger than before.

## 5. Sandbox E2E revalidation procedure

This is a future procedure, not executed here. The existing `scripts/e2e-sandbox` was read as a reference; do not run its old fixed-path server against the new deployment. Implement explicit prepare/resume/verify phases later, with redacted outputs under a fresh ignored `_runs/YYYY-MM-DD-sandbox/` and private capability files mode 0600.

1. Record the build hash, Worker deployment/environment, selected MCP/Agents/test versions, date/time, and human test operator. Confirm sandbox API base, configured KR merchant, wallet-only checkout, USD, and the exact return/webhook origin. Load external secrets only at runtime with logging off; no environment dump.
2. Prepare a fresh 500-cent AUTHORIZE session through the actual public Worker/adapter. Verify one purchase unit, stable creation key replay, a durable D1 recovery anchor, and the DO alarm. Store access privately; publish only redacted assertions. A wrong budget or provider must fail before PayPal.
3. Human opens the PayPal sandbox wallet link and approves. Do not automate login/credentials. Resume using the same business session; server confirms order and authorization CREATED with exact USD 5.00. Test a second activate call returns existing authorization.
4. Through MCP call `market_lookup(coffee)` (20), `landed_cost(45,KR)` (35), and `landed_cost(45,JP)` (35), respecting the policy prompts. Replay first call with identical key/arguments. DO must contain exactly three successful entries, 90 used cents, zero reserved, 410 available; replay adds zero and no extra execution.
5. Send concurrent close requests; wait for provider confirmation. Independently GET order and enumerate captures: exactly one matching capture. GET capture detail: COMPLETED, USD 0.90, `final_capture:true`, correct authorization/order relationship. GET authorization and record actual returned state. Show unused USD 4.10 separately; do not claim a measured bank release without such evidence.
6. Verify DO receipt and D1 projection converge to the same gross capture; record projection lag. Reload buyer and merchant UI. Screenshot no secrets, buyer emails, or approval URL tokens. No void ID may be invented.
7. Fresh zero-use session: human approval→authorize→close must send no capture and result in verified VOIDED (or confirmed provider expiry if deliberately testing that case). Record the stable void request reference and authorization state.
8. Fresh short-TTL test session: consume one call, close browser, wait conditionally for alarm-triggered settlement. Do not send another application request to cause the settlement; only afterwards inspect evidence/provider GET. Label test TTL, not normal product timeout. Also abandon an approved checkout before application activation and verify no held authorization is left undiscovered.
9. Test duplicate/real signed webhook delivery on the deployment. Register the sandbox webhook only after deployment/account authorization. A simulator payload without the genuine signature path is a separate test, not proof of signature verification. Verify D1 projection retry after an injected temporary failure.
10. Run controlled response-loss tests in the test environment by withholding delivery of a real successful response from the adapter state machine, not by forging provider success. If remote fault injection is not ready, report local crash tests and normal remote E2E separately; do not claim a remote crash gate passed.
11. End every created session; inventory pending/review authorizations. Do not leave a paid capture ambiguous just to finish the test report. Write command/step results, safe provider status facts, totals, and any unresolved recovery tasks. Never commit private credentials or raw `_runs` logs.

Success evidence is split: automated unit/local Worker results; actual deployed CPU/quota results; actual human-approved sandbox resources; actual selected AI host behavior; actual UI screenshots. A partial run is reported as partial. The prior recorded 57 tests and phase-2 PASS are regression references, not proof of the new stack.

## 6. Owner decisions and assumptions

These decisions do not block this documentation task. Ask at the appropriate implementation gate with the concrete option/results ready; do not create accounts or pay to resolve them silently.

| Decision | Proposed default / consequence | Needed by |
|---|---|---|
| Cloudflare account availability and signup | Owner confirms existing account or authorizes signup. Free Worker/DO/D1 feasibility must be measured on that account. | Before remote M1 |
| Deployment and public URL | Owner approves sandbox public endpoint, resources, webhook registration, and later stable judge URL; workers.dev is sufficient, no purchased domain assumed. | Before remote M1 / M6 |
| GitHub public repository and license | Owner selects account/repo and approves MIT license, publication and push. Keep local only until authorized. | M6 |
| Actual AI host / built-in agent | Default: external AI host through tested adapter, browser observes live run and launches scripted rehearsal. Exact host/version and available entitlement to be confirmed; no assumption every connector accepts custom auth. Built-in hosted AI needs provider and budget decision. | M1 choice, M5 proof |
| LLM cost / paid Cloudflare escape | $0 infra target; no assumed free LLM credits. Owner sets any paid-model cap. Only consider Workers Paid after measured Free failure and explicit approval. | Before paid call/upgrade |
| Timing and limits | Proposed 30-min approval, 15-min inactivity, 30-min active hard cap, default 100 sessions/day; old $5/$0.50/$0.30 policy preserved. Owner may adjust UX limits, never invariants. | M2 |
| Judge access and maintenance | Public simulated rehearsal plus genuine sandbox/AI recording; optional controlled sandbox buyer guide, no public operator secret. Confirm who monitors through Dec 16. | M6 |
| Exceptional unresolved payment | Capture idempotency retention remains unproven for some endpoints; default unknown POSTs reconcile/read and then review. Production release timing and arbitrary-tool exactly-once remain out of scope. | M1 contract research; no automatic unsafe fallback |

Before external release, the owner reviews a runnable candidate, sanitized repository diff, measured quotas, access instructions, and video. Authorization is a final step for a concrete result, not a reason to halt ordinary local implementation after a later build task is granted.
