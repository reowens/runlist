import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGitIndex } from '../src/git.mjs';
import { readReleaseIntent } from './release-intent.mjs';
import { validatePluginManifests } from './sync-plugin-version.mjs';

function git(projectRoot, args) {
  return spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
}

export function runReleasePreflight(projectRoot = process.cwd()) {
  const pending = readReleaseIntent(projectRoot);
  if (pending) {
    throw new Error(`release v${pending.newVersion} is incomplete; run \`npm run release:resume\` before starting another bump`);
  }
  assertGitIndex(projectRoot);

  const dirty = git(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (dirty.status !== 0) throw new Error(dirty.stderr.trim() || 'cannot inspect the working tree');
  if (dirty.stdout) throw new Error('working tree is dirty; commit or remove all release inputs before versioning');

  const branch = git(projectRoot, ['branch', '--show-current']);
  if (branch.status !== 0 || branch.stdout.trim() !== 'main') {
    throw new Error(`release must run from main (current: ${branch.stdout.trim() || 'detached'})`);
  }

  const fetch = git(projectRoot, ['fetch', '--quiet', 'origin', 'main']);
  if (fetch.status !== 0) throw new Error(fetch.stderr.trim() || 'cannot fetch live origin/main');
  const ancestry = git(projectRoot, ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD']);
  if (ancestry.status !== 0) throw new Error('local main does not descend from origin/main; reconcile before releasing');

  validatePluginManifests(projectRoot);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    runReleasePreflight();
  } catch (err) {
    process.stderr.write(`release preflight failed: ${err.message}\n`);
    process.exitCode = 1;
  }
}
