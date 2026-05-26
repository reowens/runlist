import { describe, it, beforeEach, afterEach } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/config.mjs';
import { updateFrontmatter, writeFrontmatter } from '../src/lifecycle.mjs';

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

describe('writeFrontmatter', () => {
  it('prepends a fresh frontmatter block to a file without one', () => {
    // The bulk-tag flow needs to tag pre-existing markdown that never had
    // a frontmatter block. updateFrontmatter throws on that case; this
    // helper creates the block instead.
    const docsDir = setupProject();
    const filePath = path.join(docsDir, 'untagged.md');
    writeFileSync(filePath, '# Legacy doc\n\nSome body content.\n');

    writeFrontmatter(filePath, { type: 'doc', status: 'draft' });

    const content = readFileSync(filePath, 'utf8');
    ok(content.startsWith('---\n'), `expected leading frontmatter block; got:\n${content}`);
    ok(content.includes('type: doc'), 'type field written');
    ok(content.includes('status: draft'), 'status field written');
    ok(content.includes('# Legacy doc'), 'body preserved');
    ok(content.includes('Some body content.'), 'full body preserved');
  });

  it('delegates to updateFrontmatter when block already exists', () => {
    // Callers should be able to hand any file to writeFrontmatter without
    // pre-checking — when a block exists, behavior matches updateFrontmatter
    // (append-or-replace key by key).
    const docsDir = setupProject();
    const filePath = writeDoc(docsDir, 'tagged.md', 'type: doc', '# Already tagged\n');

    writeFrontmatter(filePath, { status: 'active' });

    const content = readFileSync(filePath, 'utf8');
    ok(content.includes('type: doc'), 'existing field preserved');
    ok(content.includes('status: active'), 'new field appended');
    // Should NOT double up the frontmatter block.
    const blockCount = (content.match(/^---$/gm) || []).length;
    strictEqual(blockCount, 2, `expected exactly 2 block markers (open + close); got ${blockCount}`);
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

  it('suggests close-match statuses on a typo (A3 follow-up)', async () => {
    const docsDir = setupProject();
    const filePath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# Plan\n');
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    // `planed` is one letter off `planned` — should suggest it.
    const result = spawnSync('node', [bin, 'status', filePath, 'planed', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });
    ok(result.status !== 0, 'should exit non-zero on invalid status');
    ok(result.stderr.includes('Invalid status: planed'), `got: ${result.stderr}`);
    ok(result.stderr.includes('Did you mean'), `expected suggestion, got: ${result.stderr}`);
    ok(result.stderr.includes('planned'), `expected 'planned' in suggestion, got: ${result.stderr}`);
  });

  it('omits Did-you-mean line when no close match exists', async () => {
    const docsDir = setupProject();
    const filePath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# Plan\n');
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'status', filePath, 'xyzzy', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });
    ok(result.status !== 0, 'should exit non-zero on invalid status');
    ok(!result.stderr.includes('Did you mean'),
      `should not suggest when nothing close, got: ${result.stderr}`);
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

// Regression for audit-example-project F1 (sites B+C): updateRefsFromMovedFile
// resolved refs only doc-relative. Repo-relative refs like `docs/foo/bar.md`
// got joined to the source's old dir, the resulting absolute didn't exist, and
// the rewrite silently skipped — leaving the moved file pointing at an
// incorrect relative path. Verify both ref-field and body-link rewrites work
// for repo-relative refs.
describe('archive ref rewriting for repo-relative refs', () => {
  // Source nested in docs/plans/, ref target lives in docs/journeys/ — pre-fix,
  // path.resolve(oldDir, 'docs/journeys/target.md') produced
  // docs/plans/docs/journeys/target.md (doubled), existsSync failed, rewrite
  // silently skipped. setupProject's single-root config archives docs/plans/X
  // to docs/archived/X, so the rewrite has to walk up to keep the ref valid.
  it('rewrites repo-relative ref-field entries when source moves across dirs', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'plans'), { recursive: true });
    mkdirSync(path.join(docsDir, 'journeys'), { recursive: true });

    writeDoc(docsDir, 'journeys/target.md', 'status: active\nupdated: 2025-01-01');
    writeDoc(docsDir, 'plans/source.md',
      'status: active\nupdated: 2025-01-01\nrelated_plans:\n  - docs/journeys/target.md',
      '# Source\n');

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'archive', path.join(docsDir, 'plans/source.md'),
      '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    // Find the archived file (single-root config → docs/archived/).
    const archivedPath = path.join(docsDir, 'archived', 'source.md');
    ok(existsSync(archivedPath), `archived file should exist at ${archivedPath}. stdout: ${result.stdout}`);
    const archivedContent = readFileSync(archivedPath, 'utf8');
    const refMatch = archivedContent.match(/related_plans:\n\s+-\s+(\S+)/);
    ok(refMatch, `expected ref-field entry in archived file:\n${archivedContent}`);
    const archivedDir = path.dirname(archivedPath);
    const resolved = path.resolve(archivedDir, refMatch[1]);
    ok(existsSync(resolved),
      `rewritten ref \`${refMatch[1]}\` must resolve from new dir to existing target. Resolved to: ${resolved}`);
  });

  it('rewrites repo-relative body links when source moves across dirs', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'plans'), { recursive: true });
    mkdirSync(path.join(docsDir, 'journeys'), { recursive: true });

    writeDoc(docsDir, 'journeys/target.md', 'status: active\nupdated: 2025-01-01');
    writeDoc(docsDir, 'plans/source.md',
      'status: active\nupdated: 2025-01-01',
      '# Source\n\nSee [target](docs/journeys/target.md) for details.\n');

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'archive', path.join(docsDir, 'plans/source.md'),
      '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const archivedPath = path.join(docsDir, 'archived', 'source.md');
    ok(existsSync(archivedPath), `archived file should exist at ${archivedPath}. stdout: ${result.stdout}`);
    const archivedContent = readFileSync(archivedPath, 'utf8');
    const linkMatch = archivedContent.match(/\[target\]\(([^)]+)\)/);
    ok(linkMatch, `expected body link in archived file:\n${archivedContent}`);
    const archivedDir = path.dirname(archivedPath);
    const resolved = path.resolve(archivedDir, linkMatch[1]);
    ok(existsSync(resolved),
      `rewritten body link \`${linkMatch[1]}\` must resolve. Resolved to: ${resolved}`);
  });
});

