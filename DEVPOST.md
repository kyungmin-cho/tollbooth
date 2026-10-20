# Tollbooth

**Tagline:** Your AI agent pays per tool call from one PayPal hold. Approve USD 5, pay USD 0.90 for what it used, and the rest is released.

**Demo:** https://tollbooth.arcsolve.workers.dev (start at `/judge`; the rehearsal needs no login)

**Repository:** https://github.com/kyungmin-cho/tollbooth (MIT)

**Video:** <YouTube URL — insert after upload>

## Inspiration

Picture someone who sells coffee online and wants to know whether a USD 45 item is worth shipping to Korea or Japan. They ask an AI agent. To answer, the agent needs a paid demand lookup and two paid landed-cost estimates: three tool calls, USD 0.90 in total.

Handing the agent a card number doesn't settle much. Who set the limit? Who said yes to the bigger calls? If a request retries, does it get paid twice? Agentic commerce needs an agent that can spend real money while the person stays in control, and PayPal already has the pieces for that. Tollbooth is our PayPal + AI answer: it puts those pieces in front of paid MCP tools.

## What it does

The person approves one PayPal authorization of USD 5. Nothing is charged yet; it's a hold.

The agent then works inside that hold. Workers AI picks the three tools for the task, and each successful call is metered: USD 0.20 for the coffee demand lookup, USD 0.35 for each landed-cost estimate. The policy asks the person before any call above USD 0.30 and blocks anything above USD 0.50. The agent can't approve its own spending. If it retries a call, Tollbooth returns the stored result and adds USD 0.00.

When the person finishes, Tollbooth captures USD 0.90 once on PayPal and the other USD 4.10 is never charged. A session that used nothing has its authorization voided. The person gets a receipt.

## How we built it

We built it around the PayPal flow, in the order money moves.

1. **Hold.** Orders v2 with `intent: AUTHORIZE`. The buyer approves the session limit in their PayPal wallet. The hold is the ceiling the buyer agreed to, and Tollbooth only ever captures metered usage. A browser redirect back from PayPal doesn't count as approval; Tollbooth checks the authorization with PayPal first.
2. **Consent.** Before a call above the threshold runs, the buyer sees its price and says yes or no in the app.
3. **Capture or void.** Closing a session sends a single capture with `final_capture: true` for the exact usage, or a void when there was none. If PayPal's answer is lost, Tollbooth reconciles against the existing order and never issues a second capture.
4. **Verified webhooks.** Every PayPal event goes through `verify-webhook-signature` and must return SUCCESS before it enters the session's durable inbox. A pending capture is not shown as paid.

The AI side is Workers AI running `@cf/zai-org/glm-4.7-flash`. It reads the tool catalog and the task, then proposes calls in one bounded planning round. It never holds a payment credential. A deterministic policy checks price, merchant and budget, and the human decides above the threshold. The MCP adapter executes only schema-valid, policy-approved calls with stable replay identities. Daily quotas and token limits cap inference, and when the model is unavailable the UI says so and offers scripted tools. MCP clients connect over Streamable HTTP at `/mcp`; our contract tests cover protocol versions `2026-07-28` and `2025-11-25`.

All of this runs in one Cloudflare Worker written in TypeScript. The Agents SDK `createMcpHandler` serves stateless MCP, and each payment session lives in its own SQLite Durable Object. Prices are integer cents set by the server, and each call reserves budget before it runs. Ledger rows reach D1 through a durable outbox, and alarms plus recovery scans finish settlement even if the browser closes. The UI uses Vite, React, Tailwind and shadcn Base UI.

AI coding assistants helped with implementation and tests. The logo concepts were AI-generated; we redrew the chosen mark by hand as SVG.

## Impact

For the buyer the numbers are small and exact. They approve USD 5, pay USD 0.90, and the remaining USD 4.10 is never charged. A retried call costs nothing extra, and the agent can't go past the hold or skip the questions above USD 0.30.

The tool publisher gets a way to sell a 20-cent lookup to an agent. Three small calls end up as one PayPal capture at the end of the session rather than three separate payments, and the publisher can see each session and charge on a dashboard.

## Innovation

