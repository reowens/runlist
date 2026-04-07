import { describe, it, beforeEach, afterEach } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/config.mjs';
import { updateFrontmatter } from '../src/lifecycle.mjs';

let tmpDir;

function setupProject(opts = {}) {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-life-'));

  // Init git repo so git mv works
  spawnSync('git', ['init'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

  // Create docs dir and archive dir
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(path.join(docsDir, 'archived'), { recursive: true });

  // Write config
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
    export const root = 'docs';
  `);

  return docsDir;
}

function writeDoc(docsDir, filename, frontmatter, body = '') {
  const filePath = path.join(docsDir, filename);
  writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`);
  // Stage in git so git mv works
  spawnSync('git', ['add', filePath], { cwd: tmpDir });
  spawnSync('git', ['commit', '-m', `add ${filename}`], { cwd: tmpDir });
  return filePath;
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('updateFrontmatter', () => {
  it('updates existing frontmatter fields', () => {
    const docsDir = setupProject();
    const filePath = writeDoc(docsDir, 'test.md', 'status: active\nupdated: 2025-01-01', '# Test\n');

    updateFrontmatter(filePath, { status: 'archived', updated: '2025-06-01' });

    const content = readFileSync(filePath, 'utf8');
    ok(content.includes('status: archived'));
    ok(content.includes('updated: 2025-06-01'));
    ok(content.includes('# Test'));
  });

  it('appends new frontmatter fields', () => {
    const docsDir = setupProject();
    const filePath = writeDoc(docsDir, 'test.md', 'status: active', '# Test\n');

    updateFrontmatter(filePath, { updated: '2025-06-01' });

    const content = readFileSync(filePath, 'utf8');
    ok(content.includes('updated: 2025-06-01'));
    ok(content.includes('status: active'));
  });

  it('throws for file without frontmatter', () => {
    const docsDir = setupProject();
    const filePath = path.join(docsDir, 'bad.md');
    writeFileSync(filePath, '# No frontmatter\n');

    let threw = false;
    try {
      updateFrontmatter(filePath, { status: 'active' });
    } catch {
      threw = true;
    }
    ok(threw);
  });
});

describe('init command', () => {
  it('creates config, docs dir, and index file', async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'init'], { cwd: tmpDir, encoding: 'utf8' });

    ok(existsSync(path.join(tmpDir, 'dotmd.config.mjs')), 'config file created');
    ok(existsSync(path.join(tmpDir, 'docs')), 'docs dir created');
    ok(existsSync(path.join(tmpDir, 'docs', 'docs.md')), 'index file created');

    // Running init again should report "exists" instead of creating
    const result2 = spawnSync('node', [bin, 'init'], { cwd: tmpDir, encoding: 'utf8' });
    ok(result2.stdout.includes('exists'), 'reports existing files');
  });
});

describe('init auto-detect', () => {
  it('detects statuses, surfaces, and ref fields from existing docs', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-detect-'));
    const docsDir = path.join(tmpDir, 'docs');
    mkdirSync(docsDir, { recursive: true });

    writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nsurface: backend\nrelated_plans:\n  - ./b.md\n---\n# A\n');
    writeFileSync(path.join(docsDir, 'b.md'), '---\nstatus: planned\nsurface: frontend\nmodule: auth\n---\n# B\n');

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'init'], { cwd: tmpDir, encoding: 'utf8' });

    ok(result.stdout.includes('detected 2 docs'), 'reports detected doc count');

    const config = readFileSync(path.join(tmpDir, 'dotmd.config.mjs'), 'utf8');
    ok(config.includes("'active'"), 'detected active status');
    ok(config.includes("'planned'"), 'detected planned status');
    ok(config.includes("'backend'"), 'detected backend surface');
    ok(config.includes("'frontend'"), 'detected frontend surface');
    ok(config.includes("'related_plans'"), 'detected related_plans ref field');
  });

  it('falls back to starter config when no docs exist', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-empty-'));

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    spawnSync('node', [bin, 'init'], { cwd: tmpDir, encoding: 'utf8' });

    const config = readFileSync(path.join(tmpDir, 'dotmd.config.mjs'), 'utf8');
    ok(config.includes('All exports are optional'), 'uses starter config');
    ok(!config.includes('auto-detected'), 'not auto-detected');
  });

  it('falls back when docs exist but have no frontmatter', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-nofm-'));
    const docsDir = path.join(tmpDir, 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(path.join(docsDir, 'plain.md'), '# Just a heading\nNo frontmatter here.\n');

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    spawnSync('node', [bin, 'init'], { cwd: tmpDir, encoding: 'utf8' });

    const config = readFileSync(path.join(tmpDir, 'dotmd.config.mjs'), 'utf8');
    ok(!config.includes('auto-detected'), 'not auto-detected');
  });
});

