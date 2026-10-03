/** Version succession is deliberately excluded from derivation traversal. */
export function blastRadius(root, edges, heads) {
  const children = new Map();
  for (const edge of edges) {
    if (!children.has(edge.source_version_id)) children.set(edge.source_version_id, []);
    children.get(edge.source_version_id).push(edge.target_version_id);
  }
  const historical = new Set([root]);
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i]) ?? []) {
      if (!historical.has(child)) { historical.add(child); queue.push(child); }
    }
  }
  const current = new Set(Object.values(heads));
  return { historical: [...historical], active: [...historical].filter((version) => current.has(version)) };
}
