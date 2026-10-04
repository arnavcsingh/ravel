import type { DebuggerSnapshot } from '@ravel/shared';

export function visibleVersionIds(
  snapshot: DebuggerSnapshot,
  options: {
    hazardId?: string | null;
    selectedVersionId?: string | null;
    highlightNodes?: string[];
    showHistory?: boolean;
  },
) {
  if (options.showHistory) return new Set(snapshot.graph.nodes.map((node) => node.id));
  const hazard = snapshot.hazards.find((hazard) => hazard.id === options.hazardId);
  const visible = hazard
    ? new Set([
        hazard.observedVersionId,
        hazard.staleSinceVersionId,
        hazard.consumerVersionId,
        ...hazard.activeBlastRadius,
      ])
    : new Set(Object.values(snapshot.heads));
  if (!hazard) {
    // Keep only actual ancestors of current heads, not every retired lineage.
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of snapshot.graph.edges) {
        if (edge.kind === 'DERIVED_FROM' && visible.has(edge.target) && !visible.has(edge.source)) {
          visible.add(edge.source);
          changed = true;
        }
      }
    }
  }
  if (options.selectedVersionId) visible.add(options.selectedVersionId);
  for (const id of options.highlightNodes ?? []) visible.add(id);
  return visible;
}
