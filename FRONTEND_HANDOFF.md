# Frontend redesign handoff

Branch: `frontend-design`. Isolated checkout: `C:/Users/arnsf/Desktop/Coding/Hackathons/mhacks/ravel/.frontend-design-worktree`.

The requested `.frontend-design` directory already existed, was unregistered, and was locked by another process. It was preserved. This session used a separate registered worktree. The main checkout was not edited. No push was performed.

Stable base at start: `e4e5957`. Existing older frontend history was retained, then merged with that stable base in `a764da5`. Main implementation: `457da36` (`feat(web): make concurrency evidence the debugger centerpiece`). Final polish and handoff are committed afterward; use `git rev-parse HEAD` for the final exact revision.

## Delivered

Full-width concurrent agent timeline; generic agent summaries with latest-attempt observations and output lineage; selectable keyboard-accessible events; visible pending intents, Guard rejection, fresh retries, and replacement attempts; derived stale intervals for rejected candidates; recorded input-versus-validation-head Guard evidence; topologically ordered resource columns; contextual graph emphasis and opt-in extra history; resizable graph/inspector split with keyboard controls; vertically resizable and collapsible graph; collapsible resource heads and immutable version chains; version creator/sequence/short hash/attempt metadata; clear deterministic evidence versus Gemini analysis; compact live health/phase and expandable controller results; run identity, mode, and time; local technical overflow and smaller-window layouts.

Reusable components: `AgentCard`, `StatusIndicator`, `WorkspaceSplit`, `ResourceHeads`, `EventDetails`, `GuardValidationPanel`, `RaceSummary`, `LiveRunDetails`. Existing `Timeline`, `CausalGraph`, and `Inspector` now compose these views. `traceView.ts` adapts existing immutable event facts without changing shared DTOs, validator behavior, scheduler behavior, API contracts, or transport. `graphLayout.ts` changes coordinates only and tolerates resource-level cycles.

No frontend dependencies added. Existing React 19, TypeScript, Vite, React Flow, Zod, plain CSS, and Spacetime SDK retained. No Tailwind, router, or global state library. One route with React hooks; custom SVG timeline; React Flow graph; native dialogs/selects/details; existing Spacetime subscription / SSE fallback transport.

Impeccable installed under ignored `.design-tools/impeccable` from its official repository. Context launcher could not write its external cache; used its documented direct-context fallback. Applied audit, polish, distill, and typeset guidance manually. No tool payload, downloaded binaries, credentials, generated outputs, or `.env` committed.

## Verification

- `pnpm test:ui`: 14 tests across five files pass. Existing contract and transport tests preserved. Added historical slicing / cross-run isolation, rejected-version evidence, six generic agent rendering, and causal layout / cycle checks.
- `pnpm typecheck`: pass.
- `pnpm format:check`: pass. No lint script is configured.
- `pnpm build`: pass, including production Vite and Go runtime build. Existing Vite chunk-size warning remains (main bundle approximately 524 KB before gzip).
- Production browser at `http://127.0.0.1:4337/`: no console errors or warnings.
- Real Gemini controlled Observe: stale hazard, Gemini assessment, two active affected heads; stored causal replay verified.
- Real Gemini Guard: one rejected stale candidate, one fresh retry, zero affected heads. Rejection inspector shows schema @1 observed versus @2 at rejection; rejected candidates are never represented as committed versions.
- Real Gemini Natural: all three agents start concurrently; completed with zero hazards and zero active impact. A clean natural outcome remains correctly labeled.
- Scripted fixture: real held intent, release, stale publication, and successful repair from two affected heads to zero. Old hazard and versions remain available historically.
- Real Gemini repairs: two attempts exercised. First replaced Backend output but Frontend produced no mutation, leaving one affected head. Second replaced two outputs but retained affected provenance, leaving two heads. Both outcomes were reported as incomplete. A successful zero-impact live Gemini repair was **not** verified on this frozen backend; no backend changes were made to force it. This is the principal demo limitation to revisit after integrating generalized-live.
- Historical live/fixture runs reopen; event log and version content work; input/output evidence remains available; SSE updates observed throughout execution and repair.
- Keyboard event selection and splitter resizing verified; graph collapse/expand and resource selection verified.
- Desktop, 860px, and 390px inspected. No document-level horizontal overflow; long traces and technical diagrams scroll locally. Six-agent presentation validated by a component render test, not by an actual six-agent backend run.
- Real Spacetime cloud connectivity was not exercised in this isolated preview (SSE-only configuration). Existing subscription/fallback tests pass. Optional Fetch Inspector was not launched.

