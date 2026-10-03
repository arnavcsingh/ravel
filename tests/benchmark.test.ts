import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkOutput, runTrial, scenarios, summarize, type Trial } from '../benchmarks/local';

describe('local benchmark', () => {
  it.each(scenarios)(
    '$id: compares identical work with executable dependency checks',
    async (scenario) => {
      const root = mkdtempSync(join(tmpdir(), 'ravel-benchmark-'));
      try {
        const trials: Trial[] = [];
        for (const mode of ['off', 'observe', 'guard'] as const)
          trials.push(await runTrial(scenario, mode, join(root, mode)));
        const [off, observe, guard] = trials;
        expect(off.success).toBe(!scenario.stale);
        expect(off.hazardsDetected).toBeNull();
        expect(observe.success).toBe(off.success);
        expect(observe.hazardsDetected).toBe(Number(scenario.stale));
        expect(guard.success).toBe(true);
        expect(guard.writesRejected).toBe(Number(scenario.stale));
        expect(guard.attemptsRerun).toBe(Number(scenario.stale));
        expect(guard.generationCalls).toBe(2 + Number(scenario.stale));
        expect(guard.generatedBytes).toBeGreaterThan(0);
        expect(summarize(trials).find((row) => row.mode === 'guard')?.dependencyPassRate).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it('rejects broken, stale, and nonterminating generated implementations', () => {
    const expected = { prefix: '/v2/', factor: 100 };
    expect(checkOutput('exports.transform = n => "/v1/" + n;', 'transform', expected)).toBe(false);
    expect(checkOutput('throw new Error("broken")', 'transform', expected)).toBe(false);
    expect(
      checkOutput('exports.transform = () => { while (true) {} };', 'transform', expected),
    ).toBe(false);
  });
});
