import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

let tmpDir;

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-deps-'));
  mkdirSync(path.join(tmpDir, '.git'));
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
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
    cwd: tmpDir, encoding: 'utf8',
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('deps: flat overview', () => {
  it('shows overview with edges', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - b.md\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'b.md'), '---\nstatus: planned\nupdated: 2025-01-01\n---\n# B\n');
    writeFileSync(path.join(docsDir, 'c.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# C\n');

    const result = run(['deps']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Deps'), 'shows heading');
    ok(result.stdout.includes('blocking') || result.stdout.includes('blocked') || result.stdout.includes('Orphans'), 'shows dep info');
  });

  it('shows orphans', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n');

    const result = run(['deps']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Orphans') || result.stdout.includes('No dependencies'), 'shows orphan or no-deps message');
  });

  it('--json produces valid JSON', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - b.md\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'b.md'), '---\nstatus: planned\nupdated: 2025-01-01\n---\n# B\n');

    const result = run(['deps', '--json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    ok(json.stats, 'has stats');
    ok(Array.isArray(json.mostBlocking), 'has mostBlocking');
    ok(Array.isArray(json.orphans), 'has orphans');
  });
});

describe('deps: tree view', () => {
  it('shows depends-on and depended-on-by', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - b.md\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'b.md'), '---\nstatus: planned\nupdated: 2025-01-01\nrelated_plans:\n  - a.md\n---\n# B\n');

    const result = run(['deps', path.join(docsDir, 'a.md')]);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Depends on'), 'shows depends on');
    ok(result.stdout.includes('Depended on by'), 'shows depended on by');
    ok(result.stdout.includes('related_plans'), 'shows field name');
  });

  it('shows blockers', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: blocked\nupdated: 2025-01-01\nblockers:\n  - waiting on review\n---\n# A\n');

    const result = run(['deps', path.join(docsDir, 'a.md')]);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Blockers'), 'shows blockers section');
    ok(result.stdout.includes('waiting on review'), 'shows blocker text');
  });

  it('detects cycles', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - b.md\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'b.md'), '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - a.md\n---\n# B\n');

    const result = run(['deps', path.join(docsDir, 'a.md')]);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('[cycle]'), 'shows cycle marker');
  });

  it('--json produces valid JSON tree', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - b.md\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'b.md'), '---\nstatus: planned\nupdated: 2025-01-01\n---\n# B\n');

    const result = run(['deps', path.join(docsDir, 'a.md'), '--json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    strictEqual(json.slug, 'a');
    ok(Array.isArray(json.dependsOn), 'has dependsOn');
    ok(Array.isArray(json.dependedOnBy), 'has dependedOnBy');
  });

  it('--depth limits tree depth', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - b.md\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'b.md'), '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - c.md\n---\n# B\n');
    writeFileSync(path.join(docsDir, 'c.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# C\n');

    const result = run(['deps', path.join(docsDir, 'a.md'), '--depth', '1']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('b'), 'shows depth-1 dep');
    ok(!result.stdout.includes('    c'), 'does not show depth-2 dep with 4-space indent');
  });

  it('errors on nonexistent file', () => {
    setupProject();
    const result = run(['deps', 'nonexistent.md']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('not found'), 'shows error');
  });
});

describe('deps: --help', () => {
  it('shows help', () => {
    setupProject();
    const result = run(['deps', '--help']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('dependency'), 'shows help text');
  });
});
