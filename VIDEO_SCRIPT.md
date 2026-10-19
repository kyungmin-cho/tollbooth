# Tollbooth demo video

English on-screen captions; no voiceover or music. 1280×720. Target under 2:50 and strictly under the official three-minute limit. Screen footage is recorded from the deployed app in a fresh Playwright context with PayPal hosts and all writes except anonymous visitor initialization blocked. No credentials, owner sessions, emails or tokens are loaded.

| Scene | What viewers see | Caption / message |
|---|---|---|
| Opening | Deployed rehearsal workspace | Tollbooth: human-approved budgets for paid AI tools. Simulated demonstration. |
| Budget | Budget, usage and tool prices | No wallet approval, AI inference or payment occurs in rehearsal. |
| Lookup | Click coffee lookup | Successful usage adds USD 0.20. |
| Consent | Korea estimate dialog | A USD 0.35 call needs human consent; policy caps still apply. |
| Execute | Allow this call | Consent is scoped to this call. |
| Next call | Japan estimate and consent | Three successful calls total USD 0.90. |
| Replay | Replay coffee | Same identity; USD 0.00 additional usage. |
| Close | Finish dialog | Closing stops new spending and settles usage once. |
| Receipt | Simulated receipt | USD 0.90; unused budget not charged. |
| Merchant | Public simulated dashboard and date filter | Separate sample records; AG Grid Community. |
| Judge | Public judge guide | Personal sandbox buyer instructions; real AI vs fallback. |
| Evidence card, 12 seconds | Original text card, not a payment screen | Separately verified live sandbox: real AI plan, 3 calls + replay, one USD 0.90 capture; zero-use void; 6 verified webhook events. |
| Closing card, 8 seconds | Original text card | Try /run/rehearsal and /judge. Sandbox only; Free quotas. Live redelivery proof pending. |

The footage is not presented as a live AI or PayPal checkout recording. Evidence-card claims come from October 19 hardening Stage B; no private screenshots or payment identifiers are included. Visual captions are burned into the video and supplied as a separate SRT. The exact scene boundaries are saved in recording.json. Actual runtime and codec checks are saved in video-metadata.json.

Reproduce from the repository root with `node scripts/package/record.mjs <output-directory>`, then `python3 scripts/package/render.py <output-directory>`. Requires the installed Playwright browser, Python Pillow, ffmpeg and ffprobe. This records public screens only and never opens a real order. Uploading to YouTube and public submission require separate owner approval.
