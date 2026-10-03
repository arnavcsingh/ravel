# Ravel v0 Design Document

**Project:** Ravel  
**Hackathon:** MHacks 2026  
**Status:** Core architecture frozen enough for implementation  
**Primary goal:** Build a causal concurrency debugger for asynchronous coding agents operating on shared repository state.

## 1. Product definition

Ravel detects and explains concurrency failures caused by coding agents producing work from stale shared state.

The core failure pattern is:

```text
Agent A observes resource R@v1
            │
            │ reasoning
            │
Agent B produces R@v2
            │
            │
Agent A produces artifact O
based on its observation of R@v1
```

Ravel should answer:

- What did the agent observe?
- When did that observation become stale?
- What artifact was produced from it?
- Which agent changed the underlying state?
- What downstream artifacts consumed the stale output?
- What exact execution interleaving caused the failure?
- Is the stale difference likely to matter semantically?

The product pitch is:

> ThreadSanitizer for coding agents.

The more precise description is:

> A causal concurrency debugger for asynchronous coding-agent systems.

Ravel is primarily a debugger and observability system. Concurrency control and automatic rerunning are optional policy layers built on top of the same detector.

---

# 2. Architectural principles

### 2.1 Model independence

The Ravel core does not depend on model internals.

Agents are treated as opaque workers communicating with their environment through operations such as:

```text
OBSERVE RESOURCE
WRITE RESOURCE
RUN COMMAND
RECEIVE TOOL RESULT
```

Codex, Claude Code, Gemini CLI, OpenHands, and future systems require adapters, but the core event model remains unchanged.

### 2.2 Versioned shared state

Ravel reasons about immutable resource versions rather than mutable filenames.

```text
schema.sql@17
schema.sql@18
schema.sql@19
```

Each version contains:

```text
resource_id
generation
content_hash
content_blob
creation_event
producer_attempt
```

For v0:

```text
resource_id = normalized repository-relative path
```

### 2.3 Historical facts are immutable

A historical artifact never changes from stale to clean.

Repair creates new versions.

```text
types@5  stale historical artifact
types@6  clean replacement
```

### 2.4 Events are facts; incidents are interpretations

Instrumentation emits factual events.

```text
OBSERVE_RESOURCE
WRITE_COMMIT
COMMAND_START
COMMAND_END
TOOL_RESULT
```

The analysis engine derives:

```text
STALE_HAZARD
DOWNSTREAM_IMPACT
SEMANTIC_CONFLICT
```

This allows old traces to be reanalyzed using improved detectors.

### 2.5 Correctness does not depend on wall-clock timestamps

Ordering is established through:

```text
runtime sequence
agent sequence
resource generations
explicit provenance edges
```

Wall-clock timestamps exist primarily for visualization.

---

# 3. System boundary

The supported v0 execution contract is:

```text
Coding Agent
     │
     ▼
Agent Adapter
     │
     ▼
Ravel Runtime
     │
 ┌───┼─────────────┐
 ▼   ▼             ▼
read write        command
 │   │             │
 └───┴─────────────┘
         │
         ▼
 shared workspace
```

Ravel only guarantees complete analysis for operations mediated by the Ravel runtime.

Arbitrary filesystem operations that bypass the runtime are outside the soundness guarantee of v0.

Future integrations may provide stronger interception using filesystem virtualization, tracing, or framework-specific adapters.

---

# 4. Core entities

## Run

One complete multi-agent execution.

```text
Run
    run_id
    started_at
    ended_at
    metadata
```

## Agent

A logical coding-agent worker.

```text
Agent
    agent_id
    run_id
    name
    adapter_type
```

## Task

A logical unit of work.

Example:

```text
"Update backend types from database schema"
```

```text
Task
    task_id
    run_id
    name
    prompt
```

## TaskAttempt

A specific execution of a task.

```text
TaskAttempt
    attempt_id
    task_id
    agent_id
    attempt_number
    started_event
    ended_event
    status
```

Rerunning a task creates another attempt.

## Resource

A mutable shared-state identity.

For v0:

```text
Resource = repository file
```

## ResourceVersion

An immutable content state of a resource.

