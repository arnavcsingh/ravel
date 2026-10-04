# Ravel

## Ravel Live Lab

Set `GEMINI_API_KEY` in your ignored `.env`, install Go 1.26+, Python 3.11+,
Node 22.18+, and pnpm, then run:

```sh
pnpm install
pnpm demo:live
```

Open **http://localhost:4317/**. This command builds the debugger and Go runtime,
starts the optional Python live-demo controller, and enables the Spacetime
projection when `RAVEL_SPACETIME_ENABLED=true`. Check for an older Ravel process on
port 4317 first. The controller defaults to loopback port 4318; override with
`RAVEL_DEMO_PORT`. `RAVEL_DEMO_URL` is wired automatically by this launcher.
Fetch remains a separate `pnpm inspector` process with its optional Python
environment (see below).

Click **New Live Run**, configure **2–6 agents** with editable names and natural-language
tasks, and edit initial repository paths/content if needed. Select **Natural concurrency**,
**Interactive**, or **Deterministic Race Reproduction**, and choose Observe or Guard. Every start
creates a fresh Run ID and template workspace without deleting previous runs.
Use the run selector to inspect history. The scripted offline fixture is
separately labeled and is not the live Gemini demo.

**Natural concurrency** launches every configured agent concurrently, with no forced
ordering. Generic agents have no assigned output files or predeclared dependencies:
Gemini chooses what to inspect and write through the existing mediated tools.

**Interactive** creates all agents queued. Start them individually and edit a queued
task before starting it. Every agent has generic **Hold next commit / Release pending
commit**, **Pause / Resume**, **Pause after next observation**, and **Retry task** controls.
Pause takes effect at a tool boundary; it cannot interrupt a provider request already
in flight. A held candidate is a real immutable Go write intent, and release invokes
ordinary Go validation. Hold remains armed until you release it. Resume clears pause;
release clears hold, so an agent paused and held needs both actions. Finish with
**Finish run & analyze** after active agents have finished; unused queued agents can
remain unstarted. Retry is available for completed/failed agents while the experiment
is still open. Adding agents during an active run is deliberately unsupported.

**Deterministic Race Reproduction** preserves the verified three-agent sample.
Use **Load Sample Scenario** to fill its prompts and initial repository. This mode
holds Backend's real write intent, lets Database run, then
releases that intent through the ordinary Go validator and starts Frontend.
Scheduling uses synchronization
events, never timing sleeps. The model generates all mutations through mediated
tools. No hazard or semantic result is guaranteed: no mutation, an unchanged
write, and a clean run are legitimate outcomes shown in the UI.

For a fresh run from the terminal:

```sh
pnpm live start
pnpm live start --config examples/live-demo.json
pnpm live start --config examples/live-lab.json
pnpm live status --run RUN_ID
pnpm live control --run RUN_ID --agent contract --action hold
pnpm live control --run RUN_ID --agent contract --action start
pnpm live control --run RUN_ID --agent migration --action start
pnpm live control --run RUN_ID --agent contract --action release
pnpm live finish --run RUN_ID
pnpm live repair --run RUN_ID --hazard HAZARD_ID
```

`examples/live-demo.json` contains editable prompts and initial files, not agent
outputs. Reset means starting another run; do not delete `.ravel` or use the
offline archive-reset command to repeat a judge demo. Provider/controller status
is saved alongside runtime data; SQLite and immutable blobs remain authoritative
for observations, writes, provenance, replay, and hazard state.

Repair derives affected producing tasks and their order from the actual
provenance graph, reruns supported tasks with fresh Gemini transcripts against
current heads, and verifies active lineage afterward. New immutable versions
replace heads; historical versions remain. Cyclic or unsupported task lineages
are reported rather than silently repaired. A clean lineage does not prove all
generated code is semantically correct.

