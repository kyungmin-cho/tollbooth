# Tollbooth agent rules

Explain causes plainly and ask focused questions when a product decision is genuinely unclear. Report work and verification to the owner in Korean; keep product documentation and user-facing demo copy in English.

## Authority and scope

- This initial repository is DESIGN ONLY. Do not implement, install dependencies, provision resources, deploy, create accounts, add remotes, or push until a subsequent task authorizes that work.
- Read `docs/DESIGN.md`, `docs/PLAN.md`, and applicable ADRs before implementation. Update the contract and tests before changing a financial invariant. A future code task authorizes ordinary local work within its scope, not unrelated publication or spending.
- Work only in this repository and specifically authorized evidence locations. Preserve concurrent changes and the original `../paypal-ai-hackathon/app` baseline. Do not copy private `_runs` artifacts into Git.
- Cloudflare signup, GitHub publication, deployment, paid-plan changes, LLM spending, and competition submission need the owner's explicit authorization. Do not repeatedly ask for authorization already granted in that session.

## Secrets and trust

- Never read or reproduce secret values for documentation. `~/.config/paypal-hackathon/sandbox.env` is an external runtime source, not a file to copy or commit. Future sandbox tests may load it only under test authorization without printing it.
- Deploy secrets through `wrangler secret`; never through `VITE_*`, source files, URLs, logs, screenshots, LLM messages, or public build variables. Redact session/client/merchant tokens as well as PayPal credentials.
- Sandbox, one configured merchant, PayPal wallet, AUTHORIZE, USD only. No automatic production/prepaid fallback.

## Financial invariants

- Integer cents; server-owned versioned prices. Atomic reservation before execution, immutable call fingerprint, and one successful usage entry per call key.
- A DO is not a mutex across network awaits. Use persistent state, short local transactions, leases/fences, and a closing barrier.
- One immutable settlement per session; capture positive usage with explicit amount and `final_capture:true`, or void zero usage. Unknown outcomes require reconciliation, never a new capture key.
- D1 is not the spending authority. Keep durable outbox and recovery anchors. Do not rely on browser lifetime, `waitUntil`, or a memory timer for settlement.
- Approval redirect is not authorization. Pending capture is not a paid receipt. Unused budget is not a guaranteed immediate refund.

## Tests and evidence

- Implement every retained/rewritten baseline test in the PLAN mapping, including the replacement tests for removed prepaid behavior. Do not weaken assertions to fit a port.
- Use Vitest plus the compatible Cloudflare Workers integration for DO/D1/alarm tests; verify the current plugin versus older pool package before pinning. Add real deployed CPU and sandbox acceptance evidence separately.
- Exercise simultaneous calls, close/execute races, eviction, lost responses, webhook reordering, and outbox replay. Assert observable money, execution counts, and provider resources.
- Label mock, recorded baseline, local-runtime, deployed-runtime, and real sandbox results separately. Never call an unexecuted or blocked gate passed.
- UI must use the Base UI variant of shadcn/ui and AG Grid Community only. No required Enterprise/Studio trial feature.
- Before any commit, review the exact file set, whitespace, links, secret-pattern findings, and test results appropriate to the change. This documentation-only phase requires document consistency checks, not app execution.
