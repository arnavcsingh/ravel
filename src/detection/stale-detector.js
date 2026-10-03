export function detectStale(state, attempt, output, event) {
  const hazards = [];
  for (const observationId of Object.values(attempt.frontier)) {
    const observation = state.observations[observationId];
    const observed = state.versions[observation.resource_version_id];
    const head = state.versions[state.heads[observed.resource_id]];
    if (observed.content_hash === head.content_hash) continue;
    const first = Object.values(state.versions).find((version) =>
      version.resource_id === observed.resource_id && version.generation > observed.generation && version.content_hash !== observed.content_hash);
    hazards.push({
      hazard_id: `hazard:${output.version_id}:${observationId}`,
      consuming_version_id: output.version_id,
      observed_version_id: observed.version_id,
      first_invalidating_version_id: first.version_id,
      head_at_validation_id: head.version_id,
      source_observation_id: observationId,
      observing_agent_id: attempt.agent_id,
      invalidating_agent_id: first.producer_attempt_id ? state.attempts[first.producer_attempt_id].agent_id : null,
      evidence_type: observed.resource_id === output.resource_id ? 'SAME_RESOURCE_BASE' : 'MODEL_OBSERVATION',
      semantic_status: 'unassessed',
      detected_seq: event.runtime_seq,
    });
  }
  return hazards;
}
