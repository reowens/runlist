import { describe, it, afterEach } from 'node:test';
import { ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

function run(args) {
  return spawnSync('node', [BIN, ...args], {
    cwd: tmpDir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function setupProject() {
  tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dotmd-diff-')));

  spawnSync('git', ['init'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });

  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
    export const root = 'docs';
  `);

  return docsDir;
}

/**
 * Write a doc and commit it with a specific date.
 * dateStr should be like '2020-01-15T12:00:00'.
 */
function writeDocAt(docsDir, filename, fm, body, dateStr) {
  const p = path.join(docsDir, filename);
  writeFileSync(p, `---\n${fm}\n---\n${body}`);
  spawnSync('git', ['add', p], { cwd: tmpDir });
  spawnSync('git', ['commit', '-m', `add ${filename}`], {
    cwd: tmpDir,
    env: { ...process.env, GIT_AUTHOR_DATE: dateStr, GIT_COMMITTER_DATE: dateStr },
  });
  return p;
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('diff command', () => {
  it('shows diff for a single file with changes after updated date', () => {
    const docsDir = setupProject();
    // First commit: Jan 10 2024
    const filePath = writeDocAt(docsDir, 'plan.md',
      'status: active\nupdated: 2024-01-15', '# Plan\n\nOriginal content.\n',
      '2024-01-10T12:00:00');

    // Second commit: Jan 20 2024 (after updated date of Jan 15)
    writeFileSync(filePath, '---\nstatus: active\nupdated: 2024-01-15\n---\n# Plan\n\nUpdated content.\n');
    spawnSync('git', ['add', filePath], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'update plan'], {
      cwd: tmpDir,
      env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-20T12:00:00', GIT_COMMITTER_DATE: '2024-01-20T12:00:00' },
    });

    const result = run(['diff', filePath]);
    ok(result.stdout.includes('plan.md'), `shows filename, got: ${result.stdout}`);
    ok(result.stdout.includes('2024-01-15'), 'shows updated date');
    ok(result.stdout.includes('Updated content') || result.stdout.includes('Original content'), `shows diff content, got: ${result.stdout}`);
  });

  it('--stat shows stat format', () => {
    const docsDir = setupProject();
    const filePath = writeDocAt(docsDir, 'stat.md',
      'status: active\nupdated: 2024-01-15', '# Stat\n\nBefore.\n',
      '2024-01-10T12:00:00');

    writeFileSync(filePath, '---\nstatus: active\nupdated: 2024-01-15\n---\n# Stat\n\nAfter change.\n');
    spawnSync('git', ['add', filePath], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'update stat'], {
      cwd: tmpDir,
      env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-20T12:00:00', GIT_COMMITTER_DATE: '2024-01-20T12:00:00' },
    });

    const result = run(['diff', filePath, '--stat']);
    ok(result.stdout.includes('stat.md'), `shows filename, got: ${result.stdout}`);
    ok(result.stdout.includes('changed') || result.stdout.includes('insertion') || result.stdout.includes('deletion'), `stat output: ${result.stdout}`);
  });

  it('--since override works', () => {
    const docsDir = setupProject();
    // Create doc with a future updated date (no drift normally)
    const filePath = writeDocAt(docsDir, 'since.md',
      'status: active\nupdated: 2099-01-01', '# Since\n\nOriginal.\n',
      '2024-01-10T12:00:00');

    writeFileSync(filePath, '---\nstatus: active\nupdated: 2099-01-01\n---\n# Since\n\nChanged.\n');
    spawnSync('git', ['add', filePath], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'update since'], {
      cwd: tmpDir,
      env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-20T12:00:00', GIT_COMMITTER_DATE: '2024-01-20T12:00:00' },
    });

    // Use --since with date between the two commits
    const result = run(['diff', filePath, '--since', '2024-01-15']);
    ok(result.stdout.includes('since.md'), `shows filename, got: ${result.stdout}`);
    ok(result.stdout.includes('Changed') || result.stdout.includes('Original'), `shows diff with overridden date, got: ${result.stdout}`);
  });

  it('shows "No changes" when file has not changed since updated date', () => {
    const docsDir = setupProject();
    // Single commit, updated date is AFTER the commit — no later commits to diff
    writeDocAt(docsDir, 'clean.md',
      'status: active\nupdated: 2099-01-01', '# Clean\n',
      '2024-01-10T12:00:00');

    const result = run(['diff', 'docs/clean.md']);
    ok(result.stdout.includes('No changes since'), `reports no changes, got: ${result.stdout}`);
  });

  it('all-drifted-docs mode shows drifted files', () => {
    const docsDir = setupProject();
    // Commit config first
    spawnSync('git', ['add', path.join(tmpDir, 'dotmd.config.mjs')], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'add config'], {
      cwd: tmpDir,
      env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-05T12:00:00', GIT_COMMITTER_DATE: '2024-01-05T12:00:00' },
    });

    const filePath = writeDocAt(docsDir, 'drifted.md',
      'status: active\nupdated: 2024-01-15', '# Drifted\n\nOriginal.\n',
      '2024-01-10T12:00:00');

    writeFileSync(filePath, '---\nstatus: active\nupdated: 2024-01-15\n---\n# Drifted\n\nModified.\n');
    spawnSync('git', ['add', filePath], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'modify drifted'], {
      cwd: tmpDir,
      env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-20T12:00:00', GIT_COMMITTER_DATE: '2024-01-20T12:00:00' },
    });

    const result = run(['diff']);
    ok(result.stdout.includes('drifted.md'), `shows drifted doc, got: ${result.stdout}`);
    ok(result.stdout.includes('doc(s) with changes'), `shows summary header, got: ${result.stdout}`);
  });

  it('all-drifted-docs mode shows "No drifted docs" when none drifted', () => {
    const docsDir = setupProject();
    // Commit config
    spawnSync('git', ['add', path.join(tmpDir, 'dotmd.config.mjs')], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'add config'], {
      cwd: tmpDir,
      env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-05T12:00:00', GIT_COMMITTER_DATE: '2024-01-05T12:00:00' },
    });

    // Future updated date — no drift
    writeDocAt(docsDir, 'future.md',
      'status: active\nupdated: 2099-01-01', '# Future\n',
      '2024-01-10T12:00:00');

    const result = run(['diff']);
    ok(result.stdout.includes('No drifted docs'), `reports no drifted docs, got: ${result.stdout}`);
  });

  it('errors when file not found', () => {
    setupProject();
    const result = run(['diff', 'nonexistent.md']);
    ok(result.stderr.includes('File not found'), 'reports file not found');
  });
});
