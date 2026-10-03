import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ControlledScheduler,
  Deferred,
  HeuristicSemanticAnalyzer,
  RunCoordinator,
  RavelStore,
  id,
  type AgentDriver,
  type RavelSession,
} from '@ravel/core';
import type { Task } from '@ravel/shared';

export const fixture = {
  schema: 'CREATE TABLE users (\n    id INTEGER PRIMARY KEY,\n    email TEXT NOT NULL\n);\n',
  migrated: 'CREATE TABLE users (\n    id UUID PRIMARY KEY,\n    email TEXT NOT NULL\n);\n',
  types: 'export interface User {\n  id: number;\n}\n',
  client: '// Generate the client from api/types.ts.\n',
};

export class ScriptedBackendAgent implements AgentDriver {
  readonly name = 'ScriptedBackendAgent';
  async run(_task: Task, session: RavelSession): Promise<void> {
    const schema = await session.observeResource('schema.sql');
    const identifier = /\bid\s+UUID\b/.test(schema.content ?? '') ? 'string' : 'number';
    const result = await session.writeResource(
      'api/types.ts',
      `export interface User {\n  id: ${identifier};\n  email: string;\n}\n`,
    );
    if (!result.rejected) await session.complete();
  }
}
export class ScriptedDatabaseAgent implements AgentDriver {
  readonly name = 'ScriptedDatabaseAgent';
  async run(_task: Task, session: RavelSession): Promise<void> {
    const schema = await session.observeResource('schema.sql');
    await session.writeResource('schema.sql', schema.content!.replace('id INTEGER', 'id UUID'));
    await session.complete();
  }
}
export class ScriptedFrontendAgent implements AgentDriver {
  readonly name = 'ScriptedFrontendAgent';
  async run(_task: Task, session: RavelSession): Promise<void> {
    const types = await session.observeResource('api/types.ts');
    const numeric = /id: number/.test(types.content ?? '');
    await session.writeResource(
      'frontend/client.ts',
      `import type { User } from '../api/types';\n\nexport function userUrl(id: User['id']): string {\n  return \`/users/\${${numeric ? 'id.toFixed(0)' : 'encodeURIComponent(id)'}}\`;\n}\n`,
    );
    await session.complete();
  }
}

export interface DemoController {
  coordinator: RunCoordinator;
  scheduler: ControlledScheduler;
  phase: 'ready' | 'held' | 'running' | 'completed' | 'failed';
  error: string | null;
  released: boolean;
  release(): void;
  execute(): Promise<void>;
}

