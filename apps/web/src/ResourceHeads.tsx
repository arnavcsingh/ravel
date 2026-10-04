import { useState } from 'react';
import type { DebuggerSnapshot, GraphNode } from '@ravel/shared';
import { StatusIndicator } from './StatusIndicator';

export function ResourceHeads({
  snapshot,
  selectedId,
  inspect,
}: {
  snapshot: DebuggerSnapshot;
  selectedId: string | null;
  inspect: (node: GraphNode) => void;
}) {
  const [resource, setResource] = useState<string | null>(null);
  const chosen =
    resource && snapshot.graph.nodes.some((node) => node.resourceId === resource)
      ? resource
      : Object.keys(snapshot.heads)[0];
  const versions = snapshot.graph.nodes
    .filter((node) => node.resourceId === chosen)
    .sort((a, b) => b.generation - a.generation);
  return (
    <details className="resource-panel" open>
      <summary>
        Resource heads{' '}
        <span className="mono">
          {Object.keys(snapshot.heads).length} resources · immutable versions
        </span>
      </summary>
      <div className="resource-state-grid">
        <div className="resource-head-list" aria-label="Current resource heads">
          {Object.entries(snapshot.heads).map(([path, id]) => {
            const node = snapshot.graph.nodes.find((node) => node.id === id);
            return (
              <button
                key={path}
                className={`resource-head ${chosen === path ? 'selected' : ''}`}
                aria-pressed={chosen === path}
                onClick={() => {
                  setResource(path);
                  if (node) inspect(node);
                }}
              >
                <code>{path}</code>
                <span className="mono">{node ? `@${node.generation}` : id.slice(0, 8)}</span>
                <StatusIndicator
                  state={node?.state === 'CLEAN' ? 'CURRENT' : (node?.state ?? 'NORMAL')}
                />
              </button>
            );
          })}
        </div>
        <div className="resource-history" aria-label="Resource version history">
          <div className="section-label">{chosen ?? 'No resources'} · VERSION HISTORY</div>
          {versions.map((node) => {
            const event = snapshot.timeline.find(
              (event) => event.versionId === node.id && event.action !== 'OBSERVE',
            );
            return (
              <button
                className={`resource-version ${selectedId === node.id ? 'selected' : ''}`}
                key={node.id}
                aria-pressed={selectedId === node.id}
                onClick={() => inspect(node)}
              >
                <strong className="mono">@{node.generation}</strong>
                <span>
                  {event?.agentName ?? 'Initial / recorded version'}
                  <small>
                    {event
                      ? `sequence ${event.runtimeSeq}`
                      : 'Select to inspect content and provenance'}
                  </small>
                </span>
                <StatusIndicator
                  state={
                    node.currentHead ? (node.state === 'CLEAN' ? 'CURRENT' : node.state) : 'NORMAL'
                  }
                >
                  {node.currentHead ? 'current head' : 'historical'}
                </StatusIndicator>
              </button>
            );
          })}
        </div>
      </div>
    </details>
  );
}
