# Ravel

## Causal concurrency debugging for asynchronous coding agents

**Hackathon:** MHacks 2026  
**Status:** Implementation specification  
**Primary track:** Actually Intelligent  
**Working principle:** Build the complete deterministic Ravel debugger first. External APIs and sponsor integrations must never block the core product.

---

# 1. What Ravel is

Ravel is a concurrency debugger for multiple coding agents operating asynchronously on shared repository state.

The core failure:

```text
Agent A observes schema.sql@17

Agent B changes:
schema.sql@17 → schema.sql@18

Agent A later produces:
api/types.ts@5

using assumptions derived from schema.sql@17.

Agent C reads:
api/types.ts@5

and produces:
frontend/client.ts@9
```

There may be no Git merge conflict.

Ravel should detect:

```text
schema@17
    │
    │ stale derivation
    ▼
types@5
    │
    │ downstream propagation
    ▼
client@9
```

and reconstruct exactly how the failure unfolded.

5-second pitch:

> ThreadSanitizer for coding agents.

More precise description:

> A causal concurrency debugger for asynchronous coding-agent systems.

---

# 2. Product goal

Given concurrent coding agents, Ravel should answer:

1. What shared state did each agent observe?
2. Which version did it observe?
3. Did that state change before the agent used it?
4. What artifact did the stale observation contribute to?
5. Which other artifacts consumed the stale output?
6. What is the downstream blast radius?
7. What exact interleaving caused the failure?
8. Does the state change actually matter semantically?

---

# 3. Core distinction

Ravel is not primarily a concurrency-control system.

Systems such as locks, leases, workspace isolation, and optimistic concurrency try to prevent bad interleavings.

Ravel's primary job is:

```text
failure
   ↓
diagnosis
   ↓
causal reconstruction
   ↓
blast radius
   ↓
replay
```

Optional Guard/Repair behavior comes later.

---

# 4. Architectural principles

## 4.1 Model agnostic

Ravel must not depend on Gemini, Codex, Claude, OpenHands, or any model-provider internals.

Core Ravel sees only:

```text
OBSERVE RESOURCE
WRITE RESOURCE
COMMAND
TOOL RESULT
TASK
AGENT
RESOURCE VERSION
```

Provider/framework behavior belongs in adapters.

---

## 4.2 Deterministic core

The following must never require an LLM:

- event ordering
- resource identity
- resource versioning
- content hashing
- observation tracking
- stale detection
- provenance traversal
- blast-radius computation
- trace replay

AI is used only for semantic questions.

---

## 4.3 Version-level reasoning

Ravel reasons about:

```text
schema.sql@17
```

not merely:

```text
schema.sql
```

Each resource version is immutable.

Repair creates new versions.

Historical versions never change status retroactively.

---

## 4.4 Events are facts

Instrumentation records facts:

```text
OBSERVE_RESOURCE
WRITE_COMMIT
COMMAND_START
COMMAND_END
TOOL_RESULT
```

Analysis derives:

```text
STALE_HAZARD
DOWNSTREAM_AFFECTED
SEMANTIC_CONFLICT
```

Raw events must remain immutable so old traces can be reanalyzed later.

---

# 5. Technology stack

Use a TypeScript monorepo.

Required:

```text
Node 20+
TypeScript
pnpm workspaces
Fastify
React
Vite
Zod
SQLite
better-sqlite3
Vitest
React Flow
```

Local storage:

```text
SQLite
+
SHA-256 content-addressed blob directory
```

External systems must be optional integrations.

Do not introduce:

```text
Supabase
Neon
Redis
Kafka
Neo4j
Docker
Kubernetes
```

into the core implementation unless explicitly instructed later.

---

# 6. Repository structure

Use approximately:

```text
ravel/
├── apps/
│   ├── server/
│   └── web/
│
├── packages/
│   ├── core/
│   │   ├── domain/
│   │   ├── runtime/
│   │   ├── storage/
│   │   ├── observations/
│   │   ├── provenance/
│   │   ├── detection/
│   │   └── replay/
│   │
│   └── shared/
│       ├── schemas/
│       └── dto/
│
├── integrations/
│   ├── gemini/
│   ├── spacetime/
│   └── fetch/
│
├── demo/
│   ├── workspace/
│   ├── scripted-agents/
│   └── scenarios/
│
├── tests/
├── docs/
│   ├── DESIGN.md
│   └── IMPLEMENTATION_STATUS.md
│
├── .env.example
└── README.md
```

