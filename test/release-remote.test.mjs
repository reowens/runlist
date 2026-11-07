import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { nextVersion, readReleaseHost, runRelease } from '../scripts/release-remote.mjs';

const posixOnly = { skip: process.platform === 'win32' && 'release automation is POSIX-only', timeout: 60_000 };

// The fake ssh records each call's host and mode, then runs the remote command
// with a local bash, so the release host is a directory under the fixture HOME.
const FAKE_SSH = `#!/usr/bin/env bash
mode=$(printf '%s' "$6" | grep -o 'release-host-[a-z]*' | head -n 1)
printf '%s %s\\n' "$5" "$mode" >> "$SSH_LOG"
if [ -n "\${SSH_DOWN:-}" ]; then echo "ssh: connect to host $5 port 22: Operation timed out" >&2; exit 255; fi
if [ -n "\${SSH_DROP_FOLLOW:-}" ] && [ "$mode" = release-host-follow ]; then echo "partial line"; exit 255; fi
exec bash -c "$6"
`;

// tmux runs a new session's command at once, so the log is complete before it
// is followed; the follower must still stop at release-exit= on its own.
const FAKE_TMUX = `#!/usr/bin/env bash
case $1 in
  list-sessions) [ -f "$TMUX_STATE/server" ] || { echo "no server running" >&2; exit 1; }; cat "$TMUX_STATE/sessions" 2>/dev/null; exit 0 ;;
  has-session) grep -q "^$3" "$TMUX_STATE/sessions" 2>/dev/null ;;
  new-session) printf '%s' "$5" > "$TMUX_STATE/command"; sh -c "$5" ;;
esac
`;

const FAKE_NPM = `#!/usr/bin/env bash
echo "npm $* TMPDIR=$TMPDIR" | tee -a "$NPM_LOG"
if [ "$1" = version ]; then
  git commit -q --allow-empty -m "version $2" && git push -q origin HEAD:main || exit 9
fi
exit "\${FAKE_NPM_EXIT:-0}"
`;

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

function executable(file, text) {
  writeFileSync(file, text);
  chmodSync(file, 0o755);
}

