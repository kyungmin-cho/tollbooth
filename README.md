<img src="docs/brand/option-01-raised-barrier.png" alt="Tollbooth raised barrier mark" width="120" />

# Tollbooth

**Your AI agent pays per tool call from one PayPal hold. Approve USD 5, pay USD 0.90 for what it used, and the rest is released.**

Tollbooth is agentic commerce with the person still in charge. You approve one PayPal authorization, which holds the money without charging it. A Workers AI planner picks three paid MCP tools for a research task: a USD 0.20 coffee demand lookup and two USD 0.35 landed-cost estimates for Korea and Japan. Calls above USD 0.30 wait for your OK, and the agent can't approve its own spending. A retry returns the stored result at USD 0.00. When you finish, PayPal captures USD 0.90 once and the other USD 4.10 is never charged. If nothing was used, the authorization is voided.

**[Try the rehearsal, no login](https://tollbooth.arcsolve.workers.dev/run/rehearsal) · [Judge guide](https://tollbooth.arcsolve.workers.dev/judge) · Video: <!-- YouTube URL after upload -->**

Verified in PayPal sandbox on October 19, 2026: capture `2RA569713M861961N` for USD 0.90 after a real Workers AI plan, a voided zero-use authorization `2FC89859D10835132`, and six PayPal-signed webhooks verified before they were applied. Code gate: 177 Vitest and 15 Playwright tests. [Evidence and limits](docs/HARDENING.md)

## How PayPal and AI fit together

1. **PayPal Orders v2, `intent: AUTHORIZE`.** You approve the session limit in your PayPal wallet.
2. **Workers AI (`@cf/zai-org/glm-4.7-flash`)** proposes the tool calls. It never holds a payment credential.
3. **Policy and consent.** A deterministic policy checks price, merchant and budget, and you decide anything above the threshold. When you close the session, Tollbooth sends a single capture with `final_capture: true` for metered usage, or voids the hold if nothing was used.
4. **Verified webhooks.** Every PayPal event must pass `verify-webhook-signature` before it counts. Pending is not paid.

Tool publishers see sessions and charges on a merchant dashboard ([simulated demo](https://tollbooth.arcsolve.workers.dev/demo/merchant)).

## Judge quick-start

1. Open [rehearsal](https://tollbooth.arcsolve.workers.dev/run/rehearsal): run coffee lookup, approve the two estimates, replay coffee, then finish. This is explicitly **simulated**, requires no credentials, and makes no payment or AI inference.
2. Open the [simulated merchant dashboard](https://tollbooth.arcsolve.workers.dev/demo/merchant). Explore the Community grid and filters. Its sample records are separate from your rehearsal.
3. For real sandbox AI + payments, follow [/judge](https://tollbooth.arcsolve.workers.dev/judge). Create your own **Personal sandbox buyer** through [PayPal Developer](https://developer.paypal.com/sandbox-testing/accounts/). Never enter a production buyer password. Open a USD 5 session, ask AI to choose tools, approve the wallet on PayPal, return in the same browser, check authorization, run the saved plan, and finish. Default policy asks before each USD 0.35 call. All three successful calls total USD 0.90. A separately approved session closed without calls voids the hold.

No owner credentials are required for the public rehearsal. Real merchant views require a privately provisioned admin key; the public dashboard is a simulation. Session URLs do not transfer ownership. Judge accounts and test secrets are never published. Real AI has bounded free quotas; if unavailable, the UI explicitly offers scripted tools. Rehearsal remains available.

## Connect an MCP client

Use Streamable HTTP at `https://tollbooth.arcsolve.workers.dev/mcp`. Discovery works without credentials. Modern `2026-07-28` and legacy `2025-11-25` are tested; arbitrary host compatibility is not assumed.

Open [/connect](https://tollbooth.arcsolve.workers.dev/connect) in your browser, explicitly issue a temporary client credential, and configure it as the client's Authorization bearer header. Keep it in the client secret store, never in prompts or source. Paid calls require the [Tollbooth adapter](src/client/adapter.ts), its policy and human-consent callbacks, and stable call metadata (`sessionId`, `callKey`, `maxPriceCents`, `pricingVersion`) under `params._meta.tollbooth`. `tollbooth_open`, `tollbooth_status` and `tollbooth_close` manage the separate business session. A payment-required tool result is not automatic permission to pay. The [contract tests](tests/contract/mcp.test.ts) show both wire lanes.

## Run locally

Node 26.10 and pnpm 12.5.1; dependency versions are locked.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm db:local
pnpm dev
# http://127.0.0.1:8787
pnpm test:browser
pnpm verify:secrets
```

The credential-free rehearsal needs no PayPal keys. Financial tests use synthetic provider responses in real Workers/DO/D1 runtimes. For local real sandbox sessions, create ignored `.dev.vars` with `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_ID`, and an independently generated `OWNER_TOKEN_SIGNING_KEY` (at least 32 characters); chmod 0600. Optional merchant access needs independent `MERCHANT_ADMIN_TOKEN` and `MERCHANT_COOKIE_SIGNING_KEY`. Webhooks additionally need a registered `PAYPAL_WEBHOOK_ID`. Never use `VITE_*` for secrets. See [sandbox instructions](docs/M5.md#sandbox-driver) and [webhook setup](docs/M2-M3.md#webhook-registration). Local Playwright uses port 8790 and synthetic provider/model fixtures; it creates no real orders.

## Architecture and money safety

```text
Buyer / AI host → policy + human consent → Agents SDK createMcpHandler
                                      → SQLite Session Durable Object
                                      → PayPal Orders v2 AUTHORIZE → capture / void
                                             ↓ verified webhooks
Session DO → durable outbox → D1 projections → merchant dashboard
```

One Cloudflare Worker serves Vite/React assets and stateless MCP. Each session has a SQLite Durable Object; D1 handles admission, recovery anchors and projections. Workers AI uses `@cf/zai-org/glm-4.7-flash` for tool selection. UI: Tailwind, shadcn Base UI and AG Grid Community.

- Integer cents and server-owned prices; atomic reservation before execution.
- Immutable call fingerprints and one usage entry per successful call key; replay adds no charge.
- Closing prevents new reservations and waits for in-flight work.
- One immutable settlement: explicit positive amount with `final_capture:true`, or zero-use void.
- Unknown provider outcomes reconcile existing identities; they do not create a new capture.
- Durable alarms, outbox and recovery scans survive browser closure. D1 is never spending authority.
- PayPal `verify-webhook-signature` must return SUCCESS before durable ingress. Approval redirects alone are not authorization; pending is not paid.

## Deployment (operator only)

The checked-in remote config targets Worker `tollbooth` and the existing D1 `tollbooth-m1`; it is **not** a generic deploy target for judges. No deployment is needed to evaluate the public demo. Authorized operators confirm `pnpm exec wrangler whoami`, build, apply D1 migrations with `pnpm exec wrangler d1 migrations apply tollbooth-m1 --remote --config wrangler.remote.jsonc`, supply secrets only via `wrangler secret put <NAME> --config wrangler.remote.jsonc`, and deploy with `pnpm exec wrangler deploy --config wrangler.remote.jsonc`. A different installation must first configure its own account/resources/origin and AI binding. Never deploy to the supplied account without permission.

## Evidence and limits

As of October 19: 177 Vitest tests and 15 Playwright tests passed. The deployed real AI run captured USD 0.90 once; a zero-use authorization was voided. Six genuine sandbox webhooks were verified and applied. Redelivery deduplication is covered by runtime tests. After the address move, a genuine resend reached the new webhook endpoint with HTTP 200 and unchanged durable ingress; payload-free tail evidence does not reconstruct the deleted old DO inbox.

Sandbox only, USD, one merchant, synthetic tool data and a fixed research mission. No production readiness or generic agent compatibility claim. Free-plan CPU is tight: final sampled requests reached 10 ms; earlier samples reached 11/15 ms and tail omits some requests. Daily AI/session quotas can restrict real judging; local tests and public rehearsal are alternatives, not proof of live inference. Unused budget is not charged, but payment-method holds may take time to update. [Detailed evidence and limitations](docs/HARDENING.md).

[Design](docs/DESIGN.md) · [UI](docs/UI.md) · [Plan](docs/PLAN.md) · [MIT license](LICENSE) · [Third-party notices](THIRD_PARTY.md)

Address transition: the former Worker was deleted on October 19, 2026 after its eight sessions settled; its DO data is gone, while D1 retains historical rows. The competing cron/recovery actors are no longer present. The account subdomain is now `arcsolve`, and the existing PayPal webhook registration points to `https://tollbooth.arcsolve.workers.dev/webhooks/paypal` with its ID unchanged. D1 `tollbooth-m1` and PLAN_KV are retained. Historical D1 rows are not migrated DO sessions. See [address transition](docs/ADDRESS.md).
