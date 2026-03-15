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
});
