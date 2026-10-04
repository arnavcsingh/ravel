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
}: {
  snapshot: DebuggerSnapshot;
  step: ReplayStep | null;
  inspect: (node: GraphNode) => void;
}) {
  const nodes: ResourceNode[] = useMemo(
    () =>
      snapshot.graph.nodes.map((node) => ({
        id: node.id,
        type: 'resource',
        position: { x: node.x, y: node.y },
        data: { ...node, highlighted: step?.highlightNodes.includes(node.id) ?? false, inspect },
      })),
    [snapshot.graph.nodes, step, inspect],
  );
  const edges: Edge[] = useMemo(
    () =>
      snapshot.graph.edges.map((edge) => ({
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
    [snapshot.graph.edges, step],
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
          key={`${snapshot.run.id}:${snapshot.graph.nodes.length}`}
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
          minZoom={0.25}
          maxZoom={1.8}
        >
          <Background gap={22} color="var(--line)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
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
