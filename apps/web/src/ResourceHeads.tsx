import { useState } from 'react';
import type { DebuggerSnapshot, GraphNode } from '@ravel/shared';

export function ResourceHeads({
  snapshot,
  inspect,
}: {
  snapshot: DebuggerSnapshot;
  inspect: (node: GraphNode) => void;
}) {
  const [resource, setResource] = useState<string | null>(null);
  const history = snapshot.graph.nodes
    .filter((node) => node.resourceId === resource)
    .sort((a, b) => a.generation - b.generation);
  return (
    <details className="resource-heads panel">
      <summary>
        Resource heads · {Object.keys(snapshot.heads).length} files · click to inspect version
        history
      </summary>
      <div className="resource-heads-grid">
        <div className="head-list">
          {Object.entries(snapshot.heads).map(([path, id]) => {
            const node = snapshot.graph.nodes.find((node) => node.id === id);
            return (
              <button
                className={`head-row ${resource === path ? 'selected' : ''}`}
                key={path}
                onClick={() => {
                  setResource(path);
                  if (node) inspect(node);
                }}
              >
                <span>{path}</span>
                <b>
                  @{node?.generation ?? '—'} {node?.state !== 'CLEAN' ? '⚠' : ''}
                </b>
              </button>
            );
          })}
        </div>
        <div className="version-history">
          {resource ? (
            <>
              <strong>{resource}</strong>
              {history.map((node) => {
                const creator = snapshot.timeline.find(
                  (event) => event.action !== 'OBSERVE' && event.versionId === node.id,
                );
                return (
                  <button className="head-row" key={node.id} onClick={() => inspect(node)}>
                    <span>
                      @{node.generation} · {creator?.agentName ?? 'Initial repository'}
                      {creator ? ` · sequence ${creator.runtimeSeq}` : ''}
                    </span>
                    <b>{node.currentHead ? 'HEAD' : '↓ successor'}</b>
                  </button>
                );
              })}
            </>
          ) : (
            <p className="muted">Select a resource to follow its immutable versions.</p>
          )}
        </div>
      </div>
    </details>
  );
}