Repair attempts record `repairOf`, referencing an ended attempt of the same agent
and task. Go prevents those attempts from reading affected artifacts as inputs and
requires fresh source observations at publication. Regenerating an affected head
creates a new version with the actual repair provenance even when the generated
bytes are identical; ordinary byte-identical writes remain no-ops. Historical
version succession is retained separately from derivation, so it does not carry
stale impact into a freshly regenerated version.

For a 60–90 second presentation: load the sample and start a fresh Deterministic
Race Reproduction in Observe, point out
Backend's observation and held mutation, watch Database's new schema version and
the released stale write, inspect the input diff and Gemini assessment, click
**Replay race**, then **Repair affected tasks** and show the new versions and
zero active affected heads. Model latency and quota can extend this sequence;
the UI reports failures and preserves the trace. A follow-up Guard run shows
normal rejection and fresh-attempt retry. Natural mode demonstrates outcomes
without a forced interleaving.

For a judge-driven experiment:

1. Create an **Interactive / Observe** run with at least two agents. Give one a normal
   contract-generation task and leave another queued for the judge's requested change.
2. Arm **Hold next commit** on the first agent, then **Start** it. Inspect its actual
   observed resources and wait for **HELD** with a pending candidate.
3. Ask the judge for a change. Edit the queued agent's task, then start it. Wait for
   its real writes to advance resource heads.
4. Release the held agent. Start any downstream agent once the output exists.
5. Finish the run. Inspect the race, diff, focused **Replay race**, and Gemini
   semantic assessment. If the run is clean, report that honestly.
6. Use **Repair affected tasks** to rerun actual affected producing tasks in provenance
   order. Show immutable replacements and retained historical hazards. Repeat in Guard
   to show rejection and fresh-attempt retry.

Agent cards show current attempts, actual reads (including search observations), real
pending candidates, and scheduler state. Timeline selections and focused trace replay
highlight the agent and version in the causal graph. **Resource heads** expands to
immutable per-file history; the inspector shows sequence, short hash, and content.
The default incident graph emphasizes the observed version, its successor, the stale
output, and active descendants. Include historical incidents to show deeper history.

Previous verified Gemini rehearsals remain in ignored `.ravel/live-validation`.
For an emergency historical fallback, launch `pnpm demo:live --data .ravel/live-validation`,
select the recorded Observe run `62d60261-4fe2-58bb-4f49-d903a606c0cf`, and enable
**Include historical incidents** to inspect its repaired hazard, Gemini assessment,
blast radius, and focused replay. Label this as a historical trace, not a fresh run.

Health shows API readiness, Gemini configuration, Spacetime availability/SSE
fallback, optional Inspector readiness, and template availability. Configuration
is not a provider quota guarantee. Gemini authentication, timeout, quota, no-write,
and semantic-analysis errors are visible; semantic failure never erases runtime
facts. Set `RAVEL_AGENT_MODEL` and `RAVEL_SEMANTIC_MODEL` to override the default
`gemini-3.5-flash-lite`. Empty values use that default. A coding attempt has a
12-call budget, 45-second call timeout, and at most two Guard retries.

The launcher prefers an existing workspace `.ravel/sponsors-venv` on Windows unless
`RAVEL_PYTHON` is set. This keeps optional Inspector tests on the installed pinned SDK
instead of an unrelated partially configured system Python. The core still requires
no optional sponsor packages. Controller interruption preserves the runtime trace;
it does not silently resume agents or publish held generic candidates after restart.

Use `RAVEL_SPACETIME_ENABLED=false` for a fully working SSE-only demo. When
enabled, cloud publishing failures automatically fall back to SSE. Keep the
debugger page open; for Fetch also keep the ASI:One conversation with
`@ravel-inspector` and its local Inspector process running.

Ravel Inspector is an optional Python Agentverse mailbox agent, registered as
`@ravel-inspector`. It calls the existing Go HTTP API; concurrency decisions,
immutable history, replay, and repair remain in Go.

Install the optional environment with Python 3.12+:

