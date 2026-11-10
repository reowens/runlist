import { createGateReader, gateLines } from './gates.mjs';
import { dependencyTree, boundedOutput } from './dependency-tree.mjs';
import path from 'node:path';
import { buildGraph } from './graph.mjs';
import { buildIndex, resolveDocArg } from './index.mjs';
import { toRepoPath, die } from './util.mjs';
import { bold, dim, green } from './color.mjs';

export function runDeps(argv, config) {
  const positional = [];
  let json = false;
  let maxDepth = 5;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') { json = true; continue; }
    if (argv[i] === '--depth') { const raw = argv[++i]; maxDepth = Number(raw); if (!/^\d+$/.test(raw ?? '') || !Number.isSafeInteger(maxDepth) || maxDepth > 64) die('--depth takes an integer from 0 to 64.'); continue; }
    if (argv[i] === '--config') { i++; continue; }
    if (argv[i].startsWith('-')) continue;
    positional.push(argv[i]);
  }

  const index = buildIndex(config);
  const graph = buildGraph(index, config);
  const docByPath = new Map(index.docs.map(d => [d.path, d]));
  const readGates = createGateReader(index.docs, config);

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
    const filePath = resolveDocArg(input, config);
    const repoPath = toRepoPath(filePath, config.repoRoot);
    const doc = docByPath.get(repoPath);
    if (!doc) die(`Doc not in index: ${repoPath}`);

    if (json) {
      renderTreeJson(doc, forwardMap, reverseMap, docByPath, maxDepth, readGates(doc.path));
    } else {
      renderTree(doc, forwardMap, reverseMap, docByPath, maxDepth);
      process.stdout.write(gateLines(boundedOutput(readGates(doc.path))).join("\n") + "\n");
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

function renderTree(doc, forward, reverse, docs, maxDepth) {
  const tree = boundedOutput(dependencyTree(doc, forward, reverse, docs, maxDepth));
  const lines = [`${tree.slug} (${tree.status})`, 'Document connections (Depends on / Depended on by are reference links):'];
  const visit = (nodes, level) => { for (const n of (nodes ?? []).filter(Boolean)) {
    lines.push(`${'  '.repeat(level)}${n.slug} (${n.status}) via ${n.field}${n.cycle ? ' [cycle]' : n.shared ? ' [shared]' : n.broken ? ' [broken]' : ''}`);
    visit(n.dependsOn, level + 1);
  }};
  visit(tree.dependsOn, 1);
  for (const n of tree.dependedOnBy ?? []) lines.push(`  Referenced by: ${n.slug} via ${n.field}`);
  if (tree.blockers?.length) lines.push('Blockers:', ...tree.blockers.map(b => `  - ${b}`));
  if (!tree.dependsOn?.length && !tree.dependedOnBy?.length && !tree.blockers?.length) lines.push('No dependencies found.');
  if (tree.truncated) lines.push(`Truncated: ${tree.truncationReasons.join(', ')}`);
  process.stdout.write(lines.join('\n') + '\n');
}

function renderTreeJson(doc, forward, reverse, docs, maxDepth, gates) {
  process.stdout.write(JSON.stringify(boundedOutput({...dependencyTree(doc, forward, reverse, docs, maxDepth), gates}), null, 2) + '\n');
}

// ── Flat overview ──────────────────────────────────────────────────────

function renderFlat(graph, forward, reverse, docs) {
  const summary = flatData(graph, forward, reverse, docs);
  const lines = [`Deps — ${graph.stats.nodeCount} docs, ${graph.stats.edgeCount} document connections`];
  if (!graph.stats.edgeCount) lines.push('No dependencies found. Add referenceFields to your config.');
  lines.push('Most blocking (reference links, not execution gates):');
  for (const row of summary.mostBlocking ?? []) lines.push(`  ${row.slug}: ${row.blocksCount}`);
  lines.push('Most blocked (reference links, not execution gates):');
  for (const row of summary.mostBlocked ?? []) lines.push(`  ${row.slug}: ${row.dependsOnCount}`);
  lines.push('With blockers:');
  for (const row of summary.withBlockers ?? []) lines.push(`  ${row.slug}: ${(row.blockers ?? []).join('; ')}`);
  lines.push(`Orphans (no reference links): ${(summary.orphans ?? []).join(', ')}`);
  if (summary.truncated) lines.push(`Truncated: ${summary.truncationReasons.join(', ')}`);
  process.stdout.write(lines.join('\n') + '\n');
}

function flatData(graph, forwardMap, reverseMap, docByPath) {
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

  return boundedOutput({
    stats: graph.stats,
    mostBlocking: blocking,
    mostBlocked: blocked,
    withBlockers,
    orphans: graph.orphans,
  });
}

function renderFlatJson(...args) {
  process.stdout.write(JSON.stringify(flatData(...args),null,2) + '\n');
}

// ── Unblocks ─────────────────────────────────────────────────────────

export function runUnblocks(argv, config) {
  const input = argv.find(a => !a.startsWith('-'));
  const json = argv.includes('--json');
  if (!input) die('Usage: runlist unblocks <file>');

  const filePath = resolveDocArg(input, config);
  const repoPath = toRepoPath(filePath, config.repoRoot);

  const index = buildIndex(config);
  const graph = buildGraph(index, config);
  const docByPath = new Map(index.docs.map(d => [d.path, d]));
  const readGates = createGateReader(index.docs, config);
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

  let directDeps = (reverseMap.get(repoPath) || []).map(e => {
    const d = docByPath.get(e.source);
    return { path: e.source, slug: path.basename(e.source, '.md'), status: d?.status, field: e.field };
  });

  let blockerDeps = blockerRefs
    .filter(d => d.path !== repoPath)
    .map(d => ({ path: d.path, slug: path.basename(d.path, '.md'), status: d.status, blockers: d.blockers }));

  let gates = index.docs.flatMap(d => readGates(d.path).entries.filter(e=>e.target?.path===repoPath).map(e=>({...e,dependent:d.path})));
  const result = boundedOutput({doc:repoPath,directDeps,blockerDeps,gates});
  ({directDeps,blockerDeps,gates}=result);
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (result.truncated && !json) process.stdout.write(`Truncated: ${result.truncationReasons.join(', ')}\n`);
  const slug = path.basename(repoPath, '.md');
  process.stdout.write(gateLines(boundedOutput({review:'inverse declarations',entries:gates,diagnostics:[]})).join('\n') + '\n');
  process.stdout.write(`${bold('Unblocks')} — what happens when ${green(slug)} completes:\n\n`);

  if ((directDeps ?? []).length > 0) {
    process.stdout.write(bold('Referenced by:') + '\n');
    for (const d of directDeps ?? []) {
      process.stdout.write(`  ${d.slug.padEnd(24)} ${dim(`(${d.status})`)}  via ${dim(d.field)}\n`);
    }
    process.stdout.write('\n');
  }

  if ((blockerDeps ?? []).length > 0) {
    process.stdout.write(bold('Listed as blocker in:') + '\n');
    for (const d of blockerDeps ?? []) {
      process.stdout.write(`  ${d.slug.padEnd(24)} ${dim(`(${d.status})`)}\n`);
    }
    process.stdout.write('\n');
  }

  if ((directDeps ?? []).length === 0 && (blockerDeps ?? []).length === 0 && (gates ?? []).length === 0) {
    process.stdout.write(dim('No docs depend on or are blocked by this file.') + '\n');
  }
}
