import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

let tmpDir;

function setupMultiRoot() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-multiroot-'));
  spawnSync('git', ['init'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

  mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'docs', 'plans', 'archived'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'docs', 'modules'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'docs', 'modules', 'archived'), { recursive: true });

  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
    export const root = ['docs/plans', 'docs/modules'];
    export const referenceFields = {
      bidirectional: ['related_plans'],
      unidirectional: [],
    };
  `);

  writeFileSync(path.join(tmpDir, 'docs', 'plans', 'plan-a.md'),
    '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - ../modules/mod-a.md\n---\n# Plan A\n');
  writeFileSync(path.join(tmpDir, 'docs', 'modules', 'mod-a.md'),
    '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - ../plans/plan-a.md\n---\n# Module A\n');
  writeFileSync(path.join(tmpDir, 'docs', 'modules', 'mod-b.md'),
    '---\nstatus: planned\nupdated: 2025-01-01\n---\n# Module B\n');

  spawnSync('git', ['add', '.'], { cwd: tmpDir });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });
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

describe('multi-root: list', () => {
  it('shows docs from all roots', () => {
    setupMultiRoot();
    const result = run(['json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const index = JSON.parse(result.stdout);
    strictEqual(index.docs.length, 3, 'finds docs across both roots');
  });

  it('tags each doc with its root', () => {
    setupMultiRoot();
    const result = run(['json']);
    const index = JSON.parse(result.stdout);
    const planDoc = index.docs.find(d => d.path.includes('plan-a'));
    const modDoc = index.docs.find(d => d.path.includes('mod-a'));
    strictEqual(planDoc.root, 'docs/plans');
    strictEqual(modDoc.root, 'docs/modules');
  });
});

describe('multi-root: --root filter', () => {
  it('filters to a single root', () => {
    setupMultiRoot();
    const result = run(['json', '--root', 'plans']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const index = JSON.parse(result.stdout);
    strictEqual(index.docs.length, 1, 'only plans root docs');
    ok(index.docs[0].path.includes('plans'), 'doc is from plans');
  });

  it('filters modules root', () => {
    setupMultiRoot();
    const result = run(['json', '--root', 'modules']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const index = JSON.parse(result.stdout);
    strictEqual(index.docs.length, 2, 'only modules root docs');
  });
});

describe('multi-root: cross-root references', () => {
  it('validates cross-root references without errors', () => {
    setupMultiRoot();
    const result = run(['check']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!result.stdout.includes('does not resolve'), 'no broken ref errors');
  });
});

describe('multi-root: archive within root', () => {
  it('archives to the same root archive dir', () => {
    setupMultiRoot();
    const modPath = path.join(tmpDir, 'docs', 'modules', 'mod-b.md');
    const result = run(['archive', modPath]);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    ok(existsSync(path.join(tmpDir, 'docs', 'modules', 'archived', 'mod-b.md')),
      'archived within modules root');
    ok(!existsSync(path.join(tmpDir, 'docs', 'plans', 'archived', 'mod-b.md')),
      'not archived to plans root');
  });
});

describe('multi-root: new with --root', () => {
  it('creates doc in specified root', () => {
    setupMultiRoot();
    const result = run(['new', 'new-module', '--root', 'modules']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(existsSync(path.join(tmpDir, 'docs', 'modules', 'new-module.md')),
      'created in modules root');
  });

  it('defaults to first root without --root', () => {
    setupMultiRoot();
    const result = run(['new', 'new-plan']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(existsSync(path.join(tmpDir, 'docs', 'plans', 'new-plan.md')),
      'created in first (plans) root');
  });

  it('rejects unknown root', () => {
    setupMultiRoot();
    const result = run(['new', 'foo', '--root', 'nonexistent']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('Unknown root'), 'shows error');
  });
});

describe('multi-root: stats', () => {
  it('aggregates across all roots', () => {
    setupMultiRoot();
    const result = run(['stats', '--json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const stats = JSON.parse(result.stdout);
    strictEqual(stats.totalDocs, 3);
  });
});

describe('multi-root: graph', () => {
  it('shows cross-root edges', () => {
    setupMultiRoot();
    const result = run(['graph', '--json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const graph = JSON.parse(result.stdout);
    ok(graph.edges.length > 0, 'has edges');
    ok(graph.edges.some(e => e.source.includes('plans') && e.target.includes('modules')),
      'has cross-root edge');
  });
});

describe('multi-root: backwards compat', () => {
  it('string root still works', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-singleroot-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n');

    const result = run(['json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const index = JSON.parse(result.stdout);
    strictEqual(index.docs.length, 1);
    strictEqual(index.docs[0].root, 'docs');
  });
});
