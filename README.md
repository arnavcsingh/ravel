# Ravel

**A causal concurrency debugger for asynchronous coding agents.**

Ravel records what repository state each agent observed, detects when that state changed before publication, and follows resulting artifacts through immutable version provenance.

## Start

Install **Go 1.26+**, **Python 3.11+**, **Node.js 22.18+**, and **pnpm 11.25+**. SQLite is embedded; no database service, model, or API key is needed.

```sh
pnpm install
pnpm demo
```

Open **http://127.0.0.1:4317**. This builds the existing React debugger and Go executable, initializes an isolated workspace, and records the controlled three-agent race. First installation downloads npm and Go dependencies; subsequent runs can use cached dependencies.

Set `RAVEL_GO` or `RAVEL_PYTHON` if the executables are not on PATH. The launcher also recognizes the workspace-local Go SDK and Codex's bundled Python when available. `.env` is loaded by the pnpm launcher; directly launched Go/Python programs use their process environment. `PORT` defaults to `4317`; `RAVEL_DATA_DIR` defaults to `.ravel/v3`. Earlier `.ravel/v2` data is preserved.

## Try it

1. Inspect the recorded incident: Backend observed `schema.sql@17`; Database changed INTEGER to UUID; Backend produced `types.ts@5` with `id: number`.
2. Follow the graph to `client.ts@9`. Two current versions are affected.
3. Click **Replay race** for five backend-authored steps through the stored causal chain.
4. Click **Run live demo** with **Pause before the stale write commits** checked, then **Release pending write**.
5. Click **Repair demo**. Current heads become clean; historical stale branches remain visible.
6. Choose **Guard and retry** for a fresh run. The runtime rejects stale publication and the scripted agent retries with a fresh attempt.

## Commands

| Command                          | Purpose                                                      |
| -------------------------------- | ------------------------------------------------------------ |
| `pnpm demo`                      | Build frontend/runtime and start the complete app            |
| `pnpm start`                     | Build/start Go with the existing frontend build              |
| `pnpm dev`                       | Go API on 4317 and Vite with HMR on 5173                     |
| `pnpm demo:reset`                | Archive stopped runtime data; fresh demo on next launch      |
| `pnpm test`                      | Go runtime tests, Python benchmark tests, frontend DTO tests |
| `pnpm test:race`                 | Go race detector; requires a supported C compiler            |
| `pnpm benchmark --repetitions 5` | Python OFF/Observe/Guard suite with saved traces             |
| `pnpm build`                     | Typecheck and build frontend plus Go runtime                 |
| `pnpm check`                     | TypeScript checking and frontend/document formatting         |
| `pnpm format`                    | Format frontend, tooling and documentation                   |

Go source uses `gofmt`; `go vet ./...` runs from `runtime`. Python uses only the standard library. The small JavaScript launcher locates Python for pnpm; it implements no runtime semantics.

Stop the server before reset. A sibling process lease prevents simultaneous CLI owners and reset while running. Reset renames verified Ravel data to `.saved-<timestamp>` rather than deleting history. Demo workspaces never edit this source repository.

## Why three languages

