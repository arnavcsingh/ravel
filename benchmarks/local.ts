import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runInNewContext } from 'node:vm';
import { RavelStore, RunCoordinator, type RavelSession } from '../packages/core/src';

export type Mode = 'off' | 'observe' | 'guard';
type Contract = { prefix: string; factor: number };
export interface Scenario {
  id: string;
  description: string;
  initial: Contract;
  changes: Contract[];
  schedule: 'overlap' | 'serial';
  expected: Contract;
  stale: boolean;
}
const original = { prefix: '/v1/', factor: 1 };
const migrated = { prefix: '/v2/', factor: 100 };
export const scenarios: Scenario[] = [
  {
    id: 'overlapping-migration',
    description: 'Both contract fields change after observation.',
    initial: original,
    changes: [migrated],
    schedule: 'overlap',
    expected: migrated,
    stale: true,
  },
  {
    id: 'factor-only',
    description: 'Numeric conversion changes during generation.',
    initial: original,
    changes: [{ ...original, factor: 100 }],
    schedule: 'overlap',
    expected: { ...original, factor: 100 },
    stale: true,
  },
  {
    id: 'serial-control',
    description: 'Producer finishes before the consumer observes.',
    initial: original,
    changes: [migrated],
    schedule: 'serial',
    expected: migrated,
    stale: false,
  },
  {
    id: 'identical-write-control',
    description: 'Writing identical contents must not reject work.',
    initial: original,
    changes: [original],
    schedule: 'overlap',
    expected: original,
    stale: false,
  },
  {
    id: 'aba-control',
    description: 'Contents change and return to the observed value.',
    initial: original,
    changes: [migrated, original],
    schedule: 'overlap',
    expected: original,
    stale: false,
  },
  {
    id: 'aba-then-change',
    description: 'A second invalidation after content reversion.',
    initial: original,
    changes: [migrated, original, { prefix: '/v3/', factor: 10 }],
    schedule: 'overlap',
    expected: { prefix: '/v3/', factor: 10 },
    stale: true,
  },
];

// These same generators and inputs are used in every mode. No model or tokens are involved.
function generateApi(content: string): string {
  const contract = JSON.parse(content) as Contract;
  return `exports.transform = value => ${JSON.stringify(contract.prefix)} + String(value * ${contract.factor});\n`;
}
function generateClient(api: string): string {
  return api.replace('exports.transform', 'exports.render');
}
export function checkOutput(source: string, symbol: string, expected: Contract): boolean {
  try {
    const context = { exports: {} };
    const expectedResults = [0, 2, -3].map(
      (value) => expected.prefix + String(value * expected.factor),
    );
    const results: unknown = runInNewContext(
      `${source}\n[0, 2, -3].map(exports.${symbol})`,
      context,
      { timeout: 100 },
    );
    return JSON.stringify(results) === JSON.stringify(expectedResults);
  } catch {
    return false;
  }
}
export interface Trial {
  scenario: string;
  mode: Mode;
  repetition: number;
  success: boolean;
  dependencyChecks: { api: boolean; client: boolean };
  dependencyPassRate: number;
  hazardsDetected: number | null;
  writesRejected: number;
  attemptsRerun: number;
  generationCalls: number;
  generatedBytes: number;
  elapsedMs: number;
  runId: string | null;
  directory: string;
}

