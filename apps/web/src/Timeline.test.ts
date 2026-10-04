import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DebuggerSnapshotSchema, EventSchema, type RavelEvent } from '@ravel/shared';
import { Timeline } from './Timeline';
import { executionView } from './traceView';
const fixture = JSON.parse(readFileSync('runtime/testdata/guard.json', 'utf8'));
const events: RavelEvent[] = fixture.events.map((event: unknown) => EventSchema.parse(event));
const snapshot = DebuggerSnapshotSchema.parse(fixture.snapshot ?? fixture.snapshots.at(-1));
it('renders six generic agents and keeps each important event keyboard inspectable', () => {
  const view = executionView(snapshot, events);
  const expanded = {
    ...view,
    agents: [
      ...view.agents,
      ...Array.from({ length: 6 - view.agents.length }, (_, index) => ({
        ...view.agents[0],
        id: `extra-${index}`,
        name: `Worker ${index}`,
      })),
    ],
  };
  const markup = renderToStaticMarkup(
    createElement(Timeline, {
      snapshot: expanded,
      step: null,
      selectHazard: () => {},
      selectEvent: () => {},
      selectedEventId: null,
      selectedAgentId: null,
      selectAgent: () => {},
    }),
  );
  expect((markup.match(/class="agent-card /g) ?? []).length).toBe(6);
  expect(markup).toContain('GUARD_REJECT');
  expect(markup).toContain('RETRY');
  expect(markup).toContain('tabindex="0"');
});
