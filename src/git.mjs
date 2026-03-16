import { spawnSync } from 'node:child_process';

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

export function gitMv(source, target, repoRoot) {
  ensureGit();
  const result = spawnSync('git', ['mv', source, target], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr };
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
