import type { LiveRunStatus } from './LiveRun';
import { StatusIndicator } from './StatusIndicator';

export function LiveRunDetails({ status }: { status: LiveRunStatus }) {
  return (
    <div className="live-session-details" role="status">
      <div className="live-session-phase">
        <StatusIndicator state={status.phase}>{status.phase}</StatusIndicator>
        <span>{status.scheduler}</span>
        {status.activeAffectedCount !== undefined && (
          <span>{status.activeAffectedCount} affected heads</span>
        )}
      </div>
      {status.phase === 'held' && (
        <p>A real candidate is held. Publication still passes through runtime validation.</p>
      )}
      {status.phase === 'completed' && status.hazardCount === 0 && (
        <p>No hazard occurred; this is a valid execution outcome.</p>
      )}
      {status.error && (
        <p className="error" role="alert">
          {status.error}
        </p>
      )}
      {status.warnings?.map((warning, i) => (
        <p className="live-warning" key={i}>
          {warning}
        </p>
      ))}
      {status.repairs?.map((repair, i) => (
        <p key={i}>
          <StatusIndicator state={repair.status === 'clean' ? 'REPAIRED' : repair.status}>
            Repair {repair.status}
          </StatusIndicator>{' '}
          · {repair.replacements.length} replacement versions. Historical versions retained.
          {repair.error && <span className="error">{repair.error}</span>}
          {repair.activeAffectedCount !== undefined && (
            <span> · {repair.activeAffectedCount} affected heads after this repair</span>
          )}
        </p>
      ))}
      {status.phase === 'completed' && (
        <p>
          Execution completed.{' '}
          {status.activeAffectedCount === 0 ? 'No active impact.' : 'Active impact remains.'} Repair
          success is recorded separately for each repair below.
        </p>
      )}
      {!!status.operationErrors?.length && (
        <details>
          <summary>
            Controller API rejection evidence · {status.operationErrors.length} operations
          </summary>
          {status.operationErrors.map((e, i) => (
            <p key={i}>
              <code>{e.attemptId}</code> · {e.operation} · HTTP {e.status} · {e.error}
            </p>
          ))}
          <p>
            Rejected API operations are retained separately from committed runtime facts and
            semantic interpretation.
          </p>
        </details>
      )}
      <details>
        <summary>Task results · {status.attempts?.length ?? 0} recorded attempts</summary>
        <div className="live-health" aria-label="Task attempts">
          {status.attempts?.map((attempt) => (
            <span key={attempt.id}>
              {attempt.role} #{attempt.number} · {attempt.status} ·{' '}
              <code>{attempt.id.slice(0, 8)}</code>
              {attempt.repairOf && (
                <span>
                  {' '}
                  · repair of <code>{attempt.repairOf.slice(0, 8)}</code>
                </span>
              )}
            </span>
          ))}
        </div>
        {Object.entries(status.resultHistory ?? status.results ?? {}).map(([role, result]) => (
          <p key={role}>
            <b>{role}</b> · {result.committedWrites} writes ·{' '}
            <code>{result.attemptId.slice(0, 8)}</code> · {result.summary}
          </p>
        ))}
      </details>
    </div>
  );
}
