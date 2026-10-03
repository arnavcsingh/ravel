import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  DebuggerSnapshotSchema,
  HazardDetailSchema,
  ReplayPlanSchema,
} from '../packages/shared/src';

// These are captured from the original TypeScript runtime; Go independently
// reproduces every projection in TestBaselineGoldenReplay.
for (const name of ['observe', 'guard', 'repair', 'held']) {
  it(`preserves the existing frontend contract: ${name}`, () => {
    const fixture = JSON.parse(readFileSync(`runtime/testdata/${name}.json`, 'utf8'));
    for (const snapshot of fixture.snapshots ?? [fixture.snapshot]) {
      expect(DebuggerSnapshotSchema.safeParse(snapshot).success).toBe(true);
    }
    for (const detail of fixture.hazards ?? [])
      expect(HazardDetailSchema.safeParse(detail).success).toBe(true);
    for (const plan of fixture.plans ?? [])
      expect(ReplayPlanSchema.safeParse(plan).success).toBe(true);
  });
}
