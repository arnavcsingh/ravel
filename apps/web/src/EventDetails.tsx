import type { TimelineEvent, DebuggerSnapshot, RavelEvent } from '@ravel/shared';
import { StatusIndicator } from './StatusIndicator';

export function EventDetails({
  event,
  snapshot,
  close,
  facts = [],
}: {
  event: TimelineEvent;
  snapshot: DebuggerSnapshot;
  close: () => void;
  facts?: RavelEvent[];
}) {
  const node = snapshot.graph.nodes.find((node) => node.id === event.versionId);
  const fact = facts.find(
    (f) =>
      f.runId === snapshot.run.id &&
      (f.id === event.id || event.id.startsWith(`${f.id}:`)) &&
      f.runtimeSeq <= snapshot.currentRuntimeSeq,
  );
  return (
    <section className="event-details" aria-label="Selected event details">
      <div className="event-detail-heading">
        <strong>{event.action}</strong>
        <span className="mono">seq {event.runtimeSeq}</span>
        <button className="text-button" onClick={close}>
          Close event
        </button>
      </div>
      <p>{event.description}</p>
      <dl>
        <div>
          <dt>Agent</dt>
          <dd>{event.agentName || 'Runtime'}</dd>
        </div>
        <div>
          <dt>Resource</dt>
          <dd>
            <code>{node?.label ?? event.resourceId ?? '—'}</code>
          </dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd>
            <StatusIndicator state={event.state}>
              {event.state === 'CLEAN'
                ? 'no stale lineage recorded'
                : event.state.replaceAll('_', ' ').toLowerCase()}
            </StatusIndicator>
          </dd>
        </div>
      </dl>
      {event.attemptId && (
        <p className="mono">
          Attempt {event.attemptId} · task {event.taskId}
          {event.repairOf ? ` · repair of ${event.repairOf}` : ''}
        </p>
      )}
      {fact && (
        <details>
          <summary>
            {fact.kind === 'SEMANTIC_ASSESSMENT'
              ? 'Gemini / semantic interpretation payload'
              : 'Raw runtime evidence'}
          </summary>
          <pre className="version-code">{JSON.stringify(fact, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}
