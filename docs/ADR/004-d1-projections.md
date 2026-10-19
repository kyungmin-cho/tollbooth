# ADR 004 — D1 read projections with an admission and recovery index

- Date: 2026-10-18
- Status: Accepted.

## Context

Merchant tables span many independent sessions. Querying every DO for each dashboard refresh is expensive and brittle. DO and D1 writes do not share a transaction.

## Decision

DO is the payment authority. Commit a versioned outbox with its state, then atomically apply complete, version-guarded snapshots to D1. Use absolute totals and deduplication receipts. Buyer budget and payment receipt read the DO directly. Register a D1 admission/recovery anchor before any new external payment operation; this small ingress index is the deliberate exception to projection-only writes.

## Alternatives

Synchronous dual writes could lose one side; additive revenue events can double count replay; D1-only truth adds a different payment concurrency design. A projection alone without a discovery anchor cannot recover objects it cannot find.

## Consequences and verification

Dashboard lag is visible. Existing sessions continue using DO truth during D1 outage, while new order creation fails safely. Verify ACK loss, reverse versions, batch failure, rebuild, concurrent admission, and scan recovery. See [D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/) and [DESIGN section 6](../DESIGN.md).