describe('archive collision (same basename twice)', () => {
  it('keeps the prior archive and suffixes the new one with a UTC timestamp', () => {
    const docsDir = setupProject();
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const cfg = path.join(tmpDir, 'dotmd.config.mjs');

    // Archive #1: docs/foo.md → docs/archived/foo.md
    writeDoc(docsDir, 'foo.md', 'status: active\nupdated: 2025-01-01', '# First\n');
    const r1 = spawnSync('node', [bin, 'archive', path.join(docsDir, 'foo.md'), '--config', cfg], { cwd: tmpDir, encoding: 'utf8' });
    strictEqual(r1.status, 0, `first archive failed: ${r1.stderr}`);
    ok(existsSync(path.join(docsDir, 'archived', 'foo.md')), 'first archive landed at archived/foo.md');

    // Archive #2: another docs/foo.md → should NOT clobber, should suffix
    writeDoc(docsDir, 'foo.md', 'status: active\nupdated: 2026-05-21', '# Refresh\n');
    const r2 = spawnSync('node', [bin, 'archive', path.join(docsDir, 'foo.md'), '--config', cfg], { cwd: tmpDir, encoding: 'utf8' });
    strictEqual(r2.status, 0, `second archive failed: ${r2.stderr}`);

    // Original archive untouched
    const original = readFileSync(path.join(docsDir, 'archived', 'foo.md'), 'utf8');
    ok(original.includes('# First'), 'prior archive body preserved');

    // A second file landed in archived/ with a timestamp-suffixed name
    const entries = readdirSync(path.join(docsDir, 'archived'));
    const suffixed = entries.filter(f => f !== 'foo.md' && /^foo-\d{8}T\d{6}Z\.md$/.test(f));
    strictEqual(suffixed.length, 1, `expected one timestamp-suffixed sibling, got entries: ${entries.join(', ')}`);

    const refreshed = readFileSync(path.join(docsDir, 'archived', suffixed[0]), 'utf8');
    ok(refreshed.includes('# Refresh'), 'second archive contains the refreshed body');

    // The CLI output should reference the suffixed path so the user can see the rename
    ok(r2.stdout.includes(suffixed[0]), `expected stdout to mention ${suffixed[0]}, got: ${r2.stdout}`);
  });
});

