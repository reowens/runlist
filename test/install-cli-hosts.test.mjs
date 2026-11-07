import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { installCliHosts, readCliHosts, remoteInstallArgs, remoteRefreshArgs } from '../scripts/install-cli-hosts.mjs';
import { installLocalCLI } from '../scripts/prepare-local-cli.mjs';

const posixOnly = { skip: process.platform === 'win32' && 'release automation is POSIX-only' };
const repoRoot = path.resolve(import.meta.dirname, '..');

function withTemp(fn) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'runlist-cli-hosts-')));
  try { return fn(dir); } finally {
    // Prepared artifacts are read-only by design.
    spawnSync('chmod', ['-R', 'u+w', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeConfig(dir, value) {
  const file = path.join(dir, 'release-config.json');
  writeFileSync(file, JSON.stringify(value));
  return { RUNLIST_RELEASE_CONFIG: file };
}

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

// A released package in its own origin, with the installer scripts a host
// extracts from the tag's commit.
function releaseFixture(dir, version = '1.2.3') {
  const source = path.join(dir, 'source');
  mkdirSync(path.join(source, 'bin'), { recursive: true });
  mkdirSync(path.join(source, 'scripts'));
  mkdirSync(path.join(source, 'src'));
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'runlist', version, files: ['bin/'], bin: { runlist: 'bin/runlist.mjs', rl: 'bin/runlist.mjs' } }));
  writeFileSync(path.join(source, 'bin', 'runlist.mjs'), "#!/usr/bin/env node\nconsole.log('usage: runlist');\n");
  copyFileSync(path.join(repoRoot, 'scripts', 'prepare-local-cli.mjs'), path.join(source, 'scripts', 'prepare-local-cli.mjs'));
  copyFileSync(path.join(repoRoot, 'src', 'durable-rename.mjs'), path.join(source, 'src', 'durable-rename.mjs'));
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'add', '.');
  git(source, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', version);
  git(source, 'tag', `v${version}`);
  const origin = path.join(dir, 'origin.git');
  git(dir, 'clone', '-q', '--bare', source, origin);
  const checkout = path.join(dir, 'checkout');
  git(dir, 'clone', '-q', '--no-tags', origin, checkout);
  return { checkout, commit: git(source, 'rev-parse', 'HEAD'), home: path.join(dir, 'home') };
}

test('cliHosts come only from the private release config and are checked', () => {
  withTemp(dir => {
    assert.deepEqual(readCliHosts(dir, {}), []);
    assert.deepEqual(readCliHosts(dir, writeConfig(dir, { signTeam: 'x' })), []);
    assert.deepEqual(readCliHosts(dir, writeConfig(dir, { cliHosts: [{ ssh: 'worker-a', checkout: '/srv/runlist' }] })),
      [{ ssh: 'worker-a', checkout: '/srv/runlist', node: 'node' }]);
    for (const cliHosts of ['worker-a', [{ checkout: '/srv/runlist' }], [{ ssh: '-oProxyCommand=x', checkout: '/srv/runlist' }], [{ ssh: 'worker-a', checkout: 'relative' }], [{ ssh: 'worker-a', checkout: '/srv/runlist', node: '' }]]) {
      assert.throws(() => readCliHosts(dir, writeConfig(dir, { cliHosts })));
    }
  });
});

test('an unreachable or refusing host is reported as owed with the resume command', () => {
  withTemp(dir => {
    const env = writeConfig(dir, { cliHosts: [
      { ssh: 'worker-a', checkout: '/srv/run list', node: '/opt/node/bin/node' },
      { ssh: 'worker-b', checkout: '/srv/runlist' },
      { ssh: 'worker-c', checkout: '/srv/runlist' },
      { ssh: 'worker-d', checkout: '/srv/runlist' },
      { ssh: 'worker-e', checkout: '/srv/runlist' },
    ] });
    const calls = [];
    const lines = [];
    const commit = 'a'.repeat(40);
    const { owed } = installCliHosts({ root: dir, version: '1.2.3', commit, env, log: line => lines.push(line), run: (program, args) => {
      calls.push([program, ...args]);
      const refresh = args.at(-1).includes('--input-type=module');
      if (refresh && args.includes('worker-e')) return { status: 1, stdout: 'runlist plugin 0.1.0 behind\n', stderr: 'expected 1.2.3' };
      if (refresh) return { status: 0, stdout: 'Installed host integrations verified against 1.2.3\n', stderr: '' };
      if (args.includes('worker-b')) return { status: 255, stdout: '', stderr: 'ssh: connect to host worker-b: No route to host' };
      if (args.includes('worker-c')) return { status: 1, stdout: '', stderr: 'Local CLI preparation refused: package changed' };
      if (args.includes('worker-d')) return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: JSON.stringify({ links: [{ link: '/home/u/.local/bin/runlist', entry: '/x/bin/runlist.mjs', changed: true }] }), stderr: '' };
    } });
    assert.deepEqual(owed, [
      { host: 'worker-b', reason: 'unreachable over SSH' },
      { host: 'worker-c', reason: 'install exited 1' },
      { host: 'worker-d', reason: 'install reported no selected links' },
      { host: 'worker-e', reason: 'host integration refresh exited 1' },
    ]);
    // Only a host whose CLI install succeeded goes on to refresh its integrations.
    assert.deepEqual(calls.map(call => [call.at(-2), call.at(-1).includes('--input-type=module')]), [
      ['worker-a', false], ['worker-a', true], ['worker-b', false], ['worker-c', false], ['worker-d', false], ['worker-e', false], ['worker-e', true]]);
    assert.ok(calls[1].at(-1).startsWith('/opt/node/bin/node '), calls[1].at(-1));
    assert.ok(calls[1].at(-1).endsWith(' /x/bin/runlist.mjs 1.2.3'), calls[1].at(-1));
    for (const call of calls) {
      assert.equal(call[0], 'ssh');
      assert.ok(call.includes('BatchMode=yes'));
      assert.ok(call.includes('ConnectTimeout=15'));
    }
    assert.ok(calls[0].at(-1).includes('"/srv/run list" v1.2.3 ' + commit + ' 1.2.3 /opt/node/bin/node'), calls[0].at(-1));
    const output = lines.join('\n');
    assert.match(output, /still owed on worker-b: unreachable over SSH\n {4}ssh: connect to host worker-b/);
    assert.match(output, /still owed on worker-e: host integration refresh exited 1\n {4}expected 1\.2\.3/);
    assert.match(output, / {2}Installed host integrations verified against 1\.2\.3/);
    assert.match(output, /4 CLI host\(s\) still owe 1\.2\.3.*npm run release:resume/);
  });
});

