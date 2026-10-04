import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { DebuggerSnapshotSchema, EventSchema } from '@ravel/shared';
import { attemptAction, attemptViews, executionView } from './traceView';
import { Timeline } from './Timeline';
import { ResourceHeads } from './ResourceHeads';
import { LiveRunDetails } from './LiveRunDetails';
import { EventDetails } from './EventDetails';
import { visibleVersionIds } from './graphFocus';

// Captured from the real Go runtime and controller with the named offline
// HistoryFixture in test_live_lab. No provider-network calls or invented facts.
const fixture = JSON.parse(readFileSync('tests/fixtures/repair-attempts.json', 'utf8'));
const events = fixture.events.map((event: unknown) => EventSchema.parse(event));
const snapshot = DebuggerSnapshotSchema.parse(fixture.snapshot);
const view = executionView(snapshot, events, fixture.controller.timelineExtras);

it('retains incomplete, failed, rejected and clean repair attempts after zero active impact', () => {
  const attempts = attemptViews(snapshot, events);
  const repairs = attempts.filter((a) => a.repairOf);
  expect(snapshot.activeAffectedCount).toBe(0);
  expect(snapshot.hazards.length).toBeGreaterThan(0);
  expect(repairs.some((a) => a.status === 'failed')).toBe(true);
  expect(repairs.some((a) => a.status === 'completed' && !a.outputs.length)).toBe(true);
  expect(repairs.some((a) => a.status === 'invalidated' && a.rejected.length)).toBe(true);
  expect(repairs.some((a) => a.status === 'completed' && a.outputs.length)).toBe(true);
  const html = renderToStaticMarkup(
    createElement(Timeline, {
      snapshot: view,
      events,
      step: null,
      selectedEventId: null,
      selectedAgentId: null,
      selectHazard: () => {},
      selectEvent: () => {},
      selectAgent: () => {},
    }),
  );
  for (const attempt of repairs) expect(html).toContain(attempt.id);
  expect(html).toContain('no replacement recorded');
  expect(html).toContain('rejected candidates');
  expect(html).toContain('GUARD_REJECT');
});

it('starts each attempt with fresh observations and output summaries', () => {
  for (const event of events) {
    if (event.kind !== 'TASK_ATTEMPT_START') continue;
    const frame = { ...snapshot, currentRuntimeSeq: event.runtimeSeq };
    const attempt = attemptViews(frame, events).at(-1)!;
    expect(attempt.id).toBe(event.payload.attempt.id);
    expect(attempt.observed).toEqual([]);
    expect(attempt.outputs).toEqual([]);
    const trace = executionView(frame, events);
    const agent = snapshot.agents.find((a) => a.id === attempt.agentId)!;
    const html = renderToStaticMarkup(
      createElement(Timeline, {
        snapshot: { ...trace, agents: [agent] },
        events,
        step: null,
        selectedEventId: null,
        selectedAgentId: null,
        selectHazard: () => {},
        selectEvent: () => {},
        selectAgent: () => {},
      }),
    );
    const card = html.slice(
      html.indexOf('class="agent-card '),
      html.indexOf('class="attempt-history"'),
    );
    expect(card).toContain('No recorded read');
    expect(card).toContain('No recorded write');
  }
});

it('uses immutable repair metadata and never past rejection to identify a new task', () => {
  expect(attemptAction({ number: 1 })).toBe('START');
  expect(attemptAction({ number: 2 })).toBe('RETRY');
  expect(attemptAction({ number: 1, repairOf: 'source' })).toBe('REPAIR');
  expect(attemptAction({ number: 4, repairOf: 'source' })).toBe('REPAIR');
  const rejection = view.timeline.find((e) => e.action === 'GUARD_REJECT')!;
  expect(rejection.repairOf).toBeTruthy();
  expect(view.timeline.filter((e) => e.runtimeSeq === rejection.runtimeSeq)).toHaveLength(1);
  const repair = view.timeline.filter((e) => e.action === 'REPAIR');
  for (const event of repair)
    expect(view.timeline.filter((e) => e.runtimeSeq === event.runtimeSeq)).toHaveLength(1);
});

it('shows identical-content replacements as immutable versions and preserves historical focus', () => {
  expect(
    view.timeline.filter((e) => e.description.includes('content and hash unchanged.')),
  ).toHaveLength(2);
  const html = renderToStaticMarkup(
    createElement(ResourceHeads, {
      snapshot: view,
      events,
      selectedId: null,
      inspect: () => {},
    }),
  );
  expect(html).toContain('New immutable version · content / hash unchanged');
  const focus = visibleVersionIds(snapshot, { hazardId: snapshot.hazards[0].id });
  for (const id of snapshot.hazards[0].historicalBlastRadius) expect(focus.has(id)).toBe(true);
  const before = DebuggerSnapshotSchema.parse(fixture.before);
  const historical = executionView(before, events, fixture.controller.timelineExtras);
  expect(historical.activeAffectedCount).toBe(2);
  expect(historical.timeline.some((e) => e.action === 'REPAIR')).toBe(false);
});

it('keeps controller failures and semantic interpretations separate from runtime evidence', () => {
  const html = renderToStaticMarkup(createElement(LiveRunDetails, { status: fixture.controller }));
  expect(html).toContain('Repair incomplete');
  expect(html).toContain('Repair failed');
  expect(html).toContain('Repair clean');
  expect(html).toContain('No active impact.');
  expect(html).toContain('Controller API rejection evidence');
  expect(html).toContain('observe_resource');
  const event = view.timeline.find((e) => e.action === 'GUARD_REJECT')!;
  const evidence = renderToStaticMarkup(
    createElement(EventDetails, { event, snapshot, facts: events, close: () => {} }),
  );
  expect(evidence).toContain('Raw runtime evidence');
  expect(evidence).toContain('staleObservationIds');
});
