# Ravel implementation status

The current specification is `docs/updated_design.md`. The original prototype is preserved in commit `f7d7f3e` on `codex/ravel-v0.2`.

## Completed milestones: 1–6 — offline core and demo

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
- Added one-command production/development startup, process leases, and a reset that archives previous state and refuses to reset an active server.
- Documented setup, architecture, runtime guarantees, API routes, recovery, limitations, and the presentation sequence.
- Removed superseded JavaScript prototype source after preserving it in Git.

### Tests

- The v0.1 baseline passed 14 tests and browser verification.
- The TypeScript core passes 19 Vitest tests, including the exact acceptance scenario, two-run sequence determinism, multiple stale inputs, continuous stale intervals, concurrent ordering, injected SQLite failure, reconstruction, and Guard retry.
- Vitest uses Vite's runner config loader because config bundling attempts to enumerate a parent directory outside the Windows workspace sandbox.
- All 28 tests pass, including DTO validation, historical projection isolation, five-step replay plans, Fastify endpoints, held-mutation release, SSE reconnection, captured-input immutability, affected downstream heads after source replacement, and safe reset/lease behavior.
- Strict TypeScript checking passes.
- Production Vite build passes without warnings. Browser checks verified held writes, release, five-step replay, clean repaired heads with historical branches, and Guard retry.
- `pnpm install --offline --frozen-lockfile` passes using the populated dependency cache. Initial dependency download still requires registry access.
- `pnpm demo` builds and starts successfully at port 4317. `pnpm dev` served Vite-transformed HTML and a healthy API on a separate test port. CLI reset archived that stopped test instance successfully.
- Final browser checks verified Guard rejection/retry counts and an Observe run with one incident, two affected heads, labeled blast radius, and exact schema diff.

### Operating notes and explicit boundaries

- The new server is running at port 4317. Its TS runner requires an elevated shell in this particular Windows sandbox because `os.userInfo()` is blocked in the restricted shell; ordinary user terminals are unaffected.
- Provider credentials are intentionally unnecessary. Gemini, SpacetimeDB and Fetch transports are disabled placeholders; live provider execution is not implemented.
- Guard validates individual writes; it does not promise whole-attempt rollback. The semantic annotation is a labeled fixture heuristic, and downstream reachability means potential influence.
- SQLite and blobs are authoritative. Crashed, uncommitted intents are retained as history but are not automatically resumed or published. Reconstruction restores committed heads.
- Distributed execution, generic rollback, and production authentication remain outside the completed core/demo scope. Benchmark follow-up is tracked below.

### Completion

The offline core/demo acceptance criteria in section 82 of the updated design are satisfied. Work is saved locally on `codex/ravel-v0.2`; pushing is left to the user. No API keys or further user decisions are required to run the completed demo.

## Benchmark follow-up — codex/ravel-benchmark

- Reran the original 28 tests successfully, then added seven benchmark tests; all 35 pass.
- Added `pnpm benchmark`: six controlled scenarios, real uninstrumented OFF mode, Observe, and Guard with retry. Executable output checks are independent of hazard detection.
- Ran 90 measured trials (five repetitions): OFF/Observe 50% success and dependency pass; Guard 100%, with 15 rejections and retries. Three controls confirm no false rejection for serial, identical, or reverted inputs. These are explicitly synthetic results, not official AsynCodeBench scores.
- Reports retain per-trial results, trace databases, generated files, timing, recomputation, bytes, and source metadata. Tokens are unmeasured; no model is involved.
- Downloaded pinned AsynCodeBench and OpenHands source into ignored storage, installed an isolated Linux Python 3.12/uv runner, and passed 14 upstream release/admission contract tests. SDK source/version consistency checks pass.
- Added reproducible upstream setup/check/dry-run/smoke commands with saved logs. The real container smoke is blocked by unavailable Docker integration in Ubuntu-22.04. Official scored OFF/Guard evaluation still needs a model-backed Ravel mediation adapter that honors upstream private-worktree protocols.
- All five official cachetools protocol dry runs and 15 upstream adapter/CLI tests pass. SDK HTTP event-roundtrip still fails its child-server startup deadline on this Windows-mounted WSL checkout; it is not counted as passing.
- Final local results were reproduced from clean commit `ac20481`, retaining source revision and working-tree status. Formatting, strict checking, and the production build pass.
- See `docs/BENCHMARK.md` for commands, measured results, boundaries, and the exact upstream revision.