Approval gates and spending limits for agents already exist. Tollbooth's addition is the shape of the money: the buyer approves a limit once in PayPal, the agent makes many small paid calls under it, and PayPal settles one exact amount at the end.

PayPal's Agent Toolkit covers orders, invoices, subscriptions and refunds. When we checked its tool list on October 17, 2026, it had no tool for authorizing a hold or voiding one. Tollbooth builds that piece itself and uses the hold as the session limit for per-call pricing.

Consent is per call and only above a threshold. In this task the person is asked twice, for the two USD 0.35 estimates, and the USD 0.20 lookup runs on its own.

## Design

There are two screens. The buyer workspace shows the approved limit, accrued and reserved amounts, a call ledger and the consent dialog, and closing it gives a receipt. The merchant view lists sessions and charges in an AG Grid Community table, including pending and reconciling states. Every rehearsal screen carries a "simulated" label so nobody mistakes it for a live payment.

## Challenges

A Durable Object doesn't stay locked across a network await, so we needed leases, a closing barrier and reserved cents to stop a late call from slipping in after "finish". PayPal can complete a payment before every GET view agrees, which meant polling authoritative state without ever repeating a capture.

## Accomplishments

On October 19, 2026 we ran the real path in PayPal sandbox. The Workers AI plan executed three calls plus a free replay, and PayPal recorded one capture, `2RA569713M861961N`, for USD 0.90. A separate zero-use session's authorization, `2FC89859D10835132`, was voided. Six genuine sandbox webhooks (CHECKOUT.ORDER.APPROVED ×2, PAYMENT.AUTHORIZATION.CREATED ×2, PAYMENT.CAPTURE.COMPLETED ×1, PAYMENT.AUTHORIZATION.VOIDED ×1) passed signature verification and were applied.

The code gate is 182 Vitest tests and 15 Playwright tests. Two load batches on the free plan each completed 300 reads at concurrency 20 with zero errors.

These are sandbox results. We don't claim production readiness. The video labels every shot: a screenshot of the live sandbox site with a real Workers AI plan, the simulated rehearsal, and cards carrying the real sandbox results.

## What we learned

An AI plan, a human's consent, a tool result and a PayPal settlement are four separate decisions. Once each had its own identity and its own evidence, retries stopped being scary and the interface got simpler.

## What's next

First, webhook redelivery. After we moved the webhook address, a PayPal resend reached the new endpoint with HTTP 200 and durable ingress stayed unchanged. We matched that request by timing, because our logs leave out payloads and event IDs. In runtime tests we send the same event three times, one after another and at once, and the session changes once: one inbox entry, one capture, no new ledger entry. We haven't yet confirmed that end to end against a live redelivery.

After that: more tools in the catalog, compatibility tests with MCP hosts, more cold-start CPU headroom, and conversations with tool publishers. The current scope is sandbox-only, USD, one merchant and one fixed research task.

## Built with

PayPal Orders v2 (AUTHORIZE, capture, void) · PayPal Webhooks (verify-webhook-signature) · Workers AI (GLM-4.7-Flash) · Model Context Protocol · Cloudflare Workers, SQLite Durable Objects, D1 · Cloudflare Agents SDK · TypeScript · Vite · React · Tailwind CSS · shadcn/ui (Base UI) · AG Grid Community · Zod · Vitest · Playwright · Wrangler · pnpm

## Testing instructions for judges

**No login:** open https://tollbooth.arcsolve.workers.dev/run/rehearsal and run the coffee lookup, allow the two USD 0.35 estimates, replay coffee and finish. You'll see USD 0.90 settled and USD 4.10 unused. The rehearsal is simulated and makes no payment or AI call. `/demo/merchant` shows the publisher view with sample data.

**Real PayPal sandbox and real AI:** follow `/judge`. Create your own Personal sandbox buyer in PayPal Developer, and never use a real buyer password. Open a USD 5 session, ask the AI to choose tools, approve the wallet on PayPal, come back in the same browser, check authorization, run the plan and finish. Expect one USD 0.90 capture after three calls. Free AI and session quotas can pause real runs; the rehearsal stays available. Setup and MCP client instructions are in the README.
