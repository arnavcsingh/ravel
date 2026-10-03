# Ravel implementation status

Version 0.3 migrates runtime responsibilities to Go while retaining the React debugger. The complete prior TypeScript implementation is preserved at `077f277` on `ravel`; migration work is on `codex/ravel-polyglot`.

## Implemented

- Go domain/coordinator, observation frontier, immutable captured intents, exact-base patches, content-reversion rules, Guard rejection and fresh retry.
- Transactional SQLite event/projection persistence, immutable SHA-256 blobs, materialization and restart reconstruction.
- Provenance DAG, continuous stale intervals, active/historical blast radius, deterministic historical projections and focused replay.
- Compatible HTTP/SSE debugger API, mediated agent endpoints, script-controlled hold/release, repair, local process lease and archive reset.
- Existing React/Vite, React Flow, timeline, inspector, diff and Replay Race UI retained. Vite now proxies the Go API in development.
- Python HTTP client, six-scenario synthetic benchmark, independent executable artifact checker and moved provider interfaces. No new provider transports.
- Frozen every-event baseline projections, Go concurrency/storage/API tests, Python benchmark parity tests and frontend contract tests.

## Boundaries

Guard prevents individual stale writes; it does not undo earlier publications. Agents must use mediated operations for observations/provenance. Local file materialization follows durable commit and can need reconstruction. Replay is factual playback, not model re-execution. Semantic annotations are labeled fixture heuristics.

Gemini and Fetch transports remain deferred. No SpacetimeDB service or alternative database is introduced. Official AsynCodeBench work remains at the prior checkpoint; the Python wrapper preserves the existing pinned bootstrap without extending or rerunning upstream integration.

See [migration evidence](MIGRATION.md), [API contract](API.md), [benchmark results and limitations](BENCHMARK.md), and [the demo guide](DEMO.md).
