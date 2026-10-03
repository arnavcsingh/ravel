# Ravel

**A causal concurrency debugger for asynchronous coding agents.**

Ravel records what repository state each agent observed, detects when that state changed before the agent committed its work, and follows the resulting artifacts through a version-level provenance graph.

## Start

Use Node.js **22.18+** and pnpm **11.25+**.

```sh
pnpm install
pnpm demo
```

Open **http://127.0.0.1:4317**. This builds React, starts Fastify, initializes an isolated workspace, and records the controlled three-agent race. No API keys or external services are needed.

After dependencies have been downloaded, `pnpm install --offline --frozen-lockfile`, tests, builds, and the demo work without network access. A first installation with an empty package cache still needs the package registry. The browser loads all runtime assets locally.

## Try it

1. Inspect the recorded incident. Backend observed `schema.sql@17`; Database changed INTEGER to UUID; Backend produced `types.ts@5` with `id: number`.
2. Follow the graph to `client.ts@9`, which consumed the stale-derived types. The active blast radius contains two versions.
3. Click **Replay race**. Five backend-authored steps highlight the observation, invalidation, consuming write, downstream read, and downstream write.
4. Click **Run live demo** with **Pause before the stale write commits** checked. The candidate is genuinely held outside the lock while Database changes. **Release pending write** commits it and detects the race.
5. Click **Repair demo**. New attempts produce clean current heads; historical stale branches remain visible.
6. Select **Guard and retry** for another run. Guard rejects the stale candidate before publication and reruns Backend from fresh state.

Agents are deterministic scripts. Semantic annotations use a labeled local heuristic. The demonstration does not depend on model-provider availability.

## Commands

| Command           | Purpose                                                             |
| ----------------- | ------------------------------------------------------------------- |
| `pnpm demo`       | Build and start the complete demo                                   |
| `pnpm start`      | Start using the existing frontend build                             |
| `pnpm dev`        | Serve the frontend through Vite development transforms              |
| `pnpm demo:reset` | Archive the stopped server's data and start fresh on next launch    |
| `pnpm test`       | Semantic, concurrency, storage, projection, API and lifecycle tests |
| `pnpm typecheck`  | Strict TypeScript checking                                          |
| `pnpm build`      | Type check and build the frontend                                   |
| `pnpm format`     | Format source and configuration                                     |
| `pnpm check`      | Type check and verify formatting                                    |

Stop the server before resetting. Reset preserves history in a neighboring `.saved-<timestamp>` directory. A process lease prevents two CLI servers from owning the same data directory.

`PORT` defaults to `4317`; `RAVEL_DATA_DIR` defaults to `.ravel/v2`. Each run has a separate workspace below it. Demo operations never edit this source repository. The old v0.1 `.ravel/ravel.db` is preserved.

## Architecture

```text
AgentDriver → RavelSession → RunCoordinator
                                │
                         per-run mutex
                                │
             SQLite facts + normalized projections + blobs
                       │                    │
               DebuggerProjector     Workspace materializer
                       │
                 Fastify + SSE
                       │
               React + React Flow
```

`packages/core` has no provider, HTTP framework, React, or sponsor dependencies. It uses shared schemas, SQLite, and a diff utility.

| Directory         | Responsibility                                                   |
| ----------------- | ---------------------------------------------------------------- |
| `packages/shared` | TypeScript/Zod domain schemas and debugger DTOs                  |
| `packages/core`   | Runtime, storage, observations, provenance, detection and replay |
| `apps/server`     | Fastify, run-scoped SSE, CLI and local lifecycle controls        |
| `apps/web`        | React/Vite debugger and React Flow graph                         |
| `demo`            | Scripted drivers, event-driven scheduling, fixtures and repair   |
| `integrations`    | Optional Gemini, SpacetimeDB and Fetch interfaces                |
| `tests`           | Deterministic acceptance and regression coverage                 |
| `docs`            | Designs, implementation status and demo guide                    |

### Shared-state correctness

- Runtime and agent sequences establish order. Wall clocks do not determine causality.
- Generations establish succession; SHA-256 establishes content identity. Identical writes are no-ops. Tombstones distinguish absence from empty content.
- Each attempt has a latest-observation frontier. Rereads replace observations; writes advance their own resource frontier.
- A pending mutation captures its frontier before it can be held. Later rereads cannot change the candidate's captured inputs.
- Validation and logical commit use one critical section. The event, version, head, observations, frontier, provenance and hazards commit in one SQLite transaction.
- Database state and blobs are authoritative. Workspace files are materialized after commit. Failed materialization is reported and can be reconstructed.
- A stale interval starts at the most recent transition away from observed content. For `A → B → A → C`, it starts at `C`.
- Blast radius follows derivation edges only. Version succession is separate. Multiple stale inputs create separate hazards.
- Replay reads stored facts. Repair and retry create new attempts without rewriting old history.