describe('pickup with leases', () => {
  function runCli(args, env = {}) {
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir,
      encoding: 'utf8',
      env: { ...process.env, ...env, PATH: process.env.PATH },
    });
  }

  it('writes a lease file when picking up an active plan', () => {
    const docsDir = setupProject();
    const filePath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# Plan\n');

    const result = runCli(['pickup', filePath], { CLAUDE_CODE_SESSION_ID: 'sess-A' });
    strictEqual(result.status, 0, `pickup should succeed: ${result.stderr}`);

    const leaseFile = path.join(tmpDir, '.dotmd', 'in-session.json');
    ok(existsSync(leaseFile), 'lease file should exist');
    const leases = JSON.parse(readFileSync(leaseFile, 'utf8'));
    const key = Object.keys(leases)[0];
    strictEqual(leases[key].session, 'sess-A');
    strictEqual(leases[key].oldStatus, 'active');

    const content = readFileSync(filePath, 'utf8');
    ok(content.includes('status: in-session'), 'frontmatter flipped');
  });

  it('same-session re-pickup is silent re-attach', () => {
    const docsDir = setupProject();
    const filePath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active', '# Plan body\n');

    runCli(['pickup', filePath], { CLAUDE_CODE_SESSION_ID: 'sess-A' });
    const second = runCli(['pickup', filePath], { CLAUDE_CODE_SESSION_ID: 'sess-A' });

    strictEqual(second.status, 0, `re-pickup should succeed: ${second.stderr}`);
    ok(second.stderr.includes('Re-attached'), 'should announce re-attach');
    ok(second.stdout.includes('Plan body'), 'still prints body');
  });

  it('cross-session pickup of a fresh lease blocks with --takeover suggestion', () => {
    const docsDir = setupProject();
    const filePath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active', '# Plan\n');

    runCli(['pickup', filePath], { CLAUDE_CODE_SESSION_ID: 'sess-A' });
    const second = runCli(['pickup', filePath], { CLAUDE_CODE_SESSION_ID: 'sess-B' });
    ok(second.status !== 0, 'should fail');
    ok(second.stderr.includes('Held by') || second.stderr.includes('--takeover'), `expected conflict message, got: ${second.stderr}`);
  });

  it('cross-session pickup of a >24h-old lease reports stale', () => {
    const docsDir = setupProject();
    const filePath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active', '# Plan\n');

    runCli(['pickup', filePath], { CLAUDE_CODE_SESSION_ID: 'sess-A' });
    const leaseFile = path.join(tmpDir, '.dotmd', 'in-session.json');
    const leases = JSON.parse(readFileSync(leaseFile, 'utf8'));
    const key = Object.keys(leases)[0];
    leases[key].pickedUpAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(leaseFile, JSON.stringify(leases, null, 2) + '\n');

    const second = runCli(['pickup', filePath], { CLAUDE_CODE_SESSION_ID: 'sess-B' });
    ok(second.status !== 0, 'should fail');
    ok(second.stderr.includes('Stale') || second.stderr.includes('>24h'), `expected stale message, got: ${second.stderr}`);
  });

  it('--takeover overrides a held lease and records takenOverFrom', () => {
    const docsDir = setupProject();
    const filePath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active', '# Plan\n');

    runCli(['pickup', filePath], { CLAUDE_CODE_SESSION_ID: 'sess-A' });

    const result = runCli(['pickup', filePath, '--takeover'], { CLAUDE_CODE_SESSION_ID: 'sess-B' });
    strictEqual(result.status, 0, `takeover should succeed: ${result.stderr}`);

    const leaseFile = path.join(tmpDir, '.dotmd', 'in-session.json');
    const after = JSON.parse(readFileSync(leaseFile, 'utf8'));
    const newKey = Object.keys(after)[0];
    strictEqual(after[newKey].session, 'sess-B');
    ok(after[newKey].takenOverFrom);
    strictEqual(after[newKey].takenOverFrom.session, 'sess-A');
  });
});

