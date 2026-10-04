import type { DebuggerSnapshot, ReplayStep, TimelineEvent } from '@ravel/shared';
import { useState } from 'react';
import { AgentCard } from './AgentCard';
import { statusTone } from './StatusIndicator';

export function Timeline({
  snapshot,
  step,
  selectHazard,
  selectEvent,
  selectedEventId,
  selectedAgentId,
  selectAgent,
  attempts = [],
}: {
  snapshot: DebuggerSnapshot;
  step: ReplayStep | null;
  selectHazard: (id: string) => void;
  selectEvent: (event: TimelineEvent) => void;
  selectedEventId: string | null;
  selectedAgentId: string | null;
  selectAgent: (id: string) => void;
  attempts?: { role: string; number: number; status: string }[];
}) {
  const [details, setDetails] = useState(false);
  const shownEvents = snapshot.timeline.filter(
    (event) =>
      details ||
      ['OBSERVE', 'WRITE', 'DELETE', 'GUARD_REJECT', 'RETRY', 'REPLACEMENT'].includes(
        event.action,
      ) ||
      event.id === selectedEventId ||
      event.runtimeSeq === step?.runtimeSeq ||
      (event.action === 'WRITE_INTENT' &&
        !snapshot.timeline.some(
          (later) =>
            later.agentId === event.agentId &&
            later.runtimeSeq > event.runtimeSeq &&
            ['WRITE', 'DELETE', 'GUARD_REJECT', 'NOOP'].includes(later.action),
        )),
  );
  const runtimeEvents = shownEvents.filter(
    (event) => !snapshot.agents.some((agent) => agent.id === event.agentId),
  );
  const lanes = [
    ...snapshot.agents.map((agent) => ({ id: agent.id, name: agent.name })),
    ...(runtimeEvents.length ? [{ id: null, name: 'Runtime' }] : []),
  ];
  const sequences = [
    ...new Set([
      ...shownEvents.map((event) => event.runtimeSeq),
      ...snapshot.staleWindows.flatMap((window) => [window.startSeq, window.endSeq]),
    ]),
  ].sort((a, b) => a - b);
  if (!sequences.length) sequences.push(snapshot.currentRuntimeSeq);
  const width = Math.max(1000, sequences.length * 112 + 180),
    left = 145,
    right = width - 80;
  const height = Math.max(180, lanes.length * 82 + 64);
  const x = (seq: number) => {
    const index = sequences.findIndex((value) => value >= seq);
    const position = index < 0 ? sequences.length - 1 : index;
    return left + (position / Math.max(1, sequences.length - 1)) * (right - left);
  };
  const laneIndex = (id: string | null) =>
    Math.max(
      0,
      lanes.findIndex((lane) => lane.id === id),
    );
  const color = (event: TimelineEvent) => {
    if (/REJECT|FAIL/.test(event.action)) return 'var(--red)';
    if (/RETRY|OBSERVE/.test(event.action)) return 'var(--accent)';
    if (/INTENT|VALIDAT/.test(event.action)) return 'var(--amber)';
    if (/REPAIR/.test(event.action)) return 'var(--green)';
    return event.state === 'CLEAN'
      ? 'var(--ink)'
      : event.state === 'DOWNSTREAM'
        ? 'var(--amber)'
        : 'var(--red)';
  };
  return (
    <section className="panel timeline-panel">
      <div className="panel-heading">
        <div>
          <h2>Execution timeline</h2>
          <span className="panel-subtitle">
            Concurrent agent lanes · runtime order, not elapsed time
          </span>
        </div>
        <div className="legend">
          <label className="graph-history">
            <input
              type="checkbox"
              checked={details}
              onChange={(event) => setDetails(event.target.checked)}
            />
            Detailed events
          </label>
          <span>
            <i className="dot read" />
            Observe
          </span>
          <span>
            <i className="dot write" />
            Commit
          </span>
          <span>
            <i className="dot stale" />
            Stale interval
          </span>
          <button
            className="text-button"
            onClick={() => selectAgent('')}
            disabled={!selectedAgentId}
          >
            Clear focus
          </button>
        </div>
      </div>
      <div className="agent-roster" aria-label="Agents in this execution">
        {snapshot.agents.map((agent) => {
          const allEntries = snapshot.timeline.filter((event) => event.agentId === agent.id);
          const attemptStart =
            allEntries.filter((event) => ['START', 'RETRY'].includes(event.action)).at(-1)
              ?.runtimeSeq ?? 0;
          const entries = allEntries.filter((event) => event.runtimeSeq >= attemptStart);
          const observed = [
            ...new Map(
              entries
                .filter((event) => event.action === 'OBSERVE' && event.versionId)
                .map((event) => [
                  event.versionId!,
                  {
                    id: event.versionId!,
                    label:
                      snapshot.graph.nodes.find((node) => node.id === event.versionId)?.label ??
                      event.resourceId ??
                      'Recorded resource',
                  },
                ]),
            ).values(),
          ];
          const output = entries.filter((event) => event.action === 'WRITE').at(-1);
          const affected =
            output &&
            snapshot.graph.nodes.find(
              (node) => node.id === output.versionId && node.currentHead && node.state !== 'CLEAN',
            );
          const attempt = attempts
            .filter((attempt) => attempt.role.toLowerCase() === agent.name.toLowerCase())
            .at(-1);
          const latest = entries.at(-1);
          const pending =
            latest && /INTENT/.test(latest.action) ? (latest.resourceId ?? undefined) : undefined;
          return (
            <AgentCard
              key={agent.id}
              selected={selectedAgentId === agent.id || step?.agent === agent.name}
              onSelect={() => selectAgent(selectedAgentId === agent.id ? '' : agent.id)}
              agent={{
                id: agent.id,
                name: agent.name,
                state: pending
                  ? 'PENDING_COMMIT'
                  : latest?.action === 'GUARD_REJECT'
                    ? 'REJECTED'
                    : latest?.action === 'FAILED'
                      ? 'FAILED'
                      : (attempt?.status ?? agent.status),
                attempt: attempt?.number,
                observed,
                pendingMutation: pending,
                output: output?.versionId
                  ? {
                      id: output.versionId,
                      state: affected?.state,
                      label:
                        snapshot.graph.nodes.find((node) => node.id === output.versionId)?.label ??
                        output.resourceId ??
                        'Recorded output',
                    }
                  : undefined,
              }}
            />
          );
        })}
      </div>
      <div className="diagram-scroll">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          style={{ minWidth: width }}
          role="group"
          aria-label="Agent observations, writes, and continuous stale intervals"
        >
          {sequences.map((seq) => (
            <g key={seq}>
              <line
                x1={x(seq)}
                x2={x(seq)}
                y1={12}
                y2={height - 34}
                stroke="var(--line)"
                strokeDasharray="2 6"
              />
              <text
                x={x(seq)}
                y={height - 12}
                textAnchor="middle"
                fill="var(--muted)"
                fontSize={11}
              >
                {seq}
              </text>
            </g>
          ))}
          {lanes.map((lane, i) => {
            const y = 42 + i * 82;
            return (
              <g
                key={lane.id ?? 'runtime'}
                opacity={selectedAgentId && selectedAgentId !== lane.id ? 0.45 : 1}
              >
                <text x={16} y={y + 4} fontSize={12} fill="var(--ink)">
                  {lane.name.length > 16 ? `${lane.name.slice(0, 15)}…` : lane.name}
                </text>
                <line x1={left - 12} x2={right + 65} y1={y} y2={y} stroke="var(--line)" />
              </g>
            );
          })}
          {snapshot.staleWindows.map((window) => {
            const y = 42 + laneIndex(window.agentId) * 82,
              start = x(window.startSeq),
              end = x(window.endSeq);
            const hazard = snapshot.hazards.find((hazard) => hazard.id === window.hazardId);
            const sourceY = hazard?.invalidatingAgentId
              ? 42 + laneIndex(hazard.invalidatingAgentId) * 82
              : y;
            return (
              <g key={window.hazardId}>
                <title>{`Observed ${window.resourceId} changed at sequence ${window.startSeq}; stale interval through sequence ${window.endSeq}`}</title>
                <rect
                  x={start}
                  y={y - 21}
                  width={Math.max(end - start, 4)}
                  height={42}
                  fill="var(--red)"
                  opacity={0.12}
                />
                <path
                  d={`M ${start} ${sourceY} L ${start} ${y - 27}`}
                  stroke="var(--red)"
                  strokeDasharray="3 4"
                  fill="none"
                />
                <text x={start + 8} y={y - 27} fill="var(--red)" fontSize={10}>
                  INPUT CHANGED
                </text>
              </g>
            );
          })}
          {shownEvents.map((event) => {
            const y = 42 + laneIndex(event.agentId) * 82,
              cx = x(event.runtimeSeq),
              ink = color(event);
            const read = event.action === 'OBSERVE';
            const label =
              snapshot.graph.nodes.find((node) => node.id === event.versionId)?.label ??
              event.resourceId ??
              '';
            const highlighted =
              step?.runtimeSeq === event.runtimeSeq || selectedEventId === event.id;
            return (
              <g
                key={event.id}
                className={`timeline-event tone-${statusTone(event.state)}`}
                role="button"
                tabIndex={0}
                aria-label={`Inspect event ${event.runtimeSeq}: ${event.description}`}
                aria-pressed={highlighted}
                opacity={selectedAgentId && selectedAgentId !== event.agentId ? 0.4 : 1}
                onKeyDown={(key) => {
                  if (key.key === 'Enter' || key.key === ' ') {
                    key.preventDefault();
                    selectEvent(event);
                  }
                }}
                onClick={() => {
                  if (event.hazardIds[0]) selectHazard(event.hazardIds[0]);
                  selectEvent(event);
                }}
              >
                <title>{`#${event.runtimeSeq} ${event.action} · ${event.description}`}</title>
                <rect
                  className="event-hit-area"
                  x={cx - 26}
                  y={y - 23}
                  width={52}
                  height={61}
                  fill="transparent"
                />
                {highlighted && (
                  <circle cx={cx} cy={y} r={13} fill="none" stroke={ink} strokeWidth={1} />
                )}
                <circle
                  cx={cx}
                  cy={y}
                  r={5}
                  fill={read ? 'var(--surface)' : ink}
                  stroke={ink}
                  strokeWidth={2}
                />
                <text x={cx} y={y - 13} textAnchor="middle" fontSize={10} fill={ink}>
                  {read ? 'OBSERVE' : event.action === 'WRITE' ? 'COMMIT' : event.action}
                </text>
                <text x={cx} y={y + 23} textAnchor="middle" fontSize={11} fill="var(--muted)">
                  {label.length > 23 ? `${label.slice(0, 21)}…` : label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="timeline-foot">
        <span>
          Runtime sequence → <span className="mono">{snapshot.currentRuntimeSeq}</span>
        </span>
        <span>Shading = stale observation. Select an event for its evidence.</span>
      </div>
    </section>
  );
}
