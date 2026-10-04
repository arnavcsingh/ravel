import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DebuggerSnapshotSchema, EventSchema, type RavelEvent } from '../packages/shared/src';
import { executionView, rejectedInputs } from '../apps/web/src/traceView';

const fixture = JSON.parse(readFileSync('runtime/testdata/guard.json', 'utf8'));
const events: RavelEvent[] = fixture.events.map((event: unknown) => EventSchema.parse(event));
const snapshot = DebuggerSnapshotSchema.parse(fixture.snapshot ?? fixture.snapshots.at(-1));

it('shows real Guard rejection and fresh attempts without turning rejected candidates into versions', () => {
  const view = executionView(snapshot, events);
  expect(view.timeline.some((event) => event.action === 'GUARD_REJECT')).toBe(true);
  expect(view.timeline.some((event) => event.action === 'RETRY')).toBe(true);
  expect(
    view.timeline
      .filter((event) => event.action === 'GUARD_REJECT')
      .every((event) => event.versionId === null),
  ).toBe(true);
  expect(view.graph).toBe(snapshot.graph);
  expect(view.hazards).toBe(snapshot.hazards);
  expect(
    view.staleWindows.some(
      (window) =>
        window.endSeq ===
        view.timeline.find((event) => event.action === 'GUARD_REJECT')!.runtimeSeq,
    ),
  ).toBe(true);
});

it('does not leak later events into a historical replay slice or events from another run', () => {
  const rejection = events.find((event) => event.kind === 'WRITE_REJECTED')!;
  const view = executionView(
    { ...snapshot, currentRuntimeSeq: rejection.runtimeSeq - 1, timeline: [] },
    events,
  );
  expect(view.timeline.every((event) => event.runtimeSeq < rejection.runtimeSeq)).toBe(true);
  expect(view.timeline.some((event) => event.action === 'GUARD_REJECT')).toBe(false);
  expect(
    executionView({ ...snapshot, run: { ...snapshot.run, id: 'other-run' }, timeline: [] }, events)
      .timeline,
  ).toEqual([]);
});

it('reports the resource head at rejection rather than a later retry or repair head', () => {
  const rejection = events.find((event) => event.kind === 'WRITE_REJECTED')!;
  const inputs = rejectedInputs(rejection.id, events);
  expect(inputs.length).toBeGreaterThan(0);
  for (const { observed, current } of inputs) {
    expect(current.resourceId).toBe(observed.resourceId);
    expect(current.generation).toBeGreaterThan(observed.generation);
    expect(current.creationSeq).toBeLessThan(rejection.runtimeSeq);
    expect(current.contentHash).not.toBe(observed.contentHash);
  }
});