Critical rule:

`packages/core` must have no dependencies on:

```text
Gemini
OpenAI
Fetch
SpacetimeDB
Fastify
React
```

Core Ravel is a deterministic systems library.

---

# 7. Core execution model

## Run

One complete multi-agent execution.

## Agent

An independently executing worker.

Examples:

```text
Database Agent
Backend Agent
Frontend Agent
```

## Task

A logical assignment.

Example:

```text
Synchronize API types with the current database schema.
```

## TaskAttempt

A specific execution of a Task.

```text
Backend Task
    Attempt #1
    Attempt #2
```

Rerunning creates another TaskAttempt.

## Resource

For v0:

```text
repository-relative file path
```

Example:

```text
api/types.ts
```

## ResourceVersion

Immutable state of a resource.

Example:

```text
api/types.ts@5
```

## Observation

A version explicitly surfaced to an agent.

## ProvenanceEdge

Evidence that one resource version may have contributed to another.

## Hazard

A deterministic stale-state finding.

---

# 8. Resource identity

For v0:

```text
resource_id = normalized repository-relative path
```

Examples:

```text
schema.sql
api/types.ts
frontend/client.ts
```

Do not solve:

- symlink aliasing
- inode identity
- hard links
- arbitrary filesystem mounts

for the hackathon.

---

# 9. Resource versions

Each resource has:

```text
generation
content_hash
immutable content blob
previous_version
producer_attempt
creation event
```

Example:

```text
schema.sql@17
    ↓
schema.sql@18
    ↓
schema.sql@19
```

Use SHA-256 content hashes.

Generation answers:

> Which logical version came later?

Hash answers:

> Are the contents actually different?

---

# 10. No-op writes

If a write produces identical contents:

```text
hash(candidate) == hash(current_head)
```

do not create a meaningful new version.

Treat it as a no-op.

---

# 11. Tombstones

Resources may have versions representing absence.

Example:

```text
config.ts@3 CONTENT
        ↓
config.ts@4 TOMBSTONE
```

This allows observations of existence/nonexistence to be versioned consistently.

Implementation can remain minimal.

---

# 12. Blob store

Store immutable file contents using:

```text
.ravel/
├── ravel.db
└── blobs/
    ├── <sha256>
    └── ...
```

A ResourceVersion references a blob hash.

Identical content can therefore share storage.

---

# 13. Logical repository versus workspace

The authoritative repository state is:

```text
resource_heads
+
resource_versions
+
blob store
```

The actual workspace on disk is a materialized view.

Conceptually:

```text
SQLite heads
     │
     ▼
immutable blobs
     │
     ▼
workspace materializer
     │
     ▼
demo/workspace/
```

The mutable workspace itself is not the source of truth.

---

# 14. RunCoordinator

Every active run has one authoritative:

```text
RunCoordinator
```

It owns:

```text
runtime sequencing
resource heads
observation frontiers
shared-state boundary ordering
```

Agent model inference occurs outside the coordinator lock.

Only shared-state boundary operations need serialization.

---

# 15. Ordering

Maintain three forms of ordering.

## runtime_seq

Global order of Ravel boundary operations within one run.

Example:

```text
104 Backend OBSERVE schema@17
105 Database WRITE schema@18
106 Backend WRITE types@5
```

## agent_seq

Program order within one agent.

## generation

Version order within one resource.

Correctness must not rely on wall-clock timestamps.

Wall-clock time exists for UI display only.

---

# 16. Runtime critical section

Use a per-run lock.

The lock protects only short operations such as:

```text
observe
validate write
commit write
allocate runtime_seq
advance resource head
update frontier
```

Do not hold the lock during:

```text
LLM inference
semantic analysis
builds/tests
general computation
```

---

# 17. Agent session

Agents operate through a bound session:

```text
RavelSession
```

The session already knows:

```text
run_id
agent_id
task_id
attempt_id
```

An agent must not manually provide its identity on every call.

---

# 18. Core mediated operations

Support:

