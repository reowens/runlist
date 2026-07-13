import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearReleaseIntent, readReleaseIntent } from './release-intent.mjs';

const RELEASE_PATHS = [
  'package.json',
  'package-lock.json',
  'plugins/dotmd/.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
];

function git(projectRoot, args) {
  return spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
}

function packageVersion(projectRoot, ref = null) {
  const raw = ref
    ? git(projectRoot, ['show', `${ref}:package.json`]).stdout
    : readFileSync(path.join(projectRoot, 'package.json'), 'utf8');
  return JSON.parse(raw).version;
}

export function recoverLocalRelease(projectRoot = process.cwd()) {
  const intent = readReleaseIntent(projectRoot);
  if (!intent) throw new Error('no incomplete release intent exists; run `npm version <version>` instead');
  const version = intent.newVersion;
  const tag = `v${version}`;
  if (git(projectRoot, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]).status === 0) {
    if (packageVersion(projectRoot, tag) !== version) {
      throw new Error(`${tag} does not contain package version ${version}`);
    }
    return { ready: true, tag, action: 'existing-tag' };
  }

  const workingVersion = packageVersion(projectRoot);
  const headVersion = packageVersion(projectRoot, 'HEAD');
  if (workingVersion === version && headVersion !== version) {
    const restore = git(projectRoot, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...RELEASE_PATHS]);
    if (restore.status !== 0) throw new Error(`cannot roll back failed version attempt: ${restore.stderr.trim()}`);
    clearReleaseIntent(projectRoot);
    return {
      ready: false,
      action: 'rolled-back',
      message: `Rolled back incomplete ${tag}. Re-run \`npm version ${version}\`; do not use release:resume until the tag exists.`,
    };
  }

  if (workingVersion !== version || headVersion !== version) {
    clearReleaseIntent(projectRoot);
    return {
      ready: false,
      action: 'rolled-back',
      message: `Release ${tag} did not begin. Re-run \`npm version ${version}\`.`,
    };
  }

  const subject = git(projectRoot, ['log', '-1', '--format=%s']).stdout.trim();
  if (subject !== tag) {
    throw new Error(`tag ${tag} is missing and HEAD is not the matching npm version commit`);
  }
  const dirty = git(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (dirty.status !== 0 || dirty.stdout) {
    throw new Error(`tag ${tag} is missing but the working tree is not clean`);
  }
  const created = git(projectRoot, ['tag', '-a', tag, '-m', tag]);
  if (created.status !== 0) throw new Error(`cannot recreate ${tag}: ${created.stderr.trim()}`);
  return { ready: true, tag, action: 'created-tag' };
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    const result = recoverLocalRelease();
    if (!result.ready) {
      process.stderr.write(`${result.message}\n`);
      process.exitCode = 1;
    } else if (result.action === 'created-tag') {
      process.stdout.write(`recreated missing local release tag ${result.tag}\n`);
    }
  } catch (err) {
    process.stderr.write(`release recovery failed: ${err.message}\n`);
    process.exitCode = 1;
  }
}
