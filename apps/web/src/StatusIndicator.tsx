import type { ReactNode } from 'react';

export function statusTone(state: string) {
  const value = state.toUpperCase().replaceAll(' ', '_');
  if (/STALE|CONFLICT|FAILED|INVALIDATED/.test(value)) return 'danger';
  if (/REJECT/.test(value)) return 'rejected';
  if (/PENDING|HELD|DOWNSTREAM|REASONING|INCOMPLETE/.test(value)) return 'warning';
  if (/RETRY|OBSERV|RUNNING|REPAIRING|ASSESSING/.test(value)) return 'accent';
  if (/REPAIR|COMMIT|CURRENT|DONE|COMPLETED/.test(value)) return 'success';
  return 'neutral';
}

export function StatusIndicator({ state, children }: { state: string; children?: ReactNode }) {
  return (
    <span className={`status-indicator tone-${statusTone(state)}`}>
      <i aria-hidden="true" />
      {children ?? state.replaceAll('_', ' ').toLowerCase()}
    </span>
  );
}
