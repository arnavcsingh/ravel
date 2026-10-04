import { useMemo } from 'react';
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

type ResourceNode = Node<
  GraphNode & { highlighted: boolean; inspect: (node: GraphNode) => void },
  'resource'
>;
function VersionNode({ data }: NodeProps<ResourceNode>) {
  return (
    <div
      className={`version-node ${data.state.toLowerCase()} ${data.highlighted ? 'highlighted' : ''}`}
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
      <span className="node-resource">{data.resourceId}</span>
      <strong>
        {data.label}
        {data.currentHead && <i title="Current head" />}
      </strong>
      <span className="node-state">
        {data.tombstone ? 'ABSENT · ' : ''}
        {data.state.replaceAll('_', ' ')}
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
  selectedVersionId,
  hazardId,
  showHistory = false,
}: {
  snapshot: DebuggerSnapshot;
  step: ReplayStep | null;
  inspect: (node: GraphNode) => void;
  selectedVersionId?: string | null;
  hazardId?: string | null;
  showHistory?: boolean;
}) {
  const hazard = snapshot.hazards.find((h) => h.id === hazardId);
  const focus = hazard
    ? new Set([
        hazard.observedVersionId,
        hazard.staleSinceVersionId,
        hazard.consumerVersionId,
        ...hazard.activeBlastRadius,
      ])
    : null;
  const derived = new Set(
    snapshot.graph.edges
      .filter((edge) => edge.kind === 'DERIVED_FROM')
      .flatMap((edge) => [edge.source, edge.target]),
  );
  const visible = new Set(
    snapshot.graph.nodes
      .filter(
        (node) =>
          showHistory ||
          node.id === selectedVersionId ||
          (focus ? focus.has(node.id) : node.currentHead || derived.has(node.id)) ||
          step?.highlightNodes.includes(node.id),
      )
      .map((node) => node.id),
  );
  const resources = [
    ...new Set(
      snapshot.graph.nodes.filter((node) => visible.has(node.id)).map((node) => node.resourceId),
    ),
  ];
  const nodes: ResourceNode[] = useMemo(
    () =>
      snapshot.graph.nodes
        .filter((node) => visible.has(node.id))
        .map((node) => ({
          id: node.id,
          type: 'resource',
          position: {
            x: resources.indexOf(node.resourceId) * 270,
            y:
              snapshot.graph.nodes.filter(
                (other) =>
                  visible.has(other.id) &&
                  other.resourceId === node.resourceId &&
                  other.generation < node.generation,
              ).length * 120,
          },
          data: {
            ...node,
            highlighted:
              node.id === selectedVersionId ||
              (step?.highlightNodes.includes(node.id) ?? false) ||
              !!focus?.has(node.id),
            inspect,
          },
        })),
    [snapshot.graph.nodes, step, inspect, selectedVersionId, hazardId, showHistory],
  );
  const edges: Edge[] = useMemo(
    () =>
      snapshot.graph.edges
        .filter((edge) => visible.has(edge.source) && visible.has(edge.target))
        .map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: edge.kind === 'VERSION_SUCCESSOR' ? 'smoothstep' : 'default',
          animated: step?.highlightEdges.includes(edge.id),
          style: {
            stroke: edge.kind === 'VERSION_SUCCESSOR' ? 'var(--muted)' : 'var(--amber)',
            strokeWidth: 1.5,
            strokeDasharray: edge.kind === 'VERSION_SUCCESSOR' ? '4 5' : undefined,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#a4adb5' },
          ariaLabel: edge.label,
        })),
    [snapshot.graph.edges, step, snapshot.graph.nodes, selectedVersionId, hazardId, showHistory],
  );
  return (
    <section className="panel graph-panel">
      <div className="panel-heading">
        <div>
          <h2>Provenance graph</h2>
          <span className="panel-subtitle">Select a version to inspect its evidence</span>
        </div>
        <span className="small-tag">VERSION LEVEL</span>
      </div>
      <div className="flow-container">
        <ReactFlow
          key={`${snapshot.run.id}:${nodes.map((node) => node.id).join(',')}`}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.22, maxZoom: 1.1 }}
          nodesDraggable={false}
          nodesFocusable={false}
          nodesConnectable={false}
          deleteKeyCode={null}
          colorMode="dark"
          onNodeClick={(_event, node) => inspect(node.data)}
          minZoom={0.1}
          maxZoom={1.8}
        >
          <Background gap={22} color="var(--line)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <div className="graph-foot">
        <span>
          <i className="line-key" />
          Derived from observed version
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