```text
ResourceVersion
    version_id
    resource_id
    generation
    content_hash
    blob_ref
    created_event_id
    producer_attempt_id
```

## Observation

Information explicitly surfaced to an agent.

For v0, the most important form is:

```text
Observation
    observation_id
    attempt_id
    resource_version_id
    event_id
    observation_type
```

## ProvenanceEdge

Evidence that one artifact may have influenced another.

```text
ProvenanceEdge
    source_version_id
    target_version_id
    evidence_type
    source_observation_id
```

## Hazard

A deterministic stale-state finding.

```text
Hazard
    hazard_id
    consuming_version_id
    observed_version_id
    first_invalidating_version_id
    head_at_validation_id
    observing_agent_id
    invalidating_agent_id
    evidence_type
    semantic_status
```

---

# 5. Resource version model

Every resource maintains a generation sequence.

```text
schema.sql

@17
 ↓
@18
 ↓
@19
```

A version is identified by both:

```text
generation
content_hash
```

Generation establishes ordering.

Content hash establishes content identity.

A write that produces byte-identical content should not create a meaningful new resource version.

Example:

```text
@17 hash=A
attempted write hash=A
```

Result:

```text
NOOP_WRITE
```

No new generation is required.

A revert is handled correctly:

```text
@17 hash=A
@18 hash=B
@19 hash=A
```

An agent that observed @17 and acts while @19 is current is not content-stale because:

```text
hash(@17) == hash(@19)
```

The intervening history remains available for debugging.

---

# 6. Runtime ordering

The central Ravel runtime owns version creation and event sequencing.

Each accepted runtime operation receives:

```text
runtime_seq
```

Example:

```text
104 Backend OBSERVE schema@17
105 Database WRITE schema@18
106 Backend WRITE types@5
```

Each agent additionally maintains:

```text
agent_seq
```

Each resource maintains:

```text
generation
```

The centralized runtime should serialize the very small sections required to:

```text
read resource head
assign runtime_seq
validate resource heads
create new version
update resource head
```

This does not serialize agent reasoning.

Agents remain concurrent between environment interactions.

For v0, a single runtime mutex is acceptable. Per-resource locks can be introduced later if needed.

---

# 7. Event model

Every event has a common envelope.

```text
Event
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

    command_id?
    payload
```

Core v0 event types:

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

Optional lower-level events:

```text
PROCESS_READ
PROCESS_WRITE
```

are not required for the first implementation.

---

# 8. Observation semantics

Ravel must distinguish:

```text
the operating system read a file
```

from:

```text
the coding agent was shown information from that file
```

Agent reasoning provenance should primarily use the second.

Direct file inspection:

```text
read_file("schema.sql")
```

produces:

```text
OBSERVE_RESOURCE schema.sql@17
```

A compiler or test process reading many files does not automatically place every file in the agent's reasoning frontier.

Commands instead produce a:

```text
TOOL_RESULT
```

which is surfaced to the model.

Future command instrumentation may associate the tool result with resource versions that produced it.

For the initial implementation, precise stale validation is required only for directly observed resources.

This keeps the MVP sound and understandable.

---

# 9. Observation frontier

Each TaskAttempt maintains:

```text
latest_observation[resource_id]
```

Example:

```text
Backend attempt #1

schema.sql  -> @17
types.ts    -> @4
router.ts   -> @8
```

When the agent observes a newer version:

```text
OBSERVE schema@18
```

the frontier becomes:

```text
schema.sql -> @18
```

When an agent successfully writes a resource itself:

```text
types.ts@4 -> types.ts@5
```

its frontier should automatically become:

```text
types.ts -> @5
```

because the agent knows the state it just produced.

Observation frontiers are scoped to TaskAttempts and do not automatically leak into unrelated tasks.

---

# 10. Provenance model

The model cannot deterministically reveal which piece of context affected its reasoning.

Ravel therefore records evidence rather than claiming perfect causal knowledge.

Initial evidence types:

```text
MODEL_OBSERVATION
SAME_RESOURCE_BASE
DECLARED_COMMAND_INPUT
PROCESS_READ
SEMANTIC_MATCH
```

For the MVP, every write inherits candidate reasoning provenance from the resources directly observed during its current TaskAttempt.

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