```powershell
python -m venv .ravel/inspector-venv
.ravel/inspector-venv/Scripts/python.exe -m pip install -r python/requirements-inspector.txt
$env:RAVEL_PYTHON=(Resolve-Path .ravel/inspector-venv/Scripts/python.exe).Path
```

Start Ravel with `pnpm dev` or `pnpm start`. Set `AGENTVERSE_AGENT_URI` to the
existing agent's A2A registration URI in your ignored `.env`, and set
`RAVEL_API_BASE=http://localhost:4317` (change this if Ravel uses another port).
Run `pnpm inspector` and leave it running while evaluating or messaging the
agent in ASI:One. The SDK bridges ACP messages through Agentverse's mailbox to
the local A2A server; no publicly accessible localhost port is needed.

Before clicking Evaluate, check `http://localhost:9999/health`: `ready` must be
true, meaning initialization, registration, a running mailbox task and an
authenticated relay response were all observed. A local server listening is
insufficient. If registration returns HTTP 404 `Agent not found`, verify the
existing registration URI and corresponding public address with Agentverse;
the Inspector never generates a replacement identity or treats that response
as success. `pnpm inspector --local` runs local A2A without registration; it
intentionally reports `ready=false`. Use `--port 9998` for a second local test.

In one ASI:One conversation with `@ravel-inspector`, send:

1. `Analyze my latest Ravel run`
2. `Show the blast radius`
3. `Replay the race`
4. `Repair it`

The responses use deterministic API facts, identify affected artifacts,
preserve ordered replay, and confirm replacement versions only after fetching
updated state. Repair failures and unknown outcomes are reported without
automatic mutation retries. Historical hazards remain available after repair.
Each conversation has its own selected run and hazard. All seven tools are
also available using explicit messages such as
`{"tool":"get_hazard","arguments":{"hazard_id":"your-hazard-id"}}`:
`get_latest_run`, `get_run`, `get_hazards`, `get_hazard`, `get_blast_radius`,
`get_replay`, `repair_hazard`.

For local JSON-RPC testing, POST to `http://localhost:9999/` with
`A2A-Version: 1.0`, method `SendMessage`, and a user message containing text
parts. Replies are A2A tasks in `INPUT_REQUIRED`, with response text in the task's
status message. Reuse both the returned `contextId` and task `id` for subsequent
requests. This lets Agentverse retain the selected hazard across ACP messages.
Optional transport
tests run when the Inspector requirements are installed; the normal runtime
and frontend work without them. `ASI_ONE_API_KEY` is only needed for separate
ASI:One API checks, not mailbox registration. Keep it and the URI out of Git.

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

### Official AsynCodeBench baseline launcher

The external benchmark is pinned to `566c32b6f4ad209ecfe95f10970b02d4b79289c1`, with OpenHands SDK `944284310d9a5f1ccad0ef8c2d7c4c38342b9952` (packages 1.29.2). On Windows, use Ubuntu-22.04 in WSL with Docker Desktop integration:

```powershell
$env:RAVEL_WSL_DISTRO = 'Ubuntu-22.04'
$env:RAVEL_PYTHON = (Resolve-Path .ravel/sponsors-venv/Scripts/python.exe).Path
pnpm benchmark:upstream setup
pnpm benchmark:upstream check
pnpm benchmark:upstream dry-run
pnpm benchmark:upstream runner-check
pnpm benchmark:upstream doctor
pnpm benchmark:upstream run --task asyncodebench:cachetools --protocol single
```

`GEMINI_API_KEY` is read from ignored `.env`. The default is the same Gemini 3.5 Flash-Lite model through LiteLLM's native `gemini/gemini-3.5-flash-lite` transport at `https://generativelanguage.googleapis.com/v1beta`. This preserves tool-call thought signatures across the pinned SDK's message conversion. An explicitly configured `LLM_API_KEY`, `LLM_MODEL`, and `LLM_BASE_URL` takes precedence. Credentials travel through environment variables, and known secrets are redacted from launcher output.

