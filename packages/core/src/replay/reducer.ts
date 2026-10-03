import { EventSchema, type Observation, type RavelEvent, type Version } from '@ravel/shared';
import { emptyState, type RunState } from '../domain/state';
import { stableId } from '../domain/identity';
import { detectHazards } from '../detection/stale';
import { assertDerivation } from '../provenance/graph';

function observe(state: RunState, observation: Observation) {
  const attempt = state.attempts[observation.attemptId];
  const version = state.versions[observation.versionId];
  if (!attempt || attempt.status !== 'running' || !version)
    throw new Error('Observation references an inactive attempt or unknown ResourceVersion.');
  if (state.observations[observation.id]) throw new Error('Duplicate Observation.');
  state.observations[observation.id] = observation;
  attempt.frontier[version.resourceId] = observation.id;
  attempt.observedVersions.push(version.id);
}
function addVersion(state: RunState, version: Version, event: RavelEvent) {
  if (
    version.createdEventId !== event.id ||
    version.creationSeq !== event.runtimeSeq ||
    state.versions[version.id]
  )
    throw new Error('Invalid resource version creation event.');
  const previousId = state.heads[version.resourceId] ?? null;
  if (previousId !== version.previousVersionId)
    throw new Error('Resource version must succeed its current head.');
  if (previousId && version.generation !== state.versions[previousId].generation + 1)
    throw new Error('Invalid resource generation.');
  state.versions[version.id] = version;
  state.heads[version.resourceId] = version.id;
}
export function applyEvent(state: RunState, event: RavelEvent): RunState {
  EventSchema.parse(event);
  if (event.runtimeSeq !== state.seq + 1) throw new Error('Duplicate or out-of-order runtime_seq.');
  if (state.run && state.run.id !== event.runId) throw new Error('Event belongs to another run.');
  if (event.kind !== 'RUN_START' && !state.run)
    throw new Error('RUN_START must be the first event.');
  if (event.agentId) {
    const previous = state.events.filter((e) => e.agentId === event.agentId).at(-1)?.agentSeq ?? 0;
    if (event.agentSeq !== previous + 1) throw new Error('Invalid agent sequence.');
  }
  if (event.attemptId && event.kind !== 'TASK_ATTEMPT_START') {
    const attempt = state.attempts[event.attemptId];
    if (
      !attempt ||
      attempt.agentId !== event.agentId ||
      attempt.taskId !== event.taskId ||
      attempt.status !== 'running'
    )
      throw new Error('Event identity does not match an active task attempt.');
  }
  switch (event.kind) {
    case 'RUN_START':
      if (state.run || event.payload.id !== event.runId) throw new Error('Invalid RUN_START.');
      state.run = structuredClone(event.payload);
      break;
    case 'RUN_END':
      state.run!.status = event.payload.status;
      state.run!.endedAt = event.wallTime;
      break;
    case 'RUN_RESUME':
      state.run!.status = 'running';
      state.run!.endedAt = null;
      break;
    case 'AGENT_START':
      state.agents[event.payload.id] = structuredClone(event.payload);
      break;
    case 'AGENT_END':
      state.agents[event.payload.agentId].status = 'completed';
      break;
    case 'TASK_ATTEMPT_START': {
      const { task, attempt } = event.payload;
      if (
        !state.agents[attempt.agentId] ||
        task.runId !== event.runId ||
        attempt.taskId !== task.id ||
        attempt.id !== event.attemptId
      )
        throw new Error('Invalid task attempt identity.');
      state.tasks[task.id] = structuredClone(task);
      state.agents[attempt.agentId].status = 'running';
      state.attempts[attempt.id] = {
        ...structuredClone(attempt),
        frontier: Object.assign(Object.create(null), attempt.frontier),
      };
      break;
    }
    case 'TASK_ATTEMPT_END':
      state.attempts[event.attemptId!].status = event.payload.status;
      state.attempts[event.attemptId!].endedEventId = event.id;
      break;
    case 'RESOURCE_SNAPSHOT':
      addVersion(state, event.payload.version, event);
      break;
    case 'OBSERVE_RESOURCE':
      observe(state, event.payload.observation);
      break;
    case 'SEARCH_RESULT':
      for (const observation of event.payload.observations) observe(state, observation);
      break;
    case 'WRITE_INTENT': {
      if (event.payload.attemptId !== event.attemptId)
        throw new Error('Write intent identity mismatch.');
      for (const observationId of event.payload.observationIds)
        if (state.observations[observationId]?.attemptId !== event.attemptId)
          throw new Error('Write intent contains another attempt’s observation.');
      state.intents[event.payload.id] = event.payload;
      break;
    }
    case 'WRITE_COMMIT':
    case 'DELETE_COMMIT': {
      const { version, observationIds, observation, intentId } = event.payload;
      const intent = state.intents[intentId];
      if (
        !intent ||
        intent.attemptId !== event.attemptId ||
        intent.resourceId !== version.resourceId ||
        intent.candidateHash !== version.contentHash ||
        JSON.stringify(intent.observationIds) !== JSON.stringify(observationIds) ||
        state.settledIntents.includes(intentId)
      )
        throw new Error('Commit does not match its captured write intent.');
      state.hazards.push(...detectHazards(state, observationIds, version));
      addVersion(state, version, event);
      for (const observationId of observationIds) {
        const source = state.observations[observationId];
        const edge = {
          id: stableId('edge', version.id, observationId),
          sourceVersionId: source.versionId,
          targetVersionId: version.id,
          observationId,
          evidence: (state.versions[source.versionId].resourceId === version.resourceId
            ? 'SAME_RESOURCE_BASE'
            : 'MODEL_OBSERVATION') as 'SAME_RESOURCE_BASE' | 'MODEL_OBSERVATION',
        };
        assertDerivation(edge, state.versions);
        state.edges.push(edge);
      }
      state.attempts[event.attemptId!].producedVersions.push(version.id);
      observe(state, observation);
      state.settledIntents.push(intentId);
      break;
    }
    case 'NOOP_WRITE': {
      const intent = state.intents[event.payload.intentId];
      if (
        !intent ||
        state.settledIntents.includes(intent.id) ||
        state.versions[event.payload.observation.versionId]?.contentHash !== intent.candidateHash
      )
        throw new Error('Invalid no-op write intent.');
      observe(state, event.payload.observation);
      state.settledIntents.push(intent.id);
      break;
    }
    case 'WRITE_REJECTED':
      state.settledIntents.push(event.payload.intentId);
      break;
    case 'SEMANTIC_ASSESSMENT':
      if (!state.hazards.some((h) => h.id === event.payload.hazardId))
        throw new Error('Assessment references an unknown hazard.');
      state.assessments[event.payload.hazardId] = event.payload;
      break;
  }
  state.seq = event.runtimeSeq;
  state.events.push(event);
  return state;
}
export const replay = (events: RavelEvent[]): RunState => events.reduce(applyEvent, emptyState());
