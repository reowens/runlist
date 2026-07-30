import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareVersionCommit } from '../scripts/prepare-version-commit.mjs';
import { recoverLocalRelease } from '../scripts/recover-local-release.mjs';
import { runReleasePreflight } from '../scripts/release-preflight.mjs';
import { clearReleaseIntent, writeReleaseIntent } from '../scripts/release-intent.mjs';

let root;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function git(args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

function setupRepo() {
  root = mkdtempSync(path.join(os.tmpdir(), 'dotmd-release-life-'));
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@test.com']);
  git(['config', 'user.name', 'Test']);
  mkdirSync(path.join(root, 'plugins', 'dotmd', '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }, null, 2) + '\n');
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version: '1.0.0' }, null, 2) + '\n');
  writeFileSync(path.join(root, 'plugins', 'dotmd', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'dotmd', version: '1.0.0' }, null, 2) + '\n');
  writeFileSync(path.join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ plugins: [{ name: 'dotmd', version: '1.0.0' }] }, null, 2) + '\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  git(['remote', 'add', 'origin', root]);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
}

function seedIntent() {
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  writeReleaseIntent(root, {
    oldVersion: '1.0.0',
    newVersion: '1.0.1',
    baseHead: head,
    remoteMain: head,
  });
}

test('release preflight accepts clean main descending from origin/main', () => {
  setupRepo();
  assert.doesNotThrow(() => runReleasePreflight(root, { newVersion: '1.0.1' }));
});

test('release preflight rejects a clean feature branch', () => {
  setupRepo();
  git(['switch', '-c', 'feature']);
  assert.throws(() => runReleasePreflight(root, { newVersion: '1.0.1' }), /must run from main/);
});

test('release preflight blocks a new bump while another release intent is incomplete', () => {
  setupRepo();
  seedIntent();
  assert.throws(() => runReleasePreflight(root), /release v1\.0\.1 is incomplete.*release:resume/);
});

test('real npm version lifecycle carries target intent through commit and tag', { skip: process.platform === 'win32' && 'release automation is POSIX-only' }, () => {
  setupRepo();
  const scriptsDir = path.resolve(import.meta.dirname, '..', 'scripts');
  const pkg = {
    name: 'release-fixture',
    version: '1.0.0',
    scripts: {
      preversion: `node ${JSON.stringify(path.join(scriptsDir, 'release-preflight.mjs'))}`,
      version: `node ${JSON.stringify(path.join(scriptsDir, 'prepare-version-commit.mjs'))}`,
      postversion: `node ${JSON.stringify(path.join(scriptsDir, 'release-intent.mjs'))} clear`,
    },
  };
  const lock = {
    name: 'release-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'release-fixture', version: '1.0.0' } },
  };
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  git(['add', 'package.json', 'package-lock.json']);
  git(['commit', '-m', 'release scripts']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);

  const result = spawnSync('npm', ['version', 'patch'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'))).version, '1.0.1');
  assert.equal(git(['rev-parse', 'v1.0.1^{commit}']).stdout.trim(), git(['rev-parse', 'HEAD']).stdout.trim());
  assert.equal(git(['status', '--porcelain']).stdout, '');
});

test('version artifact failure restores package and plugin trees to HEAD', () => {
  setupRepo();
  seedIntent();
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.1' }, null, 2) + '\n');
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version: '1.0.1' }, null, 2) + '\n');
  const pluginPath = path.join(root, 'plugins', 'dotmd', '.claude-plugin', 'plugin.json');

  assert.throws(() => prepareVersionCommit(root, {
    sync: () => {
      writeFileSync(pluginPath, JSON.stringify({ name: 'dotmd', version: '1.0.1' }));
      throw new Error('injected second-manifest failure');
    },
  }), /restored package and plugin version files to HEAD/);

  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'))).version, '1.0.0');
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package-lock.json'))).version, '1.0.0');
  assert.equal(JSON.parse(readFileSync(pluginPath)).version, '1.0.0');
  assert.equal(git(['status', '--porcelain']).stdout, '');
});

test('version preparation preserves concurrent plugin edits when refusing them', () => {
  setupRepo();
  seedIntent();
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.1' }, null, 2) + '\n');
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version: '1.0.1' }, null, 2) + '\n');
  const pluginPath = path.join(root, 'plugins', 'dotmd', '.claude-plugin', 'plugin.json');
  writeFileSync(pluginPath, JSON.stringify({ name: 'dotmd', version: 'concurrent-edit' }));

  assert.throws(() => prepareVersionCommit(root), /unexpected files changed after release preflight/);
  assert.equal(JSON.parse(readFileSync(pluginPath)).version, 'concurrent-edit');
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'))).version, '1.0.0');
});

test('version preparation preserves an unexpected staged path while rolling back the bump', () => {
  setupRepo();
  seedIntent();
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.1' }, null, 2) + '\n');
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version: '1.0.1' }, null, 2) + '\n');
  writeFileSync(path.join(root, 'secret.env'), 'SECRET=1\n');
  git(['add', 'secret.env']);

  assert.throws(() => prepareVersionCommit(root), /Git index mismatch/);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'))).version, '1.0.0');
  assert.equal(git(['diff', '--cached', '--name-only']).stdout.trim(), 'secret.env');
});