`SAME_RESOURCE_BASE` is stronger evidence than a generic model observation.

Ravel v0 intentionally overapproximates reasoning provenance within one TaskAttempt.

Semantic filtering exists partly to reduce the resulting false positives.

---

# 11. Provenance DAG invariant

Derivation edges always point from already-existing versions to newly produced versions.

Therefore:

```text
creation_seq(source) < creation_seq(target)
```

for every provenance edge.

The provenance graph must consequently remain acyclic.

A detected provenance cycle represents an instrumentation or implementation bug.

Resource version succession is represented separately:

```text
VERSION_SUCCESSOR
```

and must never be treated as derivation provenance.

Example:

```text
schema@17 --VERSION_SUCCESSOR--> schema@18

schema@17 --DERIVED_FROM-------> types@5
```

Blast-radius analysis follows only derivation edges.

---

# 12. Direct stale-hazard detection

Before a write is committed, Ravel examines the attempt's relevant observations.

Suppose:

```text
Attempt observations:

schema@17
router@8
types@4
```

At validation:

```text
head(schema) = @18
head(router) = @8
head(types)  = @4
```

For each observation:

```text
if hash(observed_version) != hash(head_at_validation):
    stale
```

The comparison occurs before the consuming write changes any resource head.

A detected hazard records:

```text
observed_version
first_invalidating_version
head_at_validation
consuming_version
```

Example:

```text
Agent A observes schema@17

B writes @18
B writes @19
B writes @20

A produces types@5
```

Hazard:

```text
observed             = schema@17
first_invalidating   = schema@18
head_at_validation   = schema@20
consumer             = types@5
```

---

# 13. Hazard terminology

Ravel separates:

### STALE

The artifact was produced while a resource it observed had different current contents.

Mechanically provable.

### DOWNSTREAM_AFFECTED

The artifact descends from a stale-derived artifact in the provenance DAG.

Mechanically provable relative to recorded provenance.

### SEMANTIC_CONFLICT

The relevant state change actually contradicts or invalidates assumptions visible in the derived output.

Requires stronger deterministic evidence or semantic analysis.

Ravel must not conflate these states.

---

# 14. Blast-radius algorithm

Once a version receives a direct stale hazard:

```text
queue = [stale_version]
```

Traverse outgoing derivation edges using BFS or DFS.

Example:

```text
types@5
   ├──> serializer@3
   └──> client@9
             │
             ▼
           tests@4
```

Historical blast radius:

```text
types@5
serializer@3
client@9
tests@4
```

Complexity:

```text
O(V + E)
```

within the reachable affected graph.

Two views should be maintained:

### Historical blast radius

Every recorded descendant of the stale artifact.

### Active blast radius

Only affected versions relevant to the repository's current heads/current execution.

The UI should default to active blast radius.

---

# 15. User-facing state model

The debugger UI should use a small number of visually understandable states.

```text
CLEAN
STALE INPUT
DOWNSTREAM
SEMANTIC CONFLICT
```

Internally, hazards retain richer metadata and evidence.

A downstream artifact should not automatically be described as "wrong."

Correct language:

```text
downstream of stale artifact
potentially affected
```

not:

```text
definitely incorrect
```

---

# 16. Semantic analysis

The AI layer operates after deterministic stale detection.

Input should contain only the relevant evidence:

```text
observed resource version
current resource version
diff between them
consuming artifact
relevant provenance metadata
```

Example:

```text
schema@17:
    User.id INTEGER

schema@18:
    User.id UUID

types@5:
    id: number
```

Semantic analyzer returns structured output such as:

```text
relevance:
    irrelevant | possible | likely | confirmed

explanation:
    short explanation

affected_symbols:
    optional list
```

The semantic analyzer:

- does not create resource versions;
- does not determine event ordering;
- does not rewrite deterministic history;
- does not initially decide whether Guard mode is allowed to commit.

Its purpose is filtering and explanation.

---

# 17. Observe mode

Observe mode is the primary debugger experience.

Ravel allows the concurrency failure to happen.

Example:

```text
Backend observes schema@17
Database writes schema@18
Backend produces types@5
Frontend observes types@5
Frontend produces client@9
```

Ravel then reconstructs:

