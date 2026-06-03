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

  it('previews onArchive hook fire when hook is configured (issue #10 finding #11)', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-life-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    const docsDir = path.join(tmpDir, 'docs');
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(path.join(docsDir, 'archived'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const root = 'docs';
      export function onArchive() {}
    `);
    const filePath = writeDoc(docsDir, 'has-hook.md', 'status: active\nupdated: 2025-01-01', '# x');

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'archive', filePath, '--dry-run', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });
    strictEqual(result.status, 0, result.stderr);
    ok(result.stdout.includes('Would fire hook: onArchive'), `expected hook preview, got:\n${result.stdout}`);
  });
});

describe('archive --closeout-template (issue #10 finding #5)', () => {
  it('injects skeleton when plan body lacks `## Closeout`', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'ship-it.md',
      'type: plan\nstatus: active\nupdated: 2026-05-26',
      '# Ship It\n\n## Problem\nBody.\n\n## Version History\n- 2026-05-26 created.\n');
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node',
      [bin, 'archive', path.join(docsDir, 'ship-it.md'), '--closeout-template', '--config', path.join(tmpDir, 'dotmd.config.mjs')],
      { cwd: tmpDir, encoding: 'utf8' });
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Injected `## Closeout`'), `expected injection hint; got: ${result.stdout}`);

    const archived = readFileSync(path.join(docsDir, 'archived', 'ship-it.md'), 'utf8');
    ok(archived.includes('## Closeout'), 'archived file has Closeout section');
    ok(archived.includes('**Outcomes:**'), 'skeleton has Outcomes bullet');
    ok(archived.includes('**Key commits:**'), 'skeleton has Key commits bullet');
    ok(archived.includes('**Deferrals:**'), 'skeleton has Deferrals bullet');
    // Placement: Closeout sits ABOVE Version History.
    ok(archived.indexOf('## Closeout') < archived.indexOf('## Version History'),
      `Closeout should land above Version History; got:\n${archived}`);
  });

  it('is a no-op when `## Closeout` already exists', () => {
    const docsDir = setupProject();
    const originalCloseout = '## Closeout\n\nShipped as 0.39.5. Custom hand-written prose.\n';
    writeDoc(docsDir, 'already.md',
      'type: plan\nstatus: active\nupdated: 2026-05-26',
      `# Already\n\n${originalCloseout}\n## Version History\n- 2026-05-26 created.\n`);
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node',
      [bin, 'archive', path.join(docsDir, 'already.md'), '--closeout-template', '--config', path.join(tmpDir, 'dotmd.config.mjs')],
      { cwd: tmpDir, encoding: 'utf8' });
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('already present'), `expected idempotent hint; got: ${result.stdout}`);

    const archived = readFileSync(path.join(docsDir, 'archived', 'already.md'), 'utf8');
    // Hand-written closeout preserved verbatim — skeleton NOT prepended.
    ok(archived.includes('Custom hand-written prose'), 'original closeout body preserved');
    ok(!archived.includes('**Outcomes:**'), 'skeleton bullets NOT injected');
    // Only one `## Closeout` heading in the file.
    const occurrences = (archived.match(/^##\s+Closeout\s*$/gm) || []).length;
    strictEqual(occurrences, 1, 'exactly one Closeout heading');
  });

  it('falls back to end-of-body when no Version History section exists', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'no-vh.md',
      'type: plan\nstatus: active\nupdated: 2026-05-26',
      '# No VH\n\n## Problem\nBody.\n');
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node',
      [bin, 'archive', path.join(docsDir, 'no-vh.md'), '--closeout-template', '--config', path.join(tmpDir, 'dotmd.config.mjs')],
      { cwd: tmpDir, encoding: 'utf8' });
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const archived = readFileSync(path.join(docsDir, 'archived', 'no-vh.md'), 'utf8');
    ok(archived.includes('## Closeout'), 'has Closeout section');
    // Closeout is the LAST H2 in the body.
    const lastH2 = archived.match(/^##\s+(.+)$/gm).pop();
    ok(lastH2.includes('Closeout'), `Closeout should be the trailing H2; last H2 was: ${lastH2}`);
  });

  it('--dry-run previews the injection without writing', () => {
    const docsDir = setupProject();
    const filePath = writeDoc(docsDir, 'preview.md',
      'type: plan\nstatus: active\nupdated: 2026-05-26',
      '# Preview\n\n## Problem\nBody.\n');
    const before = readFileSync(filePath, 'utf8');
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node',
      [bin, 'archive', filePath, '--closeout-template', '--dry-run', '--config', path.join(tmpDir, 'dotmd.config.mjs')],
      { cwd: tmpDir, encoding: 'utf8' });
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Would inject `## Closeout`'), `expected dry-run preview line; got: ${result.stdout}`);
    const after = readFileSync(filePath, 'utf8');
    strictEqual(after, before, 'file is byte-identical in dry-run');
  });

  it('plain `dotmd archive` (no flag) does NOT inject — back-compat', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'no-flag.md',
      'type: plan\nstatus: active\nupdated: 2026-05-26',
      '# No Flag\n\n## Problem\nBody.\n');
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node',
      [bin, 'archive', path.join(docsDir, 'no-flag.md'), '--config', path.join(tmpDir, 'dotmd.config.mjs')],
      { cwd: tmpDir, encoding: 'utf8' });
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const archived = readFileSync(path.join(docsDir, 'archived', 'no-flag.md'), 'utf8');
    ok(!archived.includes('## Closeout'), 'no Closeout injected without --closeout-template');
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
  it('keeps the prior archive and suffixes the new one with a numeric counter', () => {
    // 0.39.5 (issue #10 finding #6): collisions used to land at
    // `foo-20260526T224855Z.md`. The non-deterministic timestamp made it
    // hard to cross-reference re-archived prompts/plans, especially for
    // agents reusing slugs like `resume-foo`. Now collisions deterministically
    // get `foo-2.md`, `foo-3.md`, … — readable + sortable + predictable.
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

    // Second archive deterministically lands at foo-2.md.
    const refreshedPath = path.join(docsDir, 'archived', 'foo-2.md');
    ok(existsSync(refreshedPath), `expected archived/foo-2.md, got entries: ${readdirSync(path.join(docsDir, 'archived')).join(', ')}`);
    const refreshed = readFileSync(refreshedPath, 'utf8');
    ok(refreshed.includes('# Refresh'), 'second archive contains the refreshed body');

    // No timestamp-suffixed siblings exist.
    const entries = readdirSync(path.join(docsDir, 'archived'));
    const stamped = entries.filter(f => /-\d{8}T\d{6}Z\.md$/.test(f));
    strictEqual(stamped.length, 0, `no timestamp-suffixed siblings; got: ${entries.join(', ')}`);

    // The CLI output should reference foo-2.md so the user can see the rename.
    ok(r2.stdout.includes('foo-2.md'), `expected stdout to mention foo-2.md, got: ${r2.stdout}`);

    // Archive #3: third collision lands at foo-3.md.
    writeDoc(docsDir, 'foo.md', 'status: active\nupdated: 2026-05-22', '# Third\n');
    const r3 = spawnSync('node', [bin, 'archive', path.join(docsDir, 'foo.md'), '--config', cfg], { cwd: tmpDir, encoding: 'utf8' });
    strictEqual(r3.status, 0, `third archive failed: ${r3.stderr}`);
    ok(existsSync(path.join(docsDir, 'archived', 'foo-3.md')), 'third archive lands at foo-3.md');
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

describe('dotmd set — status write', () => {
  function runCli(args, env = {}) {
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir,
      encoding: 'utf8',
      env: { ...process.env, ...env, PATH: process.env.PATH },
    });
  }

  it('archive transition: `dotmd set archived <f>` moves file and updates refs', () => {
    const docsDir = setupProject();
    const filePath = writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# A\n');

    const result = runCli(['set', 'archived', filePath]);
    strictEqual(result.status, 0, `set archived should succeed: ${result.stderr}`);
    ok(existsSync(path.join(docsDir, 'archived', 'a.md')), 'file moved to archive dir');
    ok(!existsSync(filePath), 'original location should be empty');
  });

  it('requires an explicit <path>', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# A\n');

    const result = runCli(['set', 'partial']);
    ok(result.status !== 0, 'should fail');
    ok(/Usage: dotmd set/.test(result.stderr), `expected usage error, got: ${result.stderr}`);
  });

  it('`set in-session <file>` writes the status without any lease file', () => {
    const docsDir = setupProject();
    const filePath = writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# A\n');

    const result = runCli(['set', 'in-session', filePath]);
    strictEqual(result.status, 0, `set in-session failed: ${result.stderr}`);
    const content = readFileSync(filePath, 'utf8');
    ok(/status: in-session/.test(content), `frontmatter should flip to in-session: ${content}`);
    ok(!existsSync(path.join(tmpDir, '.dotmd', 'in-session.json')), 'no lease file should be written');
  });

  it('rejects an invalid status with suggestion', () => {
    const docsDir = setupProject();
    const filePath = writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# A\n');

    const result = runCli(['set', 'fnord', filePath]);
    ok(result.status !== 0, 'should fail');
    ok(/Invalid status/.test(result.stderr), `expected validation error, got: ${result.stderr}`);
  });

  it('plain transition writes the new status to frontmatter', () => {
    const docsDir = setupProject();
    const filePath = writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# A\n');

    const result = runCli(['set', 'partial', filePath]);
    strictEqual(result.status, 0, `set should succeed: ${result.stderr}`);
    const content = readFileSync(filePath, 'utf8');
    ok(content.includes('status: partial'));
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

describe('type-aware archive destination (lifecycle.archiveNestedTypes)', () => {
  const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
  function cli(args) {
    return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8', env: { ...process.env, PATH: process.env.PATH },
    });
  }
  function setupTyped(configBody = `export const root = 'docs';`) {
    setupProject();
    mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
    mkdirSync(path.join(tmpDir, 'docs', 'prompts'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), configBody);
    const mk = (rel, fm) => {
      const p = path.join(tmpDir, 'docs', rel);
      writeFileSync(p, `---\n${fm}\n---\n# body\n`);
      spawnSync('git', ['add', p], { cwd: tmpDir });
      spawnSync('git', ['commit', '-qm', `add ${rel}`], { cwd: tmpDir });
      return p;
    };
    return mk;
  }

  it('archives a prompt under docs/prompts/archived/ by default', () => {
    const mk = setupTyped();
    mk('prompts/r.md', 'type: prompt\nstatus: pending');
    const r = cli(['archive', 'docs/prompts/r.md']);
    strictEqual(r.status, 0, r.stderr);
    ok(existsSync(path.join(tmpDir, 'docs', 'prompts', 'archived', 'r.md')), 'prompt nested under prompts/archived');
    ok(!existsSync(path.join(tmpDir, 'docs', 'archived', 'r.md')), 'prompt NOT in shared archive');
  });

  it('keeps plans in the shared docs/archived/', () => {
    const mk = setupTyped();
    mk('plans/p.md', 'type: plan\nstatus: active');
    const r = cli(['archive', 'docs/plans/p.md']);
    strictEqual(r.status, 0, r.stderr);
    ok(existsSync(path.join(tmpDir, 'docs', 'archived', 'p.md')), 'plan in shared archive');
    ok(!existsSync(path.join(tmpDir, 'docs', 'plans', 'archived', 'p.md')), 'plan NOT nested');
  });

  it('`set archived` and `archive` agree on the nested prompt destination', () => {
    const mk = setupTyped();
    mk('prompts/s.md', 'type: prompt\nstatus: pending');
    const r = cli(['set', 'archived', 'docs/prompts/s.md']);
    strictEqual(r.status, 0, r.stderr);
    ok(existsSync(path.join(tmpDir, 'docs', 'prompts', 'archived', 's.md')), 'set archived nests like archive');
  });

  it('is configurable — empty archiveNestedTypes sends prompts to the shared archive', () => {
    const mk = setupTyped(`export const root = 'docs';\nexport const lifecycle = { archiveNestedTypes: [] };`);
    mk('prompts/r.md', 'type: prompt\nstatus: pending');
    const r = cli(['archive', 'docs/prompts/r.md']);
    strictEqual(r.status, 0, r.stderr);
    ok(existsSync(path.join(tmpDir, 'docs', 'archived', 'r.md')), 'opt-out sends prompt to shared archive');
    ok(!existsSync(path.join(tmpDir, 'docs', 'prompts', 'archived', 'r.md')), 'not nested when opted out');
  });
});
