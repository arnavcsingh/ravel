import type { Attempt, DebuggerSnapshot, RavelEvent, TimelineEvent } from '@ravel/shared';

export function attemptViews(snapshot: DebuggerSnapshot, events: RavelEvent[]) {
  const facts = events.filter(
    (e) => e.runId === snapshot.run.id && e.runtimeSeq <= snapshot.currentRuntimeSeq,
  );
  return facts.flatMap((event) => {
    if (event.kind !== 'TASK_ATTEMPT_START') return [];
    const attempt = event.payload.attempt;
    const entries = facts.filter((e) => e.attemptId === attempt.id);
    const end = entries.find((e) => e.kind === 'TASK_ATTEMPT_END');
    return [
      {
        ...attempt,
        startedSeq: event.runtimeSeq,
        startEventId: event.id,
        taskName: event.payload.task.name,
        status: end?.kind === 'TASK_ATTEMPT_END' ? end.payload.status : 'running',
        endedEventId: end?.id ?? null,
        rejected: entries.filter((e) => e.kind === 'WRITE_REJECTED'),
        failures: entries.filter((e) => e.kind === 'TOOL_RESULT' && !e.payload.success),
        observed: entries.flatMap((e) =>
          e.kind === 'OBSERVE_RESOURCE'
            ? [e.payload.observation.versionId]
            : e.kind === 'SEARCH_RESULT'
              ? e.payload.observations.map((o) => o.versionId)
              : [],
        ),
        outputs: entries.flatMap((e) =>
          e.kind === 'WRITE_COMMIT' || e.kind === 'DELETE_COMMIT' ? [e.payload.version.id] : [],
        ),
      },
    ];
  });
}

export function attemptAction(attempt: Pick<Attempt, 'repairOf' | 'number'>) {
  return attempt.repairOf ? 'REPAIR' : attempt.number > 1 ? 'RETRY' : 'START';
}

// A view adapter over immutable facts. It does not infer scheduler actions.
export function executionView(
  snapshot: DebuggerSnapshot,
  events: RavelEvent[],
  extras: TimelineEvent[] = [],
): DebuggerSnapshot {
  const facts = events.filter(
    (event) => event.runId === snapshot.run.id && event.runtimeSeq <= snapshot.currentRuntimeSeq,
  );
  const timeline = new Map(
    snapshot.timeline
      .filter((e) => e.runtimeSeq <= snapshot.currentRuntimeSeq)
      .map((event) => [event.id, event]),
  );
  const starts = facts.filter((e) => e.kind === 'TASK_ATTEMPT_START');
  for (const event of facts) {
    const attempt = starts.find(
      (e) => e.kind === 'TASK_ATTEMPT_START' && e.payload.attempt.id === event.attemptId,
    );
    const metadata = attempt?.kind === 'TASK_ATTEMPT_START' ? attempt.payload.attempt : null;
    const existing = timeline.get(event.id);
    if (existing && event.kind !== 'TASK_ATTEMPT_START') {
      let description = existing.description;
      if (event.kind === 'WRITE_COMMIT') {
        const previous = facts.find(
          (e) =>
            'version' in e.payload &&
            e.payload.version.id === event.payload.version.previousVersionId,
        );
        if (
          previous &&
          'version' in previous.payload &&
          previous.payload.version.contentHash === event.payload.version.contentHash &&
          !description.includes('New immutable replacement version; content and hash unchanged.')
        )
          description += ' New immutable replacement version; content and hash unchanged.';
      }
      timeline.set(event.id, {
        ...existing,
        description,
        attemptId: event.attemptId,
        taskId: event.taskId,
        repairOf: metadata?.repairOf,
      });
      continue;
    }
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
      action = attemptAction(event.payload.attempt);
      description = `${name} started ${event.payload.task.name}, attempt #${event.payload.attempt.number}.${event.payload.attempt.repairOf ? ` Repair of ${event.payload.attempt.repairOf}.` : ''}`;
    } else if (event.kind === 'SEMANTIC_ASSESSMENT') {
      action = 'MODEL_ASSESSMENT';
      hazardIds = [event.payload.hazardId];
      description = `${event.payload.analyzer}: ${event.payload.reason}`;
    } else if (event.kind === 'TASK_ATTEMPT_END') {
      action =
        event.payload.status === 'completed'
          ? 'COMPLETED'
          : event.payload.status === 'failed'
            ? 'FAILED'
            : 'INVALIDATED';
      description = `${name} task attempt ${event.payload.status}. Execution completion does not establish repair success.`;
    } else if (event.kind === 'TOOL_RESULT' && !event.payload.success) {
      action = 'TOOL_FAILED';
      description = event.payload.output;
    } else if (event.kind === 'SEARCH_RESULT') {
      for (const observation of event.payload.observations) {
        const node = snapshot.graph.nodes.find((n) => n.id === observation.versionId);
        timeline.set(`${event.id}:${observation.id}`, {
          id: `${event.id}:${observation.id}`,
          runtimeSeq: event.runtimeSeq,
          agentId: event.agentId,
          agentName: name,
          action: 'OBSERVE',
          description: `${name} observed ${node?.label ?? observation.versionId} through search.`,
          resourceId: node?.resourceId ?? null,
          versionId: observation.versionId,
          state: node?.state ?? 'CLEAN',
          hazardIds: [],
          attemptId: event.attemptId,
          taskId: event.taskId,
          repairOf: metadata?.repairOf,
        });
      }
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
        attemptId: event.kind === 'TASK_ATTEMPT_START' ? event.payload.attempt.id : event.attemptId,
        taskId: event.kind === 'TASK_ATTEMPT_START' ? event.payload.attempt.taskId : event.taskId,
        repairOf:
          event.kind === 'TASK_ATTEMPT_START' ? event.payload.attempt.repairOf : metadata?.repairOf,
      });
  }
  // Controller projections are fallback markers only. Immutable facts own a sequence.
  for (const extra of extras) {
    if (
      extra.runtimeSeq > snapshot.currentRuntimeSeq ||
      facts.some((e) => e.runtimeSeq === extra.runtimeSeq)
    )
      continue;
    if (
      ![...timeline.values()].some(
        (e) => e.runtimeSeq === extra.runtimeSeq && e.agentId === extra.agentId,
      )
    )
      timeline.set(extra.id, extra);
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
    staleWindows: [
      ...new Map(
        [...snapshot.staleWindows, ...rejectedWindows].map((w) => [
          `${w.hazardId}:${w.resourceId}:${w.startSeq}`,
          w,
        ]),
      ).values(),
    ],
    timeline: [...timeline.values()].sort((a, b) => a.runtimeSeq - b.runtimeSeq),
  };
}

export function rejectedInputs(eventId: string, events: RavelEvent[]) {
  const rejection = events.find((event) => event.id === eventId);
  if (rejection?.kind !== 'WRITE_REJECTED') return [];
  events = events.filter(
    (event) => event.runId === rejection.runId && event.runtimeSeq <= rejection.runtimeSeq,
  );
  const versions = events.flatMap((event) =>
    ['RESOURCE_SNAPSHOT', 'WRITE_COMMIT', 'DELETE_COMMIT'].includes(event.kind) &&
    'version' in event.payload
      ? [event.payload.version]
      : [],
  );
  return rejection.payload.staleObservationIds.flatMap((id) => {
    const observation = events
      .flatMap((event) =>
        event.kind === 'SEARCH_RESULT'
          ? event.payload.observations
          : 'observation' in event.payload
            ? [event.payload.observation]
            : [],
      )
      .find((observation) => observation.id === id);
    const observed = versions.find((version) => version.id === observation?.versionId);
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
