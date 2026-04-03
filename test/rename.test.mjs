import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-rename-'));

  // Init git repo so git mv works
  spawnSync('git', ['init'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
    export const root = 'docs';
    export const referenceFields = {
      bidirectional: ['related_plans'],
      unidirectional: ['supports_plans'],
    };
  `);
  return docsDir;
}

function writeDoc(docsDir, filename, frontmatter, body = '') {
  const filePath = path.join(docsDir, filename);
  writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`);
  spawnSync('git', ['add', filePath], { cwd: tmpDir });
  spawnSync('git', ['commit', '-m', `add ${filename}`], { cwd: tmpDir });
  return filePath;
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('dotmd rename', () => {
  it('renames a doc via git mv', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'old-name.md', 'status: active\nupdated: 2025-01-01', '# Old\n');

    const result = run(['rename', path.join(docsDir, 'old-name.md'), 'new-name']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Renamed'), 'shows Renamed');

    ok(!existsSync(path.join(docsDir, 'old-name.md')), 'old file gone');
    ok(existsSync(path.join(docsDir, 'new-name.md')), 'new file exists');
  });

  it('updates references in other docs', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'old-name.md', 'status: active\nupdated: 2025-01-01', '# Old\n');
    writeDoc(docsDir, 'referrer.md', 'status: active\nupdated: 2025-01-01\nrelated_plans:\n  - old-name.md', '# Referrer\n');

    const result = run(['rename', path.join(docsDir, 'old-name.md'), 'new-name']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Updated references'), 'reports updated references');

    const referrerContent = readFileSync(path.join(docsDir, 'referrer.md'), 'utf8');
    ok(referrerContent.includes('new-name.md'), 'reference updated to new name');
    ok(!referrerContent.includes('old-name.md'), 'old reference removed');
  });

  it('--dry-run previews without modifying files', () => {
    const docsDir = setupProject();
    const oldPath = writeDoc(docsDir, 'old-name.md', 'status: active\nupdated: 2025-01-01', '# Old\n');
    writeDoc(docsDir, 'referrer.md', 'status: active\nupdated: 2025-01-01\nrelated_plans:\n  - old-name.md', '# Referrer\n');

    const result = run(['rename', path.join(docsDir, 'old-name.md'), 'new-name', '--dry-run']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('[dry-run]'), 'shows dry-run prefix');

    // Files should not have changed
    ok(existsSync(oldPath), 'old file still exists');
    ok(!existsSync(path.join(docsDir, 'new-name.md')), 'new file not created');
  });

  it('errors when target already exists', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'old-name.md', 'status: active\nupdated: 2025-01-01', '# Old\n');
    writeDoc(docsDir, 'new-name.md', 'status: active\nupdated: 2025-01-01', '# New\n');

    const result = run(['rename', path.join(docsDir, 'old-name.md'), 'new-name']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('already exists'), 'shows error');
  });

  it('updates references in body of other docs', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'old-name.md', 'status: active\nupdated: 2025-01-01', '# Old\n');
    writeDoc(docsDir, 'referrer.md', 'status: active\nupdated: 2025-01-01', '# Referrer\nSee [old plan](old-name.md) and old-name.md for details.\n');

    const result = run(['rename', path.join(docsDir, 'old-name.md'), 'new-name']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Updated references'), 'reports updated references');

    const referrerContent = readFileSync(path.join(docsDir, 'referrer.md'), 'utf8');
    ok(referrerContent.includes('new-name.md'), 'body reference updated to new name');
    ok(!referrerContent.includes('old-name.md'), 'old body reference removed');
  });

  it('errors when source file not found', () => {
    setupProject();

    const result = run(['rename', 'nonexistent.md', 'new-name']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('not found'), 'shows not found error');
  });

  it('supports cross-directory moves', () => {
    const docsDir = setupProject();
    const subDir = path.join(docsDir, 'modules');
    mkdirSync(subDir, { recursive: true });
    writeDoc(docsDir, 'old-name.md', 'status: active\nupdated: 2025-01-01', '# Old\n');

    const result = run(['rename', path.join(docsDir, 'old-name.md'), 'docs/modules/old-name.md']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!existsSync(path.join(docsDir, 'old-name.md')), 'old file gone');
    ok(existsSync(path.join(subDir, 'old-name.md')), 'file moved to subdirectory');
  });

  it('adds .md extension automatically', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'old-name.md', 'status: active\nupdated: 2025-01-01', '# Old\n');

    const result = run(['rename', path.join(docsDir, 'old-name.md'), 'new-name']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(existsSync(path.join(docsDir, 'new-name.md')), 'new file with .md exists');
  });
});