| Component           | Language and responsibility                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime/`          | Go: coordinator, domain, SQLite, immutable blobs, workspace recovery, observations/intents, atomic validation and commit, provenance, hazards, projections, HTTP/SSE |
| `apps/web/`         | Existing TypeScript/React/Vite UI: React Flow graph, timeline, incident inspector, diff viewer, Replay Race                                                          |
| `packages/shared/`  | Frontend TypeScript/Zod DTO declarations and validation                                                                                                              |
| `python/ravel/`     | Python: mediated agent client, benchmark orchestration, existing optional provider interfaces                                                                        |
| `runtime/testdata/` | Frozen TypeScript baseline events and every-sequence projections                                                                                                     |

Go owns concurrency and durable state because these concerns need one explicit synchronization and transaction boundary. Python fits coding-agent and benchmark ecosystems; it makes HTTP calls and never duplicates validation decisions. React remains the debugger's presentation layer. Every client uses the same model-independent API.

The Go demo scheduler and fixture heuristic remain deterministic conformance fixtures. The optional Python Gemini driver uses mediated HTTP tools; its semantic analyzer appends labeled annotations through Go. Invoke it explicitly with `pnpm gemini`; normal startup stays offline. SpacetimeDB can mirror the debugger read model for live React subscriptions. Persistence remains SQLite plus SHA-256 blobs.

## Optional SpacetimeDB live projection

Authenticate the installed CLI with `spacetime login`, then publish the isolated module:

```sh
spacetime publish ravel-mhacks-2026 --server maincloud --module-path integrations/spacetime/spacetimedb
spacetime generate --lang typescript --out-dir apps/web/src/spacetime_bindings --module-path integrations/spacetime/spacetimedb
```

Set these values in your ignored `.env`, then restart Ravel:

```dotenv
RAVEL_SPACETIME_ENABLED=true
RAVEL_SPACETIME_URI=https://maincloud.spacetimedb.com
RAVEL_SPACETIME_DATABASE=ravel-mhacks-2026
```

`RAVEL_SPACETIME_CLI` optionally selects an absolute CLI path. The runtime reads the existing CLI login token into memory; it never puts that token in browser configuration, projection rows, or source files. Only the module publisher identity can publish snapshots. Public subscription tables contain debugger summaries, not file contents, agent prompts, or local workspace paths. Publish only run summaries you intend to share with clients of this database.

The background worker reads committed SQLite facts through its own read-only connection. It coalesces changes into complete snapshots containing the timeline in `runtime_seq` order. Failed publications retry from SQLite with capped backoff, and restart republishes existing runs. The module ignores duplicate and older cursors. React consumes generated subscription bindings and preserves SSE as a fallback for connection failure, disabled projection, or lag beyond 2.5 seconds. Replay and mutations always use the Go HTTP API. `/api/live` reports enabled configuration and the worker's latest publication status.

Set `RAVEL_SPACETIME_ENABLED=false` to run entirely through SSE. The core does not need the CLI, account, or cloud connection. Automated runtime-process tests disable cloud publication regardless of local `.env` settings.

## Agent API

Start the runtime, set `PYTHONPATH=python`, then use a bound session:

```python
from ravel.client import Client

client = Client("http://127.0.0.1:4317")
run = client.create_run("Generate types", "guard", {"schema.sql": "id UUID"})
agent = client.create_agent(run, "Backend")
session = client.create_attempt(run, agent, "Generate types", "Read the schema")
observed = session.observe_resource("schema.sql")
# Inference happens in Python, outside the runtime lock.
result = session.write_resource("types.ts", "export interface User { id: string }\n")
if result["rejected"]:
    session = session.retry()  # Reobserve and regenerate before publishing again.
else:
    session.complete()
    client.end(run)
```

Sessions also expose exact-base `apply_patch`, `list_resources`, `search_repository`, and explicit `write_intent`/`commit_write`.

## Runtime guarantees

- Sequences establish order; wall clocks do not determine causality.
- Generations identify immutable versions; hashes establish content validity. Identical writes are no-ops; tombstones distinguish absence from empty files.
- Each attempt has a latest-observation frontier. Rereads refresh it; own writes advance it. An intent captures inputs before any scheduling pause.
- Validation and publication share one per-run critical section. Accepted write facts, version, head, observations, provenance and hazards commit in one SQLite transaction.
- SQLite and blobs are authoritative. Materialization follows commit and can be reconstructed after failure.
- For `A → B → A → C`, the continuous stale interval starts at `C`. Reverting to observed content restores validity despite generation changes.
- Blast radius follows derivation edges, with active and historical views. Replay reads facts; repair/retry append new attempts.
- Guard applies per write; it does not roll back earlier writes in an attempt. One CLI process owns the store. Unmediated filesystem operations are outside the observation contract.

The API binds loopback for trusted local clients and has no remote authentication layer. Registered read-only command handlers receive snapshots; HTTP does not expose arbitrary shell execution. Pending candidates are not automatically published after restart; recover with fresh attempts.

## Verification and benchmark

Go/Python tests and frozen replay fixtures preserve the original concurrency behavior.

`pnpm benchmark` runs six deterministic scenarios in OFF, Observe and Guard. It independently executes generated artifacts and records correctness, hazards, retries, generation work and elapsed time. It is **not an official AsynCodeBench score**.
