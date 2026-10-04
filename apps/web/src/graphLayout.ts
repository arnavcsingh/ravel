import type { GraphEdge, GraphNode } from '@ravel/shared';

// Order resources by recorded derivation, preserving version order within each.
// Resource-level cycles fall back to original order; version edges are unchanged.
export function layoutVersions(nodes: GraphNode[], edges: GraphEdge[]) {
  const resources = [...new Set(nodes.map((node) => node.resourceId))];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map(resources.map((resource) => [resource, new Set<string>()]));
  for (const edge of edges) {
    const source = byId.get(edge.source)?.resourceId,
      target = byId.get(edge.target)?.resourceId;
    if (edge.kind === 'DERIVED_FROM' && source && target && source !== target)
      incoming.get(target)!.add(source);
  }
  const order: string[] = [];
  while (order.length < resources.length) {
    const next = resources.find(
      (resource) =>
        !order.includes(resource) &&
        [...incoming.get(resource)!].every((parent) => order.includes(parent)),
    );
    if (!next) {
      order.push(...resources.filter((resource) => !order.includes(resource)));
      break;
    }
    order.push(next);
  }
  return nodes.map((node) => ({
    ...node,
    x: order.indexOf(node.resourceId) * 215,
    y:
      nodes.filter(
        (other) => other.resourceId === node.resourceId && other.generation < node.generation,
      ).length * 116,
  }));
}
