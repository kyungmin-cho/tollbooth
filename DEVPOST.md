# Tollbooth

**Tagline:** Human-approved budgets for paid AI tools.

**Demo:** https://tollbooth.arcsolve.workers.dev

**Repository / public YouTube URL:** Pending owner-approved publication. This file is a local submission draft, not a submitted entry.

## Inspiration

A useful AI agent may need a paid lookup or calculation. Giving it a payment credential does not answer who approved the spend, what happens when a request retries, or how to settle after a crash. We built Tollbooth for tool publishers and people using agents: approve a budget, meter successful calls, and settle the actual usage.

## What it does

A buyer approves a PayPal sandbox wallet limit. A Workers AI model selects three MCP tools for a fixed market-and-shipping research task. A deterministic policy checks the proposed prices, merchant and budget; the human approves calls above the threshold. The model never holds a payment credential or overrides policy.

The workspace shows accrued and reserved amounts, a call ledger and a receipt. Closing captures successful usage once, or voids a zero-use authorization. Merchants can inspect sessions and charges through an AG Grid Community dashboard. Credential-free rehearsal and a separate simulated dashboard let anyone explore the experience without a PayPal login.

## How we built it

TypeScript runs in one Cloudflare Worker. The Agents SDK createMcpHandler serves stateless MCP, while a SQLite Durable Object owns each payment session. Atomic reservations and persistent operation identities separate execution from settlement. A durable outbox projects data into D1; alarms and recovery scans do not depend on the browser remaining open.

PayPal Orders v2 uses AUTHORIZE, followed by an explicit final capture or void. Webhooks call PayPal's verify-webhook-signature API before entering the durable inbox. Vite, React, Tailwind and shadcn Base UI provide the buyer screens; AG Grid Community handles merchant grids.

The actual AI model is Workers AI `@cf/zai-org/glm-4.7-flash`. It chooses tools from the catalog for one bounded planning round. The existing MCP adapter executes only schema-valid, policy-approved calls with stable replay identities. Daily quotas and token limits bound inference; unavailable AI is labeled as scripted fallback. AI coding assistance helped implementation and tests; the supplied logo concepts were AI-generated and the chosen mark was manually redrawn as SVG.

## Challenges

A Durable Object is not a lock across a network await. We needed leases, fences, reserved cents and a closing barrier. PayPal can complete a payment before every GET view converges, so verification polls authoritative state without repeating a capture. A stale dashboard must not become spending authority. Free-plan cold CPU also required moving immutable schema work to startup and simplifying discovery.

## Accomplishments

The local gate passed 177 unit/Workers/contract tests and 15 browser tests. A deployed run executed the saved real AI plan: three successful calls, a free replay and one USD 0.90 capture. A separate zero-use session voided its authorization. Six genuine sandbox webhook events passed verification and reached the session inboxes. Two modest free-endpoint load batches completed 600 reads with no errors.

These are sandbox results, not production claims. The video demonstrates the public simulated experience and labels the separately verified real-run results.

## What we learned

Reliable payment behavior comes from identities that survive retries and evidence that distinguishes pending from complete. An AI plan, human consent, a tool result and payment settlement are different decisions. Making those boundaries visible improved both recovery and the interface.

## What's next

Observe a genuine webhook redelivery and confirm deduplication end-to-end: our runtime tests pass, but a live resend was accepted without observed arrival in the ten-minute window. Expand the tool catalog and host compatibility tests, increase cold-start CPU headroom, and validate merchant demand before pursuing production payments. Current limits are sandbox-only, USD, one merchant and a fixed AI task.

## Built with

PayPal Orders v2; PayPal Webhooks; Cloudflare Workers, SQLite Durable Objects, D1 and Workers AI; GLM-4.7-Flash; Cloudflare Agents SDK; Model Context Protocol; TypeScript; Vite; React; Tailwind CSS; shadcn/ui (Base UI); AG Grid Community; Zod; Vitest; Playwright; Wrangler; pnpm.

## Testing instructions for judges

Start at `/judge` on the demo domain. `/run/rehearsal` and `/demo/merchant` are credential-free and explicitly simulated. Real payments require your own Personal PayPal sandbox buyer account; create one through PayPal Developer Sandbox Accounts. Open a USD 5 session, request the AI plan, approve the wallet, return to the same browser, check authorization, approve the two above-threshold calls, and finish. Expect USD 0.90 after three calls. Never use a real buyer password. The README includes setup and MCP instructions. Owner credentials are not public. Free quotas can pause real runs; rehearsal and fixture-based local tests remain available.

## Owner-only submission decisions (remove from submitted description)

Choose the public repository host/name and authorize publication. Upload the reviewed video publicly to YouTube and insert its URL. Confirm eligibility, entrant/team identity, contact details, source/brand rights, any pre-existing baseline disclosure, and whether to enter the AG Grid sponsor category. Keep the demo available throughout judging; resolve real-run quota/access constraints before submission. The authenticated form's additional fields must be reviewed by the owner; no form was opened or submitted here.

## 사장님 요약 — 제출 본문에서 제외

AI가 유료 MCP 도구를 고르되 정책·사람 동의·원자 예약으로 지출을 제한하고 PayPal 승인 후 실제 사용액만 한 번 정산하는 제품입니다. 실제 AI 90센트 capture·0사용 void·서명 웹훅 6건은 통과했습니다. 영상은 공개 시뮬레이션이며 실결제 영상으로 가장하지 않습니다. 공개 저장소/YouTube 업로드/Devpost 제출은 아직 하지 않았습니다. 재전송 실증, Free CPU 여유, 심사 기간의 실제 실행 한도와 접근성은 남은 검토 항목입니다.
