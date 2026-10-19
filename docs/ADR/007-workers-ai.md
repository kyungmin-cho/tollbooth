# ADR 007 — Bounded Workers AI planner and explicit MCP execution

- Date: 2026-10-18
- Status: Accepted by the owner's M5 authorization; supersedes the external-host-only default.

Use the existing Workers Free account's AI binding with `@cf/zai-org/glm-4.7-flash`. Its current catalog explicitly supports function calling and Free access. Several older Llama model routes now report unavailable, so they are not deployment assumptions. No AI Gateway, prepaid credit, paid API key, or automatic model fallback is configured.

A fixed public mission asks the model to choose coffee demand and USD 45 landed-cost calls for KR/JP from the same versioned schemas used by MCP. The model supplies names, arguments, and ordering. Validate all three; never replace an invalid answer with a claimed AI result. This is a one-round tool planner, not an open-ended conversational agent or a model-generated financial adviser.

Before inference, D1 atomically reserves one nonrefundable run per financial session, up to 20 per UTC day globally and three per owner/day. Input is fixed, under 4 KiB serialized, with no user/private context; reserve 8,192 input tokens conservatively for formatting overhead. Output is capped at 768 completion tokens, including reasoning; thinking is disabled. At documented 5,500 input and 36,400 output neurons per million tokens, the conservative application budget is 1,460.22 neurons/day, below 70% of the 10,000 allocation. This is an estimate, not provider usage accounting. The Free account's provider-enforced daily cutoff is the final no-overage barrier, including other account workloads. Do not enable Paid without revisiting this contract.

PENDING is committed before the network call. Retries read the saved plan and never re-infer. After 90 seconds an interrupted pending run becomes explicit FALLBACK; late results cannot replace it. A crash may lose an AI result and consume a slot; it cannot spend or infer twice. A model/provider/quota error offers labeled scripted tools and a credential-free rehearsal. No fallback executes automatically.

The browser uses TollboothClient 0.1.0 and pinned MCP client 2.3.1, discovers the actual catalog, restores the owned session, and applies the existing deterministic policy before every call. Stable `ai-v1-N` keys survive reload/retry; DO fingerprints guard argument changes. Above-threshold calls require a real dialog response. Replays skip new consent only after authoritative ledger evidence and still pass policy and DO fingerprint checks. Credentials stay in memory, outside model context. Disconnect leaves durable settlement alarms intact; close is explicit.

Sources checked 2026-10-18: [model](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/), [pricing and Free cutoff](https://developers.cloudflare.com/workers-ai/platform/pricing/), [errors](https://developers.cloudflare.com/workers-ai/platform/errors/), [Free-supported models](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/).
