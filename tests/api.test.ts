import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/server/src/app';
import {
  DebuggerSnapshotSchema,
  HazardDetailSchema,
  ReplayPlanSchema,
} from '../packages/shared/src';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'ravel-http-'));
  const result = await createApp({ directory });
  cleanup.push(async () => {
    await result.app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return result;
}
it('serves all debugger endpoints without provider configuration', async () => {
  const { app } = await setup();
  const get = async (url: string) => (await app.inject({ url })).json();
  expect(
    (await get('/api/health')).integrations.every(
      (integration: { enabled: boolean }) => !integration.enabled,
    ),
  ).toBe(true);
  const [run] = await get('/api/runs');
  const snapshot = DebuggerSnapshotSchema.parse(await get(`/api/runs/${run.id}/debugger`));
  expect(snapshot.hazards).toHaveLength(1);
  const hazard = HazardDetailSchema.parse(await get(`/api/hazards/${snapshot.hazards[0].id}`));
  expect(hazard.observedContent).toContain('INTEGER');
  expect(hazard.currentContent).toContain('UUID');
  const plan = ReplayPlanSchema.parse(await get(`/api/hazards/${hazard.id}/replay`));
  expect(plan.steps).toHaveLength(5);
  expect((await get(`/api/versions/${hazard.consumerVersionId}/content`)).content).toContain(
    'id: number',
  );
  expect((await app.inject({ url: `/api/runs/${run.id}/debugger?seq=0` })).statusCode).toBe(400);
  expect((await app.inject({ url: '/api/runs/missing/debugger' })).statusCode).toBe(404);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/demo',
        headers: { origin: 'https://foreign.example' },
      })
    ).statusCode,
  ).toBe(403);
  const repaired = await app.inject({ method: 'POST', url: `/api/hazards/${hazard.id}/repair` });
  expect(repaired.statusCode).toBe(200);
  expect(repaired.json().activeAffectedCount).toBe(0);
});
it('interactive scheduling holds the real mutation and releases it through the API', async () => {
  const { app, controllers } = await setup();
  const started = await app.inject({
    method: 'POST',
    url: '/api/demo',
    payload: { interactive: true },
  });
  expect(started.statusCode).toBe(201);
  const { runId } = started.json();
  const controller = controllers.get(runId)!;
  await controller.scheduler.waitForEvent(
    (e) =>
      e.kind === 'TASK_ATTEMPT_END' &&
      controller.coordinator.state.agents[e.agentId!]?.name === 'Database',
  );
  expect((await app.inject({ url: `/api/runs/${runId}/demo` })).json().canRelease).toBe(true);
  const held = (await app.inject({ url: `/api/runs/${runId}/debugger` })).json();
  expect(held.hazards).toHaveLength(0);
  expect(held.staleWindows).toHaveLength(1);
  const ended = controller.scheduler.waitForEvent((e) => e.kind === 'RUN_END');
  expect((await app.inject({ method: 'POST', url: `/api/runs/${runId}/release` })).statusCode).toBe(
    200,
  );
  await ended;
  expect((await app.inject({ url: `/api/runs/${runId}/debugger` })).json().hazards).toHaveLength(1);
});
it('streams run-specific events with reconnect cursors and closes cleanly', async () => {
  const { app, store } = await setup();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  const run = store.runs()[0];
  const stream = await fetch(`http://127.0.0.1:${address.port}/api/runs/${run.id}/stream`, {
    headers: { 'Last-Event-ID': '1' },
  });
  expect(stream.headers.get('content-type')).toBe('text/event-stream');
  const reader = stream.body!.getReader();
  const chunk = await reader.read();
  const text = new TextDecoder().decode(chunk.value);
  expect(text).toContain('event: update');
  expect(text).toContain(run.id);
  expect(text).toContain('id: 2');
  await reader.cancel();
});
