# ADR 002 — Stateless createMcpHandler and an explicit payment adapter

- Date: 2026-10-18
- Status: Accepted.

## Context

A payment session needs persistence; an MCP transport session does not need to own that persistence. SDK/protocol evolution makes copying the old v1 Express adapter unsafe.

## Decision

Use the Cloudflare Agents `createMcpHandler` factory path and the compatible pinned MCP server package. Target the modern specification and test ordinary tools on the legacy stateless lane. Carry a separate authenticated business-session handle. Payment-required is a structured tool result with `isError:true`; a Tollbooth adapter handles policy, human wallet approval, and same-business-key retry.

## Alternatives

McpAgent, a persistent protocol-session store, and a literal HTTP 402 assumption add coupling without solving payment correctness. Generic x402/MPP wrappers do not implement this PayPal authorization-and-settlement contract.

## Consequences and verification

No universal custom-connector compatibility claim. Select and test an actual AI host, with the adapter/bridge where needed. URL fallback is mandatory; optional modern elicitation cannot replace it. Secret credentials stay outside model-visible results. See [MCP handler documentation](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/) and [DESIGN section 8](../DESIGN.md).