describe('unpickup', () => {
  function runCli(args, env = {}) {
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir,
      encoding: 'utf8',
      env: { ...process.env, ...env, PATH: process.env.PATH },
    });
  }

  it('no-arg releases all leases owned by current session', () => {
    const docsDir = setupProject();
    const a = writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active', '');
    const b = writeDoc(docsDir, 'b.md', 'type: plan\nstatus: planned', '');
    runCli(['pickup', a], { CLAUDE_CODE_SESSION_ID: 'sess-A' });
    runCli(['pickup', b], { CLAUDE_CODE_SESSION_ID: 'sess-A' });

    const result = runCli(['unpickup'], { CLAUDE_CODE_SESSION_ID: 'sess-A' });
    strictEqual(result.status, 0, `unpickup failed: ${result.stderr}`);

    const leaseFile = path.join(tmpDir, '.dotmd', 'in-session.json');
    ok(!existsSync(leaseFile), 'lease file should be gone (empty)');

    ok(readFileSync(a, 'utf8').includes('status: active'), 'a flipped to active');
    ok(readFileSync(b, 'utf8').includes('status: planned'), 'b flipped to planned (oldStatus)');
  });

  it('file arg releases that one', () => {
    const docsDir = setupProject();
    const a = writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active', '');
    const b = writeDoc(docsDir, 'b.md', 'type: plan\nstatus: active', '');
    runCli(['pickup', a], { CLAUDE_CODE_SESSION_ID: 'sess-A' });
    runCli(['pickup', b], { CLAUDE_CODE_SESSION_ID: 'sess-A' });

    runCli(['unpickup', a], { CLAUDE_CODE_SESSION_ID: 'sess-A' });

    const leases = JSON.parse(readFileSync(path.join(tmpDir, '.dotmd', 'in-session.json'), 'utf8'));
    strictEqual(Object.keys(leases).length, 1, 'only b remains');
  });

  it('--to overrides target status', () => {
    const docsDir = setupProject();
    const a = writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active', '');
    runCli(['pickup', a], { CLAUDE_CODE_SESSION_ID: 'sess-A' });
    runCli(['unpickup', '--to', 'planned'], { CLAUDE_CODE_SESSION_ID: 'sess-A' });
    ok(readFileSync(a, 'utf8').includes('status: planned'));
  });

  it('refuses cross-session release without --force', () => {
    const docsDir = setupProject();
    const a = writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active', '');
    runCli(['pickup', a], { CLAUDE_CODE_SESSION_ID: 'sess-A' });

    const result = runCli(['unpickup', a], { CLAUDE_CODE_SESSION_ID: 'sess-B' });
    ok(result.stderr.includes('Skipped') || result.stderr.includes('held by'), `expected refusal: ${result.stderr}`);

    // Lease still exists
    const leases = JSON.parse(readFileSync(path.join(tmpDir, '.dotmd', 'in-session.json'), 'utf8'));
    strictEqual(Object.keys(leases).length, 1, 'lease retained');
  });

  it('--stale releases stale leases regardless of session', () => {
    const docsDir = setupProject();
    const a = writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active', '');
    runCli(['pickup', a], { CLAUDE_CODE_SESSION_ID: 'sess-A' });

    // Forge an old pickedUpAt
    const leaseFile = path.join(tmpDir, '.dotmd', 'in-session.json');
    const leases = JSON.parse(readFileSync(leaseFile, 'utf8'));
    const key = Object.keys(leases)[0];
    leases[key].pickedUpAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(leaseFile, JSON.stringify(leases, null, 2) + '\n');

    const result = runCli(['unpickup', '--stale'], { CLAUDE_CODE_SESSION_ID: 'sess-B' });
    strictEqual(result.status, 0, `--stale failed: ${result.stderr}`);
    ok(!existsSync(leaseFile), 'stale lease cleared');
    ok(readFileSync(a, 'utf8').includes('status: active'));
  });

  it('--json returns released and skipped arrays', () => {
    const docsDir = setupProject();
    const a = writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active', '');
    runCli(['pickup', a], { CLAUDE_CODE_SESSION_ID: 'sess-A' });

    const result = runCli(['unpickup', '--json'], { CLAUDE_CODE_SESSION_ID: 'sess-A' });
    const parsed = JSON.parse(result.stdout);
    ok(Array.isArray(parsed.released));
    ok(Array.isArray(parsed.skipped));
    strictEqual(parsed.released.length, 1);
    strictEqual(parsed.released[0].newStatus, 'active');
  });

  it('manual-edit fallback warns + flips', () => {
    const docsDir = setupProject();
    // Manually create an in-session plan with NO lease
    const a = writeDoc(docsDir, 'a.md', 'type: plan\nstatus: in-session', '');

    const result = runCli(['unpickup', a, '--to', 'active'], { CLAUDE_CODE_SESSION_ID: 'sess-A' });
    strictEqual(result.status, 0, `should succeed: ${result.stderr}`);
    ok(result.stderr.includes('No lease found'), 'warns about missing lease');
    ok(readFileSync(a, 'utf8').includes('status: active'));
  });

  it('--dry-run does not mutate the lease file', () => {
    const docsDir = setupProject();
    const a = writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active', '');
    runCli(['pickup', a], { CLAUDE_CODE_SESSION_ID: 'sess-A' });

    runCli(['unpickup', '--dry-run'], { CLAUDE_CODE_SESSION_ID: 'sess-A' });

    const leases = JSON.parse(readFileSync(path.join(tmpDir, '.dotmd', 'in-session.json'), 'utf8'));
    strictEqual(Object.keys(leases).length, 1, 'lease retained');
    ok(readFileSync(a, 'utf8').includes('status: in-session'), 'frontmatter retained');
  });
});

