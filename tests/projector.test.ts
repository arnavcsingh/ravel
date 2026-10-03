import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RavelStore, DebuggerProjector } from '../packages/core/src';
import {
  DebuggerSnapshotSchema,
  HazardDetailSchema,
  ReplayPlanSchema,
} from '../packages/shared/src';
import { prepareDemo, repairDemo } from '../demo/src';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ravel-projector-'));
  const store = new RavelStore(root);
  cleanup.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const demo = await prepareDemo(store, join(root, 'workspace'));
  await demo.execute();
  return { demo, store, projector: new DebuggerProjector(store) };
}
it('produces validated backend DTOs with exact stale windows and separately typed succession edges', async () => {
  const { demo, projector } = await setup();
  const snapshot = DebuggerSnapshotSchema.parse(projector.snapshot(demo.coordinator.runId));
  expect(snapshot.hazards).toHaveLength(1);
  expect(snapshot.activeAffectedCount).toBe(2);
  const detail = HazardDetailSchema.parse(projector.hazard(snapshot.hazards[0].id));
  expect(detail.observationSeq).toBeLessThan(detail.staleWindow.startSeq);
  expect(detail.staleWindow.startSeq).toBeLessThan(detail.staleWindow.endSeq);
  expect(detail.diff.filter((line) => line.kind !== 'context').map((line) => line.kind)).toEqual([
    'removed',
    'added',
  ]);
  expect(snapshot.graph.edges.filter((e) => e.kind === 'DERIVED_FROM')).toHaveLength(3);
  expect(snapshot.graph.edges.filter((e) => e.kind === 'VERSION_SUCCESSOR')).toHaveLength(3);
  expect(snapshot.graph.nodes.find((n) => n.id === detail.consumerVersionId)!.state).toBe(
    'STALE_INPUT',
  );
});
it('focused replay excludes lifecycle and intent events and contains backend annotations', async () => {
  const { demo, projector } = await setup();
  const hazard = demo.coordinator.state.hazards[0];
  const plan = ReplayPlanSchema.parse(projector.replayPlan(hazard.id));
  expect(plan.steps.map((s) => s.action)).toEqual([
    'OBSERVE',
    'WRITE',
    'WRITE',
    'OBSERVE',
    'WRITE',
  ]);
  expect(plan.steps[1].openStaleWindow).toBe(true);
  expect(plan.steps[2].closeStaleWindow).toBe(true);
  expect(plan.steps[2].highlightEdges).toHaveLength(1);
  expect(plan.steps[4].highlightNodes).toHaveLength(1);
});
it('historical projections reveal no future hazard or assessment and retain repaired branches', async () => {
  const { demo, projector } = await setup();
  const h = demo.coordinator.state.hazards[0];
  const early = projector.snapshot(demo.coordinator.runId, h.detectedSeq - 1);
  expect(early.hazards).toHaveLength(0);
  expect(() => projector.hazard(h.id, h.detectedSeq - 1)).toThrow('not found');
  const detected = projector.hazard(h.id, h.detectedSeq);
  expect(detected.assessment).toBeNull();
  await repairDemo(demo.coordinator);
  const repaired = projector.snapshot(demo.coordinator.runId);
  expect(repaired.activeAffectedCount).toBe(0);
  expect(repaired.hazards[0].active).toBe(false);
  expect(repaired.hazards[0].historicalBlastRadius).toHaveLength(2);
  expect(repaired.graph.nodes.filter((n) => n.currentHead).every((n) => n.state === 'CLEAN')).toBe(
    true,
  );
});
