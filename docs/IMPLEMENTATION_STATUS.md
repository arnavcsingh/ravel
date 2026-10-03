# Ravel implementation status

The current specification is `docs/updated_design.md`. The original prototype is preserved in commit `f7d7f3e` on `codex/ravel-v0.2`.

## Completed milestone: 1 — deterministic TypeScript core

### Completed

- Saved the v0.1 prototype and both design documents in Git.
- Established pnpm workspaces and the required dependency boundaries.
- Identified changes from the first design: continuous stale intervals, captured write intents, database-authoritative state, normalized transactional projections, and backend presentation DTOs.
- Implemented strict TypeScript/Zod entities, SQLite migrations and normalized projections committed atomically with events, and immutable content storage.
- Added bound sessions, per-run mutex, captured write intents, content-validity checks, provenance and blast radius.
- Added direct observations, literal search observations, resource listing, exact-base patches, registered read-only command handlers, tombstones, and workspace reconstruction.
- Added event-driven scheduler hooks and deterministic scripted drivers. No timing sleeps establish the race.
- Added strict per-write Guard rejection/retry and scripted repair; these do not promise multi-write attempt rollback.

### Tests

- The v0.1 baseline passed 14 tests and browser verification.
- The TypeScript core passes 16 Vitest tests, including the exact acceptance scenario, two-run sequence determinism, multiple stale inputs, continuous stale intervals, concurrent ordering, injected SQLite failure, reconstruction, and Guard retry.
- Vitest uses Vite's runner config loader because config bundling attempts to enumerate a parent directory outside the Windows workspace sandbox.

### Known issues

- HTTP and React migration remains in progress. The previous local server continues to serve v0.1 until the new application is ready.
- Provider credentials are intentionally unnecessary. Optional integrations will remain disabled stubs unless configured and implemented.

### Next milestone

Milestone 2: backend DebuggerSnapshot, HazardDetail, ReplayPlan, and Fastify/SSE endpoints. Then replace the prototype frontend with React and React Flow.
