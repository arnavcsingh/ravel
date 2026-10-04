# Frontend integration handoff

Branch: `frontend-design`. Integrated local finalized `main` (`cedfe81`) into the design branch (`9e5cd5d`). This is a merge integration; both histories are retained. Run `git rev-parse HEAD` for the resulting integration commit. No push was requested or performed.

## Ownership and conflict resolution

All six conflicts were reconciled: `App.tsx`, `LiveRun.tsx`, `Timeline.tsx`, `CausalGraph.tsx`, `Inspector.tsx`, and the add/add `ResourceHeads.tsx` conflict.

The frontend-design visual system remains: full-width concurrent timeline, generic agent cards, causal graph with contextual focus and history controls, resizable graph/inspector workspace, resource heads and version chains, existing typography, colors, spacing, responsive behavior, and keyboard selection. The generalized controller setup and all start/retry/pause/resume/hold/release/finish operations from main are retained. Current live controls/results are expandable to preserve the compact evidence-first hierarchy.

All main runtime, repair, Python client, replay, Gemini, Fetch/Inspector, Spacetime projection, benchmark, and generalized task behavior is retained. The Go runtime and sponsor integration files are identical to finalized main. Controller additions only preserve and expose evidence; Go continues to decide publication, affected provenance, rejection, and immutable version identity.

## Working repair flow

- Shared `AttemptSchema` preserves optional nullable `repairOf`; timeline DTOs can carry `attemptId`, `taskId`, and `repairOf`.
- Attempt identity and classification come from immutable `TASK_ATTEMPT_START` metadata. A repair retry remains repair work because it retains `repairOf`; an ordinary later task is not labeled repair because an agent previously encountered rejection.
- Observations and produced-output summaries reset at every attempt start, including repair and replacement boundaries. Controller results are shown only for the current immutable attempt; earlier summaries remain in durable `resultHistory`.
- Each attempt is independently listed with identity, status, observations, outputs, and inspectable start/end/rejection evidence. Failed, invalidated, incomplete, and clean output lineages remain available after later successful repair.
- Historical hazards, stale versions, and historical blast radius remain inspectable. Active blast radius and affected heads are displayed separately.
- Execution completed, no active impact, and verified repair success are separate labels. Only a controller repair result of `clean` is labeled successful repair. A historical incident with no active descendants does not by itself claim repair success.
- Identical-content repair regeneration is displayed as a new immutable version with unchanged content/hash. Ordinary identical-write no-op semantics are unchanged.
- Immutable trace-derived markers take precedence over controller `timelineExtras` at the same runtime sequence; search observations are projected individually. Repeated derivation does not duplicate rejected windows or unchanged-hash annotations.
- Raw runtime payloads are inspectable separately from semantic assessment payloads. Runtime HTTP operation failures, including affected-input rejection, are retained as controller API rejection evidence with the immutable attempt ID. They are not fabricated runtime events or observations.
- Current controller state has an explicit warning label during historical replay. Historical views do not inherit current scheduling state and cannot initiate repair against an old snapshot.
- Controller/demo errors do not prevent a valid debugger snapshot from loading. Missing incident details retain an explicit partial/loading presentation and the trace/version inspection surfaces.

## Verification

- `pnpm check`: typecheck and repository formatting pass. The handoff is additionally formatted explicitly.
- `pnpm test`: all Go runtime and Spacetime sink tests pass; all 65 Python tests pass; all 23 frontend tests across seven files pass.
- `pnpm build`: TypeScript, production Vite bundle, and Go executable build pass. The existing Vite chunk-size advisory remains (approximately 541 KB before gzip for the largest bundle).
- Full suite initially hit Windows sandbox workspace-creation errors (`Access is denied`). Rerunning with authorized filesystem access passed. No application workaround for the sandbox was introduced.
- Added a real Go/controller regression using a named offline provider: fresh interactive run; held observation/write intent; concurrent source change; genuine hazard and two affected heads; semantic assessment; incomplete repair; failed repair; affected-input HTTP rejection; stale repair candidate rejection; fresh repair retry; two immutable replacements whose hashes are unchanged; zero final active affected heads. The original hazard, stale output versions, failed attempt, invalidated attempt, and controller error remain inspectable.
- `tests/fixtures/repair-attempts.json` is a captured genuine runtime trace from that regression. The frontend tests parse it through shared schemas and render the timeline, attempt history, resource history, controller outcomes, and raw rejection evidence. Historical slices exclude later repair markers and retain their earlier active impact.
- Production UI inspected against an isolated real runtime/controller with this trace: historical incidents and stale versions selectable; rejected candidate inspector shows schema @2 versus @3; replay labels current controller state separately; replacement hash/history labels visible. Browser warning/error logs are empty. Narrow viewport inspection has no document-level horizontal overflow.
- Existing controller tests cover six arbitrary agents, fresh run IDs, queued task edits, natural and deterministic scheduling, Guard retries, pause/resume, hold/release, finish, shutdown/recovery, errors, and no-mutation outcomes. A new retry boundary assertion verifies old observations/output/results are absent while historical summaries remain.

No integration blockers remain. This validation uses offline providers with real local runtime APIs. It does not claim a new paid Gemini network run, real Spacetime cloud connectivity, or external Agentverse account verification; transport, semantic, sponsor projection, and local A2A/Inspector tests pass.

## Launch

Use `pnpm demo:live` with the existing local `.env` configuration to run the finalized live controller and production frontend. `pnpm dev` provides the development frontend. `examples/live-lab.json` supplies generalized sample tasks. Existing run archives and credentials were not modified.

The temporary verification preview and outputs are under ignored `.ravel`; they are not production run data or committed secrets.

## Files changed by the integration

- `apps/web/src/App.tsx`
- `apps/web/src/CausalGraph.tsx`
- `apps/web/src/debugger.css`
- `apps/web/src/EventDetails.tsx`
- `apps/web/src/graphFocus.ts`
- `apps/web/src/Inspector.tsx`
- `apps/web/src/LiveRun.tsx`
- `apps/web/src/LiveRunDetails.tsx`
- `apps/web/src/RaceSummary.tsx`
- `apps/web/src/repair-integration.test.ts`
- `apps/web/src/ResourceHeads.tsx`
- `apps/web/src/style.css`
- `apps/web/src/Timeline.tsx`
- `apps/web/src/traceView.ts`
- `examples/live-lab.json`
- `FRONTEND_HANDOFF.md`
- `packages/shared/src/dto.ts`
- `packages/shared/src/schemas.ts`
- `python/ravel/client.py`
- `python/ravel/live_demo_server.py`
- `python/ravel/live_demo.py`
- `python/ravel/live_lab.py`
- `python/ravel/repair.py`
- `python/tests/test_live_lab.py`
- `python/tests/test_repair.py`
- `README.md`
- `runtime/coordinator.go`
- `runtime/model.go`
- `runtime/reducer.go`
- `runtime/repair_test.go`
- `runtime/server.go`
- `scripts/python.mjs`
- `tests/fixtures/repair-attempts.json`
- `tests/graphFocus.test.ts`