describe('status command (dry-run)', () => {
  it('previews status change without modifying files', async () => {
    const docsDir = setupProject();
    const filePath = writeDoc(docsDir, 'plan.md', 'status: active\nupdated: 2025-01-01', '# Plan\n');

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'status', filePath, 'planned', '--dry-run', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });

    ok(result.stdout.includes('[dry-run]'), 'shows dry-run prefix');
    ok(result.stdout.includes('active') && result.stdout.includes('planned'), 'shows transition');

    // File should not have changed
    const content = readFileSync(filePath, 'utf8');
    ok(content.includes('status: active'), 'file unchanged');
  });
});

describe('touch command', () => {
  it('updates the updated date', async () => {
    const docsDir = setupProject();
    const filePath = writeDoc(docsDir, 'doc.md', 'status: active\nupdated: 2024-01-01', '# Doc\n');

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    spawnSync('node', [bin, 'touch', filePath, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });

    const content = readFileSync(filePath, 'utf8');
    const today = new Date().toISOString().slice(0, 10);
    ok(content.includes(`updated: ${today}`), 'updated date is today');
    ok(content.includes('status: active'), 'status unchanged');
  });
});

describe('archive command (dry-run)', () => {
  it('previews archive without modifying files', async () => {
    const docsDir = setupProject();
    const filePath = writeDoc(docsDir, 'old.md', 'status: active\nupdated: 2025-01-01', '# Old\n');

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'archive', filePath, '--dry-run', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });

    ok(result.stdout.includes('[dry-run]'), 'shows dry-run prefix');
    ok(result.stdout.includes('archived'), 'mentions archived');

    // File should still exist at original location
    ok(existsSync(filePath), 'original file still exists');
  });
});

describe('archive path boundary', () => {
  it('does not double-nest when root name overlaps with archiveDir', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-archboundary-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

    // Create two roots: 'docs/archived' and 'docs/archived-extras'
    mkdirSync(path.join(tmpDir, 'docs', 'archived'), { recursive: true });
    mkdirSync(path.join(tmpDir, 'docs', 'archived-extras'), { recursive: true });

    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const root = ['docs/archived', 'docs/archived-extras'];
    `);

    const filePath = path.join(tmpDir, 'docs', 'archived-extras', 'plan.md');
    writeFileSync(filePath, '---\nstatus: active\nupdated: 2025-01-01\n---\n# Plan\n');
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'archive', filePath, '--dry-run', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });

    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    // Must archive into archived-extras/archived/, NOT docs/archived/archived/
    ok(result.stdout.includes('docs/archived-extras/archived/plan.md'), `expected correct archive path, got: ${result.stdout}`);
    ok(!result.stdout.includes('archived/archived/plan.md'), 'must not double-nest');
  });

  it('allows archiving when repo lives under a directory named like archiveDir', () => {
    // Create a temp dir whose path contains /archived/ (simulating a repo under an 'archived' parent)
    const parentDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-'));
    const archivedParent = path.join(parentDir, 'archived', 'myproject');
    mkdirSync(archivedParent, { recursive: true });
    tmpDir = archivedParent;

    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

    const docsDir = path.join(tmpDir, 'docs');
    mkdirSync(docsDir, { recursive: true });

    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const root = 'docs';
    `);

    const filePath = path.join(docsDir, 'plan.md');
    writeFileSync(filePath, '---\nstatus: active\nupdated: 2025-01-01\n---\n# Plan\n');
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'archive', filePath, '--dry-run', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });

    strictEqual(result.status, 0, `archive should succeed, stderr: ${result.stderr}`);
    ok(result.stdout.includes('docs/archived/plan.md'), `expected correct archive path, got: ${result.stdout}`);

    // Clean up parent
    rmSync(parentDir, { recursive: true, force: true });
    tmpDir = null;
  });
});
