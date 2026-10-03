import type { Hazard, Version } from '@ravel/shared';
import type { RunState } from '../domain/state';
import { stableId } from '../domain/identity';

export function staleInputs(state: RunState, observationIds: readonly string[]) {
  return observationIds.flatMap((observationId) => {
    const observation = state.observations[observationId];
    if (!observation) throw new Error('Unknown Observation.');
    const observed = state.versions[observation.versionId];
    const head = state.versions[state.heads[observed.resourceId]];
    if (!head) throw new Error('Resource head references a missing version.');
    if (observed.contentHash === head.contentHash) return [];
    // Walk backward until the most recent content match. The following version
    // begins the CURRENT continuous stale interval, including A→B→A→C histories.
    let start = head;
    while (start.previousVersionId) {
      const previous = state.versions[start.previousVersionId];
      if (!previous) throw new Error('Broken version succession.');
      if (
        previous.contentHash === observed.contentHash ||
        previous.creationSeq < observed.creationSeq
      )
        break;
      start = previous;
    }
    return [{ observation, observed, head, staleSince: start }];
  });
}

export function detectHazards(
  state: RunState,
  observationIds: readonly string[],
  output: Version,
): Hazard[] {
  return staleInputs(state, observationIds).map(({ observation, observed, head, staleSince }) => ({
    id: stableId('hazard', output.id, observation.id),
    observedVersionId: observed.id,
    staleSinceVersionId: staleSince.id,
    validationHeadVersionId: head.id,
    consumerVersionId: output.id,
    observationId: observation.id,
    observingAgentId: state.attempts[observation.attemptId].agentId,
    invalidatingAgentId: staleSince.producerAttemptId
      ? state.attempts[staleSince.producerAttemptId].agentId
      : null,
    evidence:
      observed.resourceId === output.resourceId ? 'SAME_RESOURCE_BASE' : 'MODEL_OBSERVATION',
    detectedSeq: output.creationSeq,
  }));
}
