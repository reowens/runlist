import path from 'node:path';
import { toSlug, toRepoPath, warn } from './util.mjs';
import { bold, red, green, dim } from './color.mjs';

const STATUS_COLORS = {
  active:    '#b3e6b3',
  ready:     '#b3d9ff',
  planned:   '#ffffb3',
  research:  '#e6ccff',
  blocked:   '#ffb3b3',
  reference: '#d9d9d9',
  archived:  '#e6e6e6',
};
const DEFAULT_COLOR = '#f2f2f2';

export function buildGraph(index, config, filters = {}) {
  const biFields = new Set(config.referenceFields.bidirectional || []);
  const uniFields = new Set(config.referenceFields.unidirectional || []);
  const allRefFields = [...biFields, ...uniFields];

  // Filter docs
  let docs = index.docs;
  if (filters.statuses?.length) {
    docs = docs.filter(d => filters.statuses.includes(d.status));
  }
  if (filters.module) {
    const m = filters.module.toLowerCase();
    docs = docs.filter(d => (d.modules ?? []).some(mod => mod.toLowerCase() === m) || (d.module ?? '').toLowerCase() === m);
  }
  if (filters.surface) {
    const s = filters.surface.toLowerCase();
    docs = docs.filter(d => (d.surfaces ?? []).some(sf => sf.toLowerCase() === s) || (d.surface ?? '').toLowerCase() === s);
  }

  const docPathSet = new Set(docs.map(d => d.path));
  const allDocPaths = new Set(index.docs.map(d => d.path));
  const docByPath = new Map(index.docs.map(d => [d.path, d]));

  // Build nodes
  const nodes = docs.map(d => ({
    id: d.path,
    slug: toSlug(d),
    title: d.title,
    status: d.status,
    module: d.module,
    surface: d.surface,
    edgeCount: 0,
  }));
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // Build edges
  const edges = [];
  const edgeKeys = new Set();
  const referencedPaths = new Set();

  for (const doc of docs) {
    const docDir = path.dirname(path.join(config.repoRoot, doc.path));

    for (const field of allRefFields) {
      for (const relPath of (doc.refFields[field] || [])) {
        const resolved = path.resolve(docDir, relPath);
        const targetPath = toRepoPath(resolved, config.repoRoot);
        const edgeKey = `${doc.path}|${targetPath}|${field}`;
        if (edgeKeys.has(edgeKey)) continue;
        edgeKeys.add(edgeKey);

        const broken = !allDocPaths.has(targetPath);
        const external = !broken && !docPathSet.has(targetPath);

        edges.push({
          source: doc.path,
          target: targetPath,
          field,
          type: biFields.has(field) ? 'bidirectional' : 'unidirectional',
          broken,
          external,
        });

        referencedPaths.add(targetPath);
        referencedPaths.add(doc.path);
      }
    }
  }

  // Count edges per node
  for (const edge of edges) {
    if (nodeMap.has(edge.source)) nodeMap.get(edge.source).edgeCount++;
  }

  // Find orphans (no outgoing or incoming edges among filtered docs)
  const connectedPaths = new Set();
  for (const edge of edges) {
    connectedPaths.add(edge.source);
    if (!edge.broken && !edge.external) connectedPaths.add(edge.target);
  }
  const orphans = docs.filter(d => !connectedPaths.has(d.path)).map(d => d.path);

  const brokenEdges = edges.filter(e => e.broken);

  return {
    nodes,
    edges,
    orphans,
    brokenEdges,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      orphanCount: orphans.length,
      brokenEdgeCount: brokenEdges.length,
    },
  };
}

// ── Text renderer ──────────────────────────────────────────────────────

export function renderGraphText(graph, config) {
  const defaultRenderer = (g) => _renderGraphText(g, config);
  if (config.hooks.renderGraph) {
    try { return config.hooks.renderGraph(graph, defaultRenderer); }
    catch (err) { warn(`Hook 'renderGraph' threw: ${err.message}`); }
  }
  return defaultRenderer(graph);
}

