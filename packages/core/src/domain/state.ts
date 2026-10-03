import type {
  Agent,
  Assessment,
  Attempt,
  Hazard,
  Observation,
  ProvenanceEdge,
  RavelEvent,
  Run,
  Task,
  Version,
  WriteIntent,
} from '@ravel/shared';
export interface RunState {
  run: Run | null;
  seq: number;
  events: RavelEvent[];
  agents: Record<string, Agent>;
  tasks: Record<string, Task>;
  attempts: Record<string, Attempt>;
  versions: Record<string, Version>;
  heads: Record<string, string>;
  observations: Record<string, Observation>;
  edges: ProvenanceEdge[];
  hazards: Hazard[];
  assessments: Record<string, Assessment>;
  intents: Record<string, WriteIntent>;
  settledIntents: string[];
}
export const emptyState = (): RunState => ({
  run: null,
  seq: 0,
  events: [],
  agents: Object.create(null),
  tasks: Object.create(null),
  attempts: Object.create(null),
  versions: Object.create(null),
  heads: Object.create(null),
  observations: Object.create(null),
  edges: [],
  hazards: [],
  assessments: Object.create(null),
  intents: Object.create(null),
  settledIntents: [],
});
export function cloneState(state: RunState): RunState {
  const clone = structuredClone(state);
  clone.heads = Object.assign(Object.create(null), clone.heads);
  for (const attempt of Object.values(clone.attempts))
    attempt.frontier = Object.assign(Object.create(null), attempt.frontier);
  return clone;
}
