# ADR 005 — AG Grid Community for merchant tables

- Date: 2026-10-18
- Status: Accepted by owner stack decision.

## Context

The seller needs useful session and charge tables through the full judging period. Trial expiry must not disable a required screen.

## Decision

Use AG Grid Community in React for merchant sessions/charges, with bounded client-side pages and application-owned global filters, pagination, and aggregate cards. Use shadcn components for the rest of the interface and a small semantic buyer ledger table. No Enterprise or AG Studio dependency on a required route.

## Alternatives

An Enterprise trial adds a time limit and cost decision. A generic shadcn data table could work but would not implement the chosen AG Grid integration. Integrating both on the same seller screen would add maintenance without product value.

## Consequences and verification

Keep local page filtering visibly distinct from global D1 filtering. Avoid master/detail, server-side row model, pivoting, Excel export, and integrated charts. Check the bundle and browser for Enterprise modules/license warnings. Sponsor-prize competitiveness is not assumed from a grid alone. See the [feature matrix](https://www.ag-grid.com/react-data-grid/community-vs-enterprise/) and [UI merchant design](../UI.md).