Screenshots (ignored local artifacts): `.ravel/frontend-screenshots/observe.jpg`, `guard.jpg`, and `repaired.jpg`. Observe captures the stale-input race with separately labeled Gemini analysis; Guard captures rejection / observed-versus-validation versions; repaired captures zero active heads with historical lineage retained. The earlier Observe capture precedes final graph column ordering; Guard and repaired captures include that ordering.

## Merge with generalized-live

The parallel session committed `42c0f1b` on `ravel-asyncodebench` during this session. This checkout intentionally remains based on the stable `e4e5957` state. Comparing this branch against the now-advanced branch shows backend differences; these are parallel-session additions, not backend deletions authored by this frontend work.

Exact overlapping source files:

| File                             | Ownership and resolution                                                                                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/App.tsx`           | Generalized run actions and selection versus workspace composition/event selection. Preserve generalized API hooks and action bodies; transplant the timeline, split, evidence, and resource composition. Keep its timeline-event selection behavior compatible with the new adapter. |
| `apps/web/src/LiveRun.tsx`       | Generalized setup/agent controls versus a small status-JSX extraction. Keep generalized orchestration. Add `LiveRunDetails` only after mapping the finalized status DTO; no controller logic was changed here.                                                                        |
| `apps/web/src/Timeline.tsx`      | Parallel event-click additions versus generic lanes, detailed events, and focus. Reconcile prop names/callbacks and preserve generalized scheduling semantics.                                                                                                                        |
| `apps/web/src/CausalGraph.tsx`   | Parallel selection updates versus contextual focus/layout/history controls. Preserve both selection callbacks and the coordinate-only layout helper.                                                                                                                                  |
| `apps/web/src/Inspector.tsx`     | Parallel inspection/control additions versus evidence hierarchy and version metadata. Preserve generalized actions; apply visual blocks and optional metadata props.                                                                                                                  |
| `apps/web/src/ResourceHeads.tsx` | Add/add overlap: parallel run-resource implementation versus this resource-head/version-history component. Keep the finalized generalized API view and adapt this presentation to it.                                                                                                 |

`style.css` changed on the parallel branch but has no content changes from this task against the frozen base. `debugger.css` is a separate imported presentation layer; inspect combined selectors visually after merging. `main.tsx` only adds that import. Shared schemas, API clients, transport code, and backend files have no task-authored changes.

Recommended order: integrate generalized-live (`42c0f1b`) first; then merge `frontend-design` and resolve the six overlapping files, keeping generalized behavior. Alternatively cherry-pick `457da36` and the final polish commit, restoring `DESIGN.md`/`PRODUCT.md` from this branch if those documentation files conflict. Do not overwrite whole files with this branch's older LiveRun/App versions. Re-run frontend tests, typecheck/build, and real Observe/Guard/replay/repair after integration.

## Launch

From PowerShell:

```powershell
Set-Location 'C:\Users\arnsf\Desktop\Coding\Hackathons\mhacks\ravel\.frontend-design-worktree'
$env:RAVEL_GO = 'C:\Users\arnsf\Desktop\Coding\Hackathons\mhacks\ravel\.ravel\tools\go\bin\go.exe'
$env:RAVEL_PYTHON = 'C:\Users\arnsf\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$env:GOFLAGS = '-buildvcs=false'
pnpm build
node --env-file=../.env scripts/python.mjs live-demo serve --url http://127.0.0.1:4337 --controller-port 4338 --data .ravel/frontend-preview
```

Browser: `http://127.0.0.1:4337/`. The isolated controller/runtime is currently running there. Stop that preview before starting another process on the same ports. The env-file command reads existing local configuration without copying credentials into this worktree. For SSE-only operation set `$env:RAVEL_SPACETIME_ENABLED='false'`.

Optional development UI (currently running): `$env:PORT='4337'; node node_modules/vite/bin/vite.js --config apps/web/vite.config.ts --configLoader runner --port 5183`, browser `http://127.0.0.1:5183/`.

Current data is separate from the main checkout and retains all verification runs. Build outputs, screenshots, tool clone, and runtime data are ignored. No further major task or merge was started after this handoff.