function fixture(t, { releaseHost } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'runlist-release-remote-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), nodeBin = path.join(dir, 'node-bin'), home = path.join(dir, 'home'), state = path.join(dir, 'tmux');
  for (const folder of [bin, nodeBin, home, state, path.join(dir, 'tmp')]) mkdirSync(folder);
  executable(path.join(bin, 'ssh'), FAKE_SSH);
  executable(path.join(bin, 'tmux'), FAKE_TMUX);
  executable(path.join(nodeBin, 'npm'), FAKE_NPM);
  writeFileSync(path.join(state, 'server'), '');

  const source = path.join(dir, 'source');
  mkdirSync(source);
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'runlist', version: '1.2.3' }) + '\n');
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'add', '.');
  git(source, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', '1.2.3');
  const origin = path.join(dir, 'origin.git');
  git(dir, 'clone', '-q', '--bare', source, origin);
  const local = path.join(dir, 'local');
  const remote = path.join(home, 'checkout');
  git(dir, 'clone', '-q', origin, local);
  git(dir, 'clone', '-q', origin, remote);

  const config = path.join(dir, 'release-config.json');
  writeFileSync(config, JSON.stringify({ releaseHost: releaseHost === undefined
    ? { ssh: 'worker-a', checkout: '~/checkout', node: path.join(nodeBin, 'node'), env: { TMPDIR: path.join(dir, 'tmp') } }
    : releaseHost }));
  const env = {
    ...process.env,
    PATH: [bin, process.env.PATH].join(path.delimiter),
    HOME: home,
    RUNLIST_RELEASE_CONFIG: config,
    SSH_LOG: path.join(dir, 'ssh.log'),
    TMUX_STATE: state,
    NPM_LOG: path.join(dir, 'npm.log'),
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const read = file => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  return {
    dir, home, local, remote, state, nodeBin, env,
    calls: () => read(env.SSH_LOG).split('\n').filter(Boolean),
    tmuxCommand: () => read(path.join(state, 'command')),
    originHead: () => git(origin, 'rev-parse', 'main'),
    async run(argv = [], extra = {}) {
      const out = { text: '', write(chunk) { this.text += chunk; return true; } };
      const err = { text: '', write(chunk) { this.text += chunk; return true; } };
      const code = await runRelease({ argv, root: local, env: { ...env, ...extra.env }, platform: extra.platform ?? 'linux', arch: extra.arch ?? 'x64', out, err });
      return { code, out: out.text, err: err.text };
    },
  };
}

// A commit pushed from this checkout leaves the release host's checkout behind origin/main.
function pushLocalCommit(f) {
  writeFileSync(path.join(f.local, 'change.txt'), 'change\n');
  git(f.local, 'add', '.');
  git(f.local, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'change');
  git(f.local, 'push', '-q', 'origin', 'main');
}

test('releaseHost comes only from the private release config and is checked', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runlist-release-host-'));
  try {
    const file = path.join(dir, 'release-config.json');
    const read = value => { writeFileSync(file, JSON.stringify(value)); return readReleaseHost(dir, { RUNLIST_RELEASE_CONFIG: file }).host; };
    assert.equal(readReleaseHost(dir, { RUNLIST_RELEASE_CONFIG: path.join(dir, 'none.json') }).host, null);
    assert.equal(read({ cliHosts: [] }), null);
    assert.deepEqual(read({ releaseHost: { ssh: 'mac-a', checkout: '~/src/runlist' } }), { ssh: 'mac-a', checkout: '~/src/runlist', node: null, env: {} });
    assert.deepEqual(read({ releaseHost: { ssh: 'mac-a', checkout: '/src/runlist', node: '/opt/node/bin/node', env: { TMPDIR: '/tmp' } } }).env, { TMPDIR: '/tmp' });
    for (const releaseHost of ['mac-a', { checkout: '/src' }, { ssh: '-oProxyCommand=x', checkout: '/src' }, { ssh: 'mac-a', checkout: 'relative' },
      { ssh: 'mac-a', checkout: '/src', node: 'node' }, { ssh: 'mac-a', checkout: '/src', env: { PATH: '/bin' } }, { ssh: 'mac-a', checkout: '/src', env: { TMPDIR: 1 } }]) {
      assert.throws(() => read({ releaseHost }), /releaseHost/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the next version follows the bump', () => {
  assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
  assert.throws(() => nextVersion('1.2.3-beta.1', 'patch'));
});

test('off the Mac with no releaseHost the release refuses before any SSH', posixOnly, async t => {
  const f = fixture(t, { releaseHost: null });
  writeFileSync(f.env.RUNLIST_RELEASE_CONFIG, '{}');
  await assert.rejects(f.run(), /qualified Apple Silicon Mac[\s\S]*releaseHost/);
  assert.deepEqual(f.calls(), []);
});

test('a release fast-forwards the release host, runs npm version in its tmux, streams the log and fast-forwards here', posixOnly, async t => {
  const f = fixture(t);
  pushLocalCommit(f);
  const target = f.originHead();
  const { code, out } = await f.run();
  assert.equal(code, 0, out);
  assert.deepEqual(f.calls(), ['worker-a release-host-check', 'worker-a release-host-start', 'worker-a release-host-follow']);
  const log = `${f.home}/runlist-release-1.2.4.log`;
  assert.equal(f.tmuxCommand(), `cd ${f.remote} && export PATH=${f.nodeBin}:${f.home}/.local/bin:"$PATH" TMPDIR=${f.dir}/tmp && npm version patch >> ${log} 2>&1; echo release-exit=$? >> ${log}`);
  assert.match(out, /fast-forwarded to [0-9a-f]{7}/);
  assert.match(out, new RegExp(`npm version patch TMPDIR=${f.dir}/tmp\\n`));
  assert.match(out, /^release-exit=0$/m);
  assert.equal(git(f.remote, 'rev-parse', 'HEAD~1'), target);
  assert.equal(git(f.local, 'rev-parse', 'HEAD'), f.originHead());
  assert.equal(git(f.local, 'log', '-1', '--format=%s'), 'version patch');
});

test('the release exit code passes through and this checkout stays put', posixOnly, async t => {
  const f = fixture(t);
  const before = git(f.local, 'rev-parse', 'HEAD');
  const { code, out } = await f.run(['minor'], { env: { FAKE_NPM_EXIT: '3' } });
  assert.equal(code, 3);
  assert.match(out, /release-exit=3/);
  assert.match(out, /exited 3; resume it from here with: npm run release:resume/);
  assert.match(f.tmuxCommand(), /npm version minor >> \S+runlist-release-1\.3\.0\.log/);
  assert.equal(git(f.local, 'rev-parse', 'HEAD'), before);
});

test('each refusal comes before the bump and leaves the release host unchanged', posixOnly, async t => {
  const cases = [
    { name: 'dirty local tree', setup: f => writeFileSync(path.join(f.local, 'stray.txt'), 'x'), message: /local working tree is dirty/, calls: [] },
    { name: 'unpushed local commit', setup: f => git(f.local, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'local'), message: /not on origin\/main; push them/, calls: [] },
    { name: 'dirty release host', setup: f => writeFileSync(path.join(f.remote, 'stray.txt'), 'x'), message: /checkout on worker-a has 1 uncommitted/ },
    { name: 'release session running', setup: f => writeFileSync(path.join(f.state, 'sessions'), 'runlist-release\n'), message: /release tmux session already runs on worker-a \(runlist-release\)/ },
    { name: 'incomplete release intent', setup: f => writeFileSync(path.join(f.remote, '.git', 'runlist-release-intent.json'), JSON.stringify({ schemaVersion: 1, newVersion: '1.2.4' }, null, 2)), message: /worker-a has incomplete release v1\.2\.4; finish it with: npm run release:resume/ },
    { name: 'no tmux server', setup: f => rmSync(path.join(f.state, 'server')), message: /no tmux server runs on worker-a; start tmux from the Mac's own login/ },
    { name: 'release host unreachable', env: { SSH_DOWN: '1' }, message: /cannot reach worker-a over SSH/ },
  ];
  for (const c of cases) {
    await t.test(c.name, async t => {
      const f = fixture(t);
      pushLocalCommit(f);
      const remoteHead = git(f.remote, 'rev-parse', 'HEAD');
      c.setup?.(f);
      const { code, out } = await f.run([], { env: c.env });
      assert.equal(code, 1, out);
      assert.match(out, c.message);
      assert.deepEqual(f.calls(), c.calls ?? ['worker-a release-host-check']);
      assert.equal(f.tmuxCommand(), '');
      assert.equal(git(f.remote, 'rev-parse', 'HEAD'), remoteHead);
    });
  }
});

test('a dry run checks both checkouts and prints the command without starting or moving anything', posixOnly, async t => {
  const f = fixture(t);
  pushLocalCommit(f);
  const remoteHead = git(f.remote, 'rev-parse', 'HEAD');
  const { code, out } = await f.run(['--dry-run']);
  assert.equal(code, 0, out);
  assert.match(out, /worker-a: tmux server running, no release session, no incomplete release, .* would fast-forward to [0-9a-f]{7}/);
  assert.match(out, /would start v1\.2\.4 on worker-a in tmux session runlist-release: cd .* && npm version patch >> /);
  assert.deepEqual(f.calls(), ['worker-a release-host-check']);
  assert.equal(f.tmuxCommand(), '');
  assert.equal(git(f.remote, 'rev-parse', 'HEAD'), remoteHead);
});

test('--attach follows the newest release log and passes its exit code through', posixOnly, async t => {
  const f = fixture(t);
  const write = (name, text, seconds) => {
    const file = path.join(f.home, name);
    writeFileSync(file, text);
    utimesSync(file, seconds, seconds);
  };
  write('runlist-release-1.2.2.log', 'old\nrelease-exit=0\n', 1_000);
  write('runlist-release-1.2.3.log', 'step one\nstep two\nrelease-exit=5\nafter\n', 2_000);
  write('runlist-release-9.log', 'not a release log\nrelease-exit=0\n', 3_000);
  const { code, out, err } = await f.run(['--attach']);
  assert.equal(code, 5);
  assert.match(err, /following .*runlist-release-1\.2\.3\.log/);
  assert.match(out, /^step one\nstep two\nrelease-exit=5\n/);
  assert.doesNotMatch(out, /after/);
  assert.deepEqual(f.calls(), ['worker-a release-host-follow']);
});

test('a dropped connection says how to re-follow the release', posixOnly, async t => {
  const f = fixture(t);
  const { code, out } = await f.run(['--attach'], { env: { SSH_DROP_FOLLOW: '1' } });
  assert.equal(code, 255);
  assert.match(out, /partial line\n.*before release-exit .*npm run release -- --attach/);
});

test('release:resume forwards to the release host when it holds the intent', posixOnly, async t => {
  const f = fixture(t);
  const none = await f.run(['--resume']);
  assert.equal(none.code, 1);
  assert.match(none.out, /no incomplete release on this host or worker-a/);
  writeFileSync(path.join(f.remote, '.git', 'runlist-release-intent.json'), JSON.stringify({ schemaVersion: 1, newVersion: '1.2.4' }, null, 2));
  const { code, out } = await f.run(['--resume']);
  assert.equal(code, 0, out);
  const log = `${f.home}/runlist-release-1.2.4-resume.log`;
  assert.match(f.tmuxCommand(), new RegExp(`&& npm run release:resume >> ${log} 2>&1; echo release-exit=\\$\\? >> ${log}$`));
  assert.match(out, /npm run release:resume TMPDIR=/);
  assert.deepEqual(f.calls().slice(-3), ['worker-a release-host-check', 'worker-a release-host-start', 'worker-a release-host-follow']);
});

test('release:resume fast-forwards the release host past commits pushed from here', posixOnly, async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.remote, '.git', 'runlist-release-intent.json'), JSON.stringify({ schemaVersion: 1, newVersion: '1.2.4' }, null, 2));
  pushLocalCommit(f);
  const dry = await f.run(['--resume', '--dry-run']);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /would fast-forward to origin\/main/);
  assert.notEqual(git(f.remote, 'rev-parse', 'HEAD'), f.originHead());
  const { code, out } = await f.run(['--resume']);
  assert.equal(code, 0, out);
  assert.match(out, /fast-forwarded to origin\/main/);
  assert.equal(git(f.remote, 'rev-parse', 'HEAD'), f.originHead());
});

