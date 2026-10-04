import type { ReactNode } from 'react';
import { StatusIndicator } from './StatusIndicator';

export type AgentCardData = {
  id: string;
  name: string;
  state: string;
  attempt?: number;
  observed: { id: string; label: string }[];
  output?: { id: string; label: string; state?: string };
  pendingMutation?: string;
  sequence?: number;
};

export function AgentCard({
  agent,
  selected,
  onSelect,
  actions,
}: {
  agent: AgentCardData;
  selected: boolean;
  onSelect: () => void;
  actions?: ReactNode;
}) {
  return (
    <div className={`agent-card ${selected ? 'selected' : ''}`}>
      <button
        className="agent-card-select"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`Focus ${agent.name} agent`}
      >
        <div className="agent-card-title">
          <strong>{agent.name}</strong>
          <span className="mono">
            {agent.attempt ? `attempt #${agent.attempt}` : agent.id.slice(0, 8)}
          </span>
        </div>
        <StatusIndicator state={agent.state} />
        <dl>
          <div>
            <dt>Observed</dt>
            <dd title={agent.observed.map((v) => v.label).join('\n')}>
              {agent.observed.length
                ? agent.observed.map((v) => <span key={v.id}>{v.label}</span>)
                : 'No recorded read'}
            </dd>
          </div>
          <div>
            <dt>{agent.pendingMutation ? 'Pending' : 'Produced'}</dt>
            <dd>
              {agent.pendingMutation ?? agent.output?.label ?? 'No recorded write'}
              {agent.output?.state && <StatusIndicator state={agent.output.state} />}
            </dd>
          </div>
        </dl>
      </button>
      {actions && <div className="agent-card-actions">{actions}</div>}
    </div>
  );
}
