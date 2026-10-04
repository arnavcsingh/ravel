import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DebuggerSnapshotSchema } from '../packages/shared/src/index';
import { visibleVersionIds } from '../apps/web/src/graphFocus';

const fixture = JSON.parse(readFileSync('runtime/testdata/observe.json', 'utf8'));
const snapshot = DebuggerSnapshotSchema.parse(fixture.snapshots.at(-1));

it('keeps stale observed input, its successor, produced output, and active descendants in incident focus', () => {
  const hazard = snapshot.hazards[0];
  const visible = visibleVersionIds(snapshot, { hazardId: hazard.id });
  expect(visible).toEqual(
    new Set([
      hazard.observedVersionId,
      hazard.staleSinceVersionId,
      hazard.consumerVersionId,
      ...hazard.activeBlastRadius,
    ]),
  );
  expect(visible.size).toBeLessThan(snapshot.graph.nodes.length);
});

it('hides unrelated retired versions while retaining current heads and their actual ancestry', () => {
  const visible = visibleVersionIds(snapshot, {});
  for (const id of Object.values(snapshot.heads)) expect(visible.has(id)).toBe(true);
  for (const edge of snapshot.graph.edges) {
    if (edge.kind === 'DERIVED_FROM' && visible.has(edge.target))
      expect(visible.has(edge.source)).toBe(true);
  }
  const isolated = snapshot.graph.nodes.find(
    (node) =>
      !node.currentHead &&
      !snapshot.graph.edges.some(
        (edge) =>
          edge.kind === 'DERIVED_FROM' && (edge.source === node.id || edge.target === node.id),
      ),
  );
  expect(isolated).toBeDefined();
  expect(visible.has(isolated!.id)).toBe(false);
});

it('keeps selected and replay-highlighted history visible without changing facts', () => {
  const hidden = snapshot.graph.nodes.filter(
    (node) => !visibleVersionIds(snapshot, {}).has(node.id),
  );
  const visible = visibleVersionIds(snapshot, {
    selectedVersionId: hidden[0].id,
    highlightNodes: hidden.slice(1).map((node) => node.id),
  });
  for (const node of hidden) expect(visible.has(node.id)).toBe(true);
  expect(snapshot.graph.nodes.length).toBe(fixture.snapshots.at(-1).graph.nodes.length);
});

it('shows complete immutable history only when requested', () => {
  expect(visibleVersionIds(snapshot, { showHistory: true })).toEqual(
    new Set(snapshot.graph.nodes.map((node) => node.id)),
  );
});
