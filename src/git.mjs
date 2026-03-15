import { spawnSync } from 'node:child_process';

export function getGitLastModified(relPath, repoRoot) {
  const result = spawnSync('git', ['log', '-1', '--format=%aI', '--', relPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  return result.stdout.trim();
}

export function gitMv(source, target, repoRoot) {
  const result = spawnSync('git', ['mv', source, target], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr };
}