export async function prepareDemo(
  store: RavelStore,
  root: string,
  options: { mode?: 'observe' | 'guard'; interactive?: boolean } = {},
): Promise<DemoController> {
  const runId = id(),
    workspace = join(root, runId);
  mkdirSync(join(workspace, 'api'), { recursive: true });
  mkdirSync(join(workspace, 'frontend'), { recursive: true });
  writeFileSync(join(workspace, 'schema.sql'), fixture.schema);
  writeFileSync(join(workspace, 'api/types.ts'), fixture.types);
  writeFileSync(join(workspace, 'frontend/client.ts'), fixture.client);
  const scheduler = new ControlledScheduler();
  const coordinator = new RunCoordinator(store, workspace, runId, {
    gate: scheduler,
    commands: {
      'check-contract': (files) => ({
        exitCode:
          /id UUID/.test(files['schema.sql'] ?? '') &&
          /id: number/.test(files['api/types.ts'] ?? '')
            ? 1
            : 0,
        output:
          /id UUID/.test(files['schema.sql'] ?? '') &&
          /id: number/.test(files['api/types.ts'] ?? '')
            ? 'User.id mismatch: database uses UUID; API uses number.'
            : 'Identifier contract is consistent.',
      }),
    },
  });
  coordinator.on('event', (event) => scheduler.notify(event));
  await coordinator.start(
    'The identifier migration',
    'identifier-migration',
    options.mode ?? 'observe',
  );
  await coordinator.importResource('schema.sql', 17);
  await coordinator.importResource('api/types.ts', 4);
  await coordinator.importResource('frontend/client.ts', 8);
  const backendAgent = await coordinator.createAgent('Backend'),
    databaseAgent = await coordinator.createAgent('Database'),
    frontendAgent = await coordinator.createAgent('Frontend');
  const backend = await coordinator.createAttempt(
    backendAgent,
    'Generate API types',
    'Read schema.sql and update api/types.ts.',
  );
  const ready = new Deferred();
  const invoke = (driver: AgentDriver, session: RavelSession) =>
    driver.run(coordinator.state.tasks[session.identity.taskId], session);
  const controller: DemoController = {
    coordinator,
    scheduler,
    phase: 'ready',
    error: null,
    released: false,
    release() {
      if (controller.phase !== 'held') throw new Error('No pending demo mutation is held.');
      controller.released = true;
      ready.resolve();
    },
    async execute() {
      if (controller.phase !== 'ready') throw new Error('Demo already started.');
      controller.phase = 'running';
      scheduler.holdMutation(backend.attemptId);
      const backendWork = invoke(new ScriptedBackendAgent(), backend);
      try {
        await Promise.race([
          scheduler.waitForEvent(
            (e) => e.kind === 'WRITE_INTENT' && e.attemptId === backend.attemptId,
          ),
          backendWork.then(() => {
            throw new Error('Backend ended without its expected write intent.');
          }),
        ]);
        const database = await coordinator.createAttempt(
          databaseAgent,
          'Migrate identifiers',
          'Migrate User.id from INTEGER to UUID.',
        );
        await invoke(new ScriptedDatabaseAgent(), database);
        controller.phase = 'held';
        if (options.interactive) await ready.promise;
        controller.phase = 'running';
        scheduler.releaseMutation(backend.attemptId);
        await backendWork;
        if (coordinator.state.attempts[backend.attemptId].status === 'invalidated') {
          const retry = await coordinator.createAttempt(
            backendAgent,
            '',
            '',
            backend.identity.taskId,
          );
          await invoke(new ScriptedBackendAgent(), retry);
        }
        const frontend = await coordinator.createAttempt(
          frontendAgent,
          'Update the client',
          'Read api/types.ts and update frontend/client.ts.',
        );
        await invoke(new ScriptedFrontendAgent(), frontend);
        await coordinator.end();
        controller.phase = 'completed';
        // Post-detection annotation: asynchronous and outside all coordinator locks.
        for (const hazard of coordinator.state.hazards) {
          const state = coordinator.state;
          const result = await new HeuristicSemanticAnalyzer().analyze({
            observed: store.content(state.versions[hazard.observedVersionId]),
            current: store.content(state.versions[hazard.validationHeadVersionId]),
            consumer: store.content(state.versions[hazard.consumerVersionId]),
            task: 'Generate API types',
            resourceId: 'schema.sql',
          });
          await coordinator.assess(hazard.id, result);
        }
      } catch (error) {
        controller.phase = 'failed';
        controller.error = (error as Error).message;
        scheduler.cancel(error as Error);
        await backendWork.catch(() => {});
        throw error;
      }
    },
  };
  return controller;
}

export async function repairDemo(coordinator: RunCoordinator): Promise<void> {
  const state = coordinator.state;
  if (state.run?.scenario !== 'identifier-migration' || state.run.status !== 'completed')
    throw new Error('Repair requires a completed identifier migration demo.');
  if (Object.values(state.attempts).some((a) => a.number > 1))
    throw new Error('This demo already has replacement attempts.');
  await coordinator.resume();
  for (const [name, driver] of [
    ['Backend', new ScriptedBackendAgent()],
    ['Frontend', new ScriptedFrontendAgent()],
  ] as const) {
    const agent = Object.values(state.agents).find((a) => a.name === name)!;
    const original = Object.values(state.attempts).find((a) => a.agentId === agent.id)!;
    const session = await coordinator.createAttempt(agent.id, '', '', original.taskId);
    await driver.run(state.tasks[original.taskId], session);
  }
  await coordinator.end();
}
