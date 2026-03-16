import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

let tmpDir;

function setupProject(opts = {}) {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-fixrefs-'));
  mkdirSync(path.join(tmpDir, '.git'));
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(path.join(docsDir, 'archived'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
    export const root = 'docs';
    export const referenceFields = {
      bidirectional: ['related_plans'],
      unidirectional: ['supports_plans'],
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

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('fix-refs command', () => {
  it('reports no broken references when clean', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n');

    const result = run(['fix-refs']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('No broken references'), 'shows no broken refs');
  });

  it('fixes a broken reference by basename match', () => {
    const docsDir = setupProject();
    // b.md is in archived/, but a.md references it as if it were in docs/
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - b.md\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'archived', 'b.md'), '---\nstatus: archived\n---\n# B\n');

    const result = run(['fix-refs']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Fixed'), 'shows fixed message');
    ok(result.stdout.includes('archived/b.md'), 'shows corrected path');

    const content = readFileSync(path.join(docsDir, 'a.md'), 'utf8');
    ok(content.includes('archived/b.md'), 'frontmatter updated to correct path');
    ok(!content.includes('  - b.md'), 'old broken ref removed');
  });

  it('dry-run does not modify files', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - b.md\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'archived', 'b.md'), '---\nstatus: archived\n---\n# B\n');

    const result = run(['fix-refs', '--dry-run']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('[dry-run]'), 'shows dry-run prefix');

    const content = readFileSync(path.join(docsDir, 'a.md'), 'utf8');
    ok(content.includes('  - b.md'), 'file not modified in dry-run');
  });

  it('reports unfixable refs when basename not found', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - nonexistent.md\n---\n# A\n');

    const result = run(['fix-refs']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('could not be auto-resolved'), 'shows unfixable count');
  });
});

describe('check --errors-only', () => {
  it('suppresses warnings in output', () => {
    const docsDir = setupProject();
    // Missing summary triggers a warning, missing updated triggers an error
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n');

    const result = run(['check', '--errors-only']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    // Should still show warning count in summary but not list them
    ok(result.stdout.includes('warnings:'), 'shows warning count');
    ok(!result.stdout.includes('Warnings\n'), 'does not show Warnings section');
  });
});

describe('check --fix', () => {
  it('fixes broken refs and shows remaining check', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - b.md\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'archived', 'b.md'), '---\nstatus: archived\n---\n# B\n');

    const result = run(['check', '--fix']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Fixed'), 'shows fix-refs output');
    ok(result.stdout.includes('Check'), 'shows check output after fix');

    const content = readFileSync(path.join(docsDir, 'a.md'), 'utf8');
    ok(content.includes('archived/b.md'), 'reference was fixed');
  });
});

describe('touch --git', () => {
  it('syncs dates from git history', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-touchgit-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

    const docsDir = path.join(tmpDir, 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);

    // Create doc with old date
    const docPath = path.join(docsDir, 'stale.md');
    writeFileSync(docPath, '---\nstatus: active\nupdated: 2020-01-01\n---\n# Stale\n');
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const result = run(['touch', '--git']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Synced'), 'shows synced message');

    const content = readFileSync(docPath, 'utf8');
    ok(!content.includes('updated: 2020-01-01'), 'old date was replaced');
  });

  it('dry-run does not modify files', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-touchgit-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

    const docsDir = path.join(tmpDir, 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);

    const docPath = path.join(docsDir, 'stale.md');
    writeFileSync(docPath, '---\nstatus: active\nupdated: 2020-01-01\n---\n# Stale\n');
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const result = run(['touch', '--git', '--dry-run']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('[dry-run]'), 'shows dry-run prefix');

    const content = readFileSync(docPath, 'utf8');
    ok(content.includes('updated: 2020-01-01'), 'file not modified');
  });

  it('reports when all dates are already in sync', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-touchgit-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

    const docsDir = path.join(tmpDir, 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);

    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(path.join(docsDir, 'fresh.md'), `---\nstatus: active\nupdated: ${today}\n---\n# Fresh\n`);
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const result = run(['touch', '--git']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('in sync'), 'reports all in sync');
  });
});

describe('archive updates references', () => {
  it('auto-updates references in other docs when archiving', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-arcrefs-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

    const docsDir = path.join(tmpDir, 'docs');
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(path.join(docsDir, 'archived'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const root = 'docs';
      export const referenceFields = {
        bidirectional: ['related_plans'],
        unidirectional: [],
      };
    `);

    // a.md references b.md, and b.md will be archived
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - b.md\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'b.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# B\n');
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const result = run(['archive', path.join(docsDir, 'b.md')]);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Updated references'), 'shows ref update count');

    const aContent = readFileSync(path.join(docsDir, 'a.md'), 'utf8');
    ok(aContent.includes('archived/b.md'), 'reference in a.md updated to archived path');
    ok(!aContent.includes('  - b.md'), 'old reference removed');
  });

  it('dry-run shows would-update count', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-arcrefs-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

    const docsDir = path.join(tmpDir, 'docs');
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(path.join(docsDir, 'archived'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const root = 'docs';
      export const referenceFields = {
        bidirectional: ['related_plans'],
        unidirectional: [],
      };
    `);

    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - b.md\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'b.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# B\n');
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const result = run(['archive', path.join(docsDir, 'b.md'), '--dry-run']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Would update references'), 'shows would-update message');
  });
});
