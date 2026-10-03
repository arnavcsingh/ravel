# Ravel HTTP and SSE boundary

Go serves JSON on loopback. All routes work with and without `/api`; React uses `/api`. IDs are opaque strings. Responses preserve `packages/shared/src/` DTOs. Malformed JSON, unknown fields and bodies above 1 MiB are rejected. Errors use `{ "error": "message" }`: invalid requests return 400, missing entities 404, conflicting demo controls 409, and foreign-origin mutations 403.

## Debugger

| Method and route                    | Result                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `GET /health`                       | Runtime and disabled integration status                                      |
| `GET /runs`                         | Recorded runs                                                                |
| `GET /runs/{runId}/debugger?seq=N`  | Timeline, provenance, windows, heads, hazards, active count and Guard status |
| `GET /runs/{runId}/events?seq=N`    | Events through optional positive sequence                                    |
| `GET /hazards/{hazardId}?seq=N`     | Incident, exact diff and blast radius                                        |
| `GET /hazards/{hazardId}/replay`    | Backend-authored focused replay                                              |
| `GET /versions/{versionId}/content` | Immutable version and content                                                |
| `GET /runs/{runId}/stream`          | Run-scoped SSE                                                               |
| `POST /runs/{runId}/reconstruct`    | Re-materialize current heads                                                 |

SSE uses `event: update` with runtime sequence as the SSE `id` and JSON `{ "runId": "...", "runtimeSeq": 12, "kind": "WRITE" }`. Catch-up events are followed by a `kind: CONNECTED` update, then live updates. `Last-Event-ID` catches up missing events. Subscription precedes catch-up to avoid gaps; duplicate factual events are skipped. Heartbeats keep idle connections open. Slow clients reconnect with their last cursor. Clients refresh HTTP projections after updates.

## Mediated agents

1. `POST /runs` with `{ "name": "Task", "mode": "guard", "files": { "schema.sql": "id UUID" } }` returns `{ "runId": "..." }` (201). Mode is `observe` or `guard`; Go creates an isolated workspace.
2. `POST /runs/{runId}/agents` with `{ "name": "Backend", "adapter": "python" }` returns `{ "agentId": "..." }`.
3. `POST /runs/{runId}/attempts` with `{ "agentId": "...", "name": "Generate types", "prompt": "Read schema" }` returns a TaskAttempt. Retry by including the original `taskId`; it creates a fresh frontier and next attempt number.
4. POST operations below under `/runs/{runId}/attempts/{attemptId}/`.

| Operation           | Body                                                                      | Result                                                               |
| ------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `observe_resource`  | `{ "path": "schema.sql" }`                                                | `{ "version": {...}, "content": "..." }`; records observation        |
| `write_resource`    | `{ "path": "types.ts", "content": "..." }`                                | Write result; includes rejection, no-op and materialization outcome  |
| `apply_patch`       | `{ "path": "types.ts", "baseVersionId": "...", "patch": "unified diff" }` | Same write result; exact recorded base required                      |
| `list_resources`    | `{}`                                                                      | Paths; no observations                                               |
| `search_repository` | `{ "query": "User" }`                                                     | Literal matches; matched versions become observations                |
| `write_intent`      | `{ "path": "types.ts", "content": "..." }`                                | Captured intent including `id`; not published                        |
| `commit_write`      | `{ "intentId": "..." }`                                                   | Write result; intent must belong to bound attempt                    |
| `complete`          | `{ "status": "completed" }`                                               | `{ "completed": true }`; `failed` also allowed                       |
| `run_command`       | `{ "name": "registered-handler" }`                                        | Snapshot-based result; requires an application-registered Go handler |

Explicit `"content": null` creates a tombstone; missing content is an error. Guard rejection is HTTP 200 with `rejected: true`. Create a fresh attempt, reobserve, regenerate and retry. Inspect recorded state after losing a mutation response; requests do not yet support idempotency keys.

`POST /runs/{runId}/end` completes a run; `/resume` reopens it. Rejected attempts cannot publish again. One pending mutation per attempt is allowed, while other agents remain concurrent. Registered commands and agent computation run outside the coordinator lock.

## External semantic assessments

External semantic analyzers may append annotations with `POST /hazards/{hazardId}/assessments`: `{ "analyzer": "provider/model", "relevance": "LIKELY", "reason": "Evidence-based explanation", "affectedElements": ["User.id"] }`. Relevance is `IRRELEVANT`, `POSSIBLE`, `LIKELY` or `CONFLICT`. Go validates bounded strings/arrays, generates the assessment ID and sequence, appends the event and emits an SSE update. Existing causal facts and historical snapshots are preserved. IDs, sequences and extra fields supplied by callers are rejected. See [Gemini integration](GEMINI.md).

## Demo controls

`POST /demo` accepts `{ "mode": "observe", "interactive": true }`. `GET /runs/{runId}/demo` reports phase; `POST /runs/{runId}/release` releases a held candidate. `POST /hazards/{hazardId}/analyze` appends a labeled fixture assessment. `POST /hazards/{hazardId}/repair` runs scripted repair. These controls target the identifier-migration fixture, not general model orchestration.

## Restart

SQLite schema and event fields preserve the baseline. Default data directory `.ravel/v3` leaves old data intact. Historical v2 databases remain readable; mutation recovery requires a workspace under the chosen store's managed `workspaces` directory. Stop the old server and preserve its data before selecting an old directory. A legacy `server.lock` is rejected rather than silently stealing ownership.

Events and committed content survive restart. Pending intents remain historical facts but candidates are not silently recommitted. Reconstruct files and create fresh attempts for interrupted work.
