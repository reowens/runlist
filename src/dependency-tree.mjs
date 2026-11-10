// One expansion per document prevents shared subgraphs growing once per path.
export const DEPENDENCY_LIMITS = Object.freeze({ nodes: 1000, edges: 4000, bytes: 512 * 1024, value: 4096 });

export function dependencyTree(doc, forward, reverse, docs, depth, limits = DEPENDENCY_LIMITS) {
  const expanded = new Set([doc.path]);
  let examined = 0;
  const reasons = new Set();
  function walk(source, level, ancestors) {
    const result = [];
    const edges = forward.get(source) ?? [];
    if (level > depth) { if (edges.length) reasons.add('depth'); return result; }
    for (const edge of edges) {
      if (examined >= limits.edges) { reasons.add('edges'); break; }
      examined++;
      const target = docs.get(edge.target);
      const node = { path: edge.target, slug: edge.target.split('/').pop().replace(/\.md$/, ''), status: target?.status ?? 'unknown', field: edge.field, broken: !!edge.broken, cycle: ancestors.has(edge.target) };
      if (!node.cycle && !node.broken) {
        if (expanded.has(edge.target)) node.shared = true;
        else if (expanded.size >= limits.nodes) { reasons.add('nodes'); node.shared = true; }
        else {
          expanded.add(edge.target);
          node.dependsOn = walk(edge.target, level + 1, new Set([...ancestors, edge.target]));
        }
      }
      result.push(node);
    }
    return result;
  }
  return {
    path: doc.path, slug: doc.path.split('/').pop().replace(/\.md$/, ''), status: doc.status,
    dependsOn: walk(doc.path, 1, new Set([doc.path])),
    dependedOnBy: (reverse.get(doc.path) ?? []).slice(0, limits.edges).map(e => ({path:e.source, slug:e.source.split('/').pop().replace(/\.md$/, ''), status:docs.get(e.source)?.status ?? 'unknown', field:e.field})),
    blockers: doc.blockers ?? [],
    truncated: reasons.size > 0 || (reverse.get(doc.path)?.length ?? 0) > limits.edges,
    truncationReasons: [...reasons, ...((reverse.get(doc.path)?.length ?? 0) > limits.edges ? ['reverse-edges'] : [])],
    traversal: { expanded: expanded.size, examined },
  };
}

// Bound serialized values too: one author-controlled string can outweigh a graph.
export function boundedOutput(value, limits = DEPENDENCY_LIMITS) {
  let remaining = limits.bytes - 2048;
  const reasons = new Set(value.truncationReasons ?? []);
  const clip = (v, depth = 0) => {
    if (remaining < 128 || depth > 64) {
      reasons.add(depth > 64 ? 'depth' : 'bytes');
      if (Array.isArray(v)) return [];
      if (v && typeof v === 'object') return {};
      return typeof v === 'string' ? '' : v;
    }
    remaining -= 32 + depth * 8;
    if (typeof v === 'string') {
      const max = Math.min(limits.value, Math.floor(remaining / 12));
      const text = v.slice(0, max);
      if (text.length < v.length) reasons.add('value');
      remaining -= Buffer.byteLength(JSON.stringify(text));
      return text;
    }
    if (Array.isArray(v)) {
      const out = [];
      for (const item of v) { if (remaining < 128) { reasons.add('bytes'); break; } out.push(clip(item, depth + 1)); }
      return out;
    }
    if (v && typeof v === 'object') {
      const entries = Object.entries(v);
      // Gate facts and traversal counts survive a large compatibility tree.
      if (depth === 0) {
        const priority = ['path', 'slug', 'status', 'doc', 'gates', 'traversal'];
        entries.sort(([a],[b]) => {
          const rank = key => priority.includes(key) ? priority.indexOf(key) : priority.length;
          return rank(a) - rank(b);
        });
      }
      return Object.fromEntries(entries.map(([k,item]) => [k,clip(item, depth + 1)]));
    }
    return v;
  };
  const out = clip(value);
  return {...out, truncated: !!value.truncated || reasons.size > 0, truncationReasons:[...reasons]};
}
