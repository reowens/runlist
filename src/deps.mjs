import path from 'node:path';
import { buildGraph } from './graph.mjs';
import { buildIndex } from './index.mjs';
import { resolveDocPath, toSlug, toRepoPath, die, warn } from './util.mjs';
import { bold, dim, green } from './color.mjs';

export function runDeps(argv, config) {
  const positional = [];
  let json = false;
  let maxDepth = 5;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') { json = true; continue; }
    if (argv[i] === '--depth' && argv[i + 1]) { maxDepth = Number.parseInt(argv[++i], 10) || 5; continue; }
    if (argv[i] === '--config') { i++; continue; }
    if (argv[i].startsWith('-')) continue;
    positional.push(argv[i]);
  }

  const index = buildIndex(config);
  const graph = buildGraph(index, config);
  const docByPath = new Map(index.docs.map(d => [d.path, d]));

  // Build adjacency maps
  const forwardMap = new Map(); // source → [{target, field, broken}]
  const reverseMap = new Map(); // target → [{source, field}]

  for (const edge of graph.edges) {
    if (!forwardMap.has(edge.source)) forwardMap.set(edge.source, []);
    forwardMap.get(edge.source).push({ target: edge.target, field: edge.field, broken: edge.broken });
    if (!edge.broken) {
      if (!reverseMap.has(edge.target)) reverseMap.set(edge.target, []);
      reverseMap.get(edge.target).push({ source: edge.source, field: edge.field });
    }
  }

  const input = positional[0];

  if (input) {
    // Tree view for a specific doc
    const filePath = resolveDocPath(input, config);
    if (!filePath) die(`File not found: ${input}`);
    const repoPath = toRepoPath(filePath, config.repoRoot);
    const doc = docByPath.get(repoPath);
    if (!doc) die(`Doc not in index: ${repoPath}`);

    if (json) {
      renderTreeJson(doc, forwardMap, reverseMap, docByPath, maxDepth);
    } else {
      renderTree(doc, forwardMap, reverseMap, docByPath, maxDepth);
    }
  } else {
    // Flat overview
    if (json) {
      renderFlatJson(graph, forwardMap, reverseMap, docByPath);
    } else {
      renderFlat(graph, forwardMap, reverseMap, docByPath);
    }
  }
}

// ── Tree view ──────────────────────────────────────────────────────────

function renderTree(doc, forwardMap, reverseMap, docByPath, maxDepth) {
  const slug = path.basename(doc.path, '.md');
  process.stdout.write(`${bold(slug)} ${dim(`(${doc.status})`)}\n`);

  const forward = forwardMap.get(doc.path) || [];
  const reverse = reverseMap.get(doc.path) || [];

  if (forward.length > 0) {
    process.stdout.write(`\n${bold('Depends on:')}\n`);
    for (const edge of forward) {
      printTreeNode(edge.target, edge.field, edge.broken, forwardMap, docByPath, maxDepth, 1, new Set([doc.path]));
    }
  }

  if (reverse.length > 0) {
    process.stdout.write(`\n${bold('Depended on by:')}\n`);
    for (const edge of reverse) {
      const targetSlug = path.basename(edge.source, '.md');
      const targetDoc = docByPath.get(edge.source);
      const status = targetDoc?.status ?? 'unknown';
      process.stdout.write(`  ${targetSlug} ${dim(`(${status})`)}  ${dim(`via ${edge.field}`)}\n`);
    }
  }

  if (doc.blockers?.length > 0) {
    process.stdout.write(`\n${bold('Blockers:')}\n`);
    for (const b of doc.blockers) {
      process.stdout.write(`  - ${b}\n`);
    }
  }

  if (forward.length === 0 && reverse.length === 0 && !doc.blockers?.length) {
    process.stdout.write(`\n${dim('No dependencies found.')}\n`);
  }

  process.stdout.write('\n');
}

