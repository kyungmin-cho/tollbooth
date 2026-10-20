# Tollbooth demo video (v3)

1920×1080, 60 fps, H.264, 2:29 (148.8 s), silent. All on-screen text is English. The video file itself is not stored in this repository.

The first 30 seconds are a cold open that shows the whole result: your AI agent plans paid tool calls, you approve a USD 5 PayPal hold, the agent makes three calls, PayPal captures USD 0.90 once, and the real sandbox run's signed webhooks are verified. The full walkthrough follows, so the repeat is deliberate. Cloudflare only appears near the end, in the architecture scene.

## What the footage is

Each footage scene carries one of these badges in the top-right corner. The logo, architecture and end-card graphics have none.

- **Real UI · live sandbox site · Oct 18, 2026.** A screenshot of the deployed workspace from October 18, 2026: a real Workers AI plan (`@cf/zai-org/glm-4.7-flash`) saved for a sandbox session that was still waiting for PayPal approval. The truncated session reference is masked.
- **Real UI · live site in sandbox mode.** The public landing page and its spending policy.
- **Approval step · recreated from the app.** The approval card and the USD 5.00 hold bar, rebuilt with the app's own labels.
- **Simulated rehearsal · no real money.** Screens from the credential-free `/run/rehearsal` flow.
- **Verified in PayPal sandbox · Oct 19, 2026.** Motion-graphic cards with the real numbers from the October 19 sandbox run. They are not screen recordings.
- **Simulated merchant dashboard · sample data.** `/demo/merchant`.

No PayPal-hosted page is shown: the buyer's approval on PayPal needs a sandbox login, so we didn't record it. The only IDs on screen are capture `2RA569713M861961N` and voided authorization `2FC89859D10835132`. Order IDs, webhook event IDs, emails, tokens and approval URLs never appear.

## Scenes

| # | Time | What is shown | On-screen text |
|---|---|---|---|
| 1 | 0:00–0:04 | Real screenshot: "Let AI choose the tools" with the saved Workers AI plan. The three calls are ringed; the greyed "Run AI plan through MCP" button is tagged. | "Your AI agent wants three paid tool calls." · "Real Workers AI plan · market_lookup USD 0.20 · landed_cost USD 0.35 × 2" · "Locked until you approve a budget" |
| 2 | 0:04–0:09 | Same screenshot, panned down to "Approve a limit of USD 5.00". The "You" cursor clicks "Approve with PayPal ↗". | "First, you approve USD 5 once, in PayPal." · "The agent can't approve its own budget." |
| 3 | 0:09–0:12 | The approval becomes a USD 5.00 AUTHORIZE hold bar. | "A hold, not a charge." · "PayPal · AUTHORIZE · Hold for this session · USD 5.00" |
| 4 | 0:12–0:15 | Rehearsal: the AI-agent cursor runs the coffee lookup and ledger row 1 appears. | "Call 1 · metered · market_lookup · USD 0.20" |
| 5 | 0:15–0:19 | The Korea estimate stops at the consent dialog and you click "Allow this call". | "USD 0.35 call → you decide" · "The agent cannot approve its own spending." |
| 6 | 0:19–0:21 | The ledger after the Japan call. | "3 successful calls · Total accrued USD 0.90" |
| 7 | 0:21–0:25 | The hold bar splits into the captured and released parts. | "PayPal captures USD 0.90, once." · "Captured USD 0.90 · 1 capture · final_capture: true" · "Released USD 4.10 · never charged" |
| 8 | 0:25–0:30 | Real sandbox proof: the capture line above the webhook panel, which counts up to 6/6. | "Real run in PayPal sandbox · Oct 19, 2026 · Capture 2RA569713M861961N · USD 0.90 · COMPLETED" · "Signed by PayPal · verified · applied" |
| 9 | 0:30–0:37 | The Tollbooth mark forms, the lockup appears and flies into the site header. | "Tollbooth" · "Your AI agent pays per tool call from one PayPal hold." · "PayPal Orders v2 · AUTHORIZE → capture / void" · "Workers AI planner" · "MCP tools" |
| 10 | 0:37–0:51 | Live landing page: the session budget, then each Policy JSON line. | "USD 5.00, at most" · "No call above USD 0.50" · "USD 5.00 for the session" · "Above USD 0.30, ask me" · "Pay tollbooth.demo only" |
| 11 | 0:51–0:58 | "Open session → PayPal approval" turns into the approval card; you approve; it becomes the hold bar. | "Approve a limit of USD 5.00" · "A hold, not a charge." |
| 12 | 0:58–1:08 | The hold becomes the Approved limit card. The agent runs the coffee lookup; Accrued and Available update. | "Approved limit: USD 5.00" · "market_lookup · USD 0.20" · "Accrued 0.20 · Available 4.80" |
| 13 | 1:08–1:22 | Korea and Japan estimates, each with your consent. | "USD 0.35 call → you decide" · "Consent covers this one call only." · "Total accrued USD 0.90" |
| 14 | 1:22–1:32 | The agent replays call 1. | "Stored result · +USD 0.00" · "Still 3 entries · USD 0.90" |
| 15 | 1:32–1:47 | Finish, settle, receipt rows. | "USD 0.90 settles once" · "Captured USD 0.90" · "USD 4.10 never charged" · "FINAL_CAPTURE" |
| 16 | 1:47–1:56 | Zero-use receipt from the rehearsal. | "No calls → hold voided" · "VOIDED" |
| 17 | 1:56–2:12 | Sandbox evidence: Workers AI plan, the capture, the zero-use void, then the six webhooks. | "Then we ran it for real." · "Capture ID 2RA569713M861961N" · "Authorization 2FC89859D10835132" · "6/6" · "PayPal verify-webhook-signature must return SUCCESS before an event enters the session's durable inbox." |
| 18 | 2:12–2:16 | `/demo/merchant`, gross captured card. | "Tool publishers see every charge" · "Gross captured USD 0.90" |
| 19 | 2:16–2:21 | Architecture: AI agent → Tollbooth Worker → Session Durable Object → PayPal Orders v2, with PayPal webhooks, D1 and the merchant dashboard. | "One Cloudflare Worker · one Durable Object per session · integer cents · idempotent call keys" |
| 20 | 2:21–2:29 | End card. | "Your AI agent pays per tool call from one PayPal hold." · "Try it now — no login needed" · tollbooth.arcsolve.workers.dev · /run/rehearsal · /demo/merchant · /judge · github.com/kyungmin-cho/tollbooth · "PayPal sandbox only · no real money · Built for the PayPal AI Hackathon" |

## Notes

- The video is silent, so each highlighted element stays on screen for about two seconds. The cold open is tighter; check its pace when you play it back.
- PayPal, Cloudflare and AG Grid appear as text only. No third-party logos are used.
- Webhook redelivery deduplication is not claimed. That live check is still open (see [docs/HARDENING.md](docs/HARDENING.md)).
- The film is built from the screenshots above with a time-based HTML timeline, rendered through Playwright and ffmpeg. That build folder lives outside this repository. Uploading to YouTube and submitting need separate owner approval.