test('no listed hosts means nothing is owed', () => {
  withTemp(dir => {
    const lines = [];
    assert.deepEqual(installCliHosts({ root: dir, version: '1.2.3', commit: 'a'.repeat(40), env: {}, log: line => lines.push(line), run: () => assert.fail('no host to reach') }), { owed: [] });
    assert.match(lines.join('\n'), /no other CLI hosts listed/);
  });
});

test('a host fetches the tag and links runlist and rl to the prepared commit, again without change', posixOnly, () => {
  withTemp(dir => {
    const { checkout, commit, home } = releaseFixture(dir);
    // The host's temporary folder sits behind a symbolic link, as /var does on macOS.
    mkdirSync(path.join(dir, 'real-tmp'));
    symlinkSync(path.join(dir, 'real-tmp'), path.join(dir, 'linked-tmp'));
    const command = remoteInstallArgs({ ssh: 'worker-a', checkout, node: process.execPath }, '1.2.3', commit).at(-1);
    const run = () => spawnSync('sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, HOME: home, TMPDIR: path.join(dir, 'linked-tmp') } });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const entry = path.join(home, '.local/share/runlist/artifacts', commit, 'package/bin/runlist.mjs');
    for (const name of ['runlist', 'rl']) assert.equal(readlinkSync(path.join(home, '.local/bin', name)), entry);
    assert.deepEqual(JSON.parse(first.stdout).links.map(link => link.changed), [true, true]);
    const again = run();
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(JSON.parse(again.stdout).links.map(link => link.changed), [false, false]);

    const wrongTag = spawnSync('sh', ['-c', remoteInstallArgs({ ssh: 'worker-a', checkout, node: process.execPath }, '1.2.3', 'b'.repeat(40)).at(-1)], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    assert.notEqual(wrongTag.status, 0);
    assert.match(wrongTag.stderr, /does not name/);
  });
});

test('an existing preparation is revalidated, and an incomplete or mismatched one refused', posixOnly, () => {
  withTemp(dir => {
    const { checkout, commit, home } = releaseFixture(dir);
    git(checkout, 'fetch', '-q', 'origin', 'refs/tags/v1.2.3:refs/tags/v1.2.3');
    const options = { repository: checkout, commit, artifacts: path.join(home, 'artifacts'), bin: path.join(home, 'bin') };
    assert.throws(() => installLocalCLI({ ...options, version: '9.9.9' }), /is version 1\.2\.3, not 9\.9\.9/);
    assert.ok(existsSync(path.join(options.artifacts, commit, 'receipt.json')));
    assert.equal(existsSync(path.join(options.bin, 'runlist')), false);
    const installed = installLocalCLI({ ...options, version: '1.2.3' });
    assert.equal(installed.links.length, 2);

    const incomplete = 'c'.repeat(40);
    mkdirSync(path.join(options.artifacts, incomplete));
    assert.throws(() => installLocalCLI({ ...options, commit: incomplete }), /incomplete preparation/);
  });
});

// The refresh runs the installed CLI's own updater over a non-interactive SSH
// shell: no CLAUDE_CONFIG_DIR and a bare PATH. Profiles are still found by
// their folders in the home directory, and a stale one keeps the host owed.
test('the remote refresh runs the installed updater with the exact version and fails while a profile is stale', posixOnly, () => {
  withTemp(dir => {
    const version = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
    const entry = path.join(repoRoot, 'bin', 'runlist.mjs');
    const home = path.join(dir, 'home');
    mkdirSync(home);
    const run = (v) => spawnSync('sh', ['-c', remoteRefreshArgs({ ssh: 'worker-a', node: process.execPath }, v, entry).at(-1)],
      { encoding: 'utf8', cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin', NO_COLOR: '1' } });
    const clean = run(version);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.match(clean.stdout, new RegExp(`Installed host integrations verified against ${version.replace(/\./g, '\\.')}`));
    const wrong = run('0.0.1');
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /host update requires this CLI version/);
    const plugins = path.join(home, '.claude-work', 'plugins');
    mkdirSync(plugins, { recursive: true });
    writeFileSync(path.join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'runlist@runlist': [{ scope: 'user', version: '0.1.0' }] } }));
    const stale = run(version);
    assert.notEqual(stale.status, 0, stale.stdout);
    assert.match(stale.stdout, /\.claude-work: runlist@runlist: user has 0\.1\.0, expected/);
    assert.ok(!stale.stdout.includes('Installed host integrations verified'));
  });
});
