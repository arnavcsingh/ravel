# Ravel interface

## Surface

Operate mode. An execution debugger for the existing single-page frontend. Prioritize the agent lanes, execution order, provenance, and incident evidence. Preserve interactions and API contracts.

## Tokens

Background #101214; surface #171a1d; raised controls #202428; border #30363b. Text #e5e9ec; secondary #a4adb5. Interaction accent #70d5bd. Semantic danger #f28a82, warning #e3bb76, recovery #91c8a1. State colors always accompany text or structural notation.

System sans for UI, Cascadia Code/Consolas/system monospace for IDs, resource names, versions, sequence numbers, logs, and code. UI body 13px, metadata 11–12px, panel headings 13px, page heading 22px. Spacing uses 4/8/12/16/24px. Controls have 3px corners; work surfaces use square structural borders. No decorative shadows or motion.

## Composition

Narrow workspace rail, compact header and run controls, inline execution statistics. Agent roster and execution lanes lead the workspace; provenance graph follows. The evidence inspector shares the workspace border rather than floating separately. Mobile uses a horizontal navigation bar and stacked evidence with locally scrollable technical diagrams/tables.

## Audit of the incumbent

- P1: 7–10px labels and muted olive text make chart legends and incident metadata difficult to read.
- P1: timeline incident markers are clickable SVG groups without keyboard semantics.
- P2: light olive surfaces, a 38px editorial hero, promotional sidebar copy, and oversized metrics compete with execution evidence.
- P2: repeated overrides and hard-coded SVG/graph colors prevent consistent theming.
- P2: narrow layouts lose navigation labels and diagram legends; the fixed rail uses valuable mobile space.

Keep: truthful provenance, separate semantic assessment, working demo controls, native selects/dialog, labeled inputs, and React Flow zoom/navigation.

## Impeccable

Installed project-locally from https://github.com/pbakaus/impeccable (.agents/skills/impeccable, version 4.5.0) using the Codex skill installer. The upstream Windows context launcher fails at its cache-directory label in this environment; guidance was read directly (audit, operate, craft-floor, polish). Skill payload is local tooling, not a frontend dependency. Reinstall with the skill installer using `--repo pbakaus/impeccable --path .agents/skills/impeccable --dest .agents/skills`.
