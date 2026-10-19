# Address transition — completed

Current target: `https://tollbooth.arcsolve.workers.dev`, Worker `tollbooth`, version `6df30cf0-b859-4289-b90f-fe95caf756e4`. D1 remains `tollbooth-m1` (`33319057-6712-4276-bf92-8727589c68fb`); its eight `session_index` rows are retained. D1, PLAN_KV and the new Worker are retained.

Per the owner's report, following approval at 13:32 KST on 2026-10-19, the former Worker `tollbooth-m1` was deleted using `wrangler delete tollbooth-m1` at approximately 13:35 KST. Its DO namespace data was also removed; all eight historical sessions had settled. The former address now returns 404. Stage C records these supplied facts only; no remote operation or independent remote verification was performed.

## Recovery status after deletion

Deletion removes the old scheduler and old DO recovery actors, resolving Stage A's two-Worker cron/recovery contention over the shared D1. The earlier recommendation to retain the old Worker or remove only its cron is superseded by the owner's completed deletion. Only the new Worker's scheduler remains.

Retained D1 projections are historical evidence, not a migration of the old authoritative DO ledger. Old sessions cannot be resumed or read-reconciled through the deleted DO namespace. The recovery scan still has no namespace discriminator; deleting the old Worker resolves competing actors, not reconstruction of old DO state. Do not treat retained rows as migrated sessions or deliberately requeue old recovery work.

## Completed address steps

As of October 19–20, 2026, the account workers.dev subdomain is `arcsolve` and the public origin is `https://tollbooth.arcsolve.workers.dev`. Address Stage D verified health, modern/legacy MCP and the public rehearsal, merchant demo and judge pages. The existing PayPal webhook was PATCHed to `https://tollbooth.arcsolve.workers.dev/webhooks/paypal`, preserving its ID and all eight events.

A genuine resend was accepted with 202 and reached the new endpoint about 5.3 seconds later with HTTP 200, which requires PayPal signature-verifier SUCCESS. Durable ingress remained unchanged. Tail excluded payloads/event IDs, so attribution uses timing and ingress evidence; this was not a reconstruction of the deleted old DO inbox. No new order or payment was created for that check.

`/connect` and the built-in AI adapter use `location.origin`; judge navigation uses relative paths. Historical evidence, cookies, callback origins and DO identities are not migrated. No code, configuration, D1 migration, custom domain or route changed in Stage C.
