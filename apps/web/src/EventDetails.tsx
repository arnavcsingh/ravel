import type { TimelineEvent, DebuggerSnapshot } from '@ravel/shared';
import { StatusIndicator } from './StatusIndicator';

export function EventDetails({
  event,
  snapshot,
  close,
}: {
  event: TimelineEvent;
  snapshot: DebuggerSnapshot;
  close: () => void;
}) {
  const node = snapshot.graph.nodes.find((node) => node.id === event.versionId);
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
    </section>
  );
}
