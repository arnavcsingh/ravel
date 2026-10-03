import { diffLines } from 'diff';
import {
  DebuggerSnapshotSchema,
  HazardDetailSchema,
  ReplayPlanSchema,
  type DebuggerSnapshot,
  type GraphEdge,
  type HazardDetail,
  type HazardSummary,
  type ReplayPlan,
  type TimelineEvent,
  type VersionState,
} from '@ravel/shared';
import type { RunState } from '../domain/state';
import { stableId } from '../domain/identity';
import { RavelStore } from '../storage/store';
import { blastRadius } from '../provenance/graph';
import { staleInputs } from '../detection/stale';
import { replay } from './reducer';

/** Sole owner of concurrency presentation meaning. Clients render these DTOs. */
export class DebuggerProjector {
  constructor(readonly store: RavelStore) {}
  state(runId: string, seq?: number): RunState {
    const state = replay(this.store.events(runId, seq));
    if (!state.run) throw new Error('Run not found.');
    return state;
  }
  private summaries(state: RunState): HazardSummary[] {
    return state.hazards.map((hazard) => {
      const radius = blastRadius(hazard.consumerVersionId, state.edges, state.heads);
      return {
        ...hazard,
        observed: state.versions[hazard.observedVersionId],
        invalidating: state.versions[hazard.staleSinceVersionId],
        consumer: state.versions[hazard.consumerVersionId],
        observerName: state.agents[hazard.observingAgentId].name,
        invalidatorName: hazard.invalidatingAgentId
          ? state.agents[hazard.invalidatingAgentId].name
          : 'Repository',
        active: radius.active.length > 0,
        historicalBlastRadius: radius.historical,
        activeBlastRadius: radius.active,
        assessment: state.assessments[hazard.id] ?? null,
      };
    });
  }
  snapshot(runId: string, seq?: number): DebuggerSnapshot {
    const all = this.store.events(runId),
      state = replay(seq === undefined ? all : all.filter((e) => e.runtimeSeq <= seq));
    if (!state.run) throw new Error('Run not found.');
    const hazards = this.summaries(state);
    const states: Record<string, VersionState> = Object.fromEntries(
      Object.keys(state.versions).map((id) => [id, 'CLEAN']),
    );
    for (const hazard of hazards)
      for (const version of hazard.historicalBlastRadius) states[version] = 'DOWNSTREAM';
    for (const hazard of hazards)
      if (states[hazard.consumerVersionId] !== 'SEMANTIC_CONFLICT')
        states[hazard.consumerVersionId] =
          hazard.assessment?.relevance === 'CONFLICT' ? 'SEMANTIC_CONFLICT' : 'STALE_INPUT';
    const resources = [...new Set(Object.values(state.versions).map((v) => v.resourceId))];
    const nodes = Object.values(state.versions).map((v) => ({
      id: v.id,
      label: `${v.resourceId.split('/').at(-1)}@${v.generation}`,
      resourceId: v.resourceId,
      generation: v.generation,
      state: states[v.id],
      currentHead: state.heads[v.resourceId] === v.id,
      tombstone: v.tombstone,
      x: resources.indexOf(v.resourceId) * 270,
      y:
        Object.values(state.versions).filter(
          (other) => other.resourceId === v.resourceId && other.generation < v.generation,
        ).length * 120,
      hazardIds: hazards
        .filter(
          (h) =>
            h.historicalBlastRadius.includes(v.id) ||
            h.observedVersionId === v.id ||
            h.staleSinceVersionId === v.id,
        )
        .map((h) => h.id),
    }));
    const edges: GraphEdge[] = state.edges.map((e) => ({
      id: e.id,
      source: e.sourceVersionId,
      target: e.targetVersionId,
      kind: 'DERIVED_FROM',
      label: e.evidence.replaceAll('_', ' ').toLowerCase(),
    }));
    for (const v of Object.values(state.versions))
      if (v.previousVersionId)
        edges.push({
          id: stableId('succession', v.id),
          source: v.previousVersionId,
          target: v.id,
          kind: 'VERSION_SUCCESSOR',
          label: 'next version',
        });
    const timeline: TimelineEvent[] = [];
    for (const event of state.events) {
      const versionId =
        event.kind === 'OBSERVE_RESOURCE'
          ? event.payload.observation.versionId
          : event.kind === 'WRITE_COMMIT' || event.kind === 'DELETE_COMMIT'
            ? event.payload.version.id
            : null;
      if (!versionId) continue;
      const version = state.versions[versionId],
        action =
          event.kind === 'OBSERVE_RESOURCE'
            ? 'OBSERVE'
            : event.kind === 'DELETE_COMMIT'
              ? 'DELETE'
              : 'WRITE';
      const agentName = state.agents[event.agentId!]?.name ?? 'Runtime';
      timeline.push({
        id: event.id,
        runtimeSeq: event.runtimeSeq,
        agentId: event.agentId,
        agentName,
        action,
        description: `${agentName} ${action === 'OBSERVE' ? 'observed' : action === 'DELETE' ? 'deleted' : 'produced'} ${version.resourceId}@${version.generation}`,
        versionId,
        resourceId: version.resourceId,
        state: action === 'OBSERVE' ? 'CLEAN' : states[versionId],
        hazardIds: hazards
          .filter(
            (h) =>
              h.consumerVersionId === versionId ||
              h.observationId ===
                (event.kind === 'OBSERVE_RESOURCE' ? event.payload.observation.id : ''),
          )
          .map((h) => h.id),
      });
    }
    const staleWindows = hazards.map((h) => ({
      hazardId: h.id,
      agentId: h.observingAgentId,
      observedSeq: state.events.find((e) => e.id === state.observations[h.observationId].eventId)!
        .runtimeSeq,
      startSeq: h.invalidating.creationSeq,
      endSeq: h.consumer.creationSeq,
      resourceId: h.observed.resourceId,
    }));
    for (const intent of Object.values(state.intents).filter(
      (intent) => !state.settledIntents.includes(intent.id),
    ))
      for (const input of staleInputs(state, intent.observationIds))
        staleWindows.push({
          hazardId: intent.id,
          agentId: state.attempts[intent.attemptId].agentId,
          observedSeq: state.events.find((e) => e.id === input.observation.eventId)!.runtimeSeq,
          startSeq: input.staleSince.creationSeq,
          endSeq: state.seq,
          resourceId: input.observed.resourceId,
        });
    return DebuggerSnapshotSchema.parse({
      run: state.run,
      agents: Object.values(state.agents),
      timeline,
      graph: { nodes, edges },
      hazards,
      staleWindows,
      currentRuntimeSeq: state.seq,
      latestRuntimeSeq: all.at(-1)?.runtimeSeq ?? 0,
      activeAffectedCount: new Set(hazards.flatMap((h) => h.activeBlastRadius)).size,
      guard: {
        rejectedWrites: state.events.filter((event) => event.kind === 'WRITE_REJECTED').length,
        retries: Object.values(state.attempts).filter((attempt) => attempt.number > 1).length,
      },
      eventCount: state.events.length,
      heads: state.heads,
      canRepair:
        state.run.scenario === 'identifier-migration' &&
        state.run.status === 'completed' &&
        hazards.some((h) => h.active) &&
        !Object.values(state.attempts).some((a) => a.number > 1),
    });
  }
  hazard(hazardId: string, seq?: number): HazardDetail {
    const runId = this.store.runForEntity('hazards', hazardId);
    if (!runId) throw new Error('Hazard not found.');
    const state = this.state(runId, seq),
      summary = this.summaries(state).find((h) => h.id === hazardId);
    if (!summary) throw new Error('Hazard not found at this point in the trace.');
    const observedContent = this.store.content(summary.observed),
      validationHead = state.versions[summary.validationHeadVersionId],
      currentContent = this.store.content(validationHead),
      consumerContent = this.store.content(summary.consumer);
    const diff = diffLines(observedContent ?? '(absent)\n', currentContent ?? '(absent)\n').flatMap(
      (part) =>
        part.value
          .replace(/\n$/, '')
          .split('\n')
          .map((text) => ({
            kind: part.added
              ? ('added' as const)
              : part.removed
                ? ('removed' as const)
                : ('context' as const),
            text,
          })),
    );
    const observationSeq = state.events.find(
      (e) => e.id === state.observations[summary.observationId].eventId,
    )!.runtimeSeq;
    return HazardDetailSchema.parse({
      ...summary,
      runId,
      observedContent,
      currentContent,
      consumerContent,
      validationHead,
      diff,
      observationSeq,
      staleWindow: {
        hazardId,
        agentId: summary.observingAgentId,
        observedSeq: observationSeq,
        startSeq: summary.invalidating.creationSeq,
        endSeq: summary.consumer.creationSeq,
        resourceId: summary.observed.resourceId,
      },
      taskName: state.tasks[state.attempts[summary.consumer.producerAttemptId!].taskId].name,
    });
  }
  replayPlan(hazardId: string): ReplayPlan {
    const detail = this.hazard(hazardId),
      state = this.state(detail.runId),
      snapshot = this.snapshot(detail.runId);
    const affected = new Set(detail.historicalBlastRadius);
    const eventIds = new Set([
      state.observations[detail.observationId].eventId,
      detail.invalidating.createdEventId,
      ...[...affected].map((id) => state.versions[id].createdEventId),
    ]);
    for (const edge of state.edges)
      if (affected.has(edge.sourceVersionId) && affected.has(edge.targetVersionId))
        eventIds.add(state.observations[edge.observationId].eventId);
    const steps = state.events
      .filter((e) => eventIds.has(e.id))
      .map((event) => {
        const item = snapshot.timeline.find((e) => e.id === event.id);
        const isInvalidation = event.id === detail.invalidating.createdEventId,
          isConsumer = event.id === detail.consumer.createdEventId;
        const versionId = item?.versionId;
        return {
          runtimeSeq: event.runtimeSeq,
          agent: item?.agentName ?? 'Runtime',
          action: item?.action ?? event.kind,
          description: item?.description ?? event.kind,
          annotation:
            event.id === state.observations[detail.observationId].eventId
              ? 'The agent now knows this input version.'
              : isInvalidation
                ? 'The observed content becomes stale here.'
                : isConsumer
                  ? 'The held output is committed using the stale observation.'
                  : item?.action === 'OBSERVE'
                    ? 'Another agent observes the stale-derived artifact.'
                    : 'Candidate provenance carries the impact downstream.',
          highlightNodes: versionId ? [versionId] : [],
          highlightEdges: snapshot.graph.edges
            .filter((e) => e.kind === 'DERIVED_FROM' && e.target === versionId)
            .map((e) => e.id),
          openStaleWindow: isInvalidation,
          closeStaleWindow: isConsumer,
        };
      });
    return ReplayPlanSchema.parse({ runId: detail.runId, hazardId, steps });
  }
  version(versionId: string) {
    const runId = this.store.runForEntity('resource_versions', versionId);
    if (!runId) throw new Error('Version not found.');
    const version = this.state(runId).versions[versionId];
    return { ...version, content: this.store.content(version), runId };
  }
}
