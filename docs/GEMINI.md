# Gemini integration

Gemini runs in Python. Go remains the sole authority for observations, versions, validation, SQLite commits, provenance, replay and SSE. Provider requests occur outside Go and never hold its coordinator lock.

## Configuration

Set `GEMINI_API_KEY` in the ignored root `.env`. Optional `RAVEL_AGENT_MODEL` and `RAVEL_SEMANTIC_MODEL` select models independently; both default to `gemini-3.5-flash-lite`, verified with this project's key. `--model` overrides either setting for one command. There is no automatic model fallback.

```sh
pnpm gemini status
pnpm gemini check
pnpm demo
```

`status` is local-only. `check` makes one tiny generation request. The pnpm bootstrap loads `.env`; direct Python invocation uses environment variables. Normal startup, scripted demos, synthetic benchmarks and unit tests make no Gemini calls. A missing key returns a clear disabled message for explicit Gemini commands and never prevents the local app from starting.

## Coding agent

With the Go app running:

```sh
pnpm gemini agent --files examples/gemini/files.json --prompt "Read schema.sql and create api/types.ts exporting a User interface matching the schema."
```

The JSON file explicitly supplies initial workspace contents as a mapping of resource paths to text. No source-repository folder is automatically uploaded. A new isolated Guard run is created and its ID is printed. Select that run in the existing debugger to inspect observations, writes and provenance. Gemini has these tools:

- `observe_resource`, `list_resources`, `search_repository`
- `write_resource`, exact-base `apply_patch`
- `finish_task`

These dispatch only through the Python HTTP session client. There is no shell, direct filesystem access, deletion tool, network-fetch tool or arbitrary Python dispatch. The agent can publish files but cannot execute tests. A completed agent means its tool loop finished; artifact correctness still needs independent validation.

Useful options:

```sh
pnpm gemini agent --run RUN_ID --prompt "Continue the work in this workspace."
pnpm gemini agent --mode observe --files examples/gemini/files.json --prompt "Generate the interface."
pnpm gemini agent --max-calls 6 --max-retries 1 --max-output-tokens 1024 --prompt "Create hello.txt."
```

`--run` joins the existing run using its original mode, resumes it if completed, and leaves it open because other agents may be active. A fresh run created by the command is completed after its agent succeeds. Existing runs and future concurrent agents use the same runtime model.

Defaults bound execution to 12 model requests, 2048 output tokens per request, one Guard retry, 45 seconds per request, and a 512 KB serialized request. These are request/output bounds, not an exact total-token billing cap. The final summary reports provider token usage, calls and retries. Explicit CLI overrides have bounded ranges.

Exactly one tool executes per model response. A batch gets error responses without executing any calls: a generated write must not claim to depend on a read whose result the model has not received. Opaque thought signatures and function-call IDs are preserved across turns. Guard rejection discards the old transcript and creates a fresh attempt; old observations are not inherited. The same request budget applies across retries. Earlier successful writes are not rolled back, matching Ravel's per-write Guard semantics.

Unknown tools, malformed arguments and unsafe paths are rejected. Provider/network failures, output truncation and exhausted budgets stop execution; the attempt is marked failed where possible. Lost HTTP mutation responses are never automatically replayed. If an interrupted mutation remains pending, inspect its recorded state before manual recovery. Materialization failure preserves the durable commit and requires reconstruction.

## Semantic analysis

```sh
pnpm gemini analyze HAZARD_ID
```

Use `--url http://127.0.0.1:4320` when targeting another local runtime. Hazard IDs are available from `GET /api/runs/{runId}/debugger` and the event log.

Python reads the exact observed version, validation-time version, consumer artifact, diff and original task metadata. It asks Gemini for validated JSON containing `relevance` (`IRRELEVANT`, `POSSIBLE`, `LIKELY`, `CONFLICT`), `reason` and `affectedElements`, then posts a provider-neutral assessment to Go.

Go appends `SEMANTIC_ASSESSMENT` with its own ID and sequence and notifies SSE subscribers. The existing inspector displays the explanation with a **GEMINI** label. Model analysis never changes immutable versions, heads, factual hazards, derivation edges or Guard decisions. Historical views retain earlier annotations; the UI's local heuristic button remains available and explicitly appends a heuristic reassessment.

The generic endpoint is `POST /api/hazards/{hazardId}/assessments`, accepting `{ "analyzer": "gemini/MODEL", "relevance": "LIKELY", "reason": "...", "affectedElements": [] }`. The server validates categories and bounded text and supplies provenance fields. It does not accept caller-selected IDs or sequences. Like other runtime mutations, this is a trusted-local API, not authenticated provider attestation.

## Verification

Offline tests use fake Gemini responses with the actual Go HTTP runtime. They cover all exposed repository tools, fresh Guard retries, stale Observe publication, signature/ID roundtrips, invalid tool batches, request budgets, provider failures, truncated output and semantic validation. Go tests verify append-only assessments, historical isolation, unchanged causal state and SSE delivery.

Live smoke on 2026-10-03 used `gemini-3.5-flash-lite`:

- Coding agent: three model calls, two mediated tool calls, 2,623 total tokens. It read the UUID schema and published `api/types.ts` with `id: string` and `email: string`. The artifact and provenance were checked through Go.
- Semantic analyzer: one model call, 1,416 total tokens. It classified the fixture's INTEGER-to-UUID/numeric-consumer mismatch as `CONFLICT`; Go recorded assessment sequence 28.

These are integration checks, not a coding benchmark or official AsynCodeBench result. Live traces are isolated under `.ravel/gemini-live-check`; no provider requests are part of `pnpm test`.

Transport uses the documented [GenerateContent REST API](https://ai.google.dev/api/generate-content), including its function-response and structured-output fields. Gemini SDK/Fetch/AsynCodeBench integration work remains separate.
