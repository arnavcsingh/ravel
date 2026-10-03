# Ravel implementation status

The current specification is `docs/updated_design.md`. The original prototype is preserved in commit `f7d7f3e` on `codex/ravel-v0.2`.

## Completed milestones: 1–2 — deterministic core and debugger API

### Completed

- Saved the v0.1 prototype and both design documents in Git.
- Established pnpm workspaces and the required dependency boundaries.
- Identified changes from the first design: continuous stale intervals, captured write intents, database-authoritative state, normalized transactional projections, and backend presentation DTOs.
- Implemented strict TypeScript/Zod entities, SQLite migrations and normalized projections committed atomically with events, and immutable content storage.
- Added bound sessions, per-run mutex, captured write intents, content-validity checks, provenance and blast radius.
- Added direct observations, literal search observations, resource listing, exact-base patches, registered read-only command handlers, tombstones, and workspace reconstruction.
- Added event-driven scheduler hooks and deterministic scripted drivers. No timing sleeps establish the race.
- Added strict per-write Guard rejection/retry and scripted repair; these do not promise multi-write attempt rollback.
- Added validated backend-owned debugger snapshots, graph layout/status, stale windows, hazard detail/diffs, and annotated focused replay plans.
- Added Fastify endpoints, run-scoped SSE with reconnect cursors, live demo controls, asynchronous heuristic annotation, repair, and reconstruction endpoints.
- Added optional Gemini, SpacetimeDB, and Fetch interfaces/placeholders. Missing credentials leave the entire local product operational.

### Tests

- The v0.1 baseline passed 14 tests and browser verification.
- The TypeScript core passes 16 Vitest tests, including the exact acceptance scenario, two-run sequence determinism, multiple stale inputs, continuous stale intervals, concurrent ordering, injected SQLite failure, reconstruction, and Guard retry.
- Vitest uses Vite's runner config loader because config bundling attempts to enumerate a parent directory outside the Windows workspace sandbox.
- All 22 tests pass, including DTO validation, historical projection isolation, five-step replay plans, Fastify endpoints, held-mutation release, and SSE reconnection.
- Strict TypeScript checking passes.

### Known issues

- React migration remains in progress. The previous local server continues to serve v0.1 until the new application is ready.
- Provider credentials are intentionally unnecessary. Optional integrations will remain disabled stubs unless configured and implemented.

### Next milestone

Milestones 3–4: React UI and React Flow, connected to the new DTOs and SSE. Then polish the offline demo, verify the browser flows, and remove the superseded prototype source.