export async function runTrial(
  scenario: Scenario,
  mode: Mode,
  directory: string,
  repetition = 1,
): Promise<Trial> {
  const workspace = join(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'contract.json'), JSON.stringify(scenario.initial));
  let store: RavelStore | undefined;
  let coordinator: RunCoordinator | undefined;
  let backend: RavelSession | undefined;
  let producer: RavelSession | undefined;
  let frontend: RavelSession | undefined;
  let generationCalls = 0,
    generatedBytes = 0,
    attemptsRerun = 0;
  const generate = (fn: (text: string) => string, text: string) => {
    const result = fn(text);
    generationCalls++;
    generatedBytes += Buffer.byteLength(result);
    return result;
  };
  // Include runtime initialization and recording overhead, exclude independent evaluation.
  const started = performance.now();
  try {
    if (mode !== 'off') {
      store = new RavelStore(join(directory, 'trace'));
      coordinator = new RunCoordinator(store, workspace);
      await coordinator.start(scenario.id, 'local-benchmark', mode);
      await coordinator.importWorkspace();
      backend = await coordinator.createAttempt(
        await coordinator.createAgent('Backend'),
        'Generate API',
        'Implement the current contract.',
      );
      producer = await coordinator.createAttempt(
        await coordinator.createAgent('Producer'),
        'Migrate contract',
        'Publish the requested contract changes.',
      );
      frontend = await coordinator.createAttempt(
        await coordinator.createAgent('Frontend'),
        'Generate client',
        'Implement the API contract.',
      );
    }
    const migrate = async () => {
      for (const contract of scenario.changes) {
        if (producer) await producer.writeResource('contract.json', JSON.stringify(contract));
        else writeFileSync(join(workspace, 'contract.json'), JSON.stringify(contract));
      }
      await producer?.complete();
    };
    if (scenario.schedule === 'serial') await migrate();
    const observed = backend
      ? (await backend.observeResource('contract.json')).content!
      : readFileSync(join(workspace, 'contract.json'), 'utf8');
    const candidate = generate(generateApi, observed);
    // Capturing the intent before migration reproduces the same interleaving without sleeps.
    const intent = backend
      ? await coordinator!.prepareWrite(backend.attemptId, 'api.js', candidate)
      : null;
    if (scenario.schedule === 'overlap') await migrate();
    if (intent) {
      const result = await coordinator!.commitWrite(intent.id);
      if (result.rejected) {
        attemptsRerun++;
        backend = await coordinator!.createAttempt(
          backend!.identity.agentId,
          '',
          '',
          backend!.identity.taskId,
        );
        const fresh = (await backend.observeResource('contract.json')).content!;
        const retried = await backend.writeResource('api.js', generate(generateApi, fresh));
        if (retried.rejected)
          throw new Error('Unexpected retry rejection after producer completion.');
      }
      await backend!.complete();
    } else writeFileSync(join(workspace, 'api.js'), candidate);
    const api = frontend
      ? (await frontend.observeResource('api.js')).content!
      : readFileSync(join(workspace, 'api.js'), 'utf8');
    const client = generate(generateClient, api);
    if (frontend) {
      await frontend.writeResource('client.js', client);
      await frontend.complete();
      await coordinator!.end();
    } else writeFileSync(join(workspace, 'client.js'), client);
    const elapsedMs = performance.now() - started;
    const dependencyChecks = {
      api: checkOutput(
        readFileSync(join(workspace, 'api.js'), 'utf8'),
        'transform',
        scenario.expected,
      ),
      client: checkOutput(
        readFileSync(join(workspace, 'client.js'), 'utf8'),
        'render',
        scenario.expected,
      ),
    };
    const state = coordinator?.state;
    return {
      scenario: scenario.id,
      mode,
      repetition,
      success: dependencyChecks.api && dependencyChecks.client,
      dependencyChecks,
      dependencyPassRate: (Number(dependencyChecks.api) + Number(dependencyChecks.client)) / 2,
      hazardsDetected: state?.hazards.length ?? null,
      writesRejected: state?.events.filter((event) => event.kind === 'WRITE_REJECTED').length ?? 0,
      attemptsRerun,
      generationCalls,
      generatedBytes,
      elapsedMs,
      runId: state?.run?.id ?? null,
      directory,
    };
  } finally {
    coordinator?.close();
    store?.close();
  }
}

export function summarize(trials: Trial[]) {
  return (['off', 'observe', 'guard'] as const).map((mode) => {
    const selected = trials.filter((trial) => trial.mode === mode);
    const times = selected.map((trial) => trial.elapsedMs).sort((a, b) => a - b);
    return {
      mode,
      trials: selected.length,
      successRate: selected.filter((trial) => trial.success).length / selected.length,
      dependencyPassRate:
        selected.reduce((sum, trial) => sum + trial.dependencyPassRate, 0) / selected.length,
      hazardsDetected:
        mode === 'off'
          ? null
          : selected.reduce((sum, trial) => sum + (trial.hazardsDetected ?? 0), 0),
      writesRejected: selected.reduce((sum, trial) => sum + trial.writesRejected, 0),
      attemptsRerun: selected.reduce((sum, trial) => sum + trial.attemptsRerun, 0),
      generationCalls: selected.reduce((sum, trial) => sum + trial.generationCalls, 0),
      recomputedGenerations: selected.reduce(
        (sum, trial) => sum + Math.max(0, trial.generationCalls - 2),
        0,
      ),
      generatedBytes: selected.reduce((sum, trial) => sum + trial.generatedBytes, 0),
      medianElapsedMs: times.length
        ? (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2
        : 0,
    };
  });
}
