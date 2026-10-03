import type { ProvenanceEdge, Version } from '@ravel/shared';
export function assertDerivation(edge: ProvenanceEdge, versions: Record<string, Version>): void {
  const source = versions[edge.sourceVersionId],
    target = versions[edge.targetVersionId];
  if (!source || !target) throw new Error('Provenance references an unknown ResourceVersion.');
  if (source.creationSeq >= target.creationSeq)
    throw new Error('Provenance cycle or backward derivation: source must precede target.');
}
export function blastRadius(root: string, edges: ProvenanceEdge[], heads: Record<string, string>) {
  const children = new Map<string, string[]>();
  for (const edge of edges)
    children.set(edge.sourceVersionId, [
      ...(children.get(edge.sourceVersionId) ?? []),
      edge.targetVersionId,
    ]);
  const visited = new Set([root]),
    queue = [root];
  for (let i = 0; i < queue.length; i++)
    for (const child of children.get(queue[i]) ?? [])
      if (!visited.has(child)) {
        visited.add(child);
        queue.push(child);
      }
  const current = new Set(Object.values(heads));
  return { historical: [...visited], active: [...visited].filter((v) => current.has(v)) };
}
