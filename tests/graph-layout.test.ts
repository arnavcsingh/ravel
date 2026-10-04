import { expect, it } from 'vitest';
import { layoutVersions } from '../apps/web/src/graphLayout';
import { DebuggerSnapshotSchema } from '../packages/shared/src';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync('runtime/testdata/observe.json', 'utf8'));
const snapshot = DebuggerSnapshotSchema.parse(fixture.snapshot ?? fixture.snapshots.at(-1));

it('lays out the recorded schema to types to client derivation from left to right', () => {
  const before = JSON.stringify(snapshot.graph);
  const nodes = layoutVersions(snapshot.graph.nodes, snapshot.graph.edges);
  const schema = nodes.find((node) => node.resourceId === 'schema.sql')!;
  const types = nodes.find((node) => node.resourceId === 'api/types.ts')!;
  const client = nodes.find((node) => node.resourceId === 'frontend/client.ts')!;
  expect(schema.x).toBeLessThan(types.x);
  expect(types.x).toBeLessThan(client.x);
  expect(JSON.stringify(snapshot.graph)).toBe(before);
});

it('terminates for resource-level cycles while keeping every immutable version', () => {
  const first = snapshot.graph.nodes[0],
    second = snapshot.graph.nodes.find((node) => node.resourceId !== first.resourceId)!;
  const edges = [
    {
      id: 'forward',
      source: first.id,
      target: second.id,
      kind: 'DERIVED_FROM' as const,
      label: 'read',
    },
    {
      id: 'reverse',
      source: second.id,
      target: first.id,
      kind: 'DERIVED_FROM' as const,
      label: 'read',
    },
  ];
  expect(layoutVersions(snapshot.graph.nodes, edges).map((node) => node.id)).toEqual(
    snapshot.graph.nodes.map((node) => node.id),
  );
});