function printTreeNode(targetPath, field, broken, forwardMap, docByPath, maxDepth, depth, visited) {
  const indent = '  '.repeat(depth);
  const targetSlug = path.basename(targetPath, '.md');
  const targetDoc = docByPath.get(targetPath);
  const status = targetDoc?.status ?? 'unknown';

  let suffix = dim(`  via ${field}`);
  if (broken) suffix += '  ' + dim('[broken]');
  if (visited.has(targetPath)) {
    process.stdout.write(`${indent}${targetSlug} ${dim(`(${status})`)}${suffix}  ${dim('[cycle]')}\n`);
    return;
  }

  process.stdout.write(`${indent}${targetSlug} ${dim(`(${status})`)}${suffix}\n`);

  if (depth >= maxDepth) return;

  const children = forwardMap.get(targetPath) || [];
  const nextVisited = new Set(visited);
  nextVisited.add(targetPath);
  for (const child of children) {
    printTreeNode(child.target, child.field, child.broken, forwardMap, docByPath, maxDepth, depth + 1, nextVisited);
  }
}

function renderTreeJson(doc, forwardMap, reverseMap, docByPath, maxDepth) {
  const slug = path.basename(doc.path, '.md');

  function walkForward(docPath, depth, visited) {
    const edges = forwardMap.get(docPath) || [];
    return edges.map(e => {
      const d = docByPath.get(e.target);
      const node = {
        path: e.target,
        slug: path.basename(e.target, '.md'),
        status: d?.status ?? 'unknown',
        field: e.field,
        broken: e.broken || false,
        cycle: visited.has(e.target),
      };
      if (!node.cycle && !node.broken && depth < maxDepth) {
        const next = new Set(visited);
        next.add(e.target);
        node.dependsOn = walkForward(e.target, depth + 1, next);
      }
      return node;
    });
  }

  const result = {
    path: doc.path,
    slug,
    status: doc.status,
    dependsOn: walkForward(doc.path, 1, new Set([doc.path])),
    dependedOnBy: (reverseMap.get(doc.path) || []).map(e => {
      const d = docByPath.get(e.source);
      return { path: e.source, slug: path.basename(e.source, '.md'), status: d?.status ?? 'unknown', field: e.field };
    }),
    blockers: doc.blockers || [],
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

// ── Flat overview ──────────────────────────────────────────────────────

function renderFlat(graph, forwardMap, reverseMap, docByPath) {
  process.stdout.write(bold('Deps') + dim(` — ${graph.stats.nodeCount} docs, ${graph.stats.edgeCount} edges`) + '\n\n');

  if (graph.stats.edgeCount === 0) {
    process.stdout.write(dim('No dependencies found. Add referenceFields to your config.') + '\n');
    return;
  }

  // Most blocking: nodes with the most reverse edges
  const blockingCounts = [...reverseMap.entries()]
    .map(([p, edges]) => ({ path: p, count: edges.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  if (blockingCounts.length > 0) {
    process.stdout.write(bold('Most blocking') + dim(' (depended on by the most docs):') + '\n');
    for (const { path: p, count } of blockingCounts) {
      const doc = docByPath.get(p);
      const slug = path.basename(p, '.md').padEnd(24);
      process.stdout.write(`  ${slug} ${dim(`(${doc?.status ?? '?'})`)}  blocks ${count}\n`);
    }
    process.stdout.write('\n');
  }

  // Most blocked: nodes with the most forward edges
  const blockedCounts = [...forwardMap.entries()]
    .map(([p, edges]) => ({ path: p, count: edges.filter(e => !e.broken).length }))
    .filter(e => e.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  if (blockedCounts.length > 0) {
    process.stdout.write(bold('Most blocked') + dim(' (depends on the most docs):') + '\n');
    for (const { path: p, count } of blockedCounts) {
      const doc = docByPath.get(p);
      const slug = path.basename(p, '.md').padEnd(24);
      process.stdout.write(`  ${slug} ${dim(`(${doc?.status ?? '?'})`)}  depends on ${count}\n`);
    }
    process.stdout.write('\n');
  }

  // Docs with blockers
  const withBlockers = [...docByPath.values()].filter(d => d.blockers?.length > 0);
  if (withBlockers.length > 0) {
    process.stdout.write(bold('With blockers:') + '\n');
    for (const doc of withBlockers) {
      const slug = path.basename(doc.path, '.md');
      process.stdout.write(`  ${slug}: ${doc.blockers.join('; ')}\n`);
    }
    process.stdout.write('\n');
  }

  // Orphans
  if (graph.orphans.length > 0) {
    const orphanSlugs = graph.orphans.map(p => path.basename(p, '.md'));
    process.stdout.write(`${dim('Orphans (no dependencies)')}: ${orphanSlugs.join(', ')}\n`);
    process.stdout.write('\n');
  }
}

function renderFlatJson(graph, forwardMap, reverseMap, docByPath) {
  const blocking = [...reverseMap.entries()]
    .map(([p, edges]) => ({ path: p, slug: path.basename(p, '.md'), blocksCount: edges.length }))
    .sort((a, b) => b.blocksCount - a.blocksCount);

  const blocked = [...forwardMap.entries()]
    .map(([p, edges]) => ({ path: p, slug: path.basename(p, '.md'), dependsOnCount: edges.filter(e => !e.broken).length }))
    .filter(e => e.dependsOnCount > 0)
    .sort((a, b) => b.dependsOnCount - a.dependsOnCount);

  const withBlockers = [...docByPath.values()]
    .filter(d => d.blockers?.length > 0)
    .map(d => ({ path: d.path, slug: path.basename(d.path, '.md'), blockers: d.blockers }));

  process.stdout.write(JSON.stringify({
    stats: graph.stats,
    mostBlocking: blocking,
    mostBlocked: blocked,
    withBlockers,
    orphans: graph.orphans,
  }, null, 2) + '\n');
}

// ── Unblocks ─────────────────────────────────────────────────────────

export function runUnblocks(argv, config) {
  const input = argv.find(a => !a.startsWith('-'));
  const json = argv.includes('--json');
  if (!input) die('Usage: dotmd unblocks <file>');

  const filePath = resolveDocPath(input, config);
  if (!filePath) die(`File not found: ${input}`);
  const repoPath = toRepoPath(filePath, config.repoRoot);

  const index = buildIndex(config);
  const graph = buildGraph(index, config);
  const docByPath = new Map(index.docs.map(d => [d.path, d]));
  const doc = docByPath.get(repoPath);
  if (!doc) die(`Doc not in index: ${repoPath}`);

  // Find docs that reference this one (reverse edges)
  const reverseMap = new Map();
  for (const edge of graph.edges) {
    if (!edge.broken) {
      if (!reverseMap.has(edge.target)) reverseMap.set(edge.target, []);
      reverseMap.get(edge.target).push({ source: edge.source, field: edge.field });
    }
  }

  // Also find docs with blockers mentioning this file's basename
  const basename = path.basename(repoPath, '.md');
  const blockerRefs = index.docs.filter(d =>
    d.blockers?.some(b => b.includes(basename) || b.includes(path.basename(repoPath)))
  );

  const directDeps = (reverseMap.get(repoPath) || []).map(e => {
    const d = docByPath.get(e.source);
    return { path: e.source, slug: path.basename(e.source, '.md'), status: d?.status, field: e.field };
  });

  const blockerDeps = blockerRefs
    .filter(d => d.path !== repoPath)
    .map(d => ({ path: d.path, slug: path.basename(d.path, '.md'), status: d.status, blockers: d.blockers }));

  if (json) {
    process.stdout.write(JSON.stringify({ doc: repoPath, directDeps, blockerDeps }, null, 2) + '\n');
    return;
  }

  const slug = path.basename(repoPath, '.md');
  process.stdout.write(`${bold('Unblocks')} — what happens when ${green(slug)} completes:\n\n`);

  if (directDeps.length > 0) {
    process.stdout.write(bold('Referenced by:') + '\n');
    for (const d of directDeps) {
      process.stdout.write(`  ${d.slug.padEnd(24)} ${dim(`(${d.status})`)}  via ${dim(d.field)}\n`);
    }
    process.stdout.write('\n');
  }

  if (blockerDeps.length > 0) {
    process.stdout.write(bold('Listed as blocker in:') + '\n');
    for (const d of blockerDeps) {
      process.stdout.write(`  ${d.slug.padEnd(24)} ${dim(`(${d.status})`)}\n`);
    }
    process.stdout.write('\n');
  }

  if (directDeps.length === 0 && blockerDeps.length === 0) {
    process.stdout.write(dim('No docs depend on or are blocked by this file.') + '\n');
  }
}