## Core API

Inside a workspace package that depends on `@ravel/core`:

```ts
import { RavelStore, RunCoordinator } from '@ravel/core';

const store = new RavelStore('.ravel/my-run');
const run = new RunCoordinator(store, '/absolute/path/to/workspace');
await run.start('Generate API types');
await run.importWorkspace();
const agentId = await run.createAgent('Backend', 'custom');
const session = await run.createAttempt(agentId, 'Generate types', 'Read the schema.');
const { content, version } = await session.observeResource('schema.sql');

// Inference or computation happens outside the runtime lock.
const generatedTypes = 'export interface User { id: string; }\n';
await session.writeResource('api/types.ts', generatedTypes);
await session.complete();
await run.end();
run.close();
store.close();
```

Sessions also expose `applyPatch(path, observedBaseVersionId, unifiedDiff)`, `listResources()`, `searchRepository(literalQuery)`, and `runCommand(registeredName)`.

Search results become observations of matched versions. Listing names does not claim content observations. Commands use application-registered handlers receiving immutable snapshots; arbitrary shell strings are rejected. Input versions are recorded with tool results but do not automatically enter the model-observation frontier.

One coordinator must own each active run. An attempt can have one pending mutation at a time; other agents remain concurrent. Reads can refresh while a candidate is held without changing its captured dependencies.

## HTTP API

All routes have an `/api` prefix.

| Endpoint                           | Result                                                     |
| ---------------------------------- | ---------------------------------------------------------- |
| `GET /health`                      | Service and optional-integration status                    |
| `GET /runs`                        | Recorded runs                                              |
| `GET /runs/:runId/debugger?seq=N`  | Validated snapshot through sequence N                      |
| `GET /runs/:runId/events?seq=N`    | Factual event log                                          |
| `GET /runs/:runId/stream`          | SSE with `Last-Event-ID` reconnection                      |
| `GET /hazards/:hazardId?seq=N`     | Exact versions, observations, diff and assessment          |
| `GET /hazards/:hazardId/replay`    | Annotated focused replay plan                              |
| `GET /versions/:versionId/content` | Immutable contents                                         |
| `POST /demo`                       | Start Observe or Guard demo, optionally held before commit |
| `GET /runs/:runId/demo`            | Scheduler/materialization status                           |
| `POST /runs/:runId/release`        | Release the controlled pending write                       |
| `POST /runs/:runId/reconstruct`    | Rebuild tracked workspace files                            |
| `POST /hazards/:hazardId/analyze`  | Apply the local heuristic asynchronously                   |
| `POST /hazards/:hazardId/repair`   | Execute the scripted repair                                |

The server binds to loopback. It is a local application without production authentication or multi-tenant access control.

## Optional integrations and boundaries

`.env.example` lists Gemini, SpacetimeDB and Fetch configuration. Missing keys never prevent installation, testing, build, or the demo. Interfaces and disabled transport placeholders are implemented as requested by the updated design. No live provider calls are made.

Provenance overapproximates influence within an attempt. **Downstream** means potentially affected, not proven wrong. The semantic heuristic covers the identifier-migration fixture; it is not general semantic AI.

Only mediated operations are covered. Tracked reads use immutable logical versions. External edits to materialized files are not new commits and may be overwritten during reconstruction. Symlinks are rejected. Command handlers are trusted application code, not an OS sandbox.

Guard validates individual writes. It does not stage or roll back all writes in an attempt. The demo has one backend output, allowing a safe retry of its rejected attempt. Generic rollback, distributed execution, kernel tracing, live model drivers and AsynCodeBench are outside the completed core/demo scope.

After a crash, committed heads can be reconstructed. Uncommitted intents remain historical facts and are never automatically published; start a new run for an interrupted scripted execution. Normalized projections are transactional, while in-memory state is rebuilt from the event log. Large-run performance will need incremental projection and caching.

The [updated design](docs/updated_design.md) defines scope. [Implementation status](docs/IMPLEMENTATION_STATUS.md) records verification. The [demo guide](docs/DEMO.md) gives a presentation sequence.
