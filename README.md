# Ravel

A causal concurrency debugger for coding agents. Ravel connects the repository state an agent observed to the artifacts it later produced, then shows where that state became stale and what consumed the resulting output.

## Run it

Requires **Node.js 22.18 or newer**. This first version has no npm dependencies.

```sh
npm start
```

Open **http://127.0.0.1:4317**. The first launch records the three-agent demo. Click **Run live demo** to watch another execution stream into the debugger.

```sh
npm test        # runtime acceptance, edge cases, API, and streaming
npm run check  # syntax checks
npm run demo   # record the demo and print its findings
```

`PORT` changes the server port. `RAVEL_DATA_DIR` changes the data directory (default: `.ravel`). Node 22 may print an experimental warning for its built-in SQLite module.

## What works

- A central runtime mediates file observations, writes, and deletions. Synchronous critical sections assign per-run and per-agent sequence numbers.
- SQLite stores an append-only event log; SHA-256-addressed blobs preserve exact file contents. Every live and historical view uses the same backend reducer.
- Each task attempt has its own observation frontier. Writes inherit candidate provenance, validate against resource heads before publication, and advance their own frontier.
- Stale detection handles rereads, identical writes, content reverts, first invalidators, and later validation heads. Absence has a distinct tombstone state.
- Blast-radius traversal follows derivation edges only. The UI distinguishes active heads from historical affected artifacts.
- The debugger has an agent timeline, version graph, incident inspector, stored-content diff, event log, sequence controls, and focused **Replay race**.
- Server-sent events stream the scripted race. **Repair demo** creates new backend and frontend attempts, replacing current heads while preserving historical findings.
- A labeled semantic demo rule identifies the INTEGER → UUID / `id: number` mismatch as likely relevant.

## Demo

1. Backend reads `schema.sql@17` with an integer identifier.
2. Database publishes `schema.sql@18` with a UUID identifier.
3. Backend produces `api/types.ts@5` using its old observation.
4. Frontend reads `api/types.ts@5` and produces `frontend/client.ts@9`.

Ravel reports exactly one direct stale hazard on `types.ts@5`. Its active blast radius includes `types.ts@5` and `client.ts@9`. Repair creates `types.ts@6` and `client.ts@10`; old versions remain inspectable.

All demo files live in `.ravel/workspaces/<run-id>/`. The demo does not edit the source repository.

## Runtime API

```js
import { EventStore } from './src/events/event-store.js';
import { Runtime } from './src/runtime/coordinator.js';

const store = new EventStore('.ravel');
const runtime = new Runtime(store, '/absolute/path/to/workspace');
runtime.start({ name: 'My run' });
const agent = runtime.agent('Backend', 'custom-adapter');
const attempt = runtime.attempt(agent, 'Generate types', 'Read the schema.');
const { content, version } = runtime.observe(attempt, 'schema.sql');
// Agent reasoning can happen asynchronously between runtime operations.
runtime.write(attempt, 'api/types.ts', generatedTypes);
runtime.finishAttempt(attempt);
runtime.end();
const projection = runtime.projection();
store.close();
```

The core is independent of HTTP. An adapter must route the agent's actual file observations and publications through this API. Use one coordinator per run; this is a single-process runtime, not a distributed writer protocol.

## Layout

```text
src/
  domain/       identifiers, content hashes, evidence types, path normalization
  events/       SQLite event log and content-addressed blobs
  runtime/      workspace access and operation coordinator
  detection/    deterministic stale-input detection
  provenance/  derivation traversal and active/historical blast radius
  replay/      shared reducer, projections, focused race slices
  adapters/    controlled three-agent demo and repair
  semantic/    narrow, labeled semantic demo rule
  api/         local HTTP server and SSE stream
public/         browser UI, without a build step
test/           runtime and HTTP integration tests
docs/           project design and implementation notes
```

## Boundaries of this version

Only mediated operations are covered. The runtime rejects detected external edits to tracked resources; it cannot intercept arbitrary filesystem operations or guarantee filesystem isolation. Symbolic-link resources are rejected. SQLite transactions roll back failed publications during normal operation, but filesystem and SQLite commits are not jointly crash-atomic; after a process or machine failure, an inconsistent workspace is rejected rather than silently reconciled.

Provenance overapproximates influence within a task attempt. **Downstream** means potentially affected, not proven incorrect. The semantic assessment uses a deterministic demo rule, not an LLM. Real agent adapters, command-result provenance, general semantic AI, staged Guard mode, and benchmarking remain to be implemented.

The event log is the source of truth. Entities and derived findings are currently reconstructed in memory, rather than stored in separate normalized tables. This keeps the initial runtime small and allows old traces to be reanalyzed. Large runs will need incremental projection and indexed views.

## HTTP API

| Endpoint                                  | Result                                  |
| ----------------------------------------- | --------------------------------------- |
| `GET /api/runs`                           | Recorded runs                           |
| `GET /api/runs/:id?seq=N`                 | Backend projection through sequence N   |
| `GET /api/runs/:id/version?id=VERSION_ID` | Immutable contents and version metadata |
| `GET /api/runs/:id/race?hazard=HAZARD_ID` | Focused causal event slice              |
| `GET /api/stream`                         | Live SSE event notifications            |
| `POST /api/demo`                          | Start a new controlled race             |
| `POST /api/runs/:id/repair`               | Execute the scripted repair once        |

The server binds to loopback and is intended for local development.