```text
schema@17
    │
    ▼
types@5  STALE INPUT
    │
    ▼
client@9 DOWNSTREAM
```

This is the mode used for the primary MHacks demo.

---

# 18. Guard mode

Guard mode is an optional corrective policy layer.

Conceptually it performs optimistic validation:

```text
observe state
    ↓
perform work
    ↓
validate observations
    ↓
commit or retry
```

If an observed resource changed:

```text
validation failed
```

the attempt can be invalidated and rerun.

Strict v0 policy:

```text
observed content changed
→ retry
```

Semantic AI should not initially sit in the critical correctness path.

Smart semantic retry policies can be added later.

---

# 19. Staged attempts for Guard mode

Arbitrary rollback of already-published agent writes is difficult.

Therefore robust Guard mode should eventually execute attempts in a private workspace:

```text
shared repository snapshot
          │
          ▼
 private attempt workspace
          │
     agent modifies
          │
          ▼
      validation
       /      \
    valid     stale
      │         │
   publish    discard
```

Possible implementation mechanisms include temporary repository copies or Git worktrees.

This is not required for the initial Observe-mode implementation.

---

# 20. Repair semantics

Repair operates on TaskAttempts, not files.

Bad execution:

```text
Backend attempt #1
    schema@17
       ↓
    types@5 stale

Frontend attempt #1
    types@5
       ↓
    client@9 downstream
```

Repair:

```text
Backend attempt #2
    schema@18
       ↓
    types@6 clean

Frontend attempt #2
    types@6
       ↓
    client@10 clean
```

Historical versions remain unchanged.

Current repository heads become clean.

TaskAttempts therefore need:

```text
observed_versions
produced_versions
```

and ResourceVersions need:

```text
producer_attempt_id
```

---

# 21. Replay model

Ravel must distinguish three kinds of replay.

## 21.1 Trace replay — MUST HAVE

Deterministically replay recorded events.

Example:

```text
1 Backend OBSERVE schema@17
2 Database WRITE schema@18
3 Backend WRITE types@5
4 Frontend OBSERVE types@5
5 Frontend WRITE client@9
```

This powers the animated "Replay Race" debugger.

No agents are rerun.

The same stored trace always produces the same visualization.

## 21.2 Environment replay — MVP+

Reconstruct relevant resource versions at a selected point in the trace.

Example:

```text
At runtime_seq 105:

schema.sql = @18
types.ts   = @4
```

For v0, full-repository snapshots are unnecessary.

Ravel only needs stored full contents for versioned resources involved in the run.

Each ResourceVersion stores or references its immutable content blob.

This enables:

```text
view file at event
compare @17 vs @18
inspect output @5
```

## 21.3 Agent re-execution — NOT deterministic replay

Create a new TaskAttempt using recorded task information and reconstructed state.

The LLM may produce different outputs.

This feature must be called:

```text
rerun
re-execute
retry
```

not deterministic replay.

Ravel should never claim that rerunning an LLM guarantees the original model output.

---

# 22. Replay projector

The frontend should not reconstruct execution semantics independently.

Backend logic should expose a replay projection.

Given:

```text
run_id
runtime_seq
```

the projector returns:

```text
events_so_far
current_resource_heads
active_hazards
active_provenance_edges
active_blast_radius
```

Moving the replay slider from:

```text
seq=100
```

to:

```text
seq=101
```

applies exactly one additional event.

This makes replay deterministic and keeps frontend logic simple.

---

# 23. Race replay

For a selected Hazard, Ravel should compute a focused event slice.

Example:

```text
OBSERVE schema@17
WRITE schema@18
WRITE types@5
OBSERVE types@5
WRITE client@9
```

The replay does not need to animate every unrelated event.

Focused replay should include:

```text
root observation
first invalidating event
consumer write
downstream observation/write chain
```

This produces the clearest demo.

---

# 24. Storage architecture

For the hackathon, avoid a graph database.

Recommended design:

```text
SQLite
+
content-addressed blob directory
+
in-memory adjacency maps
```

Example directory:

```text
.ravel/
    ravel.db
    blobs/
        <sha256>
        <sha256>
        ...
```

For small demo repositories, storing complete file contents per unique hash is acceptable and preferable to implementing delta compression.