Default budgets are 100 manager iterations, 100 specialist iterations, and two chat rounds. The frozen `async_manager` profile uses **30 manager iterations per event, 100 total per task**, with the same specialist cap and chat rounds; the launcher selects its required event cap automatically. Its secondary token/time/intervention limits remain upstream-controlled. `--protocol` also accepts `serial_specialists`, `async_private`, `caid_manager`, and `async_manager`. Raw bundles remain under ignored `.ravel/benchmark-source/native-*`; UTF-8 launcher logs are under `.ravel/benchmark-source/reports/`. Setup fetches the exact historical Git object required by Async-Manager's frozen-source check when missing, while preserving the tested HEAD.

`pnpm benchmark:upstream results` exports `.ravel/benchmark-source/comparison.json` and prints a native-results table. It includes a comparison row only when the saved upstream bundle records valid instrumentation and official aggregate eligibility, and every recorded artifact size and SHA-256 checksum matches. Excluded attempts remain diagnostic records; missing metrics remain null. Ravel metrics remain null until a genuine adapter is available.

The upstream online `doctor` uses OpenAI-style HTTP endpoints. For native Gemini, the launcher runs its offline infrastructure checks, then a real two-turn echo-tool diagnostic through LiteLLM and the pinned SDK's message conversion. This verifies tool-result continuation and signature preservation; it is not a benchmark score. The diagnostic passed after a transient per-minute Gemini input-token quota reset. All five protocol dry runs and the adapter/doctor contract tests passed; the separate event HTTP smoke exceeded its upstream five-second startup deadline on `/mnt/c`, so `runner-check` has not fully passed.

Verified official subset results use one `asyncodebench:cachetools` repetition per protocol with the built-in OpenHands scaffold and identical model and budgets. The `--release v0.4` launcher resolves cachetools to its upstream v0.3 scenarios; saved bundles record that resolution. The reported bundles are valid, match the official execution profile, have complete provenance, and record `official_aggregate=true`.

| Protocol      | Tests   | ADPR      | Strict DRS step | Normalized DRS | Harness wall time | Tokens    | Reported cost |
| ------------- | ------- | --------- | --------------- | -------------- | ----------------- | --------- | ------------- |
| single        | 215/215 | 5/5 = 1.0 | 1               | unavailable    | 314.16 s          | 793,306   | $0.06445      |
| async_private | 215/215 | 5/5 = 1.0 | 2–4             | unavailable    | 658.59 s          | 1,974,772 | $0.20837      |
| caid_manager  | 215/215 | 5/5 = 1.0 | 2–4             | unavailable    | 957.10 s          | 2,901,198 | $0.31705      |
| async_manager | 215/215 | 5/5 = 1.0 | 2–4             | unavailable    | 858.18 s          | 2,396,288 | $0.27274      |

Single made 22 model calls, async_private 57, caid_manager 80, and async_manager 78. Token counts include cached input; the harness cost is a reported estimate. Harness wall time excludes launcher and SDK startup overhead, and upstream excludes deterministic worktree source-build preparation from multi-agent runtime. The normalized DRS field was unavailable and is not substituted with ADPR or dependency-resolution step. Machine-readable subset results are saved in `benchmarks/results/cachetools-native.json`; complete local artifacts are in ignored `.ravel/benchmark-source/native-*`. These are four admitted executions of one task with one repetition per protocol, not a full campaign or published leaderboard result. The Ravel adapter remains unimplemented.

There is no Ravel-versus-baselines comparison yet. The earlier OpenAI-compatible Gemini attempt ended with a missing thought signature; the initial native-transport attempt used an incorrect URL prefix and made zero model calls. Both bundles are **invalid**, and their evaluator counts are diagnostic only. Ravel mediation at the benchmark's private-workspace integration boundary is still pending. Keep these infrastructure attempts separate from the synthetic benchmark above.
