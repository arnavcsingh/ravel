import type { DebuggerSnapshot, ReplayStep } from '@ravel/shared';

const colors = {
  CLEAN: 'var(--ink)',
  STALE_INPUT: 'var(--red)',
  DOWNSTREAM: 'var(--amber)',
  SEMANTIC_CONFLICT: 'var(--red)',
};
export function Timeline({
  snapshot,
  step,
  selectHazard,
  selectEvent,
  selectedVersionId,
  agentStates,
}: {
  snapshot: DebuggerSnapshot;
  step: ReplayStep | null;
  selectHazard: (id: string) => void;
  selectEvent?: (versionId: string | null, agentId: string | null) => void;
  selectedVersionId?: string | null;
  agentStates?: Record<string, string>;
}) {
  const points = [
    ...new Set([
      ...snapshot.timeline.map((event) => event.runtimeSeq),
      ...snapshot.staleWindows.flatMap((window) => [window.startSeq, window.endSeq]),
    ]),
  ].sort((a, b) => a - b);
  if (points.length < 2) points.push((points[0] ?? snapshot.currentRuntimeSeq) + 6);
  if (points.length === 1) points.unshift(snapshot.currentRuntimeSeq);
  const width = Math.max(760, (points.length - 1) * 170 + 280),
    left = 180,
    right = width - 45,
    height = Math.max(220, snapshot.agents.length * 66 + 65);
  const x = (seq: number) => {
    let index = points.findIndex((point) => point >= seq);
    if (index < 0) index = points.length - 1;
    const previous = points[Math.max(0, index - 1)];
    const offset =
      index && seq < points[index]
        ? index - 1 + (seq - previous) / (points[index] - previous)
        : index;
    return left + (offset / (points.length - 1)) * (right - left);
  };
  return (
    <section className="panel timeline-panel">
      <div className="panel-heading">
        <div>
          <h2>Execution timeline</h2>
          <span className="panel-subtitle">Agent lanes · ordered by runtime sequence</span>
        </div>
        <div className="legend">
          <span>
            <i className="dot read" />
            Observe
          </span>
          <span>
            <i className="dot write" />
            Write
          </span>
          <span>
            <i className="dot stale" />
            Stale interval
          </span>
        </div>
      </div>
      <div className="agent-roster" aria-label="Agents in this execution">
        {snapshot.agents.map((agent) => {
          const entries = snapshot.timeline.filter((event) => event.agentId === agent.id);
          const eventCount = new Set(entries.map((event) => event.runtimeSeq)).size;
          const affected = entries.find(
            (event) =>
              event.action !== 'OBSERVE' &&
              event.state !== 'CLEAN' &&
              snapshot.graph.nodes.some((node) => node.id === event.versionId && node.currentHead),
          );
          return (
            <div className="agent-summary" key={agent.id}>
              <strong>{agent.name}</strong>
              <span className={affected ? `agent-${affected.state.toLowerCase()}` : ''}>
                {affected
                  ? affected.state.toLowerCase().replaceAll('_', ' ')
                  : (agentStates?.[agent.id] ?? agent.status)}{' '}
                · {eventCount} trace event{eventCount === 1 ? '' : 's'}
              </span>
            </div>
          );
        })}
      </div>
      <div className="diagram-scroll">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          style={snapshot.timeline.length > 6 ? { minWidth: width } : undefined}
          role="group"
          aria-label="Agent observations, writes, and continuous stale intervals"
        >
          {points.map((seq, i) => {
            const cx = x(seq);
            return (
              <g key={i}>
                <line
                  x1={cx}
                  x2={cx}
                  y1={16}
                  y2={height - 31}
                  stroke="var(--line)"
                  strokeDasharray="3 5"
                />
                <text
                  x={cx}
                  y={height - 12}
                  textAnchor="middle"
                  fill="var(--muted)"
                  fontSize={11}
                  fontFamily="monospace"
                >
                  {seq}
                </text>
              </g>
            );
          })}
          {snapshot.agents.map((agent, i) => {
            const y = 40 + i * 66;
            return (
              <g key={agent.id}>
                <rect x={19} y={y - 13} width={26} height={26} rx={3} fill="var(--raised)" />
                <text x={32} y={y + 4} textAnchor="middle" fontSize={11} fill="var(--muted)">
                  {agent.name[0]}
                </text>
                <text x={56} y={y + 4} fontSize={12} fill="var(--ink)">
                  {agent.name.length > 18 ? `${agent.name.slice(0, 17)}…` : agent.name}
                </text>
                <line x1={left - 10} x2={right + 16} y1={y} y2={y} stroke="var(--line)" />
              </g>
            );
          })}
          {snapshot.staleWindows.map((window) => {
            const y = 40 + snapshot.agents.findIndex((a) => a.id === window.agentId) * 66;
            const start = x(window.startSeq),
              end = x(window.endSeq);
            return (
              <g key={`${window.hazardId}:${window.resourceId}:${window.startSeq}`}>
                <title>{`Stale ${window.resourceId}: sequence ${window.startSeq} to ${window.endSeq}`}</title>
                <rect
                  x={start}
                  y={y - 18}
                  width={Math.max(end - start, 4)}
                  height={36}
                  rx={0}
                  fill="var(--red)"
                  opacity={0.1}
                />
                <line
                  x1={start}
                  x2={start}
                  y1={y - 25}
                  y2={y + 26}
                  stroke="var(--red)"
                  strokeDasharray="3 3"
                />
                <text
                  x={start + 7}
                  y={y - 25}
                  fill="var(--red)"
                  fontSize={10}
                  fontFamily="monospace"
                >
                  STALE WINDOW
                </text>
              </g>
            );
          })}
          {snapshot.timeline.map((event) => {
            const siblings = snapshot.timeline.filter(
              (other) =>
                other.runtimeSeq === event.runtimeSeq &&
                other.agentId === event.agentId &&
                other.action === event.action,
            );
            if (siblings[0].id !== event.id) return null;
            const y = 40 + snapshot.agents.findIndex((a) => a.id === event.agentId) * 66,
              cx = x(event.runtimeSeq);
            const read = event.action === 'OBSERVE';
            const color = read ? 'var(--accent)' : colors[event.state];
            const label = snapshot.graph.nodes.find((n) => n.id === event.versionId)?.label;
            const highlighted =
              step?.runtimeSeq === event.runtimeSeq ||
              (!!selectedVersionId && selectedVersionId === event.versionId);
            const select = () => {
              selectEvent?.(event.versionId, event.agentId);
              if (event.hazardIds[0]) selectHazard(event.hazardIds[0]);
            };
            return (
              <g
                key={event.id}
                className="timeline-event"
                role="button"
                tabIndex={0}
                aria-label={`Inspect ${event.description}`}
                onKeyDown={(key) => {
                  if (key.key === 'Enter' || key.key === ' ') {
                    key.preventDefault();
                    select();
                  }
                }}
                onClick={select}
              >
                <title>{siblings.map((item) => item.description).join('\n')}</title>
                {highlighted && <circle cx={cx} cy={y} r={14} fill={color} opacity={0.16} />}
                <circle
                  cx={cx}
                  cy={y}
                  r={highlighted ? 6 : 5}
                  fill={read ? 'var(--surface)' : color}
                  stroke={color}
                  strokeWidth={2}
                />
                <text
                  x={cx}
                  y={y + (read ? -12 : 22)}
                  textAnchor={cx > right - 50 ? 'end' : cx < 155 ? 'start' : 'middle'}
                  fontSize={11}
                  fill={color}
                  fontFamily="monospace"
                >
                  {read ? 'OBSERVE' : event.action} {label}{' '}
                  {siblings.length > 1 ? `+${siblings.length - 1}` : ''}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="timeline-foot">
        <span>→ Runtime sequence</span>
        <span>Shading begins when the observed contents change</span>
      </div>
    </section>
  );
}