```text
observeResource(path)

writeResource(path, contents)

applyPatch(path, baseVersion, patch)

listResources()

searchRepository(query)

runCommand(command)
```

Initially, repository mutations must happen only through:

```text
writeResource
applyPatch
```

Do not allow arbitrary shell mutation of tracked files in v0.

---

# 19. Observe semantics

`observeResource(path)` must atomically:

1. normalize path;
2. resolve current head;
3. allocate `runtime_seq`;
4. create `OBSERVE_RESOURCE`;
5. create Observation;
6. update TaskAttempt frontier;
7. commit durable state;
8. return immutable content.

If another agent writes immediately afterward, the observation still correctly refers to the old version.

---

# 20. Observation frontier

Each TaskAttempt maintains:

```text
latest observation per resource
```

Example:

```text
Backend attempt #1

schema.sql → @17
types.ts   → @4
router.ts  → @8
```

When the same resource is re-observed:

```text
schema.sql@18
```

it replaces:

```text
schema.sql@17
```

in the frontier.

---

# 21. Self writes

If an agent successfully produces:

```text
types.ts@5
```

its frontier automatically becomes:

```text
types.ts → @5
```

The agent knows what it just wrote.

---

# 22. Provenance

Every write snapshots relevant observations from the TaskAttempt.

Example:

```text
OBSERVE schema@17
OBSERVE types@4

WRITE types@5
```

creates:

```text
schema@17
    │ MODEL_OBSERVATION
    ▼
types@5

types@4
    │ SAME_RESOURCE_BASE
    ▼
types@5
```

Ravel acknowledges that model reasoning provenance is inherently approximate.

Task-span provenance may overapproximate dependencies.

---

# 23. Evidence types

Use explicit evidence rather than pretending all dependencies are certain.

Initial types:

```text
MODEL_OBSERVATION
SAME_RESOURCE_BASE
DECLARED_COMMAND_INPUT
PROCESS_READ
SEMANTIC_MATCH
```

For the MVP, primarily use:

```text
MODEL_OBSERVATION
SAME_RESOURCE_BASE
```

---

# 24. Provenance DAG invariant

For every derivation edge:

```text
creation_seq(source) < creation_seq(target)
```

The graph must be acyclic.

A cycle indicates an implementation bug.

---

# 25. Separate version succession from provenance

These are different:

```text
schema@17 --VERSION_SUCCESSOR--> schema@18
```

versus:

```text
schema@17 --DERIVED_FROM--> types@5
```

Blast radius follows only:

```text
DERIVED_FROM
```

Never follow `VERSION_SUCCESSOR`.

---

# 26. WriteIntent

When an agent produces candidate output:

```text
writeResource("api/types.ts", candidate)
```

capture:

```text
PendingMutation / WriteIntent
```

containing:

```text
target resource
candidate bytes
candidate hash
attempt identity
snapshot of dependency frontier
same-resource base
```

Candidate generation itself happens outside the coordinator lock.

---

# 27. Atomic validation + commit

This is a critical invariant.

Do not:

```text
validate
unlock
commit later
```

Validation and commit must happen under one logical critical section.

Otherwise Ravel itself has a TOCTOU race.

Inside the critical section:

```text
read current heads
compare against captured observations
determine stale inputs
allocate runtime_seq
create ResourceVersion
create WRITE_COMMIT
create provenance edges
create hazards
advance resource head
update writer frontier
commit SQLite transaction
materialize workspace
```

Then release lock.

---

# 28. Stale detection

Suppose Backend observed:

```text
schema@17 hash=A
```

At validation:

```text
schema head = @18 hash=B
```

Since:

```text
A != B
```

the observation is stale.

If:

```text
hash(observed) == hash(current)
```

then the observation is content-valid even if generations differ.

---

# 29. Stale interval

Hazards should record:

```text
observed_version
stale_since_version
validation_head_version
consumer_version
```

`stale_since_version` is the beginning of the current continuous stale interval.

This handles change/revert/change histories correctly.

---

# 30. Hazard meanings

Keep these concepts separate.

## STALE

Artifact was produced while one of its recorded observations differed from current shared state.

Deterministically provable.

## DOWNSTREAM_AFFECTED

Artifact is downstream of a stale-derived artifact in recorded provenance.

## SEMANTIC_CONFLICT