describe('lease auto-release on lifecycle commands', () => {
  function runCli(args, env = {}) {
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir,
      encoding: 'utf8',
      env: { ...process.env, ...env, PATH: process.env.PATH },
    });
  }

  it('archive auto-releases the lease', () => {
    const docsDir = setupProject();
    const a = writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active', '# Plan\n');
    runCli(['pickup', a], { CLAUDE_CODE_SESSION_ID: 'sess-A' });

    const result = runCli(['archive', path.join(docsDir, 'a.md')], { CLAUDE_CODE_SESSION_ID: 'sess-A' });
    strictEqual(result.status, 0, `archive failed: ${result.stderr}`);

    const leaseFile = path.join(tmpDir, '.dotmd', 'in-session.json');
    ok(!existsSync(leaseFile), 'lease cleared by archive');
  });

  it('rename migrates the lease key', () => {
    const docsDir = setupProject();
    const a = writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active', '');
    runCli(['pickup', a], { CLAUDE_CODE_SESSION_ID: 'sess-A' });

    const result = runCli(['rename', a, 'renamed.md'], { CLAUDE_CODE_SESSION_ID: 'sess-A' });
    strictEqual(result.status, 0, `rename failed: ${result.stderr}`);

    const leases = JSON.parse(readFileSync(path.join(tmpDir, '.dotmd', 'in-session.json'), 'utf8'));
    const keys = Object.keys(leases);
    strictEqual(keys.length, 1);
    ok(keys[0].endsWith('renamed.md'), `expected renamed.md key, got ${keys[0]}`);
  });
});

