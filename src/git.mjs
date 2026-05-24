import { spawnSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import path from 'node:path';

let gitChecked = false;
function ensureGit() {
  if (gitChecked) return;
  const result = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (result.error) {
    throw new Error('git is not installed or not found in PATH. dotmd requires git for this operation.');
  }
  gitChecked = true;
}

export function getGitLastModified(relPath, repoRoot) {
  const result = spawnSync('git', ['log', '-1', '--format=%aI', '--', relPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
  return result.stdout.trim();
}

export function getGitFirstAdded(relPath, repoRoot) {
  const result = spawnSync('git', ['log', '--diff-filter=A', '--follow', '--format=%aI', '--', relPath], {
    cwd: repoRoot, encoding: 'utf8',
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
  // `git log` returns newest-first; the file's add commit is the LAST entry.
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  return lines[lines.length - 1] ?? null;
}

export function getGitLastModifiedBatch(repoRoot) {
  const result = spawnSync('git', [
    'log', '--format=commit %aI', '--name-only', '--diff-filter=ACDMR', 'HEAD',
  ], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.status !== 0) return new Map();

  const map = new Map();
  let currentDate = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('commit ')) {
      currentDate = line.slice(7).trim();
    } else if (line && currentDate && !map.has(line)) {
      map.set(line, currentDate);
    }
  }
  return map;
}

export function gitMv(source, target, repoRoot) {
  ensureGit();
  // Source is untracked (scaffolded this session, never committed; or repoRoot
  // is not a git repo at all): a plain rename is the only correct move. `git mv`
  // would error with `fatal: not under version control` and the user can't act
  // on that — the file is genuinely a doc, just not yet staged.
  if (!isTracked(source, repoRoot)) {
    const absSource = path.isAbsolute(source) ? source : path.join(repoRoot, source);
    const absTarget = path.isAbsolute(target) ? target : path.join(repoRoot, target);
    try {
      renameSync(absSource, absTarget);
      return { status: 0, stderr: '' };
    } catch (err) {
      return { status: 1, stderr: err.message };
    }
  }
  const result = spawnSync('git', ['mv', source, target], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr };
}

function isTracked(source, repoRoot) {
  const relSource = path.isAbsolute(source) ? path.relative(repoRoot, source) : source;
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', relSource], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return result.status === 0;
}

export function gitDiffSince(relPath, sinceDate, repoRoot, opts = {}) {
  ensureGit();
  // Find the last commit at or before sinceDate
  const baseline = spawnSync('git', [
    'log', '-1', '--before=' + sinceDate + 'T23:59:59', '--format=%H', '--', relPath
  ], { cwd: repoRoot, encoding: 'utf8' });

  const baseRef = baseline.stdout.trim();
  if (!baseRef) return null;

  const diffArgs = ['diff', baseRef, 'HEAD'];
  if (opts.stat) diffArgs.push('--stat');
  diffArgs.push('--', relPath);

  const result = spawnSync('git', diffArgs, { cwd: repoRoot, encoding: 'utf8' });
  return result.stdout || null;
}
