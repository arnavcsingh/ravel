# Ravel implementation status

The current specification is `docs/updated_design.md`. The original prototype is preserved in commit `f7d7f3e` on `codex/ravel-v0.2`.

## Completed milestones: 1–5 — core, debugger API, React UI, and scheduler

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
- Replaced the UI with React, Vite and React Flow. It renders backend-authored timeline windows, graph states, diffs, incident selection, historical branches, event log, and replay annotations.
- Added interactive held-write release, Observe/Guard demo selection, version content inspection, and repair in the browser.
- Removed remote font loading; all runtime assets are local.

### Tests

- The v0.1 baseline passed 14 tests and browser verification.
- The TypeScript core passes 16 Vitest tests, including the exact acceptance scenario, two-run sequence determinism, multiple stale inputs, continuous stale intervals, concurrent ordering, injected SQLite failure, reconstruction, and Guard retry.
- Vitest uses Vite's runner config loader because config bundling attempts to enumerate a parent directory outside the Windows workspace sandbox.
- All 22 tests pass, including DTO validation, historical projection isolation, five-step replay plans, Fastify endpoints, held-mutation release, and SSE reconnection.
- Strict TypeScript checking passes.
- Production Vite build passes without warnings. Browser checks verified held writes, release, five-step replay, clean repaired heads with historical branches, and Guard retry.

### Known issues

- The new server is running at port 4317. Its TS runner requires an elevated shell in this particular Windows sandbox because `os.userInfo()` is blocked in the restricted shell; ordinary user terminals are unaffected.
- The superseded prototype source is still present and will be removed after the migration checkpoint.
- Provider credentials are intentionally unnecessary. Optional integrations will remain disabled stubs unless configured and implemented.

### Next milestone

Milestone 6 and final audit: polish one-command startup/reset, update README and demo documentation, remove superseded source, strengthen invariant coverage, verify offline operation, and commit the final working tree.
