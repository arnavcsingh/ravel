# Ravel debugger design

Operate mode: a desktop-first concurrency debugger for hackathon judges and developers. Preserve recorded facts and controller actions; the execution trace is the primary surface.

## System

Neutral dark background #101214, surface #171a1d, raised controls #202428, structural border #30363b. Text #e5e9ec, secondary #a4adb5. Ravel accent #70d5bd. Stale / rejected / failed #f28a82; pending / held / downstream #e3bb76; committed / repaired / current #91c8a1. StatusIndicator pairs color with text and a small structural marker; rejection uses an outlined diamond. Running / observing / retrying / repairing use the accent. No glow, gradients, decorative motion, or rounded card stacks.

Segoe UI / system sans for interface; Cascadia Code / Consolas for paths, identifiers, versions, sequence, and code. Body 13px, supporting prose 12px, technical metadata 11px, workspace title 20px, incident title 18px. 4/8/12/16/24 spacing scale; square work surfaces, 3px control radius. Native focus outlines and tabular numbers.

## Workspace

Compact session controls and health precede the full-width execution timeline. Generic agent summaries show latest-attempt observations and output; output lineage state is separate from lifecycle state. Timeline coordinates represent runtime order with equal sequence columns, never elapsed time. Missing intermediate sequence numbers are intentional. Candidate intents, assessment, start, and no-op facts are available through Detailed events. Guard rejection and fresh attempts remain in the default view. Rejected stale intervals derive from immutable rejection / observation / version facts without manufacturing hazards or committed versions.

The provenance graph and evidence inspector share a resizable split. Drag or focus the divider and use arrow keys. The graph can collapse and resize vertically. Resource heads and version chains are collapsible. Current heads and immediate recorded dependencies form the default graph; extra history is opt-in. Hazard, event, version, and replay selections provide contextual emphasis. Solid edges represent derivation; dashed edges represent succession.

Deterministic race evidence stays separate from labeled Gemini / heuristic analysis. Trace replay reads history. Repair creates replacement attempts. Incomplete repair and no-mutation results remain visible. Expanded controller task results are secondary to the trace.

## Audit and targeted passes

Incumbent strengths: honest runtime contracts, immutable versions, working React Flow controls, replay, live subscriptions and SSE fallback, separate semantic assessment, editable tasks and initial files.

Incumbent gaps addressed: narrow timeline, mostly uninspectable events, no resource-head view, equal emphasis on every historical graph edge, controller summaries dominating the workspace, lifecycle and output-state conflation, small diff text, and unclear Guard rejection evidence.

Audit: every timeline event and resource/version button has keyboard access and a visible selected state; splitter supports pointer and keyboard input. Semantic colors always accompany text. Diagrams and code scroll locally. Responsive breakpoints stack evidence below the graph at <=980px; six-agent summaries wrap automatically. No scheduler or API changes.

Distill: detailed lifecycle/model events and controller transcripts use progressive disclosure. No command palette, decorative charts, toast duplication, or new UI dependency. Typeset: shared system fonts, 11px technical metadata, 12px diffs, aligned tabular sequence/version values. Polish: consistent semantic status, selected provenance, honest historical labels, minimum control height, local overflow, reduced-motion edge behavior, compact run identity with mode and timestamp.

Impeccable 4.5.0 installed from the official pbakaus/impeccable repository under ignored .design-tools/impeccable. Read its new-work, operate, craft-floor, audit, polish, distill, and typeset guidance. The context launcher could not write its external cache; followed its documented direct-context fallback. No Impeccable runtime or hook is shipped with the app. Prior verification text was replaced; current results are in FRONTEND_HANDOFF.md.
