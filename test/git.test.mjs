import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { getGitLastModified, getGitLastModifiedBatch, gitMv, gitDiffSince, inspectGitCommandPaths } from '../src/git.mjs';
import { checkGitStaleness } from '../src/validate.mjs';
import { filterDocs } from '../src/query.mjs';

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

describe('getGitLastModifiedBatch', () => {
  it('scopes history and returned dates to the requested managed paths', () => {
    setupRepo();
    commitFile(path.join(tmpDir, 'managed.md'), '# Managed\n', '2024-01-10T12:00:00Z');
    commitFile(path.join(tmpDir, 'unrelated.txt'), 'noise\n', '2025-01-10T12:00:00Z');

    const result = getGitLastModifiedBatch(tmpDir, ['managed.md']);
    strictEqual(result.complete, true);
    strictEqual(result.reason, null);
    strictEqual(result.dates.size, 1);
    ok(result.dates.get('managed.md').startsWith('2024-01-10'));
    strictEqual(result.dates.has('unrelated.txt'), false);
  });

  it('uses broader scan pathspecs while returning only exact requested paths', () => {
    setupRepo();
    mkdirSync(path.join(tmpDir, 'docs'));
    commitFile(path.join(tmpDir, 'docs', 'requested.md'), '# Requested\n', '2024-01-10T12:00:00Z');
    commitFile(path.join(tmpDir, 'docs', 'sibling.md'), '# Sibling\n', '2025-01-10T12:00:00Z');

    const result = getGitLastModifiedBatch(tmpDir, ['docs/requested.md'], { pathspecs: ['docs'] });
    strictEqual(result.complete, true);
    strictEqual(result.dates.size, 1);
    ok(result.dates.get('docs/requested.md').startsWith('2024-01-10'));
    strictEqual(result.dates.has('docs/sibling.md'), false);
  });

  it('does not spend the commit limit on history outside the requested paths', () => {
    setupRepo();
    commitFile(path.join(tmpDir, 'managed.md'), '# Managed\n', '2024-01-10T12:00:00Z');
    for (let i = 0; i < 3; i++) {
      commitFile(path.join(tmpDir, `unrelated-${i}.txt`), `${i}\n`, `2025-01-0${i + 1}T12:00:00Z`);
    }

    const result = getGitLastModifiedBatch(tmpDir, ['managed.md'], { maxCommits: 1 });
    strictEqual(result.complete, true);
    ok(result.dates.get('managed.md').startsWith('2024-01-10'));
  });

  it('treats requested filenames as literal paths, not Git pathspecs', () => {
    setupRepo();
    mkdirSync(path.join(tmpDir, 'docs'));
    commitFile(path.join(tmpDir, 'docs', 'glob*.md'), '# Literal\n', '2024-01-10T12:00:00Z');
    commitFile(path.join(tmpDir, 'docs', 'glob-noise.md'), '# Noise\n', '2025-01-10T12:00:00Z');

    const result = getGitLastModifiedBatch(tmpDir, ['docs/glob*.md'], { maxCommits: 1 });
    strictEqual(result.complete, true);
    ok(result.dates.get('docs/glob*.md').startsWith('2024-01-10'));
  });

  it('does not spend the commit limit on excluded docs inside a broad scan root', () => {
    setupRepo();
    const docsDir = path.join(tmpDir, 'docs');
    mkdirSync(docsDir);
    commitFile(path.join(docsDir, 'active.md'), '# Active\n', '2024-01-10T12:00:00Z');
    commitFile(path.join(docsDir, 'archived.md'), '# Archived\n', '2025-01-10T12:00:00Z');

    const warnings = checkGitStaleness([
      { path: 'docs/active.md', status: 'active', updated: '2020-01-01' },
      { path: 'docs/archived.md', status: 'archived', updated: '2020-01-01' },
    ], {
      repoRoot: tmpDir,
      docsRoot: docsDir,
      docsRoots: [docsDir],
      lifecycle: { skipStaleFor: new Set(['archived']) },
    }, { maxCommits: 1 });

    strictEqual(warnings.filter(warning => warning.message.includes('behind git history')).length, 1);
    strictEqual(warnings.filter(warning => warning.message.includes('Git metadata is incomplete')).length, 0);
  });

  it('returns known dates and explicit metadata when the commit limit is reached', () => {
    setupRepo();
    commitFile(path.join(tmpDir, 'oldest.md'), '# Oldest\n', '2024-01-01T12:00:00Z');
    commitFile(path.join(tmpDir, 'middle.md'), '# Middle\n', '2024-02-01T12:00:00Z');
    commitFile(path.join(tmpDir, 'newest.md'), '# Newest\n', '2024-03-01T12:00:00Z');

    const result = getGitLastModifiedBatch(tmpDir, ['oldest.md', 'middle.md', 'newest.md'], { maxCommits: 2 });
    strictEqual(result.complete, false);
    strictEqual(result.reason, 'commit-limit');
    ok(result.dates.has('newest.md'));
    ok(result.dates.has('middle.md'));
    strictEqual(result.dates.has('oldest.md'), false);
  });

  it('keeps the incomplete-history warning when no known date is a drift candidate', () => {
    setupRepo();
    commitFile(path.join(tmpDir, 'oldest.md'), '# Oldest\n', '2024-01-01T12:00:00Z');
    commitFile(path.join(tmpDir, 'middle.md'), '# Middle\n', '2024-02-01T12:00:00Z');
    commitFile(path.join(tmpDir, 'newest.md'), '# Newest\n', '2024-03-01T12:00:00Z');

    const warnings = checkGitStaleness([
      { path: 'oldest.md', status: 'active', updated: '2025-01-01' },
      { path: 'middle.md', status: 'active', updated: '2024-02-01' },
      { path: 'newest.md', status: 'active', updated: '2024-03-01' },
    ], {
      repoRoot: tmpDir,
      docsRoot: tmpDir,
      docsRoots: [tmpDir],
      lifecycle: { skipStaleFor: new Set() },
    }, { maxCommits: 2 });

    strictEqual(warnings.filter(warning => warning.message.includes('behind git history')).length, 0);
    strictEqual(warnings.filter(warning => warning.message.includes('Git metadata is incomplete')).length, 1);
  });

  it('reports output truncation instead of silently returning an empty map', () => {
    setupRepo();
    const filePath = path.join(tmpDir, 'repeated.md');
    commitFile(filePath, '# 0\n', '2024-01-01T12:00:00Z');
    for (let i = 1; i <= 4; i++) {
      commitFile(filePath, `# ${i}\n`, `2024-01-0${i + 1}T12:00:00Z`);
    }

    const result = getGitLastModifiedBatch(tmpDir, ['repeated.md'], { maxBuffer: 64 });
    strictEqual(result.complete, false);
    strictEqual(result.reason, 'output-limit');
  });

  it('treats a non-Git directory as gracefully empty history', () => {
    tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dotmd-no-git-')));
    const result = getGitLastModifiedBatch(tmpDir, ['doc.md']);
    strictEqual(result.complete, true);
    strictEqual(result.reason, null);
    strictEqual(result.dates.size, 0);
  });

  it('does not report partial history once the requested latest date is resolved', () => {
    setupRepo();
    const filePath = path.join(tmpDir, 'doc.md');
    commitFile(filePath, '# First\n', '2024-01-01T12:00:00Z');
    commitFile(filePath, '# Latest\n', '2025-01-01T12:00:00Z');
    const docsRoot = tmpDir;
    const warnings = checkGitStaleness([
      { path: 'doc.md', status: 'active', updated: '2020-01-01' },
    ], {
      repoRoot: tmpDir,
      docsRoot,
      lifecycle: { skipStaleFor: new Set() },
    }, { maxCommits: 1 });

    strictEqual(warnings.filter(warning => warning.message.includes('behind git history')).length, 1);
    strictEqual(warnings.filter(warning => warning.message.includes('Git metadata is incomplete')).length, 0);
  });

  it('ignores a later commit that only synchronized the updated line', () => {
    setupRepo();
    const filePath = path.join(tmpDir, 'doc.md');
    commitFile(filePath, '---\nupdated: 2024-01-01\n---\n# Doc\n', '2024-01-01T12:00:00Z');
    commitFile(filePath, '---\nupdated: 2024-01-01\n---\n# Doc\n\nSubstantive edit.\n', '2024-02-01T12:00:00Z');
    commitFile(filePath, '---\nupdated: 2024-02-01\n---\n# Doc\n\nSubstantive edit.\n', '2024-03-01T12:00:00Z');

    const warnings = checkGitStaleness([
      { path: 'doc.md', status: 'active', updated: '2024-02-01' },
    ], {
      repoRoot: tmpDir,
      docsRoot: tmpDir,
      docsRoots: [tmpDir],
      lifecycle: { skipStaleFor: new Set() },
    });

    strictEqual(warnings.filter(warning => warning.message.includes('behind git history')).length, 0);
  });

  it('reports incomplete substantive history instead of walking beyond the commit bound', () => {
    setupRepo();
    const filePath = path.join(tmpDir, 'doc.md');
    commitFile(filePath, '---\nupdated: 2024-01-01\n---\n# Doc\n', '2024-01-01T12:00:00Z');
    commitFile(filePath, '---\nupdated: "2024-01-01"\n---\n# Doc\n', '2024-02-01T12:00:00Z');

    const warnings = checkGitStaleness([
      { path: 'doc.md', status: 'active', updated: '2024-01-01' },
    ], {
      repoRoot: tmpDir,
      docsRoot: tmpDir,
      docsRoots: [tmpDir],
      lifecycle: { skipStaleFor: new Set() },
    }, { maxCommits: 1 });

    strictEqual(warnings.filter(warning => warning.message.includes('behind git history')).length, 0);
    strictEqual(warnings.filter(warning => warning.message.includes('Git metadata is incomplete')).length, 1);
  });

  it('ignores consecutive metadata-only commits that update multiple files', () => {
    setupRepo();
    const files = ['a.md', 'b.md'].map(name => path.join(tmpDir, name));
    for (const filePath of files) writeFileSync(filePath, '---\nupdated: 2024-01-01\n---\n# Doc\n');
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'initial'], {
      cwd: tmpDir,
      env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-01T12:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T12:00:00Z' },
    });
    for (const filePath of files) writeFileSync(filePath, '---\nupdated: 2024-01-01\n---\n# Doc\n\nSubstantive edit.\n');
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'substantive'], {
      cwd: tmpDir,
      env: { ...process.env, GIT_AUTHOR_DATE: '2024-02-01T12:00:00Z', GIT_COMMITTER_DATE: '2024-02-01T12:00:00Z' },
    });
    for (const filePath of files) writeFileSync(filePath, '---\nupdated: 2024-02-01\n---\n# Doc\n\nSubstantive edit.\n');
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'sync dates'], {
      cwd: tmpDir,
      env: { ...process.env, GIT_AUTHOR_DATE: '2024-03-01T12:00:00Z', GIT_COMMITTER_DATE: '2024-03-01T12:00:00Z' },
    });
    for (const filePath of files) writeFileSync(filePath, '---\nupdated: "2024-02-01"\n---\n# Doc\n\nSubstantive edit.\n');
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'normalize dates'], {
      cwd: tmpDir,
      env: { ...process.env, GIT_AUTHOR_DATE: '2024-04-01T12:00:00Z', GIT_COMMITTER_DATE: '2024-04-01T12:00:00Z' },
    });

    const warnings = checkGitStaleness(
      ['a.md', 'b.md'].map(filePath => ({ path: filePath, status: 'active', updated: '2024-02-01' })),
      {
        repoRoot: tmpDir,
        docsRoot: tmpDir,
        docsRoots: [tmpDir],
        lifecycle: { skipStaleFor: new Set() },
      },
    );

    strictEqual(warnings.filter(warning => warning.message.includes('behind git history')).length, 0);
  });

  it('keeps date drift when the latest commit changed content as well as updated', () => {
    setupRepo();
    const filePath = path.join(tmpDir, 'doc.md');
    commitFile(filePath, '---\nupdated: 2024-01-01\n---\n# Doc\n', '2024-01-01T12:00:00Z');
    commitFile(filePath, '---\nupdated: 2024-02-01\n---\n# Renamed Doc\n', '2024-03-01T12:00:00Z');

    const warnings = checkGitStaleness([
      { path: 'doc.md', status: 'active', updated: '2024-02-01' },
    ], {
      repoRoot: tmpDir,
      docsRoot: tmpDir,
      docsRoots: [tmpDir],
      lifecycle: { skipStaleFor: new Set() },
    });

    strictEqual(warnings.filter(warning => warning.message.includes('behind git history')).length, 1);
  });

  it('uses known dates without a partial-history warning once the latest date is resolved', () => {
    setupRepo();
    const filePath = path.join(tmpDir, 'doc.md');
    commitFile(filePath, '# First\n', '2024-01-01T12:00:00Z');
    commitFile(filePath, '# Latest\n', '2025-01-01T12:00:00Z');
    const doc = { path: 'doc.md', status: 'active', updated: '2020-01-01', daysSinceUpdate: 1, isStale: false };
    let stderr = '';
    const originalWrite = process.stderr.write;
    process.stderr.write = chunk => { stderr += String(chunk); return true; };
    try {
      const result = filterDocs([doc], { git: true, sort: 'updated', all: true, limit: 10 }, {
        repoRoot: tmpDir,
        raw: {},
        staleDaysByStatus: { active: 14 },
      }, { maxCommits: 1 });
      strictEqual(result.length, 1);
      ok(result[0].daysSinceUpdate > 1, 'known Git date replaces the frontmatter age');
    } finally {
      process.stderr.write = originalWrite;
    }
    strictEqual((stderr.match(/Git metadata is incomplete/g) ?? []).length, 0);
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

  it('falls back to fs.renameSync for an untracked source', () => {
    setupRepo();
    // One commit so the repo is valid, then a scratch file we never `git add`.
    commitFile(path.join(tmpDir, 'init.txt'), 'init\n');
    const sourcePath = path.join(tmpDir, 'untracked.md');
    writeFileSync(sourcePath, '# Untracked\n');

    const targetPath = path.join(tmpDir, 'archived', 'untracked.md');
    mkdirSync(path.dirname(targetPath), { recursive: true });
    const result = gitMv(sourcePath, targetPath, tmpDir);

    strictEqual(result.status, 0, `should succeed via fs fallback; stderr: ${result.stderr}`);
    ok(existsSync(targetPath), 'target should exist after fallback rename');
    ok(!existsSync(sourcePath), 'source should be gone after move');
  });

  it('works with absolute paths for both tracked and untracked sources', () => {
    setupRepo();
    const trackedPath = path.join(tmpDir, 'tracked.md');
    commitFile(trackedPath, '# Tracked\n');
    const trackedTarget = path.join(tmpDir, 'tracked-moved.md');
    const trackedResult = gitMv(trackedPath, trackedTarget, tmpDir);
    strictEqual(trackedResult.status, 0, `tracked move should succeed; stderr: ${trackedResult.stderr}`);
    ok(existsSync(trackedTarget), 'tracked target should exist');
  });

  it('moves an untracked file even outside any git repo', () => {
    // No git init — just a plain temp dir. gitMv should still move the file
    // because `ls-files` reports "not tracked" and the fs fallback kicks in.
    const plainDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dotmd-plain-')));
    try {
      const sourcePath = path.join(plainDir, 'orphan.md');
      writeFileSync(sourcePath, '# Orphan\n');
      const targetPath = path.join(plainDir, 'moved.md');
      const result = gitMv(sourcePath, targetPath, plainDir);
      strictEqual(result.status, 0, `should succeed in non-repo; stderr: ${result.stderr}`);
      ok(existsSync(targetPath), 'target should exist');
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
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

describe('inspectGitCommandPaths', () => {
  it('finds add-eligible paths for broad and directory pathspecs, excluding ignored files', () => {
    setupRepo();
    commitFile(path.join(tmpDir, '.gitignore'), 'docs/prompts/ignored.md\n');
    mkdirSync(path.join(tmpDir, 'docs', 'prompts'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'prompts', 'live.md'), 'live\n');
    writeFileSync(path.join(tmpDir, 'docs', 'prompts', 'ignored.md'), 'secret\n');
    writeFileSync(path.join(tmpDir, 'outside.txt'), 'outside\n');

    const all = inspectGitCommandPaths('add', ['-A'], tmpDir);
    ok(all.includes('docs/prompts/live.md'));
    ok(!all.includes('docs/prompts/ignored.md'));
    const scoped = inspectGitCommandPaths('add', ['docs'], tmpDir);
    ok(scoped.includes('docs/prompts/live.md'));
    ok(!scoped.includes('outside.txt'));
    const forceAll = inspectGitCommandPaths('add', ['-f', '-A'], tmpDir);
    ok(forceAll.includes('docs/prompts/ignored.md'));
    const bundledForceAll = inspectGitCommandPaths('add', ['-fA'], tmpDir);
    ok(bundledForceAll.includes('docs/prompts/ignored.md'));
  });

  it('finds staged paths for pathless commit and tracked changes for commit -a', () => {
    setupRepo();
    const prompt = path.join(tmpDir, 'docs', 'prompts', 'live.md');
    mkdirSync(path.dirname(prompt), { recursive: true });
    commitFile(prompt, 'initial\n');
    writeFileSync(prompt, 'modified\n');

    const beforeStage = inspectGitCommandPaths('commit', [], tmpDir);
    ok(!beforeStage.includes('docs/prompts/live.md'), 'pathless commit only sees staged paths');
    const allTracked = inspectGitCommandPaths('commit', ['-a', '-m', 'save'], tmpDir);
    ok(allTracked.includes('docs/prompts/live.md'), 'commit -a includes tracked worktree changes');
    const bundledAll = inspectGitCommandPaths('commit', ['-am', 'save'], tmpDir);
    ok(bundledAll.includes('docs/prompts/live.md'), 'commit -am parses -a and skips its message value');
    const attachedMessage = inspectGitCommandPaths('commit', ['-msave'], tmpDir);
    ok(!attachedMessage.includes('docs/prompts/live.md'), 'letters in an attached -m value are not parsed as flags');
    spawnSync('git', ['add', prompt], { cwd: tmpDir });
    const staged = inspectGitCommandPaths('commit', ['-m', 'save'], tmpDir);
    ok(staged.includes('docs/prompts/live.md'));
    const templated = inspectGitCommandPaths('commit', ['--template', 'message.txt'], tmpDir);
    ok(templated.includes('docs/prompts/live.md'), '--template value is not mistaken for a pathspec');
  });

  it('models add -u, add -f, deletions, and commit -a final worktree state', () => {
    setupRepo();
    mkdirSync(path.join(tmpDir, 'docs', 'prompts'), { recursive: true });
    commitFile(path.join(tmpDir, '.gitignore'), 'docs/prompts/forced.md\n');
    const tracked = path.join(tmpDir, 'docs', 'prompts', 'tracked.md');
    commitFile(tracked, 'initial\n');
    writeFileSync(path.join(tmpDir, 'docs', 'prompts', 'untracked.md'), 'new\n');
    writeFileSync(path.join(tmpDir, 'docs', 'prompts', 'forced.md'), 'ignored\n');

    const updateOnly = inspectGitCommandPaths('add', ['-u'], tmpDir);
    ok(!updateOnly.includes('docs/prompts/untracked.md'));
    const forced = inspectGitCommandPaths('add', ['-f', 'docs/prompts/forced.md'], tmpDir);
    ok(forced.includes('docs/prompts/forced.md'));

    rmSync(tracked);
    ok(!inspectGitCommandPaths('add', ['-A'], tmpDir).includes('docs/prompts/tracked.md'), 'deleted prompt has no body to add');
    writeFileSync(tracked, 'initial\n');
    writeFileSync(tracked, 'staged change\n');
    spawnSync('git', ['add', tracked], { cwd: tmpDir });
    writeFileSync(tracked, 'initial\n');
    ok(!inspectGitCommandPaths('commit', ['-a', '-m', 'save'], tmpDir).includes('docs/prompts/tracked.md'),
      'commit -a replaces the staged change with the reverted worktree state');
  });

  it('returns no path for a clean explicit prompt', () => {
    setupRepo();
    const prompt = path.join(tmpDir, 'docs', 'prompts', 'clean.md');
    mkdirSync(path.dirname(prompt), { recursive: true });
    commitFile(prompt, 'clean\n');
    strictEqual(inspectGitCommandPaths('add', ['docs/prompts/clean.md'], tmpDir).length, 0);
    strictEqual(inspectGitCommandPaths('commit', ['--', 'docs/prompts/clean.md'], tmpDir).length, 0);
  });

  it('returns no eligible paths for Git dry-run forms', () => {
    setupRepo();
    const prompt = path.join(tmpDir, 'docs', 'prompts', 'preview.md');
    mkdirSync(path.dirname(prompt), { recursive: true });
    writeFileSync(prompt, 'preview\n');
    strictEqual(inspectGitCommandPaths('add', ['--dry-run', '.'], tmpDir).length, 0);
    strictEqual(inspectGitCommandPaths('add', ['-nA'], tmpDir).length, 0);
    spawnSync('git', ['add', prompt], { cwd: tmpDir });
    strictEqual(inspectGitCommandPaths('commit', ['--dry-run'], tmpDir).length, 0);
  });

  it('includes staged prompts for commit --include and explicit paths on an unborn branch', () => {
    setupRepo();
    mkdirSync(path.join(tmpDir, 'docs', 'prompts'), { recursive: true });
    const prompt = path.join(tmpDir, 'docs', 'prompts', 'live.md');
    writeFileSync(prompt, 'live\n');
    spawnSync('git', ['add', prompt], { cwd: tmpDir });
    const unborn = inspectGitCommandPaths('commit', ['--', 'docs/prompts/live.md'], tmpDir);
    ok(unborn.includes('docs/prompts/live.md'));

    spawnSync('git', ['commit', '-m', 'initial'], { cwd: tmpDir });
    writeFileSync(prompt, 'changed\n');
    spawnSync('git', ['add', prompt], { cwd: tmpDir });
    writeFileSync(path.join(tmpDir, 'safe.txt'), 'safe\n');
    const include = inspectGitCommandPaths('commit', ['--include', 'safe.txt'], tmpDir);
    ok(include.includes('docs/prompts/live.md'), '--include also commits pre-existing staged changes');
  });
});
