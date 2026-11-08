import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGitIndex } from '../src/git.mjs';
import { readReleaseIntent } from './release-intent.mjs';
import { validatePluginManifests } from './sync-plugin-version.mjs';
import { preflightDesktopRelease, remoteDesktopRelease } from './desktop-release-config.mjs';
import { prepareDesktopVersionUpdates } from '../desktop/scripts/version.mjs';
import { prepareReleaseDocUpdates } from './stamp-release-docs.mjs';
import { privateVocabularyAvailable } from './public-content.mjs';
import { checkPublic as checkPublicContent } from './check-public.mjs';

function git(projectRoot, args) {
  return spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
}

export function runReleasePreflight(projectRoot = process.cwd(), { env = process.env, platform = process.platform, arch = process.arch } = {}) {
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
  const version = JSON.parse((git(projectRoot, ['show', 'HEAD:package.json'])).stdout).version;
  prepareDesktopVersionUpdates(projectRoot, version);
  prepareReleaseDocUpdates(projectRoot, version);
  preflightDesktopPublication(projectRoot, { env, platform, arch });
}

// With the private key here, a private name in the tree stops the release
// before the tag is cut rather than in publish.yml after it. The Mac also
// needs the key to scan the app bundle; a host that hands the app to a remote
// desktop release host does not.
export function preflightDesktopPublication(projectRoot, {
  env = process.env, platform = process.platform, arch = process.arch,
  vocabulary = privateVocabularyAvailable, checkPublic = checkPublicContent, issuerSha256,
} = {}) {
  if (!preflightDesktopRelease(projectRoot, { env, platform, arch, issuerSha256 })) return;
  if (vocabulary) checkPublic(projectRoot);
  else if (!remoteDesktopRelease(projectRoot, { env, platform, arch })) {
    throw new Error('Desktop publication requires the private public-content key before versioning.');
  }
}


if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    runReleasePreflight();
  } catch (err) {
    process.stderr.write(`release preflight failed: ${err.message}\n`);
    process.exitCode = 1;
  }
}