The stale difference materially contradicts or invalidates the derived output.

Requires stronger evidence or AI analysis.

Do not equate:

```text
STALE == INCORRECT
```

---

# 31. Multiple hazards

A single consumer may have several stale inputs.

Example:

```text
schema@17 → types@5
config@3  → types@5
```

Create independent Hazard objects.

Do not store only:

```text
types@5.stale = true
```

---

# 32. Blast radius

Given a stale consumer version:

```text
types@5
```

traverse outgoing provenance edges.

Example:

```text
types@5
   ├── serializer@3
   └── client@9
          │
          ▼
        tests@4
```

Use ordinary BFS/DFS.

Maintain two concepts:

### Historical blast radius

All descendants in the run.

### Active blast radius

Affected versions currently relevant to active repository heads.

UI defaults to active.

---

# 33. Observe mode

Default hackathon mode.

Ravel detects the stale write but allows it to commit.

This lets the debugger show:

```text
race
↓
bad derived artifact
↓
downstream propagation
```

Primary demo uses Observe mode.

---

# 34. Guard mode

Optional later feature.

Before publishing candidate work:

```text
validate observations
```

If stale:

```text
invalidate attempt
retry
```

Strict Guard mode should be deterministic.

Do not require semantic AI to decide whether validation succeeds.

---

# 35. Repair semantics

Repair operates on TaskAttempts.

Example:

```text
Backend attempt #1
schema@17 → types@5 stale

Frontend attempt #1
types@5 → client@9 downstream
```

Repair produces:

```text
Backend attempt #2
schema@18 → types@6 clean

Frontend attempt #2
types@6 → client@10 clean
```

Historical versions remain visible.

---

# 36. Event model

Common event fields:

```text
event_id
run_id
runtime_seq

agent_id
task_id
attempt_id

agent_seq
kind

wall_time
monotonic_time

resource_id?
version_id?
command_id?

payload
```

Core events:

```text
RUN_START
RUN_END

AGENT_START
AGENT_END

TASK_ATTEMPT_START
TASK_ATTEMPT_END

OBSERVE_RESOURCE

WRITE_COMMIT
DELETE_COMMIT
RENAME_COMMIT

COMMAND_START
COMMAND_END

TOOL_RESULT
```

---

# 37. SQLite schema

Implement approximately:

```text
runs
agents
tasks
task_attempts

events

resources
resource_versions
resource_heads

observations
attempt_frontier

provenance_edges
hazards

semantic_assessments
```

Use migrations.

All rows should use opaque generated IDs.

---

# 38. Transaction requirements

One logical Ravel shared-state mutation should create/update all related records in one SQLite transaction.

For a write this includes:

```text
WRITE_COMMIT
ResourceVersion
resource head
provenance edges
hazards
writer frontier
```

Never partially commit these pieces.

---

# 39. Workspace materialization

After durable logical commit:

```text
write temp file
close
atomic rename over destination
```

The DB/blob history is authoritative.

If workspace materialization fails, the workspace can be rebuilt from current resource heads.

---

# 40. Debugger projector

Frontend must not derive concurrency semantics itself.

Backend exposes:

```text
DebuggerProjector
```

producing:

```text
DebuggerSnapshot
HazardDetail
ReplayPlan
```

---

# 41. DebuggerSnapshot

Contains:

```text
run
agents
timeline
graph
hazards
current_runtime_seq
```

---

# 42. Timeline

One horizontal lane per agent.

Default timeline displays only meaningful events:

```text
OBSERVE
WRITE
HAZARD
```

Example:

```text
TIME ─────────────────────────────────────>

Backend   READ schema@17 ───────── WRITE types@5 ⚠
                    ╲
Database             ╲ WRITE schema@18
                      ╲
Frontend                            READ types@5
                                       │
                                       ▼
                                  WRITE client@9
```

---

# 43. Hazard window visualization

The timeline should show when an observation became stale.

Example:

```text
Backend:

READ schema@17
      │
──────●─────────●════════════════●────
                ▲                ▲
         schema@18 written    types@5 written

              stale interval
```

This is a major Ravel visualization.

---

# 44. Causal graph

Graph primarily contains ResourceVersions.

Example:

```text
schema@17
    │
    ▼
types@5
    │
    ▼
client@9
```

