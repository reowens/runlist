import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

function run(args, opts = {}) {
  return spawnSync('node', [BIN, ...args], {
    cwd: tmpDir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    ...opts,
  });
}

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-migrate-'));
  mkdirSync(path.join(tmpDir, '.git'));
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
    export const root = 'docs';
    export const statuses = {
      order: ['active', 'ready', 'planned', 'research', 'exploration', 'blocked', 'reference', 'archived'],
    };
  `);
  return docsDir;
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('dotmd migrate', () => {
  it('updates all docs matching the field value', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: research\nupdated: 2025-01-01\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'b.md'), '---\nstatus: research\nupdated: 2025-01-01\n---\n# B\n');
    writeFileSync(path.join(docsDir, 'c.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# C\n');

    const result = run(['migrate', 'status', 'research', 'exploration']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('2 file(s)'), 'reports 2 updated');
    ok(result.stdout.includes('Updated'), 'shows Updated');

    const aContent = readFileSync(path.join(docsDir, 'a.md'), 'utf8');
    ok(aContent.includes('status: exploration'), 'a.md updated');

    const bContent = readFileSync(path.join(docsDir, 'b.md'), 'utf8');
    ok(bContent.includes('status: exploration'), 'b.md updated');

    const cContent = readFileSync(path.join(docsDir, 'c.md'), 'utf8');
    ok(cContent.includes('status: active'), 'c.md unchanged');
  });

  it('--dry-run previews without writing', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: research\nupdated: 2025-01-01\n---\n# A\n');

    const result = run(['migrate', 'status', 'research', 'exploration', '--dry-run']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('[dry-run]'), 'shows dry-run prefix');

    const content = readFileSync(path.join(docsDir, 'a.md'), 'utf8');
    ok(content.includes('status: research'), 'file unchanged');
  });

  it('reports no matches when none found', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n');

    const result = run(['migrate', 'status', 'nonexistent', 'something']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('No docs found'), 'reports no matches');
  });

  it('works with non-status fields', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\nmodule: auth\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'b.md'), '---\nstatus: active\nupdated: 2025-01-01\nmodule: billing\n---\n# B\n');

    const result = run(['migrate', 'module', 'auth', 'identity']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('1 file(s)'), 'reports 1 updated');

    const aContent = readFileSync(path.join(docsDir, 'a.md'), 'utf8');
    ok(aContent.includes('module: identity'), 'a.md module updated');

    const bContent = readFileSync(path.join(docsDir, 'b.md'), 'utf8');
    ok(bContent.includes('module: billing'), 'b.md unchanged');
  });

  it('errors on missing arguments', () => {
    setupProject();

    const result = run(['migrate', 'status', 'research']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('Usage'), 'shows usage');
  });

  it('with file args, only rewrites the named files', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: research\nupdated: 2025-01-01\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'b.md'), '---\nstatus: research\nupdated: 2025-01-01\n---\n# B\n');
    writeFileSync(path.join(docsDir, 'c.md'), '---\nstatus: research\nupdated: 2025-01-01\n---\n# C\n');

    const result = run(['migrate', 'status', 'research', 'exploration', 'docs/a.md', 'docs/c.md']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('2 file(s)'), 'reports 2 updated');

    ok(readFileSync(path.join(docsDir, 'a.md'), 'utf8').includes('status: exploration'), 'a.md updated');
    ok(readFileSync(path.join(docsDir, 'b.md'), 'utf8').includes('status: research'), 'b.md left alone');
    ok(readFileSync(path.join(docsDir, 'c.md'), 'utf8').includes('status: exploration'), 'c.md updated');
  });

  it('file args + --dry-run previews without writing', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: research\nupdated: 2025-01-01\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'b.md'), '---\nstatus: research\nupdated: 2025-01-01\n---\n# B\n');

    const result = run(['migrate', 'status', 'research', 'exploration', 'docs/a.md', '--dry-run']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('[dry-run]'), 'shows dry-run prefix');
    ok(result.stdout.includes('1 file(s)'), 'reports 1 file');

    ok(readFileSync(path.join(docsDir, 'a.md'), 'utf8').includes('status: research'), 'a.md unchanged');
    ok(readFileSync(path.join(docsDir, 'b.md'), 'utf8').includes('status: research'), 'b.md unchanged');
  });

  it('file args matched by basename substring', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'alpha.md'), '---\nstatus: research\nupdated: 2025-01-01\n---\n# Alpha\n');
    writeFileSync(path.join(docsDir, 'beta.md'), '---\nstatus: research\nupdated: 2025-01-01\n---\n# Beta\n');

    const result = run(['migrate', 'status', 'research', 'exploration', 'alpha']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('1 file(s)'), 'reports 1 updated');

    ok(readFileSync(path.join(docsDir, 'alpha.md'), 'utf8').includes('status: exploration'), 'alpha.md updated');
    ok(readFileSync(path.join(docsDir, 'beta.md'), 'utf8').includes('status: research'), 'beta.md left alone');
  });

  it('file args matched by path fragment', () => {
    const docsDir = setupProject();
    const subDir = path.join(docsDir, 'plans');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(path.join(subDir, 'one.md'), '---\nstatus: research\nupdated: 2025-01-01\n---\n# One\n');
    writeFileSync(path.join(docsDir, 'two.md'), '---\nstatus: research\nupdated: 2025-01-01\n---\n# Two\n');

    const result = run(['migrate', 'status', 'research', 'exploration', 'plans/one']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('1 file(s)'), `reports 1 updated; stdout: ${result.stdout}`);

    ok(readFileSync(path.join(subDir, 'one.md'), 'utf8').includes('status: exploration'), 'plans/one.md updated');
    ok(readFileSync(path.join(docsDir, 'two.md'), 'utf8').includes('status: research'), 'two.md left alone');
  });

  it('errors on file args that match nothing', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: research\nupdated: 2025-01-01\n---\n# A\n');

    const result = run(['migrate', 'status', 'research', 'exploration', 'docs/does-not-exist.md']);
    strictEqual(result.status, 1, 'exits non-zero');
    ok(result.stderr.includes('No matching file'), `stderr: ${result.stderr}`);

    ok(readFileSync(path.join(docsDir, 'a.md'), 'utf8').includes('status: research'), 'a.md unchanged');
  });

  it('reports zero matches when file args match files but none have the old value', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n');

    const result = run(['migrate', 'status', 'research', 'exploration', 'docs/a.md']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('No docs found'), 'reports no matches');

    ok(readFileSync(path.join(docsDir, 'a.md'), 'utf8').includes('status: active'), 'a.md unchanged');
  });
});
