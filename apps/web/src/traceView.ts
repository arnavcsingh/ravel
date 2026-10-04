import type { DebuggerSnapshot, RavelEvent, TimelineEvent } from '@ravel/shared';

// A view adapter over immutable facts. It does not infer scheduler actions.
export function executionView(snapshot: DebuggerSnapshot, events: RavelEvent[]): DebuggerSnapshot {
  const facts = events.filter(
    (event) => event.runId === snapshot.run.id && event.runtimeSeq <= snapshot.currentRuntimeSeq,
  );
  const timeline = new Map(snapshot.timeline.map((event) => [event.id, event]));
  for (const event of facts) {
    if (timeline.has(event.id)) continue;
    const name = snapshot.agents.find((agent) => agent.id === event.agentId)?.name ?? 'Runtime';
    let action = '',
      description = '',
      resourceId: string | null = null;
    let state: TimelineEvent['state'] = 'CLEAN';
    let hazardIds: string[] = [];
    if (event.kind === 'WRITE_INTENT') {
      action = 'WRITE_INTENT';
      resourceId = event.payload.resourceId;
      description = `${name} proposed a candidate for ${resourceId}. Publication is not yet recorded at this event.`;
    } else if (event.kind === 'WRITE_REJECTED') {
      action = 'GUARD_REJECT';
      state = 'STALE_INPUT';
      const intent = facts.find(
        (fact) => fact.kind === 'WRITE_INTENT' && fact.payload.id === event.payload.intentId,
      );
      resourceId = intent?.kind === 'WRITE_INTENT' ? intent.payload.resourceId : null;
      description = `${name}: ${event.payload.reason} Candidate was rejected before publication.`;
    } else if (event.kind === 'TASK_ATTEMPT_START') {
      const priorRejection = facts.some(
        (fact) =>
          fact.kind === 'WRITE_REJECTED' &&
          fact.agentId === event.agentId &&
          fact.runtimeSeq < event.runtimeSeq,
      );
      action =
        event.payload.attempt.number > 1 ? (priorRejection ? 'RETRY' : 'REPLACEMENT') : 'START';
      description = `${name} started ${event.payload.task.name}, attempt #${event.payload.attempt.number}. Replacement attempts may be retries or repair work.`;
    } else if (event.kind === 'SEMANTIC_ASSESSMENT') {
      action = 'MODEL_ASSESSMENT';
      hazardIds = [event.payload.hazardId];
      description = `${event.payload.analyzer}: ${event.payload.reason}`;
    } else if (event.kind === 'TASK_ATTEMPT_END' && event.payload.status === 'failed') {
      action = 'FAILED';
      description = `${name} task attempt failed. The recorded trace is preserved.`;
    } else if (event.kind === 'NOOP_WRITE') {
      action = 'NOOP';
      description = `${name} candidate did not create a replacement version.`;
    }
    if (action)
      timeline.set(event.id, {
        id: event.id,
        runtimeSeq: event.runtimeSeq,
        agentId: event.agentId,
        agentName: name,
        action,
        description,
        resourceId,
        versionId: null,
        state,
        hazardIds,
      });
  }
  const rejectedWindows = facts.flatMap((event) =>
    event.kind === 'WRITE_REJECTED' && event.agentId
      ? rejectedInputs(event.id, facts).map((input) => ({
          hazardId: event.id,
          agentId: event.agentId!,
          observedSeq:
            facts.find(
              (fact) =>
                fact.kind === 'OBSERVE_RESOURCE' &&
                fact.payload.observation.versionId === input.observed.id &&
                fact.agentId === event.agentId,
            )?.runtimeSeq ?? input.observed.creationSeq,
          startSeq: input.staleSince.creationSeq,
          endSeq: event.runtimeSeq,
          resourceId: input.observed.resourceId,
        }))
      : [],
  );
  return {
    ...snapshot,
    staleWindows: [...snapshot.staleWindows, ...rejectedWindows],
    timeline: [...timeline.values()].sort((a, b) => a.runtimeSeq - b.runtimeSeq),
  };
}

export function rejectedInputs(eventId: string, events: RavelEvent[]) {
  const rejection = events.find((event) => event.id === eventId);
  if (rejection?.kind !== 'WRITE_REJECTED') return [];
  const versions = events.flatMap((event) =>
    ['RESOURCE_SNAPSHOT', 'WRITE_COMMIT', 'DELETE_COMMIT'].includes(event.kind) &&
    'version' in event.payload
      ? [event.payload.version]
      : [],
  );
  return rejection.payload.staleObservationIds.flatMap((id) => {
    const read = events.find(
      (event) => event.kind === 'OBSERVE_RESOURCE' && event.payload.observation.id === id,
    );
    const observed =
      read?.kind === 'OBSERVE_RESOURCE'
        ? versions.find((version) => version.id === read.payload.observation.versionId)
        : null;
    if (!observed) return [];
    const current = versions
      .filter(
        (version) =>
          version.resourceId === observed.resourceId && version.creationSeq <= rejection.runtimeSeq,
      )
      .sort((a, b) => b.creationSeq - a.creationSeq)[0];
    const chain = versions
      .filter(
        (version) =>
          version.resourceId === observed.resourceId && version.creationSeq <= rejection.runtimeSeq,
      )
      .sort((a, b) => a.creationSeq - b.creationSeq);
    const lastMatching = chain
      .map((version) => version.contentHash === observed.contentHash)
      .lastIndexOf(true);
    const staleSince = chain[lastMatching + 1] ?? current;
    return current && staleSince ? [{ observed, current, staleSince }] : [];
  });
}