describe('init writes .dotmd/ to .gitignore', () => {
  it('creates .gitignore with .dotmd/ when missing', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    spawnSync('node', [bin, 'init'], { cwd: tmpDir, encoding: 'utf8' });
    const gi = readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    ok(gi.includes('.dotmd/'), 'gitignore has .dotmd/');
  });

  it('appends .dotmd/ to an existing .gitignore', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n.env\n');
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    spawnSync('node', [bin, 'init'], { cwd: tmpDir, encoding: 'utf8' });
    const gi = readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    ok(gi.includes('node_modules/'), 'preserved existing entries');
    ok(gi.includes('.dotmd/'), 'appended .dotmd/');
  });

  it('does not duplicate .dotmd/ if already present', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    writeFileSync(path.join(tmpDir, '.gitignore'), '.dotmd/\n');
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    spawnSync('node', [bin, 'init'], { cwd: tmpDir, encoding: 'utf8' });
    const gi = readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    const matches = (gi.match(/\.dotmd\/$/gm) || []).length;
    strictEqual(matches, 1, 'only one .dotmd/ entry');
  });
});

describe('--no-index flag (issue #10 finding #3)', () => {
  // Concurrent-session repos doing path-limited commits don't want every
  // lifecycle verb to rewrite docs/plans/README.md — that pulls in other
  // agents' uncommitted index lines. `--no-index` lets the caller skip
  // regen and refresh later (or via commit hook).
  function setupWithIndex() {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-noidx-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    const docsDir = path.join(tmpDir, 'docs');
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(path.join(docsDir, 'archived'), { recursive: true });
    // Index file with generated-block markers.
    writeFileSync(path.join(docsDir, 'README.md'),
      '# Docs\n\n<!-- GENERATED:dotmd:start -->\n\n## Active\n\n| Doc | Status Snapshot |\n|-----|-----------------|\n| [Sentinel](sentinel.md) | sentinel-row-must-survive |\n\n<!-- GENERATED:dotmd:end -->\n');
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'),
      `export const root = 'docs';\nexport const index = { path: 'docs/README.md' };\n`);
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });
    return docsDir;
  }

  it('archive --no-index leaves docs/README.md untouched', () => {
    const docsDir = setupWithIndex();
    const filePath = writeDoc(docsDir, 'plan-x.md', 'type: plan\nstatus: active\nupdated: 2026-05-01', '# Plan X\n');
    const indexBefore = readFileSync(path.join(docsDir, 'README.md'), 'utf8');

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'archive', filePath, '--no-index', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const indexAfter = readFileSync(path.join(docsDir, 'README.md'), 'utf8');
    strictEqual(indexAfter, indexBefore, 'index file should be byte-identical');
    ok(result.stdout.includes('index not regenerated'), `expected skip-notice, got: ${result.stdout}`);
    // Sanity: the archive itself still happened.
    ok(existsSync(path.join(docsDir, 'archived', 'plan-x.md')), 'file was moved to archived');
  });

  it('archive (default) rewrites docs/README.md', () => {
    // Inverse: confirm we didn't accidentally make --no-index the new default.
    const docsDir = setupWithIndex();
    const filePath = writeDoc(docsDir, 'plan-y.md', 'type: plan\nstatus: active\nupdated: 2026-05-01', '# Plan Y\n');
    const indexBefore = readFileSync(path.join(docsDir, 'README.md'), 'utf8');

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'archive', filePath, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const indexAfter = readFileSync(path.join(docsDir, 'README.md'), 'utf8');
    ok(indexAfter !== indexBefore, 'default archive should rewrite the index');
    ok(result.stdout.includes('Index regenerated'), `expected regen confirmation, got: ${result.stdout}`);
  });

  it('status --no-index leaves docs/README.md untouched', () => {
    const docsDir = setupWithIndex();
    const filePath = writeDoc(docsDir, 'plan-z.md', 'type: plan\nstatus: active\nupdated: 2026-05-01', '# Plan Z\n');
    const indexBefore = readFileSync(path.join(docsDir, 'README.md'), 'utf8');

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'status', filePath, 'planned', '--no-index', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const indexAfter = readFileSync(path.join(docsDir, 'README.md'), 'utf8');
    strictEqual(indexAfter, indexBefore, 'index file should be byte-identical');
  });

  it('archive --show-files emits files footer naming touched paths', () => {
    const docsDir = setupWithIndex();
    const filePath = writeDoc(docsDir, 'showme.md', 'type: plan\nstatus: active\nupdated: 2026-05-01', '# Showme\n');

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'archive', filePath, '--show-files', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const footerMatch = result.stderr.match(/^files: (.+)$/m);
    ok(footerMatch, `expected 'files: …' footer in stderr, got: ${result.stderr}`);
    const files = footerMatch[1].split(' ');
    ok(files.includes('docs/showme.md'), `expected old path in footer: ${files.join(' ')}`);
    ok(files.includes('docs/archived/showme.md'), `expected new path in footer: ${files.join(' ')}`);
    ok(files.some(f => f.endsWith('README.md')), `expected index path in footer: ${files.join(' ')}`);
  });

  it('archive without --show-files does NOT emit files footer (default behavior)', () => {
    const docsDir = setupWithIndex();
    const filePath = writeDoc(docsDir, 'silentme.md', 'type: plan\nstatus: active\nupdated: 2026-05-01', '# Silentme\n');

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'archive', filePath, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!/^files: /m.test(result.stderr), `expected no files footer, got: ${result.stderr}`);
  });

  it('status --show-files names the doc + index', () => {
    const docsDir = setupWithIndex();
    const filePath = writeDoc(docsDir, 'flip.md', 'type: plan\nstatus: active\nupdated: 2026-05-01', '# Flip\n');

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'status', filePath, 'planned', '--show-files', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const footerMatch = result.stderr.match(/^files: (.+)$/m);
    ok(footerMatch, `expected files footer, got: ${result.stderr}`);
    const files = footerMatch[1].split(' ');
    ok(files.includes('docs/flip.md'), `expected doc in footer: ${files.join(' ')}`);
    ok(files.some(f => f.endsWith('README.md')), `expected index in footer: ${files.join(' ')}`);
  });

  it('status --show-files --no-index does not include the index in the footer', () => {
    const docsDir = setupWithIndex();
    const filePath = writeDoc(docsDir, 'skiponly.md', 'type: plan\nstatus: active\nupdated: 2026-05-01', '# Skip\n');

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'status', filePath, 'planned', '--show-files', '--no-index', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const footerMatch = result.stderr.match(/^files: (.+)$/m);
    ok(footerMatch, `expected files footer, got: ${result.stderr}`);
    const files = footerMatch[1].split(' ');
    ok(files.includes('docs/skiponly.md'), `expected doc in footer: ${files.join(' ')}`);
    ok(!files.some(f => f.endsWith('README.md')), `index should NOT be in footer when --no-index: ${files.join(' ')}`);
  });

  it('new --show-files names the new doc + index', () => {
    const docsDir = setupWithIndex();

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'new', 'doc', 'fresh-doc', '--show-files', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const footerMatch = result.stderr.match(/^files: (.+)$/m);
    ok(footerMatch, `expected files footer, got: ${result.stderr}`);
    const files = footerMatch[1].split(' ');
    ok(files.some(f => f.includes('fresh-doc.md')), `expected new doc in footer: ${files.join(' ')}`);
    ok(files.some(f => f.endsWith('README.md')), `expected index in footer: ${files.join(' ')}`);
  });

  it('preserves sibling agent\'s uncommitted index edits across an archive', () => {
    // Concurrent scenario: agent A made an uncommitted change to docs/README.md
    // (a line for some other plan). Agent B runs `dotmd archive plan-b --no-index`.
    // B's archive must NOT touch A's uncommitted edit.
    const docsDir = setupWithIndex();
    const filePath = writeDoc(docsDir, 'plan-b.md', 'type: plan\nstatus: active\nupdated: 2026-05-01', '# Plan B\n');

    // Simulate agent A's uncommitted edit (the "sentinel-row-must-survive" row).
    const readmePath = path.join(docsDir, 'README.md');
    const tampered = readFileSync(readmePath, 'utf8').replace('sentinel-row-must-survive', 'AGENT_A_UNCOMMITTED_EDIT');
    writeFileSync(readmePath, tampered);

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'archive', filePath, '--no-index', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const after = readFileSync(readmePath, 'utf8');
    ok(after.includes('AGENT_A_UNCOMMITTED_EDIT'), `agent A's edit must survive — got: ${after}`);
  });
});
