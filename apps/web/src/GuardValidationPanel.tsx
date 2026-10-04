import type { RavelEvent, TimelineEvent } from '@ravel/shared';
import { rejectedInputs } from './traceView';
import { StatusIndicator } from './StatusIndicator';

export function GuardValidationPanel({
  event,
  events,
}: {
  event: TimelineEvent;
  events: RavelEvent[];
}) {
  const inputs = rejectedInputs(event.id, events);
  return (
    <section className="guard-validation" aria-label="Guard validation evidence">
      <StatusIndicator state="REJECTED">Guard rejected candidate</StatusIndicator>
      <p>Validation intercepted this write before publication.</p>
      {inputs.map(({ observed, current }) => (
        <div className="validation-comparison" key={observed.id}>
          <code>{observed.resourceId}</code>
          <dl>
            <div>
              <dt>Observed</dt>
              <dd className="mono">@{observed.generation}</dd>
            </div>
            <div>
              <dt>At rejection</dt>
              <dd className="mono">@{current.generation}</dd>
            </div>
          </dl>
        </div>
      ))}
      {inputs.length === 0 && (
        <p>Read the rejection reason above; input version evidence is unavailable in this slice.</p>
      )}
    </section>
  );
}
