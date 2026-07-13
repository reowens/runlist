import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGitIndex } from '../src/git.mjs';
import { writeReleaseIntent } from './release-intent.mjs';
import { syncPluginVersions } from './sync-plugin-version.mjs';

const MANIFEST_PATHS = [
  'plugins/dotmd/.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
];
const RELEASE_PATHS = ['package.json', 'package-lock.json', ...MANIFEST_PATHS];

function git(projectRoot, args) {
  return spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
}

function listUnstagedPaths(projectRoot) {
  const tracked = git(projectRoot, ['diff', '--name-only', '--no-renames', '-z']);
  if (tracked.status !== 0) throw new Error(tracked.stderr.trim() || 'cannot inspect unstaged files');
  const untracked = git(projectRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untracked.status !== 0) throw new Error(untracked.stderr.trim() || 'cannot inspect untracked files');
  return [...new Set(`${tracked.stdout}${untracked.stdout}`.split('\0').filter(Boolean))];
}

export function prepareVersionCommit(
  projectRoot = process.cwd(),
  deps = {},
) {
  const sync = deps.sync ?? syncPluginVersions;
  let manifestsTouched = false;
  try {
    assertGitIndex(projectRoot);
    const unexpected = listUnstagedPaths(projectRoot)
      .filter(file => file !== 'package.json' && file !== 'package-lock.json');
    if (unexpected.length > 0) {
      throw new Error(`unexpected files changed after release preflight: ${unexpected.join(', ')}`);
    }
    const version = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
    const oldPackage = git(projectRoot, ['show', 'HEAD:package.json']);
    if (oldPackage.status !== 0) throw new Error(oldPackage.stderr.trim() || 'cannot read HEAD package version');
    const oldVersion = JSON.parse(oldPackage.stdout).version;
    if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version) || version === oldVersion) {
      throw new Error(`invalid version transition ${oldVersion} → ${version}`);
    }
    writeReleaseIntent(projectRoot, {
      oldVersion,
      newVersion: version,
      baseHead: git(projectRoot, ['rev-parse', 'HEAD']).stdout.trim(),
      remoteMain: git(projectRoot, ['rev-parse', 'FETCH_HEAD']).stdout.trim(),
    });
    const tag = `v${version}`;
    if (git(projectRoot, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]).status === 0) {
      throw new Error(`local release tag ${tag} already exists`);
    }
    const remoteTag = git(projectRoot, ['ls-remote', '--exit-code', 'origin', `refs/tags/${tag}`]);
    if (remoteTag.status === 0) throw new Error(`remote release tag ${tag} already exists`);
    if (remoteTag.status !== 2) throw new Error(remoteTag.stderr.trim() || `cannot verify remote release tag ${tag}`);
    manifestsTouched = true;
    sync(projectRoot);
    const add = git(projectRoot, ['add', '--', ...MANIFEST_PATHS]);
    if (add.status !== 0) throw new Error(add.stderr.trim() || 'git add failed');
    assertGitIndex(projectRoot, MANIFEST_PATHS);
  } catch (err) {
    const restorePaths = manifestsTouched ? RELEASE_PATHS : ['package.json', 'package-lock.json'];
    const restore = git(projectRoot, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...restorePaths]);
    if (restore.status !== 0) {
      throw new Error(`${err.message}; automatic version rollback also failed: ${restore.stderr.trim()}`);
    }
    throw new Error(`${err.message}; restored package and plugin version files to HEAD`);
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  prepareVersionCommit();
}