Core tables conceptually include:

```text
runs
agents
tasks
task_attempts

events

resources
resource_versions

observations
provenance_edges

hazards
semantic_assessments
```

The live runtime can maintain:

```text
resource_heads: resource_id -> version_id

observation_frontier:
    attempt_id -> resource_id -> version_id

children:
    version_id -> [derived version ids]
```

in memory.

SQLite is the durable event/source-of-truth store.

---

# 25. Backend/runtime module boundaries

Recommended core package layout:

```text
ravel/
    domain/
        models
        enums

    runtime/
        coordinator
        workspace
        version_manager
        sequencing

    events/
        event_store
        event_types

    observations/
        frontier

    provenance/
        builder
        graph

    detection/
        stale_detector
        blast_radius

    replay/
        projector
        race_slice

    adapters/
        base
        demo_agent
        codex

    semantic/
        analyzer

    api/
        runs
        events
        hazards
        replay
```

The first implementation should keep the core logic independent of the HTTP framework.

---

# 26. Frontend architecture

The debugger should have four primary views/panels.

## Timeline

Horizontal time axis with one lane per agent.

Example:

```text
TIME ───────────────────────────────────────>

Backend    READ schema@17 ───────── WRITE types@5
                    ╲
Database             ╲ WRITE schema@18
                      ╲
                       ⚠
Frontend                              READ types@5
                                         │
                                         ▼
                                     WRITE client@9
```

## Causal graph

Version-level provenance.

```text
schema@17
    │
    ▼
types@5
    │
    ▼
client@9
```

Superseding state shown separately:

```text
schema@17 → schema@18
```

## Incident inspector

When a hazard is selected:

```text
Observed:
schema.sql@17

Invalidated by:
schema.sql@18
Database Agent

Produced:
api/types.ts@5
Backend Agent

Blast radius:
2 downstream versions

Semantic assessment:
Likely conflict
```

It should also show the relevant diff.

## Replay controls

```text
|◀  ▶|  step  timeline slider
```

with a prominent:

```text
Replay Race
```

action for a selected incident.

---

# 27. Live updates

The backend should publish newly created events/hazards to the UI through either:

```text
WebSocket
```

or:

```text
Server-Sent Events
```

The frontend should not poll every second.

Live visualization is valuable for the demo because judges can watch the race form while agents execute.

---

# 28. Primary demo

Repository contains:

```text
schema.sql
api/types.ts
frontend/client.ts
```

Initial state:

```text
schema.sql@17

User {
    id INTEGER
}
```

Backend task:

```text
Read schema.sql and update api/types.ts.
```

Database task:

```text
Migrate User.id from INTEGER to UUID.
```

Frontend task:

```text
Read api/types.ts and update frontend/client.ts.
```

Execution is intentionally scheduled:

```text
1 Backend observes schema@17

2 Database updates schema:
  @17 -> @18

3 Backend produces types@5 from old schema understanding

4 Frontend observes types@5

5 Frontend produces client@9
```

Expected Ravel result:

```text
schema@17
    │
    ▼
types@5   stale input / semantic conflict
    │
    ▼
client@9  downstream affected
```

UI must allow the judge to:

```text
click hazard
view exact versions
view schema diff
see agents involved
see blast radius
replay race
```

---

# 29. Semantic demo extension

Use semantic analysis to detect:

```text
schema@17:
id INTEGER

schema@18:
id UUID

types@5:
id: number
```

Return something like:

```text
High semantic relevance.

The database identifier changed from an integer to a UUID,
but the generated TypeScript type still represents it as a number.
```

This demonstrates an AI task deterministic version comparison alone cannot solve reliably.

---

# 30. Repair demo extension

If time permits, add:

```text
Repair
```

which triggers:

```text
Backend attempt #2
Frontend attempt #2
```

and results in:

```text
schema@18
    │
    ▼
types@6 clean
    │
    ▼
client@10 clean
```

Old stale versions remain visible as historical branches.

A general automatic rollback engine is not required.

---

# 31. Benchmark path

Benchmark work begins only after the live demo is stable.

Target:

```text
AsynCodeBench
```

Experimental modes:

```text
Ravel OFF

Ravel Guard ON
```

