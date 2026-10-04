import { useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Node,
  type NodeProps,
  type Edge,
} from '@xyflow/react';
import type { DebuggerSnapshot, GraphNode, ReplayStep } from '@ravel/shared';
import '@xyflow/react/dist/style.css';
import { layoutVersions } from './graphLayout';

type ResourceNode = Node<
  GraphNode & { highlighted: boolean; selected: boolean; inspect: (node: GraphNode) => void },
  'resource'
>;
function VersionNode({ data }: NodeProps<ResourceNode>) {
  return (
    <div
      className={`version-node ${data.state.toLowerCase()} ${data.highlighted ? 'highlighted' : ''} ${data.selected ? 'selected' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`Inspect ${data.label}, ${data.state.replaceAll('_', ' ').toLowerCase()}${data.currentHead ? ', current head' : ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          data.inspect(data);
        }
      }}
    >
      <Handle type="target" position={Position.Left} />
      <span className="node-resource" title={data.resourceId}>
        {data.resourceId}
      </span>
      <strong>
        {data.label}
        {data.currentHead && <i title="Current head" />}
      </strong>
      <span className="node-state">
        {data.tombstone ? 'ABSENT · ' : ''}
        {data.state === 'CLEAN'
          ? data.currentHead
            ? 'CURRENT'
            : 'HISTORICAL'
          : data.state.replaceAll('_', ' ')}
      </span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { resource: VersionNode };
export function CausalGraph({
  snapshot,
  step,
  inspect,
  hazardId,
  selectedVersionId,
  focusVersionIds = [],
}: {
  snapshot: DebuggerSnapshot;
  step: ReplayStep | null;
  inspect: (node: GraphNode) => void;
  hazardId: string | null;
  selectedVersionId: string | null;
  focusVersionIds?: string[];
}) {
  const [history, setHistory] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const hazard = snapshot.hazards.find((value) => value.id === hazardId);
  const focus = new Set([
    ...(!step && hazard
      ? [
          hazard.observed.id,
          hazard.invalidating.id,
          hazard.validationHeadVersionId,
          hazard.consumer.id,
          ...hazard.activeBlastRadius,
          ...(!hazard.active ? hazard.historicalBlastRadius : []),
        ]
      : []),
    ...(!step && selectedVersionId ? [selectedVersionId] : []),
    ...(step?.highlightNodes ?? []),
    ...focusVersionIds,
  ]);
  // Keep the immediate recorded inputs of current heads. Extra history is opt-in.
  const visibleIds = new Set(
    snapshot.graph.nodes
      .filter((node) => node.currentHead || focus.has(node.id))
      .map((node) => node.id),
  );
  snapshot.graph.edges.forEach((edge) => {
    if (visibleIds.has(edge.target)) visibleIds.add(edge.source);
  });
  const nodes: ResourceNode[] = useMemo(
    () =>
      layoutVersions(snapshot.graph.nodes, snapshot.graph.edges)
        .filter((node) => history || visibleIds.has(node.id))
        .map((node) => ({
          id: node.id,
          type: 'resource',
          position: { x: node.x, y: node.y },
          data: {
            ...node,
            highlighted: focus.has(node.id),
            selected: selectedVersionId === node.id,
            inspect,
          },
          style: { opacity: focus.size && !focus.has(node.id) ? 0.45 : 1 },
        })),
    [snapshot, step, inspect, hazardId, selectedVersionId, history, focusVersionIds],
  );
  const edges: Edge[] = useMemo(
    () =>
      snapshot.graph.edges
        .filter((edge) => history || (visibleIds.has(edge.source) && visibleIds.has(edge.target)))
        .map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: edge.kind === 'VERSION_SUCCESSOR' ? 'smoothstep' : 'default',
          animated: step?.highlightEdges.includes(edge.id),
          style: {
            stroke:
              edge.kind === 'VERSION_SUCCESSOR'
                ? 'var(--muted)'
                : hazard?.activeBlastRadius.includes(edge.target)
                  ? 'var(--amber)'
                  : 'var(--accent)',
            strokeWidth: focus.has(edge.source) && focus.has(edge.target) ? 2 : 1.2,
            opacity: focus.size && !(focus.has(edge.source) && focus.has(edge.target)) ? 0.25 : 1,
            strokeDasharray: edge.kind === 'VERSION_SUCCESSOR' ? '4 5' : undefined,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#a4adb5' },
          ariaLabel: edge.label,
        })),
    [snapshot, step, hazardId, selectedVersionId, history, focusVersionIds],
  );
  return (
    <section className="panel graph-panel">
      <div className="panel-heading">
        <div>
          <h2>Provenance graph</h2>
          <span className="panel-subtitle">Select a version to inspect its evidence</span>
        </div>
        <div className="graph-toolbar">
          <label className="graph-history">
            <input
              type="checkbox"
              checked={history}
              onChange={(event) => setHistory(event.target.checked)}
            />
            All versions
          </label>
          <button
            className="text-button panel-toggle"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? 'Expand graph' : 'Collapse graph'}
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="flow-container">
          <ReactFlow
            key={`${snapshot.run.id}:${nodes.map((node) => node.id).join(',')}`}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
            nodesDraggable={false}
            nodesFocusable={false}
            nodesConnectable={false}
            deleteKeyCode={null}
            colorMode="dark"
            onNodeClick={(_event, node) => inspect(node.data)}
            minZoom={0.25}
            maxZoom={1.8}
          >
            <Background gap={22} color="var(--line)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}
      <div className="graph-foot">
        <span>
          <i className="line-key" />
          Candidate derivation
        </span>
        <span>
          <i className="line-key dashed" />
          Version succession
        </span>
        <span className="head-key">● Current head</span>
      </div>
    </section>
  );
}
