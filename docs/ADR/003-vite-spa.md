# ADR 003 — Vite React SPA on the same Worker

- Date: 2026-10-18
- Status: Accepted by owner stack decision.

## Context

The entry is an interactive execution workspace and merchant dashboard. It does not require server-rendered SEO pages, ISR, or a server-components architecture. One person has a fixed submission date.

## Decision

Use Vite, React, TypeScript, Tailwind, and the Base UI variant of shadcn/ui. Serve build assets through Workers Static Assets alongside the API Worker. Choose a single pnpm package. Route API, MCP, callbacks, and webhooks before SPA fallback; keep private data out of asset caches.

## Alternatives

Next.js/OpenNext adds runtime/build integration work without a required product benefit. This is a scope choice, not a claim that those tools cannot run on Workers. The old vanilla interface is replaced to improve the product experience.

## Consequences and verification

Client routes must survive reload; authentication belongs to APIs, not hidden navigation. Test every callback and unknown API route to prevent an HTML fallback from masquerading as a payment response. See [Static Assets routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/) and [UI](../UI.md).
