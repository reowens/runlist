import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildStats, renderStats, renderStatsJson } from '../src/stats.mjs';

let tmpDir;

function makeConfig(overrides = {}) {
  return {
    statusOrder: ['active', 'ready', 'planned', 'blocked', 'archived'],
    lifecycle: { skipWarningsFor: new Set(['archived']), skipStaleFor: new Set(['archived']), archiveStatuses: new Set(['archived']), terminalStatuses: new Set(['archived', 'deprecated', 'reference', 'done']) },
    hooks: {},
    ...overrides,
  };
}

function makeDoc(overrides = {}) {
  return {
    path: 'docs/test.md', title: 'Test', status: 'active',
    owner: null, surface: null, module: null, surfaces: [], modules: [],
    daysSinceUpdate: 5, isStale: false, hasNextStep: false, hasBlockers: false,
    checklist: { completed: 0, open: 0, total: 0 }, checklistCompletionRate: null,
    auditLevel: null, audited: null, bodyLinks: [], refFields: {},
    errors: [], warnings: [],
    ...overrides,
  };
}

function makeIndex(docs, errors = [], warnings = []) {
  const countsByStatus = {};
  for (const d of docs) countsByStatus[d.status] = (countsByStatus[d.status] || 0) + 1;
  return { docs, countsByStatus, errors, warnings };
}

function run(args) {
  const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
  return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
    cwd: tmpDir, encoding: 'utf8',
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildStats', () => {
  it('counts docs by status', () => {
    const config = makeConfig();
    const index = makeIndex([makeDoc({ status: 'active' }), makeDoc({ status: 'active' }), makeDoc({ status: 'planned' })]);
    const stats = buildStats(index, config);
    strictEqual(stats.totalDocs, 3);
    strictEqual(stats.countsByStatus.active, 2);
    strictEqual(stats.countsByStatus.planned, 1);
  });

  it('computes staleness metrics', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ status: 'active', isStale: true }),
      makeDoc({ status: 'active', isStale: false }),
      makeDoc({ status: 'archived', isStale: true }),
    ]);
    const stats = buildStats(index, config);
    strictEqual(stats.health.staleCount, 1, 'excludes archived from stale count');
  });

  it('computes freshness buckets', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ daysSinceUpdate: 0 }),
      makeDoc({ daysSinceUpdate: 3 }),
      makeDoc({ daysSinceUpdate: 20 }),
      makeDoc({ daysSinceUpdate: 45 }),
    ]);
    const stats = buildStats(index, config);
    strictEqual(stats.freshness.today, 1);
    strictEqual(stats.freshness.thisWeek, 2);
    strictEqual(stats.freshness.thisMonth, 3);
  });

  it('finds oldest doc', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ path: 'docs/old.md', daysSinceUpdate: 100 }),
      makeDoc({ path: 'docs/new.md', daysSinceUpdate: 1 }),
    ]);
    const stats = buildStats(index, config);
    strictEqual(stats.freshness.oldest.slug, 'old');
    strictEqual(stats.freshness.oldest.daysSinceUpdate, 100);
  });

  it('computes completeness for scoped docs', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ status: 'active', owner: 'alice', surface: 'web', module: 'auth', hasNextStep: true }),
      makeDoc({ status: 'active', owner: null, surface: null, module: null, hasNextStep: false }),
      makeDoc({ status: 'archived', owner: null, surface: null, module: null, hasNextStep: false }),
    ]);
    const stats = buildStats(index, config);
    strictEqual(stats.completeness.scoped, 2);
    strictEqual(stats.completeness.hasOwner, 1);
    strictEqual(stats.completeness.hasSurface, 1);
    strictEqual(stats.completeness.hasModule, 1);
    strictEqual(stats.completeness.hasNextStep, 1);
  });

  it('computes checklist metrics', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ checklist: { completed: 5, open: 0, total: 5 }, checklistCompletionRate: 1 }),
      makeDoc({ checklist: { completed: 2, open: 3, total: 5 }, checklistCompletionRate: 0.4 }),
      makeDoc({ checklist: { completed: 0, open: 0, total: 0 }, checklistCompletionRate: null }),
    ]);
    const stats = buildStats(index, config);
    strictEqual(stats.checklists.docsWithChecklists, 2);
    strictEqual(stats.checklists.fullyComplete, 1);
    strictEqual(stats.checklists.withOpenItems, 1);
    strictEqual(stats.checklists.avgCompletion, 70);
  });

  it('computes audit metrics', () => {
    const config = makeConfig();
    const index = makeIndex([
      makeDoc({ status: 'active', auditLevel: 'pass1' }),
      makeDoc({ status: 'active', auditLevel: 'pass2' }),
      makeDoc({ status: 'active', auditLevel: 'deep' }),
      makeDoc({ status: 'active', auditLevel: 'none' }),
      makeDoc({ status: 'active', auditLevel: null }),
    ]);
    const stats = buildStats(index, config);
    strictEqual(stats.audit.audited, 3);
    strictEqual(stats.audit.pass1, 1);
    strictEqual(stats.audit.pass2, 1);
    strictEqual(stats.audit.deep, 1);
  });

  it('handles empty index', () => {
    const config = makeConfig();
    const stats = buildStats(makeIndex([]), config);
    strictEqual(stats.totalDocs, 0);
    strictEqual(stats.health.staleCount, 0);
    strictEqual(stats.freshness.oldest, null);
  });
});

describe('renderStats', () => {
  it('includes Stats heading', () => {
    const config = makeConfig();
    const stats = buildStats(makeIndex([makeDoc()]), config);
    const text = renderStats(stats, config);
    ok(text.includes('Stats'), 'has heading');
    ok(text.includes('1 docs'), 'shows doc count');
  });

  it('shows all sections', () => {
    const config = makeConfig();
    const stats = buildStats(makeIndex([
      makeDoc({ owner: 'a', surface: 'web', module: 'auth', checklist: { completed: 1, open: 1, total: 2 }, checklistCompletionRate: 0.5, auditLevel: 'pass1' }),
    ]), config);
    const text = renderStats(stats, config);
    ok(text.includes('Status'), 'has Status section');
    ok(text.includes('Health'), 'has Health section');
    ok(text.includes('Freshness'), 'has Freshness section');
    ok(text.includes('Completeness'), 'has Completeness section');
    ok(text.includes('Checklists'), 'has Checklists section');
    ok(text.includes('Audit'), 'has Audit section');
  });

  it('supports hook override', () => {
    const config = makeConfig({ hooks: { renderStats: () => 'custom\n' } });
    const stats = buildStats(makeIndex([makeDoc()]), config);
    strictEqual(renderStats(stats, config), 'custom\n');
  });
});

describe('renderStatsJson', () => {
  it('produces valid JSON', () => {
    const config = makeConfig();
    const stats = buildStats(makeIndex([makeDoc()]), config);
    const json = JSON.parse(renderStatsJson(stats));
    ok(json.generatedAt);
    strictEqual(json.totalDocs, 1);
    ok(json.health);
    ok(json.freshness);
    ok(json.completeness);
    ok(json.checklists);
    ok(json.audit);
  });
});

describe('stats CLI', () => {
  it('shows text dashboard', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-stats-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n');

    const result = run(['stats']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Stats'), 'shows heading');
    ok(result.stdout.includes('active'), 'shows status');
  });

  it('--json produces valid JSON', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-stats-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n');

    const result = run(['stats', '--json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    strictEqual(json.totalDocs, 1);
  });

  it('--help shows stats help', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-stats-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);

    const result = run(['stats', '--help']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('health dashboard'), 'shows help');
  });
});