function _renderGraphText(graph, config) {
  const { nodes, edges, orphans, stats } = graph;

  if (stats.nodeCount === 0) return 'No documents found.\n';

  const allRefFields = [
    ...(config.referenceFields.bidirectional || []),
    ...(config.referenceFields.unidirectional || []),
  ];
  if (allRefFields.length === 0) {
    return `Graph — ${stats.nodeCount} docs, no reference fields configured\n\nAdd \`referenceFields\` to your config to enable relationship tracking.\n`;
  }

  const lines = [];
  const parts = [`${stats.nodeCount} docs`, `${stats.edgeCount} edges`];
  if (stats.orphanCount > 0) parts.push(`${stats.orphanCount} orphans`);
  if (stats.brokenEdgeCount > 0) parts.push(`${stats.brokenEdgeCount} broken`);
  lines.push(bold(`Graph`) + dim(` — ${parts.join(', ')}`));
  lines.push('');

  // Compute max field name length for alignment
  const fieldNames = [...new Set(edges.map(e => e.field))];
  const maxFieldLen = fieldNames.length > 0 ? Math.max(...fieldNames.map(f => f.length)) : 0;

  // Group edges by source
  const edgesBySource = new Map();
  for (const edge of edges) {
    if (!edgesBySource.has(edge.source)) edgesBySource.set(edge.source, []);
    edgesBySource.get(edge.source).push(edge);
  }

  // Build a slug lookup for targets
  const allDocByPath = new Map();
  for (const n of nodes) allDocByPath.set(n.id, n.slug);

  // Render each node with edges
  const nodesWithEdges = nodes.filter(n => edgesBySource.has(n.id));
  const nodesWithoutEdges = nodes.filter(n => !edgesBySource.has(n.id) && !orphans.includes(n.id));

  for (const node of nodesWithEdges) {
    lines.push(`${node.slug} ${dim(`(${node.status})`)}`);
    for (const edge of edgesBySource.get(node.id)) {
      const targetSlug = allDocByPath.get(edge.target) ?? path.basename(edge.target, '.md');
      const fieldPad = edge.field.padEnd(maxFieldLen);
      let line = `  ${'──'} ${fieldPad} ${'──'} ${targetSlug}`;
      if (edge.broken) line += '  ' + red('[broken]');
      if (edge.external) line += '  ' + dim('[external]');
      lines.push(line);
    }
    lines.push('');
  }

  if (orphans.length > 0) {
    const orphanSlugs = orphans.map(p => path.basename(p, '.md'));
    lines.push(`${dim('Orphans')}: ${orphanSlugs.join(', ')}`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

// ── DOT renderer ───────────────────────────────────────────────────────

export function renderGraphDot(graph, config) {
  const { nodes, edges } = graph;
  const lines = [];
  lines.push('digraph dotmd {');
  lines.push('  rankdir=LR;');
  lines.push('  node [shape=box, style="rounded,filled", fontname="Helvetica"];');
  lines.push('');

  // Nodes
  const nodeSet = new Set(nodes.map(n => n.slug));
  for (const node of nodes) {
    const color = STATUS_COLORS[node.status] ?? DEFAULT_COLOR;
    lines.push(`  "${node.slug}" [label="${node.slug}\\n(${node.status ?? 'unknown'})", fillcolor="${color}"];`);
  }

  // Synthesize broken/external target nodes
  const syntheticNodes = new Set();
  for (const edge of edges) {
    const targetSlug = path.basename(edge.target, '.md');
    if (!nodeSet.has(targetSlug) && !syntheticNodes.has(targetSlug)) {
      syntheticNodes.add(targetSlug);
      if (edge.broken) {
        lines.push(`  "${targetSlug}" [label="${targetSlug}\\n(unknown)", style="rounded,dashed,filled", fillcolor="#ffb3b3"];`);
      } else if (edge.external) {
        lines.push(`  "${targetSlug}" [label="${targetSlug}\\n(filtered)", style="rounded,dashed,filled", fillcolor="#e6e6e6"];`);
      }
    }
  }

  lines.push('');

  // Detect mutual bidirectional edges for dir=both rendering
  const biEdgeIndex = new Map();
  for (const edge of edges) {
    if (edge.type !== 'bidirectional') continue;
    const key = `${edge.source}|${edge.target}|${edge.field}`;
    biEdgeIndex.set(key, edge);
  }

  const rendered = new Set();
  for (const edge of edges) {
    const sourceSlug = path.basename(edge.source, '.md');
    const targetSlug = path.basename(edge.target, '.md');
    const edgeKey = [edge.source, edge.target, edge.field].sort().join('|');

    if (rendered.has(edgeKey)) continue;
    rendered.add(edgeKey);

    if (edge.broken) {
      lines.push(`  "${sourceSlug}" -> "${targetSlug}" [style=dashed, color=red, label="${edge.field}"];`);
    } else if (edge.type === 'bidirectional') {
      // Check if reverse edge exists
      const reverseKey = `${edge.target}|${edge.source}|${edge.field}`;
      if (biEdgeIndex.has(reverseKey)) {
        lines.push(`  "${sourceSlug}" -> "${targetSlug}" [dir=both, label="${edge.field}", color="#666666"];`);
      } else {
        lines.push(`  "${sourceSlug}" -> "${targetSlug}" [label="${edge.field}", color="#666666"];`);
      }
    } else {
      const style = edge.external ? ', style=dashed' : '';
      lines.push(`  "${sourceSlug}" -> "${targetSlug}" [label="${edge.field}", color="#999999"${style}];`);
    }
  }

  lines.push('}');
  return lines.join('\n') + '\n';
}

// ── JSON renderer ──────────────────────────────────────────────────────

export function renderGraphJson(graph) {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    stats: graph.stats,
    nodes: graph.nodes,
    edges: graph.edges.map(({ source, target, field, type, broken }) => ({
      source, target, field, type, broken,
    })),
    orphans: graph.orphans,
  }, null, 2) + '\n';
}
