import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Runtime } from '../runtime/coordinator.js';
import { id } from '../domain/models.js';
import { assessIdentifierMigration } from '../semantic/analyzer.js';

export const files = {
  schemaBefore: 'CREATE TABLE User (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL\n);\n',
  schemaAfter: 'CREATE TABLE User (\n  id UUID PRIMARY KEY,\n  name TEXT NOT NULL\n);\n',
  typesBefore: 'export interface User {\n  id: number;\n}\n',
  typesStale: 'export interface User {\n  id: number;\n  name: string;\n}\n',
  typesClean: 'export interface User {\n  id: string; // UUID\n  name: string;\n}\n',
  clientBefore: '// Client will be generated from api/types.ts.\n',
  clientStale: "import type { User } from '../api/types';\n\nexport function nextUserUrl(user: User): string {\n  return `/users/${user.id + 1}`;\n}\n",
  clientClean: "import type { User } from '../api/types';\n\nexport function userUrl(user: User): string {\n  return `/users/${encodeURIComponent(user.id)}`;\n}\n",
};

export function prepareDemo(store, workspaceRoot) {
  const runId = id('run');
  const workspace = join(workspaceRoot, runId);
  mkdirSync(join(workspace, 'api'), { recursive: true });
  mkdirSync(join(workspace, 'frontend'), { recursive: true });
  writeFileSync(join(workspace, 'schema.sql'), files.schemaBefore);
  writeFileSync(join(workspace, 'api/types.ts'), files.typesBefore);
  writeFileSync(join(workspace, 'frontend/client.ts'), files.clientBefore);
  const runtime = new Runtime(store, workspace, runId);
  runtime.start({ name: 'The identifier migration', description: 'Three agents. One shared repository. An observation that expires before it is used.', scenario: 'identifier-migration', workspace });
  runtime.snapshot('schema.sql', 17);
  runtime.snapshot('api/types.ts', 4);
  runtime.snapshot('frontend/client.ts', 8);
  const backend = runtime.agent('Backend');
  const database = runtime.agent('Database');
  const frontend = runtime.agent('Frontend');
  const backendAttempt = runtime.attempt(backend, 'Generate API types', 'Read schema.sql and update api/types.ts.');
  const databaseAttempt = runtime.attempt(database, 'Migrate identifiers', 'Migrate User.id from INTEGER to UUID.');
  const frontendAttempt = runtime.attempt(frontend, 'Update the client', 'Read api/types.ts and update frontend/client.ts.');
  const steps = [
    () => runtime.observe(backendAttempt, 'schema.sql'),
    () => runtime.write(databaseAttempt, 'schema.sql', files.schemaAfter),
    () => runtime.write(backendAttempt, 'api/types.ts', files.typesStale),
    () => runtime.observe(frontendAttempt, 'api/types.ts'),
    () => runtime.write(frontendAttempt, 'frontend/client.ts', files.clientStale),
    () => {
      const hazard = runtime.state.hazards[0];
      runtime.assess(hazard.hazard_id, assessIdentifierMigration({ observed: files.schemaBefore, current: files.schemaAfter, consumer: files.typesStale }));
      for (const attempt of [backendAttempt, databaseAttempt, frontendAttempt]) runtime.finishAttempt(attempt);
      runtime.end();
    },
  ];
  return { runtime, steps };
}

export function repairDemo(runtime) {
  if (runtime.state.run?.metadata.scenario !== 'identifier-migration') throw new Error('Repair is only available for the scripted demo.');
  if (Object.values(runtime.state.attempts).some((a) => a.attempt_number > 1)) throw new Error('This demo has already been repaired.');
  if (runtime.state.run.status !== 'completed') throw new Error('Wait for the demo to finish before repairing.');
  runtime.resume();
  const original = Object.values(runtime.state.attempts);
  const backend = original.find((a) => runtime.state.agents[a.agent_id].name === 'Backend');
  const frontend = original.find((a) => runtime.state.agents[a.agent_id].name === 'Frontend');
  const b = runtime.attempt(backend.agent_id, backend.task.name, backend.task.prompt, backend.task.task_id);
  runtime.observe(b, 'schema.sql');
  runtime.write(b, 'api/types.ts', files.typesClean);
  runtime.finishAttempt(b);
  const f = runtime.attempt(frontend.agent_id, frontend.task.name, frontend.task.prompt, frontend.task.task_id);
  runtime.observe(f, 'api/types.ts');
  runtime.write(f, 'frontend/client.ts', files.clientClean);
  runtime.finishAttempt(f);
  runtime.end();
  return runtime.projection();
}

export async function executeDemo(demo, delay = 0) {
  for (const step of demo.steps) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    step();
  }
  return demo.runtime.projection();
}
