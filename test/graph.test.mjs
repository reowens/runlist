import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildGraph, renderGraphText, renderGraphDot, renderGraphJson } from '../src/graph.mjs';

let tmpDir;

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-graph-'));
  mkdirSync(path.join(tmpDir, '.git'));
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(path.join(docsDir, 'archived'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
    export const root = 'docs';
    export const referenceFields = {
      bidirectional: ['related_plans'],
      unidirectional: ['supports'],
    };
  `);
  return docsDir;
}

function run(args) {
  const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
  return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
    cwd: tmpDir,
    encoding: 'utf8',
  });
}

function makeConfig(overrides = {}) {
  return {
    repoRoot: '/repo',
    docsRoot: '/repo/docs',
    referenceFields: {
      bidirectional: ['related_plans'],
      unidirectional: ['supports'],
    },
    hooks: {},
    ...overrides,
  };
}

function makeIndex(docs) {
  return { docs, errors: [], warnings: [], countsByStatus: {} };
}

function makeDoc(overrides = {}) {
  return {
    path: 'docs/test.md',
    title: 'Test',
    status: 'active',
    module: null,
    surface: null,
    modules: [],
    surfaces: [],
    refFields: {},
    ...overrides,
  };
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildGraph', () => {
  it('builds nodes from docs', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ path: 'docs/a.md', title: 'A' }),
      makeDoc({ path: 'docs/b.md', title: 'B' }),
    ]);
    const graph = buildGraph(index, config);
    strictEqual(graph.stats.nodeCount, 2);
    strictEqual(graph.nodes[0].slug, 'a');
    strictEqual(graph.nodes[1].slug, 'b');
  });

  it('builds edges from refFields', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ path: 'docs/a.md', refFields: { related_plans: ['b.md'] } }),
      makeDoc({ path: 'docs/b.md', refFields: {} }),
    ]);
    const graph = buildGraph(index, config);
    strictEqual(graph.stats.edgeCount, 1);
    strictEqual(graph.edges[0].source, 'docs/a.md');
    strictEqual(graph.edges[0].target, 'docs/b.md');
    strictEqual(graph.edges[0].type, 'bidirectional');
    strictEqual(graph.edges[0].broken, false);
  });

  it('detects broken references', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ path: 'docs/a.md', refFields: { supports: ['nonexistent.md'] } }),
    ]);
    const graph = buildGraph(index, config);
    strictEqual(graph.stats.brokenEdgeCount, 1);
    ok(graph.edges[0].broken);
  });

  it('detects orphan nodes', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ path: 'docs/a.md', refFields: { related_plans: ['b.md'] } }),
      makeDoc({ path: 'docs/b.md', refFields: {} }),
      makeDoc({ path: 'docs/c.md', refFields: {} }),
    ]);
    const graph = buildGraph(index, config);
    strictEqual(graph.stats.orphanCount, 1);
    deepStrictEqual(graph.orphans, ['docs/c.md']);
  });

  it('deduplicates edges by source+target+field', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ path: 'docs/a.md', refFields: { related_plans: ['b.md', 'b.md'] } }),
      makeDoc({ path: 'docs/b.md', refFields: {} }),
    ]);
    const graph = buildGraph(index, config);
    strictEqual(graph.stats.edgeCount, 1);
  });

  it('does not merge edge tuples whose pipe-joined forms collide', { skip: process.platform === 'win32' && 'Windows filenames cannot contain pipes' }, () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-graph-tuples-'));
    const repoRoot = tmpDir;
    for (const relative of [
      'docs/a.md',
      'docs/a.md|docs/b.md',
      'docs/c.md',
      'docs/b.md|docs/c.md',
    ]) {
      const file = path.join(repoRoot, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '# Test\n');
    }
    const config = makeConfig({ repoRoot, docsRoot: path.join(repoRoot, 'docs') });
    const graph = buildGraph(makeIndex([
      makeDoc({ path: 'docs/a.md', refFields: { supports: ['docs/b.md|docs/c.md'] } }),
      makeDoc({ path: 'docs/a.md|docs/b.md', refFields: { supports: ['docs/c.md'] } }),
      makeDoc({ path: 'docs/c.md' }),
      makeDoc({ path: 'docs/b.md|docs/c.md' }),
    ]), config);
    strictEqual(graph.stats.edgeCount, 2);
  });

  it('handles self-references', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ path: 'docs/a.md', refFields: { related_plans: ['a.md'] } }),
    ]);
    const graph = buildGraph(index, config);
    strictEqual(graph.stats.edgeCount, 1);
    strictEqual(graph.edges[0].source, 'docs/a.md');
    strictEqual(graph.edges[0].target, 'docs/a.md');
  });

  it('filters by status', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ path: 'docs/a.md', status: 'active' }),
      makeDoc({ path: 'docs/b.md', status: 'archived' }),
    ]);
    const graph = buildGraph(index, config, { statuses: ['active'] });
    strictEqual(graph.stats.nodeCount, 1);
    strictEqual(graph.nodes[0].slug, 'a');
  });

  it('filters by module', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ path: 'docs/a.md', module: 'notify', modules: ['notify'] }),
      makeDoc({ path: 'docs/b.md', module: 'atrium', modules: ['atrium'] }),
    ]);
    const graph = buildGraph(index, config, { module: 'notify' });
    strictEqual(graph.stats.nodeCount, 1);
    strictEqual(graph.nodes[0].slug, 'a');
  });

  it('marks external edges when filtering', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ path: 'docs/a.md', status: 'active', refFields: { related_plans: ['b.md'] } }),
      makeDoc({ path: 'docs/b.md', status: 'archived', refFields: {} }),
    ]);
    const graph = buildGraph(index, config, { statuses: ['active'] });
    strictEqual(graph.edges[0].external, true);
  });

  it('handles empty index', () => {
    const config = makeConfig();
    const graph = buildGraph(makeIndex([]), config);
    strictEqual(graph.stats.nodeCount, 0);
    strictEqual(graph.stats.edgeCount, 0);
  });

  it('distinguishes bidirectional and unidirectional edge types', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ path: 'docs/a.md', refFields: { related_plans: ['b.md'], supports: ['c.md'] } }),
      makeDoc({ path: 'docs/b.md', refFields: {} }),
      makeDoc({ path: 'docs/c.md', refFields: {} }),
    ]);
    const graph = buildGraph(index, config);
    const biEdge = graph.edges.find(e => e.field === 'related_plans');
    const uniEdge = graph.edges.find(e => e.field === 'supports');
    strictEqual(biEdge.type, 'bidirectional');
    strictEqual(uniEdge.type, 'unidirectional');
  });
});

describe('renderGraphText', () => {
  it('starts with Graph heading', () => {
    const config = makeConfig();
    const graph = buildGraph(makeIndex([makeDoc()]), config);
    const text = renderGraphText(graph, config);
    ok(text.includes('Graph'), 'starts with Graph');
  });

  it('shows orphan docs', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ path: 'docs/lonely.md', title: 'Lonely', refFields: {} }),
    ]);
    const graph = buildGraph(index, config);
    const text = renderGraphText(graph, config);
    ok(text.includes('Orphans'), 'shows orphans section');
    ok(text.includes('lonely'), 'lists orphan slug');
  });

  it('shows broken marker', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ path: 'docs/a.md', refFields: { supports: ['gone.md'] } }),
    ]);
    const graph = buildGraph(index, config);
    const text = renderGraphText(graph, config);
    ok(text.includes('[broken]'), 'shows broken marker');
  });

  it('handles no reference fields configured', () => {
    const config = makeConfig({ referenceFields: { bidirectional: [], unidirectional: [] } });
    const graph = buildGraph(makeIndex([makeDoc()]), config);
    const text = renderGraphText(graph, config);
    ok(text.includes('no reference fields configured'), 'shows config hint');
  });

  it('handles empty index', () => {
    const config = makeConfig();
    const graph = buildGraph(makeIndex([]), config);
    const text = renderGraphText(graph, config);
    ok(text.includes('No documents found'), 'shows empty message');
  });

  it('supports hook override', () => {
    const config = makeConfig({ hooks: { renderGraph: () => 'custom output\n' } });
    const graph = buildGraph(makeIndex([makeDoc()]), config);
    const text = renderGraphText(graph, config);
    strictEqual(text, 'custom output\n');
  });
});

describe('renderGraphDot', () => {
  it('produces valid DOT structure', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ path: 'docs/a.md', refFields: { related_plans: ['b.md'] } }),
      makeDoc({ path: 'docs/b.md', refFields: {} }),
    ]);
    const graph = buildGraph(index, config);
    const dot = renderGraphDot(graph, config);
    ok(dot.startsWith('digraph dotmd {'), 'starts with digraph');
    ok(dot.includes('"docs/a.md"'), 'includes full node a identity');
    ok(dot.includes('"docs/b.md"'), 'includes full node b identity');
    ok(dot.includes('->'), 'includes edge');
    ok(dot.trimEnd().endsWith('}'), 'ends with closing brace');
  });

  it('uses dir=both for mutual bidirectional edges', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ path: 'docs/a.md', refFields: { related_plans: ['b.md'] } }),
      makeDoc({ path: 'docs/b.md', refFields: { related_plans: ['a.md'] } }),
    ]);
    const graph = buildGraph(index, config);
    const dot = renderGraphDot(graph, config);
    ok(dot.includes('dir=both'), 'uses dir=both for mutual edges');
  });

  it('renders broken refs with dashed style', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ path: 'docs/a.md', refFields: { supports: ['gone.md'] } }),
    ]);
    const graph = buildGraph(index, config);
    const dot = renderGraphDot(graph, config);
    ok(dot.includes('style=dashed'), 'broken edge is dashed');
    ok(dot.includes('color=red'), 'broken edge is red');
  });

  it('keeps duplicate basenames and synthetic targets distinct by full path', () => {
    const graph = {
      nodes: [
        { id: 'docs/a/foo.md', slug: 'foo', status: 'active' },
        { id: 'docs/b/foo.md', slug: 'foo', status: 'planned' },
      ],
      edges: [
        { source: 'docs/a/foo.md', target: 'missing/a/bar.md', field: 'supports', type: 'unidirectional', broken: true, external: false },
        { source: 'docs/b/foo.md', target: 'missing/b/bar.md', field: 'supports', type: 'unidirectional', broken: true, external: false },
      ],
    };
    const dot = renderGraphDot(graph, makeConfig());
    for (const id of ['docs/a/foo.md', 'docs/b/foo.md', 'missing/a/bar.md', 'missing/b/bar.md']) {
      ok(dot.includes(`"${id}"`), `includes ${id}`);
    }
  });

  it('escapes DOT IDs, labels, statuses, and fields', () => {
    const graph = {
      nodes: [{ id: 'docs/a"\\\n.md', slug: 'a"\\', status: 'active\rstatus' }],
      edges: [{ source: 'docs/a"\\\n.md', target: 'missing/\u0001.md', field: 'field"\\\n', type: 'unidirectional', broken: true, external: false }],
    };
    const dot = renderGraphDot(graph, makeConfig());
    ok(dot.includes('docs/a\\"\\\\\\n.md'), 'escapes node ID');
    ok(dot.includes('active\\rstatus'), 'escapes status');
    ok(dot.includes('field\\"\\\\\\n'), 'escapes field');
    ok(dot.includes('missing/\\x01.md'), 'escapes control character');

    const graphviz = spawnSync('dot', ['-Tdot'], { input: dot, encoding: 'utf8' });
    if (graphviz.error?.code !== 'ENOENT') strictEqual(graphviz.status, 0, graphviz.stderr);
  });

  it('tracks rendered and reverse edges as tuples when values contain pipes', () => {
    const graph = {
      nodes: [
        { id: 'a', slug: 'a', status: 'active' },
        { id: 'a|b', slug: 'a-b', status: 'active' },
        { id: 'b|c', slug: 'b-c', status: 'active' },
        { id: 'c', slug: 'c', status: 'active' },
      ],
      edges: [
        { source: 'a', target: 'b|c', field: 'd', type: 'bidirectional', broken: false, external: false },
        { source: 'a|b', target: 'c', field: 'd', type: 'bidirectional', broken: false, external: false },
      ],
    };
    const dot = renderGraphDot(graph, makeConfig());
    strictEqual((dot.match(/ -> /g) || []).length, 2);
    ok(!dot.includes('dir=both'), 'does not invent reverse edges from joined-key collisions');
  });
});

describe('renderGraphJson', () => {
  it('produces valid JSON with expected keys', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ path: 'docs/a.md', refFields: { related_plans: ['b.md'] } }),
      makeDoc({ path: 'docs/b.md', refFields: {} }),
    ]);
    const graph = buildGraph(index, config);
    const json = JSON.parse(renderGraphJson(graph));
    ok(json.generatedAt, 'has generatedAt');
    ok(json.stats, 'has stats');
    ok(Array.isArray(json.nodes), 'has nodes array');
    ok(Array.isArray(json.edges), 'has edges array');
    ok(Array.isArray(json.orphans), 'has orphans array');
    strictEqual(json.stats.nodeCount, 2);
    strictEqual(json.stats.edgeCount, 1);
  });

  it('does not leak external flag into JSON edges', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ path: 'docs/a.md', status: 'active', refFields: { related_plans: ['b.md'] } }),
      makeDoc({ path: 'docs/b.md', status: 'archived', refFields: {} }),
    ]);
    const graph = buildGraph(index, config, { statuses: ['active'] });
    const json = JSON.parse(renderGraphJson(graph));
    ok(!('external' in json.edges[0]), 'external flag not in JSON output');
  });
});

describe('graph CLI', () => {
  it('--help shows graph help', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-graph-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);

    const result = run(['graph', '--help']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('visualize'), 'shows graph help');
  });

  it('text output works with reference fields', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - b.md\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'b.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# B\n');

    const result = run(['graph']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Graph'), 'shows Graph heading');
    ok(result.stdout.includes('related_plans'), 'shows field name');
  });

  it('--dot produces DOT output', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - b.md\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'b.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# B\n');

    const result = run(['graph', '--dot']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('digraph'), 'produces DOT output');
  });

  it('--json produces valid JSON', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n');

    const result = run(['graph', '--json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    ok(json.stats, 'has stats in JSON');
  });

  it('--status filters docs', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'b.md'), '---\nstatus: archived\n---\n# B\n');

    const result = run(['graph', '--json', '--status', 'active']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    strictEqual(json.stats.nodeCount, 1);
  });

  // Regression for audit-example-project F1: repo-relative refs (e.g.
  // `docs/foo/bar.md` written from a doc nested in `docs/plans/`) were being
  // joined to the source's docDir, producing a doubled path like
  // `docs/plans/docs/foo/bar.md` that didn't exist — marked broken. Graph
  // should use resolveRefPath (doc-relative then repo-root) like validate.mjs.
  it('resolves repo-relative refs against repo root, not source docDir', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'plans'), { recursive: true });
    mkdirSync(path.join(docsDir, 'journeys'), { recursive: true });
    // Source doc lives in docs/plans/; ref string is repo-relative.
    writeFileSync(path.join(docsDir, 'plans', 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - docs/journeys/b.md\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'journeys', 'b.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# B\n');

    const result = run(['graph', '--json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    strictEqual(json.stats.brokenEdgeCount, 0, 'repo-relative ref should resolve, not be broken');
    const edge = json.edges.find(e => e.source === 'docs/plans/a.md');
    ok(edge, 'edge from docs/plans/a.md present');
    strictEqual(edge.target, 'docs/journeys/b.md', 'target is repo-relative path, not doubled');
    strictEqual(edge.broken, false);
  });
});