Version-successor edges should appear visually different:

```text
schema@17 - - - -> schema@18
```

---

# 45. UI states

Use:

```text
CLEAN
STALE_INPUT
DOWNSTREAM
SEMANTIC_CONFLICT
```

Keep visuals understandable.

Do not expose every internal confidence/evidence detail in the first view.

---

# 46. Incident inspector

Selecting a hazard should immediately show:

```text
Stale dependency race

Backend observed:
schema.sql@17

Database changed:
schema.sql@18

Backend then produced:
api/types.ts@5

Downstream:
frontend/client.ts@9

[View diff]
[Replay race]
```

Semantic explanation appears beneath deterministic facts.

---

# 47. Diffs

Ravel must display the relevant resource diff.

For the primary demo:

```diff
CREATE TABLE users (
-    id INTEGER PRIMARY KEY,
+    id UUID PRIMARY KEY,
     email TEXT NOT NULL
);
```

and stale output:

```ts
interface User {
  id: number;
  email: string;
}
```

This should make the bug understandable without explanation.

---

# 48. Replay definitions

Do not claim deterministic LLM replay.

Ravel supports:

## Trace replay

Deterministically replays recorded events.

Must have.

## Environment replay

Reconstructs resource versions from stored blobs.

MVP+.

## Agent re-execution

Runs an agent again.

May produce different outputs.

Call it:

```text
rerun
retry
re-execute
```

not deterministic replay.

---

# 49. Focused Race Replay

For a selected Hazard, calculate a causal slice.

Example:

```text
Backend OBSERVE schema@17
Database WRITE schema@18
Backend WRITE types@5
Frontend OBSERVE types@5
Frontend WRITE client@9
```

Exclude unrelated execution events.

---

# 50. ReplayPlan

Each replay step already contains presentation meaning:

```text
runtime_seq
agent
action
description
annotation
highlight_nodes
highlight_edges
open_stale_window
close_stale_window
```

The frontend simply animates steps.

---

# 51. API

Initial HTTP surface:

```text
GET /runs/{runId}/debugger

GET /hazards/{hazardId}

GET /hazards/{hazardId}/replay

GET /versions/{versionId}/content

GET /runs/{runId}/stream
```

Later:

```text
POST /hazards/{hazardId}/analyze
POST /hazards/{hazardId}/repair
```

Use SSE for default live updates.

---

# 52. Demo repository

Create a tiny repository containing:

```text
schema.sql
api/types.ts
frontend/client.ts
```

Initial:

`schema.sql`

```sql
CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL
);
```

`api/types.ts`

```ts
export interface User {
  id: number;
}
```

Database Agent eventually changes:

```diff
- id INTEGER PRIMARY KEY
+ id UUID PRIMARY KEY
```

Backend Agent, reasoning from the old schema, writes:

```ts
export interface User {
  id: number;
  email: string;
}
```

This creates a non-noop stale artifact.

Frontend Agent then produces code accepting:

```ts
id: number;
```

based on stale backend types.

---

# 53. Controlled demo scheduler

Do not rely on sleeps.

Use an event-driven scheduler.

Desired schedule:

```text
1. Start Backend.

2. Backend observes schema@17.

3. Backend reasons and submits WRITE_INTENT for types.ts.

4. HOLD the pending mutation before validation/commit.

5. Run Database.

6. Database commits schema@18.

7. RELEASE Backend pending mutation.

8. Atomic validation sees:
   observed schema@17
   current schema@18.

9. Observe mode commits types@5 and creates Hazard.

10. Start Frontend.

11. Frontend observes types@5.

12. Frontend writes client@9.
```

This guarantees the concurrency failure while keeping every event genuine.

---

# 54. Scripted agents first

External APIs must not be required during early implementation.

Create deterministic scripted agents implementing the same adapter/environment interface.

For example:

```text
ScriptedBackendAgent
ScriptedDatabaseAgent
ScriptedFrontendAgent
```

They perform the exact demo operations programmatically.

The entire debugger must work using these agents.

This is critical.

---

# 55. Provider abstraction

Define an agent/provider interface but do not require API credentials.

Example conceptual boundary:

```text
AgentDriver
    run(task, RavelSession)
```

Implementations:

```text
ScriptedAgentDriver     REQUIRED
GeminiAgentDriver       OPTIONAL / later
```

If:

```text
GEMINI_API_KEY
```

is absent, the application must still build, test, and run the scripted demo.

---

# 56. Gemini integration placeholder

Create the integration package and interfaces, but do not block implementation on credentials.

Expected environment variables:

```text
GEMINI_API_KEY=
RAVEL_AGENT_MODEL=
RAVEL_SEMANTIC_MODEL=
```

If missing:

```text
Gemini integration disabled.
```

No crash.

Future Gemini coding agents must interact with repository state only through Ravel-mediated functions.

Never expose unrestricted filesystem mutation.

---

# 57. Semantic analyzer

Define:

```text
SemanticAnalyzer
```

with implementations:

```text
HeuristicSemanticAnalyzer
GeminiSemanticAnalyzer
```

The heuristic implementation enables the demo without APIs.

For the schema demo, deterministic/heuristic logic may detect obvious type transitions for fixture data.

The Gemini analyzer later receives:

```text
old resource content/diff
new resource content/diff
consumer artifact
task metadata
```

and returns:

```text
IRRELEVANT
POSSIBLE
LIKELY
CONFLICT
```

plus:

```text
reason
affected_elements
```

No numeric fake confidence percentages.

---

# 58. External integrations architecture

All sponsor/provider integrations must be optional.

Structure:

```text
core
  │
  └── emits facts
         │
         ▼
integration interfaces
     /       |       \
 Gemini   Spacetime  Fetch
```

None may modify core semantics.

---

# 59. SpacetimeDB placeholder

Create:

```text
LiveProjectionSink
```

Implement:

```text
NoopLiveProjectionSink
SseLiveProjectionSink
```

and stub:

```text
SpacetimeLiveProjectionSink
```

Feature variables:

```text
RAVEL_SPACETIME_ENABLED=false
RAVEL_SPACETIME_URI=
RAVEL_SPACETIME_DATABASE=
```

Core Ravel must work entirely with SSE.

If Spacetime credentials/configuration become available later, implement it without changing core runtime.

---

# 60. Fetch placeholder

Fetch integration is a separate external agent.

Do not put Fetch abstractions in core.

Future concept:

```text
ASI:One
   ↓
Ravel Inspector Agent
   ↓
Ravel HTTP API
```

It can eventually:

```text
inspect run
explain hazard
request replay
trigger repair
```

Placeholder env:

```text
ASI_ONE_API_KEY=
```

Missing key must not affect the main app.

---

# 61. Supabase / Neon

Do not use either initially.

Do not require:

```text
SUPABASE_URL
SUPABASE_KEY
DATABASE_URL
NEON_URL
```

SQLite is intentional and sufficient.

If a sponsor integration is later explicitly requested, introduce it behind a storage/projection interface without replacing the core semantics.

---

# 62. Environment file

Create `.env.example` containing:

```bash
# Ravel runs locally without external API keys.

# Gemini - optional
GEMINI_API_KEY=
RAVEL_AGENT_MODEL=
RAVEL_SEMANTIC_MODEL=

# SpacetimeDB - optional
RAVEL_SPACETIME_ENABLED=false
RAVEL_SPACETIME_URI=
RAVEL_SPACETIME_DATABASE=

# Fetch - optional
ASI_ONE_API_KEY=
```

Missing values must never prevent:

```text
install
build
test
scripted demo
frontend
backend
```

---

# 63. Milestone 1 — deterministic core

Implement first:

1. pnpm workspace.
2. shared TypeScript/Zod schemas.
3. SQLite migrations.
4. blob store.
5. RunCoordinator.
6. resources / versions / heads.
7. agents / tasks / attempts.
8. observations and frontier.
9. `observeResource()`.
10. `writeResource()`.
11. atomic validation + commit.
12. provenance edges.
13. stale detector.
14. blast-radius traversal.
15. workspace materialization.

No React.

No model APIs.

No sponsors.

---

# 64. Milestone 1 acceptance test

Run entirely deterministically:

```text
Backend observes schema@17.

Database writes schema@18.

Backend writes types@5.

Frontend observes types@5.

Frontend writes client@9.
```

Assert:

