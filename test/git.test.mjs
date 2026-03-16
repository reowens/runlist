import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { getGitLastModified, gitMv, gitDiffSince } from '../src/git.mjs';

let tmpDir;

function setupRepo() {
  tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dotmd-git-')));
  spawnSync('git', ['init'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
  return tmpDir;
}

function commitFile(filePath, content, dateStr) {
  writeFileSync(filePath, content);
  spawnSync('git', ['add', filePath], { cwd: tmpDir });
  const envVars = dateStr
    ? { ...process.env, GIT_AUTHOR_DATE: dateStr, GIT_COMMITTER_DATE: dateStr }
    : process.env;
  spawnSync('git', ['commit', '-m', `add ${path.basename(filePath)}`], {
    cwd: tmpDir,
    env: envVars,
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('getGitLastModified', () => {
  it('returns ISO date for a committed file', () => {
    setupRepo();
    const filePath = path.join(tmpDir, 'doc.md');
    commitFile(filePath, '# Test\n', '2024-06-15T12:00:00');
    const result = getGitLastModified('doc.md', tmpDir);
    ok(result, 'should return a date string');
    ok(result.startsWith('2024-06-15'), `expected date starting with 2024-06-15, got: ${result}`);
  });

  it('returns null for a file with no git history', () => {
    setupRepo();
    // Create an initial commit so the repo is valid
    const initFile = path.join(tmpDir, 'init.txt');
    commitFile(initFile, 'init\n');
    const result = getGitLastModified('nonexistent.md', tmpDir);
    strictEqual(result, null);
  });
});

describe('gitMv', () => {
  it('moves a tracked file successfully', () => {
    setupRepo();
    const filePath = path.join(tmpDir, 'original.md');
    commitFile(filePath, '# Original\n');
    const result = gitMv('original.md', 'renamed.md', tmpDir);
    strictEqual(result.status, 0, 'exit status should be 0');
  });

  it('returns non-zero status for non-existent source', () => {
    setupRepo();
    // Need at least one commit for a valid repo
    const initFile = path.join(tmpDir, 'init.txt');
    commitFile(initFile, 'init\n');
    const result = gitMv('does-not-exist.md', 'target.md', tmpDir);
    ok(result.status !== 0, 'should fail with non-zero exit');
    ok(result.stderr.length > 0, 'should have stderr output');
  });
});

describe('gitDiffSince', () => {
  it('returns diff output when file changed after sinceDate', () => {
    setupRepo();
    const filePath = path.join(tmpDir, 'changing.md');
    // First commit at Jan 10
    commitFile(filePath, '# Original\n', '2024-01-10T12:00:00');
    // Second commit at Jan 20 with changed content
    writeFileSync(filePath, '# Updated content\n');
    spawnSync('git', ['add', filePath], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'update changing'], {
      cwd: tmpDir,
      env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-20T12:00:00', GIT_COMMITTER_DATE: '2024-01-20T12:00:00' },
    });

    const result = gitDiffSince('changing.md', '2024-01-15', tmpDir);
    ok(result, 'should return diff output');
    ok(result.includes('Updated content') || result.includes('Original'), 'diff should contain file content');
  });

  it('returns null when no baseline commit found before sinceDate', () => {
    setupRepo();
    const filePath = path.join(tmpDir, 'recent.md');
    // Only commit is after the sinceDate
    commitFile(filePath, '# Recent\n', '2024-06-01T12:00:00');

    const result = gitDiffSince('recent.md', '2024-01-01', tmpDir);
    strictEqual(result, null, 'should return null when no baseline found');
  });

  it('supports --stat option', () => {
    setupRepo();
    const filePath = path.join(tmpDir, 'stat.md');
    commitFile(filePath, '# Before\n', '2024-01-10T12:00:00');
    writeFileSync(filePath, '# After\n');
    spawnSync('git', ['add', filePath], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'update stat'], {
      cwd: tmpDir,
      env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-20T12:00:00', GIT_COMMITTER_DATE: '2024-01-20T12:00:00' },
    });

    const result = gitDiffSince('stat.md', '2024-01-15', tmpDir, { stat: true });
    ok(result, 'should return stat output');
    ok(
      result.includes('changed') || result.includes('insertion') || result.includes('deletion'),
      `stat output should contain change summary, got: ${result}`
    );
  });
});
