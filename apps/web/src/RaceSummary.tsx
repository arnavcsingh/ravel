import type { DebuggerSnapshot, HazardDetail } from '@ravel/shared';
import { StatusIndicator } from './StatusIndicator';

export function RaceSummary({
  snapshot,
  detail: suppliedDetail,
}: {
  snapshot: DebuggerSnapshot;
  detail: HazardDetail | null;
}) {
  const detail = suppliedDetail ?? snapshot.hazards.find((hazard) => hazard.active) ?? null;
  const guard = snapshot.run.mode === 'guard';
  return (
    <div className={`race-summary ${detail?.active ? 'has-incident' : ''}`}>
      <div className="mode-explanation">
        <StatusIndicator state={guard ? 'CURRENT' : 'OBSERVING'}>
          {guard ? 'Guard' : 'Observe'}
        </StatusIndicator>
        <span>
          {guard
            ? 'Validate before publication. Reject stale candidates and refresh.'
            : 'Allow publication. Expose stale dependencies and their impact.'}
        </span>
      </div>
      {detail ? (
        <div className="race-facts" aria-label="Deterministic race summary">
          <span>
            <b>{detail.observerName} observed</b>
            <code>
              {detail.observed.resourceId}@{detail.observed.generation}
            </code>
          </span>
          <span aria-hidden="true">→</span>
          <span>
            <b>{detail.invalidatorName} advanced input</b>
            <code>
              @{detail.observed.generation} → @{detail.invalidating.generation}
            </code>
          </span>
          <span aria-hidden="true">→</span>
          <span>
            <b>Stale output published</b>
            <code>
              {detail.consumer.resourceId}@{detail.consumer.generation}
            </code>
          </span>
          <StatusIndicator state={detail.active ? 'STALE' : 'CURRENT'}>
            {detail.active
              ? `${detail.activeBlastRadius.length} affected heads`
              : '0 affected heads · history retained'}
          </StatusIndicator>
        </div>
      ) : guard && snapshot.guard.rejectedWrites > 0 ? (
        <div className="race-facts">
          <strong>Intercepted before publication</strong>
          <span>{snapshot.guard.rejectedWrites} rejected writes</span>
          <span>{snapshot.guard.retries} recorded retries</span>
          <StatusIndicator state={snapshot.activeAffectedCount ? 'STALE' : 'CURRENT'}>
            {snapshot.activeAffectedCount} affected heads
          </StatusIndicator>
        </div>
      ) : (
        <p className="race-empty">
          {snapshot.run.status === 'running'
            ? 'Execution is in progress. Select any event to inspect its recorded evidence.'
            : 'No visible incident in this view. Inspect resource versions or include historical incidents.'}
        </p>
      )}
    </div>
  );
}