```text
schema@18 is head

types@5 is head

client@9 is head

schema@17 -> types@5 provenance exists

types@5 -> client@9 provenance exists

exactly one direct schema hazard exists on types@5

client@9 is in blast radius

all historical blobs are retrievable

runtime_seq is deterministic

provenance graph is acyclic
```

Do not proceed until this passes.

---

# 65. Milestone 2 — debugger projection

Implement:

```text
DebuggerSnapshot
TimelineEvent
GraphNode
GraphEdge
HazardSummary
HazardDetail
ReplayPlan
```

Expose HTTP endpoints.

Test using deterministic fixtures.

---

# 66. Milestone 3 — frontend

Build React against fixture DTOs first.

Required:

```text
main debugger screen
agent timeline
stale-window visualization
causal graph
incident inspector
diff view
Replay Race animation
```

Use React Flow for graph.

Do not spend time on login/settings/user management.

---

# 67. Milestone 4 — wire frontend to backend

Replace fixtures with:

```text
GET /runs/{id}/debugger
SSE run stream
hazard endpoints
```

Scripted demo should now execute live and animate in browser.

---

# 68. Milestone 5 — controlled concurrency scheduler

Implement event-driven scheduler hooks around pending mutations.

Required capability:

```text
waitForEvent(...)
holdMutation(...)
releaseMutation(...)
```

No sleeps for correctness.

Demonstrate guaranteed stale-write schedule.

---

# 69. Milestone 6 — scripted polished demo

The primary demo must work with zero API credentials.

One command should start everything.

Prefer something like:

```bash
pnpm demo
```

which:

```text
starts backend
starts frontend
initializes demo workspace
runs controlled scripted agents
produces one hazard
produces blast radius
allows race replay
```

Create another command to reset demo state.

---

# 70. Milestone 7 — provider integration

Only after the scripted demo is polished.

Implement provider interfaces first.

If API credentials are absent:

```text
skip integration
```

Do not stop.

When Gemini becomes available:

```text
GeminiAgentDriver
GeminiSemanticAnalyzer
```

can be completed.

---

# 71. Milestone 8 — semantic analysis

Build the interface and UI now.

Use heuristic/mock implementation without API.

When provider becomes available, replace implementation via dependency injection.

Semantic analysis updates hazard annotations asynchronously.

Ravel must show deterministic hazard immediately without waiting for AI.

---

# 72. Milestone 9 — sponsor integrations

Only after primary demo works.

Priority:

```text
SpacetimeDB
then Fetch
```

Both must remain feature-flagged.

Do not compromise core architecture to qualify for sponsor prizes.

---

# 73. Milestone 10 — Guard/Repair

If time remains.

Implement:

```text
invalidate task attempt
rerun task
produce clean replacement versions
rerun downstream attempts
```

Do not attempt arbitrary generic filesystem rollback.

---

# 74. Benchmark

Stretch goal only after polished demo.

Target:

```text
AsynCodeBench
```

Compare:

```text
Ravel OFF
vs
Ravel Guard ON
```

Potential metrics:

```text
success rate
dependency pass rate
hazards detected
attempts rerun
runtime overhead
token overhead
recomputation
```

Do not block hackathon submission on benchmark integration.

---

# 75. UI priority

Primary screen:

```text
┌──────────────────────────────────────────────┐
│ Ravel               1 race detected         │
├──────────────────────────────────────────────┤
│ TIMELINE                                     │
│                                              │
│ Backend    READ schema@17 ---- WRITE types⚠ │
│                      \                       │
│ Database              WRITE schema@18       │
│                                              │
│ Frontend                     READ types@5    │
│                                  ↓           │
│                              WRITE client@9  │
├──────────────────────────┬───────────────────┤
│ CAUSAL GRAPH             │ INCIDENT          │
│                          │                   │
│ schema@17                │ Backend observed  │
│    ↓                     │ schema@17         │
│ types@5 ⚠               │                   │
│    ↓                     │ DB produced @18   │
│ client@9                 │                   │
│                          │ [Diff] [Replay]   │
└──────────────────────────┴───────────────────┘
```

Do not build multiple complicated pages.

---

# 76. Demo acceptance criteria

A judge should understand in under 10 seconds:

