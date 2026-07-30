import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGitIndex } from '../src/git.mjs';
import { writeReleaseIntent } from './release-intent.mjs';
import { syncPluginVersions } from './sync-plugin-version.mjs';

const MANIFEST_PATHS = [
  'plugins/dotmd/.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
];
const CHANGELOG_PATH = 'CHANGELOG.md';
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

function localDate(now = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Promote `## Unreleased` to `## <version> — <date>` as part of the version
// commit. `test/changelog.test.mjs` asserts the changelog carries a heading for
// whatever version package.json names, and that assertion can only fail AFTER
// the bump — which locally happens after `preversion` already ran the suite, so
// the first thing to notice is `publish.yml` running `npm test` against the
// pushed tag. That failure costs a rewritten tag to fix. Stamping here moves it
// to before the tag is cut, where the rollback below still handles it.
//
// Returns whether the file was rewritten, so the caller stages exactly what it
// changed and restores exactly that on failure.
function stampChangelog(projectRoot, version, today) {
  const file = path.join(projectRoot, CHANGELOG_PATH);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    // A repo with no changelog has nothing to keep in step — not an error.
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  if (new RegExp(`^## ${version.replaceAll('.', '\\.')}(?:\\s|$)`, 'm').test(text)) return false;
  const unreleased = /^## Unreleased[^\n]*$/m;
  if (!unreleased.test(text)) {
    throw new Error(
      `${CHANGELOG_PATH} has neither a \`## ${version}\` heading nor an \`## Unreleased\` section to promote`,
    );
  }
  writeFileSync(file, text.replace(unreleased, `## ${version} — ${today}`));
  return true;
}

export function prepareVersionCommit(
  projectRoot = process.cwd(),
  deps = {},
) {
  const sync = deps.sync ?? syncPluginVersions;
  const today = deps.today ?? localDate();
  let manifestsTouched = false;
  let changelogStamped = false;
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
    changelogStamped = stampChangelog(projectRoot, version, today);
    const stagedPaths = changelogStamped ? [...MANIFEST_PATHS, CHANGELOG_PATH] : MANIFEST_PATHS;
    const add = git(projectRoot, ['add', '--', ...stagedPaths]);
    if (add.status !== 0) throw new Error(add.stderr.trim() || 'git add failed');
    assertGitIndex(projectRoot, stagedPaths);
  } catch (err) {
    const restorePaths = manifestsTouched ? [...RELEASE_PATHS] : ['package.json', 'package-lock.json'];
    // Only restore the changelog when this run rewrote it — the path may not
    // exist in HEAD at all, and `git restore` errors on an unmatched pathspec.
    if (changelogStamped) restorePaths.push(CHANGELOG_PATH);
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
