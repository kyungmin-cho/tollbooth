# M1 authorized remote preparation

The owner authorized deployment on 2026-10-18 at 19:47 KST to account `8fb5f047b64293ae01e681d28c503798` only. `wrangler whoami` matched the specified account before provisioning. The owner identified it as Workers Free; no subscription or plan change was made. Subscription-list access with the existing OAuth token returned 403, so that API did not independently attest billing status.

## Resources and configuration

At M1, the configuration pinned that account and the former Worker `tollbooth-m1` (deleted on 2026-10-19), D1 `tollbooth-m1` (`33319057-6712-4276-bf92-8727589c68fb`), and the existing SQLite `SessionDO` class. The current target is `https://tollbooth.arcsolve.workers.dev`; the M1 measurements below belong to the former Worker. The D1 admission migration was applied remotely. The namespace API confirmed `use_sqlite: true`; two real remote sessions subsequently used that storage. No custom domain or webhook was registered.

The local config/database remains separate. `pnpm sandbox:setup --remote` creates the ignored mode-0600 `.dev.vars.remote` from the authorized sandbox source, with an independent signing key. `pnpm exec wrangler secret bulk .dev.vars.remote --config wrangler.remote.jsonc` uploads the four server secrets. Secret values never enter the config, frontend, command arguments or evidence. The repository secret scan checks both runtime files. Recreating a signing key would invalidate existing client access; preserve the file for resume.

Deployment uses `pnpm build` followed by `pnpm exec wrangler deploy --config wrangler.remote.jsonc`. Confirm `wrangler whoami` before future deployment. The configured `APP_ORIGIN` supplies the wallet return/cancel URLs; a contract test checks both. PayPal's independent order GET did not echo those callback fields, so the callback-origin evidence is the tested request construction plus deployed configuration. Query-string redaction is enabled for invocation logs before buyer redirects occur.

## Preparation and resume

The driver accepts loopback HTTP or exactly the configured HTTPS deployment. It requires an explicit remote evidence directory and binds private state to its origin; local or other-origin sessions cannot be reused remotely. The two remote order IDs, private approval URL files, exact KST deadlines and current statuses belong only in the owner's private evidence folder.

Run from the repository root:

```sh
export TOLLBOOTH_REMOTE_ORIGIN=https://tollbooth.arcsolve.workers.dev
export TOLLBOOTH_REMOTE_EVIDENCE=../paypal-ai-hackathon/_runs/2026-10-18-m1-remote
# Already prepared; these commands preserve the existing creation/session identities.
pnpm sandbox --prepare --origin "$TOLLBOOTH_REMOTE_ORIGIN" --evidence "$TOLLBOOTH_REMOTE_EVIDENCE"
pnpm sandbox --prepare --zero-use --origin "$TOLLBOOTH_REMOTE_ORIGIN" --evidence "$TOLLBOOTH_REMOTE_EVIDENCE"
# Stop for the owner's separate wallet approvals; do not approve automatically.
# After those approvals, start the sanitized tail collector in another terminal:
node scripts/verify/tail-metrics.mjs --evidence "$TOLLBOOTH_REMOTE_EVIDENCE"
# Then run the fixed three calls + free replay + final capture, and the separate zero-use void:
pnpm sandbox --resume --approve-fixture-calls --origin "$TOLLBOOTH_REMOTE_ORIGIN" --evidence "$TOLLBOOTH_REMOTE_EVIDENCE"
pnpm sandbox --resume --zero-use --origin "$TOLLBOOTH_REMOTE_ORIGIN" --evidence "$TOLLBOOTH_REMOTE_EVIDENCE"
pnpm sandbox --verify --origin "$TOLLBOOTH_REMOTE_ORIGIN" --evidence "$TOLLBOOTH_REMOTE_EVIDENCE"
pnpm sandbox --verify --zero-use --origin "$TOLLBOOTH_REMOTE_ORIGIN" --evidence "$TOLLBOOTH_REMOTE_EVIDENCE"
```

The explicit fixture flag replaces the two interactive `yes` prompts; it does not approve a wallet. Approval expires 30 minutes after session creation. An expired session must be inspected before any separately authorized replacement; neither deadlines nor creation keys are silently changed. Remote filenames are `approve-url-remote.txt` and `zero-approve-url-remote.txt`. Existing local orders and evidence are unaffected.

## Verification and measurement boundaries

`node scripts/verify/remote-smoke.mjs --evidence "$TOLLBOOTH_REMOTE_EVIDENCE"` checks deployed SPA 200, invalid bearer 401, modern 2026-07-28 and legacy 2025-11-25 tool discovery and structured payment-required responses. It opens no session. Separate checks against the prepared sessions confirmed the existing approval URL and unchanged zero usage on both lanes. Local tests passed 101 cases, with typecheck, lint and build passing; local mocked-provider tests remain distinct from remote evidence.

The sanitized collector runs `wrangler tail --format json` and retains numeric `cpuTime`/`wallTime`, allowlisted measurement labels, RPC method/class and sanitized paths. It discards headers, query strings, logs, exception contents and object IDs. Client elapsed time in `request-timings.jsonl` is network-inclusive latency, never CPU. Live tail may omit or delay records; legacy SSE CPU samples were also obtained by draining the complete response body. The initial collector omitted RPC method/class, so the two 11/14-ms non-fetch records during session creation remain separately identified as incompletely classified traces, not ordinary Worker requests.

Captured Worker samples before approval: modern tools/list CPU 1–10 ms (15 labelled records, including the final redeployment smoke), legacy tools/list CPU 1–4 ms (6 drained-response records), session open CPU 4/5 ms with wall time 4496/2842 ms. These small samples are at or below the [Workers Free 10-ms HTTP CPU limit](https://developers.cloudflare.com/workers/platform/limits/#cpu-time); one final-deployment tools/list sample reached 10 ms, so there is no demonstrated safety margin. They do not prove every cold start or future paid path fits. Runtime CPU and wall fields are milliseconds; see [trace field definitions](https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/workers_trace_events/). [Durable Objects have a separate default 30-second invocation CPU limit](https://developers.cloudflare.com/durable-objects/platform/limits/), so report their RPC/alarm records separately. Startup time printed by deploy is not request CPU.

The telemetry-query API returned 403 with the current OAuth scopes; live tail and aggregate Workers GraphQL analytics were accessible. The report uses per-event tail timing, not GraphQL unit conversions. Successful paid execution, close/final capture, zero-use void and their remote CPU/duration remain pending buyer approval. The remote M1 gate is therefore not yet fully passed. No paid LLM, Git remote, push, subscription upgrade or automatic wallet approval occurred.