test('release:resume keeps an unpushed version commit and refuses a diverged release host', posixOnly, async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.remote, '.git', 'runlist-release-intent.json'), JSON.stringify({ schemaVersion: 1, newVersion: '1.2.4' }, null, 2));
  git(f.remote, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', '1.2.4');
  const ahead = git(f.remote, 'rev-parse', 'HEAD');
  const kept = await f.run(['--resume']);
  assert.equal(kept.code, 0, kept.out);
  assert.equal(git(f.remote, 'rev-parse', 'HEAD'), ahead);
  pushLocalCommit(f);
  const diverged = await f.run(['--resume']);
  assert.equal(diverged.code, 1);
  assert.match(diverged.out, /worker-a and origin\/main [0-9a-f]{7} have diverged; merge origin\/main there/);
  assert.equal(git(f.remote, 'rev-parse', 'HEAD'), ahead);
});

test('on the qualified Mac the release runs npm version in place', posixOnly, async t => {
  const f = fixture(t);
  const { code } = await f.run(['minor'], { platform: 'darwin', arch: 'arm64', env: { PATH: [f.nodeBin, f.env.PATH].join(path.delimiter) } });
  assert.equal(code, 0);
  assert.match(readFileSync(f.env.NPM_LOG, 'utf8'), /^npm version minor /);
  assert.deepEqual(f.calls(), []);
});
