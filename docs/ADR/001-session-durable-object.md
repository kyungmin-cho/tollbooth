# ADR 001 — One SQLite Durable Object per payment session

- Date: 2026-10-18
- Status: Accepted for design; runtime viability is an M1 gate.

## Context

The old Node service keeps a per-session Promise lock and a local SQLite file. Neither survives as a Worker-wide mutex. Budget checks, tool execution, browser departure, and close can race across network awaits.

## Decision

A business session has one SQLite-backed SessionDO, independent of any MCP transport session. It owns reservations, committed usage, cached results, payment operations, settlement, and recovery jobs. Use short storage transactions for the money invariant, persisted fences for external work, a sticky closing barrier, and an alarm for due work. D1 supplies a secondary recovery discovery index.

## Alternatives

A global merchant DO would couple unrelated sessions and create a contention point. D1-only accounting would require a separate durable job and concurrency model. An in-memory mutex would not cover resets. These alternatives provide no advantage for the bounded solo demo.

## Consequences and verification

DO single-threaded execution is not request-level serialization across external awaits. The implementation must prove reservation/close races, eviction, duplicate alarms, and no lost operation identity. A single platform alarm multiplexes persisted job deadlines. See [DESIGN sections 4–5](../DESIGN.md) and [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