```text
one agent read old state
another changed it
the first produced stale code
another agent propagated it
Ravel caught the causal chain
```

The UI must show:

- agents;
- resource versions;
- stale interval;
- exact conflict;
- downstream blast radius;
- focused replay.

---

# 77. Non-goals

Do not spend implementation time solving:

```text
perfect semantic provenance
symbol-level dependencies
kernel-level tracing
arbitrary shell mutation
distributed multi-machine execution
production authentication
multi-tenant infrastructure
perfect deterministic LLM replay
generic rollback
every coding-agent framework
```

---

# 78. Error philosophy

When external services are unavailable:

```text
log warning
disable integration
continue
```

When optional environment variables are missing:

```text
continue
```

When deterministic core invariants fail:

```text
fail loudly
```

Examples of core invariant failures:

```text
provenance cycle

unknown ResourceVersion

resource head references missing version

runtime_seq duplicate

attempt accesses resource outside active run

partial logical transaction
```

---

# 79. Testing philosophy

Tests must prioritize semantics.

Required unit/integration coverage:

```text
version creation

no-op writes

content reversion

observation frontier refresh

self-write frontier advancement

stale detection

same-resource stale base

multiple hazards

blast-radius traversal

provenance DAG cycle rejection

atomic ordering under concurrent writes

trace replay

workspace reconstruction
```

Include concurrent tests using Promise-based synchronization rather than sleeps.

---

# 80. Implementation status tracking

Create:

```text
docs/IMPLEMENTATION_STATUS.md
```

After every milestone update:

```text
Completed
Tests
Known issues
Next milestone
```

Codex should use this file to recover context if interrupted.

---

# 81. Codex execution instructions

Once implementation begins:

1. Read this entire file.
2. Do not ask for API keys.
3. Do not wait for Gemini, SpacetimeDB, Fetch, Supabase, Neon, or deployment access.
4. Build all provider/sponsor integrations behind interfaces.
5. Stub/disable them when configuration is absent.
6. Continue automatically through milestones while tests pass.
7. After each milestone:
   - run formatting;
   - run type checking;
   - run tests;
   - fix failures;
   - update `IMPLEMENTATION_STATUS.md`.
8. Do not skip the deterministic acceptance test.
9. Do not replace SQLite.
10. Do not redesign the concurrency semantics without documenting a concrete contradiction in this specification.
11. Prefer a polished core/demo over more integrations.
12. If time becomes constrained, cut features in this order:

```text
Fetch
benchmark
automatic repair
SpacetimeDB
command provenance
environment replay
```

Never cut:

```text
resource versioning
observation tracking
stale detection
provenance
blast radius
timeline
causal graph
diff
Race Replay
```

---

# 82. Definition of core completion

Ravel's core is complete when all of this works **without internet access or API credentials**:

```text
pnpm install
pnpm test
pnpm build
pnpm demo
```

The demo must:

```text
initialize workspace
start run
create three agents
execute controlled concurrency
detect one stale dependency
propagate it downstream
show timeline
show causal graph
show diff
replay the race
```

External APIs improve Ravel after that point.

They are not prerequisites for having a complete hackathon project.

---

# 83. Final architectural model

```text
                    AGENT DRIVERS
                scripted / Gemini / future
                          │
                          ▼
                     RavelSession
                          │
                          ▼
                 ┌─────────────────┐
                 │ RunCoordinator  │
                 └───────┬─────────┘
                         │
          ┌──────────────┼───────────────┐
          ▼              ▼               ▼
       Events        Versions        Workspace
          │              │
          └──────┬───────┘
                 ▼
           Observations
                 │
                 ▼
            Provenance
                 │
                 ▼
          Stale Detector
                 │
                 ▼
              Hazards
              /     \
             ▼       ▼
      Blast Radius  Semantic Analyzer
             \       /
              ▼     ▼
          Debugger Projector
                 │
          ┌──────┴─────────┐
          ▼                ▼
       React UI       Optional sinks
                      Spacetime / Fetch

Primary product:

Timeline
+
Causal graph
+
Blast radius
+
Focused race replay
```

The architectural center of Ravel is:

> A versioned, event-sourced execution model that records what agents observed, connects those observations to generated artifacts, and detects when those observations became obsolete before their derived work was committed.

Everything external is an adapter around that core.
