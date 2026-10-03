import { Evidence, State } from '../domain/models.js';
import { detectStale } from '../detection/stale-detector.js';
import { blastRadius } from '../provenance/graph.js';

export function emptyState() {
  return { run: null, runtime_seq: 0, events: [], agents: Object.create(null), tasks: Object.create(null), attempts: Object.create(null), versions: Object.create(null), heads: Object.create(null), observations: Object.create(null), edges: [], hazards: [], assessments: Object.create(null) };
}

function observe(state, attempt, versionId, event, type) {
  const version = state.versions[versionId];
  const observation = {
    observation_id: `observation:${event.event_id}`, attempt_id: attempt.attempt_id,
    resource_version_id: versionId, event_id: event.event_id, observation_type: type,
  };
  state.observations[observation.observation_id] = observation;
  attempt.frontier[version.resource_id] = observation.observation_id;
  attempt.observed_versions.push(versionId);
}

/** The same reducer powers the live runtime, historical replay, and restart. */
export function applyEvent(state, event) {
  const p = event.payload;
  const attempt = state.attempts[event.attempt_id];
  switch (event.kind) {
    case 'RUN_START': state.run = { run_id: event.run_id, started_at: event.wall_time, metadata: p, status: 'running' }; break;
    case 'RUN_END': state.run.status = 'completed'; state.run.ended_at = event.wall_time; break;
    case 'RUN_RESUME': state.run.status = 'running'; state.run.ended_at = null; break;
    case 'AGENT_START': state.agents[p.agent_id] = { ...p }; break;
    case 'TASK_ATTEMPT_START':
      state.tasks[p.task.task_id] = p.task;
      state.attempts[p.attempt_id] = { ...p, agent_id: event.agent_id, started_event: event.event_id, status: 'running', frontier: Object.create(null), observed_versions: [], produced_versions: [] };
      break;
    case 'TASK_ATTEMPT_END': attempt.status = p.status; attempt.ended_event = event.event_id; break;
    case 'RESOURCE_SNAPSHOT':
      state.versions[p.version.version_id] = p.version;
      state.heads[p.version.resource_id] = p.version.version_id;
      break;
    case 'OBSERVE_RESOURCE': observe(state, attempt, p.version_id, event, 'DIRECT_READ'); break;
    case 'NOOP_WRITE': observe(state, attempt, p.version_id, event, 'OWN_WRITE'); break;
    case 'WRITE_COMMIT':
    case 'DELETE_COMMIT': {
      const version = p.version;
      // Validate against the heads BEFORE publishing the consuming version.
      state.hazards.push(...detectStale(state, attempt, version, event));
      for (const observationId of Object.values(attempt.frontier)) {
        const observation = state.observations[observationId];
        const source = state.versions[observation.resource_version_id];
        if (source.creation_seq >= event.runtime_seq) throw new Error('Provenance must point forward in execution order.');
        state.edges.push({
          source_version_id: source.version_id, target_version_id: version.version_id,
          source_observation_id: observationId,
          evidence_type: source.resource_id === version.resource_id ? Evidence.BASE : Evidence.MODEL,
        });
      }
      state.versions[version.version_id] = version;
      state.heads[version.resource_id] = version.version_id;
      attempt.produced_versions.push(version.version_id);
      observe(state, attempt, version.version_id, event, 'OWN_WRITE');
      break;
    }
    case 'SEMANTIC_ASSESSMENT': state.assessments[p.hazard_id] = { ...p, assessed_seq: event.runtime_seq }; break;
  }
  state.runtime_seq = event.runtime_seq;
  state.events.push(event);
  return state;
}

export function project(events) {
  const state = events.reduce(applyEvent, emptyState());
  const versionStates = Object.fromEntries(Object.keys(state.versions).map((id) => [id, State.CLEAN]));
  const hazards = state.hazards.map((hazard) => {
    const radius = blastRadius(hazard.consuming_version_id, state.edges, state.heads);
    for (const id of radius.historical) if (versionStates[id] === State.CLEAN) versionStates[id] = State.DOWNSTREAM;
    return { ...hazard, blast_radius: radius, active: radius.active.length > 0, assessment: state.assessments[hazard.hazard_id] ?? null };
  });
  for (const hazard of hazards) {
    versionStates[hazard.consuming_version_id] = hazard.assessment?.relevance === 'confirmed' ? State.CONFLICT : State.STALE;
  }
  return { ...state, hazards, version_states: versionStates, active_hazards: hazards.filter((h) => h.active), active_blast_radius: [...new Set(hazards.flatMap((h) => h.blast_radius.active))] };
}

export function raceSlice(state, hazardId) {
  const hazard = state.hazards.find((h) => h.hazard_id === hazardId);
  if (!hazard) throw new Error('Hazard not found.');
  const affected = new Set(blastRadius(hazard.consuming_version_id, state.edges, state.heads).historical);
  const eventIds = new Set([
    state.observations[hazard.source_observation_id].event_id,
    state.versions[hazard.first_invalidating_version_id].created_event_id,
    ...[...affected].map((id) => state.versions[id].created_event_id),
  ]);
  for (const edge of state.edges) {
    if (affected.has(edge.source_version_id) && affected.has(edge.target_version_id)) eventIds.add(state.observations[edge.source_observation_id].event_id);
  }
  return state.events.filter((event) => eventIds.has(event.event_id));
}