test('version preparation rejects an existing target tag and restores the bump', () => {
  setupRepo();
  seedIntent();
  git(['tag', 'v1.0.1']);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.1' }, null, 2) + '\n');
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version: '1.0.1' }, null, 2) + '\n');

  assert.throws(() => prepareVersionCommit(root), /tag v1\.0\.1 already exists/);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'))).version, '1.0.0');
});

test('release recovery rolls back a successful version hook when commit and tag never happened', () => {
  setupRepo();
  seedIntent();
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.1' }, null, 2) + '\n');
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version: '1.0.1' }, null, 2) + '\n');
  prepareVersionCommit(root);

  const result = recoverLocalRelease(root);
  assert.equal(result.ready, false);
  assert.equal(result.action, 'rolled-back');
  assert.match(result.message, /npm version 1\.0\.1/);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'))).version, '1.0.0');
  assert.equal(git(['status', '--porcelain']).stdout, '');
});

test('release recovery recreates a missing tag after the npm version commit succeeded', () => {
  setupRepo();
  seedIntent();
  for (const file of ['package.json', 'package-lock.json']) {
    writeFileSync(path.join(root, file), JSON.stringify({ version: '1.0.1' }, null, 2) + '\n');
  }
  writeFileSync(path.join(root, 'plugins', 'dotmd', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'dotmd', version: '1.0.1' }, null, 2) + '\n');
  writeFileSync(path.join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ plugins: [{ name: 'dotmd', version: '1.0.1' }] }, null, 2) + '\n');
  git(['add', '.']);
  git(['commit', '-m', 'v1.0.1']);

  const result = recoverLocalRelease(root);
  assert.deepEqual(result, { ready: true, tag: 'v1.0.1', action: 'created-tag' });
  assert.equal(git(['rev-parse', 'v1.0.1^{commit}']).stdout.trim(), git(['rev-parse', 'HEAD']).stdout.trim());
});

test('release recovery never falls back to the previous package version', () => {
  setupRepo();
  git(['tag', 'v1.0.0']);
  seedIntent();

  const result = recoverLocalRelease(root);
  assert.equal(result.ready, false);
  assert.equal(result.action, 'rolled-back');
  assert.match(result.message, /npm version 1\.0\.1/);
  assert.equal(git(['tag', '--list', 'v1.0.1']).stdout, '');
});

test('release recovery refuses without a durable release intent', () => {
  setupRepo();
  clearReleaseIntent(root);
  assert.throws(() => recoverLocalRelease(root), /no incomplete release intent/);
});

// The changelog heading is asserted against package.json's version, so it can
// only break after the bump — i.e. in publish CI, against a tag that is already
// pushed. These cover the promotion happening inside the version commit instead.
function bumpWorkingTree(version = '1.0.1') {
  for (const file of ['package.json', 'package-lock.json']) {
    writeFileSync(path.join(root, file), JSON.stringify({ version }, null, 2) + '\n');
  }
}

function commitChangelog(body) {
  writeFileSync(path.join(root, 'CHANGELOG.md'), body);
  git(['add', 'CHANGELOG.md']);
  git(['commit', '-m', 'changelog']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
}

test('version preparation promotes the Unreleased heading and stages it', () => {
  setupRepo();
  commitChangelog('# Changelog\n\n## Unreleased\n\n### Fixed\n\n- a thing\n\n## 1.0.0 — 2026-01-01\n');
  seedIntent();
  bumpWorkingTree();

  prepareVersionCommit(root, { today: '2026-07-29' });

  const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /^## 1\.0\.1 — 2026-07-29$/m);
  assert.doesNotMatch(changelog, /^## Unreleased/m);
  assert.equal(changelog.includes('- a thing'), true);
  assert.equal(
    git(['diff', '--cached', '--name-only']).stdout.split('\n').includes('CHANGELOG.md'),
    true,
  );
});

test('version preparation leaves an already-stamped changelog untouched', () => {
  setupRepo();
  const body = '# Changelog\n\n## 1.0.1 — 2026-07-01\n\n### Fixed\n\n- already written\n';
  commitChangelog(body);
  seedIntent();
  bumpWorkingTree();

  prepareVersionCommit(root, { today: '2026-07-29' });

  assert.equal(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), body);
  assert.equal(
    git(['diff', '--cached', '--name-only']).stdout.split('\n').includes('CHANGELOG.md'),
    false,
  );
});

test('version preparation refuses a changelog with nothing to promote and restores the bump', () => {
  setupRepo();
  const body = '# Changelog\n\n## 1.0.0 — 2026-01-01\n';
  commitChangelog(body);
  seedIntent();
  bumpWorkingTree();

  assert.throws(
    () => prepareVersionCommit(root),
    /neither a `## 1\.0\.1` heading nor an `## Unreleased` section/,
  );
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'))).version, '1.0.0');
  assert.equal(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), body);
  assert.equal(git(['status', '--porcelain']).stdout, '');
});

test('version preparation still works in a repo with no changelog', () => {
  setupRepo();
  seedIntent();
  bumpWorkingTree();

  assert.doesNotThrow(() => prepareVersionCommit(root));
  assert.equal(git(['diff', '--cached', '--name-only']).stdout.trim().split('\n').sort().join(','),
    '.claude-plugin/marketplace.json,plugins/dotmd/.claude-plugin/plugin.json');
});