The model, prompts, task, and agent count must remain the same.

Potential measurements:

```text
task success rate
dependency pass rate
stale hazards detected
attempts invalidated
attempts rerun
token overhead
runtime overhead
amount of recomputation
```

Observe mode alone is not expected to improve benchmark correctness.

Benchmark improvement requires corrective behavior such as strict validation and rerunning.

---

# 32. MVP scope

## Must have

```text
Central Ravel runtime
Agent/task/attempt identity

Mediated direct file observation
Mediated file write

Resource versioning
Generation + SHA-256 content identity
Immutable content blobs

Runtime event sequencing
Immutable event log

Observation frontier

Candidate provenance creation

Direct stale-hazard detector

Version-level provenance DAG
Blast-radius BFS/DFS

Three-agent controlled demo

Timeline visualization

Causal graph

Incident detail panel

Relevant file/version diffs

Trace replay / Replay Race

One semantic-conflict analysis
```

## MVP+

```text
Live event streaming

Environment-state inspector

Task-attempt rerunning

Simple Repair button

Codex adapter

Command result provenance
```

## Stretch

```text
Guard mode with staged workspaces

AsynCodeBench experiment

Multiple model/framework adapters

Region-level dependencies

Symbol-level dependencies

Semantic retry filtering

Generic automatic repair

Kernel/FUSE/eBPF instrumentation
```

---

# 33. Implementation order

The following can begin immediately and should be built in approximately this dependency order:

```text
Domain entities
      ↓
SQLite event store + blob store
      ↓
Runtime coordinator
      ↓
Version manager
      ↓
observe_resource()
write_resource()
      ↓
Observation frontier
      ↓
Provenance builder
      ↓
Stale detector
      ↓
Blast-radius traversal
      ↓
Replay projector
      ↓
Demo orchestrator
```

Frontend work can proceed in parallel once mock event fixtures exist.

The semantic analyzer can also proceed independently once the Hazard schema is frozen.

---

# 34. Core acceptance test

Before integrating a real coding agent, the runtime should pass one deterministic integration scenario.

Scripted actions:

```text
Backend observes schema@17

Database writes schema@18

Backend writes types@5

Frontend observes types@5

Frontend writes client@9
```

Assertions:

```text
schema@18 is current resource head

types@5 has exactly one direct stale hazard rooted at schema@17

hazard first_invalidating_version == schema@18

client@9 is reachable from types@5 through provenance

active blast radius contains:
    types@5
    client@9

event replay produces the original event order

historical resource contents for:
    schema@17
    schema@18
    types@5
    client@9
are retrievable
```

Do not integrate Codex until this scripted test works.

This isolates Ravel correctness from agent nondeterminism.

---

# 35. Non-goals for v0

Ravel v0 does not attempt to guarantee:

```text
perfect semantic dependency inference

arbitrary OS-level filesystem interception

distributed execution across machines

full deterministic LLM replay

safe rollback of arbitrary external side effects

database/Kubernetes/API resource versioning

symbol-level invalidation

perfect elimination of false-positive candidate provenance
```

These are explicit limitations, not architectural failures.

---

# 36. Final v0 architecture

```text
                  Multi-Agent Workload
                          │
                          ▼
                    Agent Adapters
                          │
                          ▼
                ┌──────────────────┐
                │ Ravel Runtime │
                └────────┬─────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
      Event Store   Version Manager   Workspace
          │              │
          └───────┬──────┘
                  ▼
         Observation Tracker
                  │
                  ▼
         Provenance Builder
                  │
                  ▼
           Provenance DAG
                  │
                  ▼
          Stale Detector
                  │
                  ▼
              Hazards
             /       \
            ▼         ▼
      Blast Radius  Semantic AI
            \         /
             ▼       ▼
             Debugger API
                  │
                  ▼
        Timeline / DAG / Replay

Optional later:

Hazards
   │
   ▼
Policy / Guard Layer
   │
   ▼
Invalidate / Retry / Repair
```

The architectural center of Ravel is therefore not the LLM and not the UI.

It is:

> **a versioned, event-sourced execution model that connects agent observations to produced artifacts and detects when those observations become obsolete before they are consumed.**

Everything else is built on top of that model.
