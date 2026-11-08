import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assessCliCopies, checkCliCopies, inspectCliCopies } from '../scripts/check-cli-copies.mjs';
import { checkRemoteCliCopies, installCliHosts, remoteCheckArgs, SHIPPED_FILES } from '../scripts/install-cli-hosts.mjs';

const posixOnly = { skip: process.platform === 'win32' && 'release automation is POSIX-only' };
const home = '/home/u';
const local = `${home}/.local/bin`;
const oldNode = `${home}/.nvm/versions/node/v18.20.0`;

// A host's filesystem and spawns: `executables` maps a path to the version it
// prints, `npms` an npm to its global prefix, `links` a path to its target.
function fakeHost({ executables = {}, npms = {}, links = {}, nodes = [], loginPath, processPath, login, overSsh } = {}) {
  const calls = [];
  const run = (program, args, options) => {
    calls.push({ program, args, options });
    if (program === 'zsh') return login ?? { status: 0, stdout: `Last login: today\n\n__RUNLIST_PATH__${loginPath}\n`, stderr: '' };
    if (Object.hasOwn(npms, program)) {
      return { status: 0, stdout: args[0] === 'prefix' ? `${npms[program]}\n` : `${npms[program]}/lib/node_modules\n`, stderr: '' };
    }
    if (args[0] === '--version') return executables[program] ? { status: 0, stdout: `${executables[program]}\n`, stderr: '' } : { status: 1, stdout: '', stderr: 'boom' };
    throw new Error(`unexpected spawn ${program} ${args.join(' ')}`);
  };
  const deps = {
    env: { PATH: processPath, npm_config_prefix: '/release-shell' },
    platform: 'darwin', home, shell: 'zsh', overSsh,
    exists: file => Object.hasOwn(executables, file) || Object.hasOwn(npms, file),
    readdir: dir => {
      if (dir === `${home}/.nvm/versions/node` && nodes.length) return nodes;
      throw Object.assign(new Error(`ENOENT ${dir}`), { code: 'ENOENT' });
    },
    realpath: file => links[file] ?? file,
    run,
  };
  return { calls, deps };
}

const current = { [`${local}/runlist`]: '1.2.3', [`${local}/rl`]: '1.2.3' };

test('every copy at the release version, resolved by every shell, passes', () => {
  const { deps } = fakeHost({ executables: current, loginPath: `${local}:/usr/bin`, processPath: `/usr/bin:${local}:${local}` });
  const lines = [];
  const result = checkCliCopies('1.2.3', { ...deps, write: line => lines.push(line) });
  assert.equal(result.ok, true, lines.join('\n'));
  assert.deepEqual(result.copies.map(copy => copy.path), [`${local}/runlist`, `${local}/rl`]);
  assert.deepEqual(result.shells.map(shell => shell.resolves), [
    { runlist: `${local}/runlist`, rl: `${local}/rl` },
    { runlist: `${local}/runlist`, rl: `${local}/rl` },
  ]);
  assert.match(lines.join('\n'), /interactive login shell \(zsh -ilc\) runs runlist → \/home\/u\/\.local\/bin\/runlist, rl → \/home\/u\/\.local\/bin\/rl/);
  assert.match(lines.at(-1), /^✓ all 2 runlist and rl copies read 1\.2\.3/);
});

test('a stale npm global under an older nvm Node that no PATH names is owed, with its npm uninstall', () => {
  const { calls, deps } = fakeHost({
    executables: { ...current, [`${oldNode}/bin/runlist`]: '1.0.0', [`${oldNode}/bin/rl`]: '1.0.0' },
    npms: { [`${oldNode}/bin/npm`]: oldNode },
    links: {
      [`${oldNode}/bin/runlist`]: `${oldNode}/lib/node_modules/runlist/bin/runlist.mjs`,
      [`${oldNode}/bin/rl`]: `${oldNode}/lib/node_modules/runlist/bin/runlist.mjs`,
    },
    nodes: ['v22.11.0', 'v18.20.0'],
    loginPath: `${local}:/usr/bin`, processPath: `${local}:/usr/bin`,
  });
  const lines = [];
  const result = checkCliCopies('1.2.3', { ...deps, write: line => lines.push(line) });
  assert.equal(result.ok, false);
  assert.deepEqual(result.stale.map(copy => copy.path), [`${oldNode}/bin/runlist`, `${oldNode}/bin/rl`]);
  const remove = `${oldNode}/bin/npm uninstall -g --prefix ${oldNode} runlist`;
  assert.deepEqual(result.stale.map(copy => copy.remove), [remove, remove]);
  assert.ok(lines.includes(`✗ ${oldNode}/bin/runlist reads 1.0.0, not 1.2.3; remove it with: ${remove}`), lines.join('\n'));
  // The npm probe must not inherit the release shell's npm_config_prefix.
  const npmCalls = calls.filter(call => call.program.endsWith('/npm'));
  assert.deepEqual(npmCalls.map(call => call.args[0]), ['prefix', 'root']);
  for (const call of npmCalls) assert.equal(call.options.env.npm_config_prefix, undefined);
});

test('a shell that runs a stale copy first is owed, and the copy is removed with rm', () => {
  const { deps } = fakeHost({
    executables: { ...current, '/opt/old/bin/runlist': '0.9.0', '/opt/old/bin/rl': '0.9.0' },
    loginPath: `/opt/old/bin:${local}`, processPath: `${local}:/usr/bin`,
  });
  const lines = [];
  const result = checkCliCopies('1.2.3', { ...deps, write: line => lines.push(line) });
  assert.equal(result.ok, false);
  assert.deepEqual(result.shells[0].resolves, { runlist: '/opt/old/bin/runlist', rl: '/opt/old/bin/rl' });
  assert.deepEqual(result.stale.map(copy => copy.remove), ['rm /opt/old/bin/runlist', 'rm /opt/old/bin/rl']);
  assert.match(lines.join('\n'), /interactive login shell \(zsh -ilc\) runs runlist → \/opt\/old\/bin\/runlist/);
});

test('a shell that runs no runlist or rl is owed, as is one whose PATH cannot be read', () => {
  const { deps } = fakeHost({ executables: current, loginPath: `${local}:/usr/bin`, processPath: '/usr/bin', overSsh: true });
  const result = assessCliCopies(inspectCliCopies(deps), '1.2.3');
  assert.equal(result.ok, false);
  assert.deepEqual(result.stale, []);
  assert.deepEqual(result.unresolved, [{ shell: 'non-interactive SSH shell', missing: ['runlist', 'rl'] }]);

  const timedOut = fakeHost({ executables: current, processPath: local, login: { status: null, stdout: 'prompt noise', error: Object.assign(new Error('spawnSync zsh ETIMEDOUT'), { code: 'ETIMEDOUT' }) } });
  const lines = [];
  const unread = checkCliCopies('1.2.3', { ...timedOut.deps, write: line => lines.push(line) });
  assert.equal(unread.ok, false);
  assert.deepEqual(unread.unreadable.map(shell => shell.error), ['timed out after 30 s']);
  assert.match(lines.join('\n'), /✗ interactive login shell \(zsh -ilc\) could not be read/);
});

test('the remote check quotes every argument it sends over SSH', posixOnly, () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'runlist-copies-')));
  try {
    const marker = path.join(dir, 'ran');
    const node = `/opt/my node/$(touch ${marker})/"it's"/\`touch ${marker}\`/node`;
    const args = remoteCheckArgs({ ssh: 'worker-a', node }, '1.2.3');
    assert.deepEqual(args.slice(0, 5), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'worker-a']);
    assert.equal(args.length, 6);
    // Split the command the way the remote login shell does, without running it.
    const split = spawnSync('sh', ['-c', 'eval "set -- $1"; printf "%s\\0" "$@"', 'split', args[5]], { encoding: 'utf8', cwd: dir });
    assert.equal(split.status, 0, split.stderr);
    const argv = split.stdout.split('\0').slice(0, -1);
    assert.equal(argv.length, 6);
    assert.deepEqual([argv[0], argv[1], argv[3], argv[4], argv[5]], ['bash', '-c', 'runlist-check', node, '1.2.3']);
    assert.match(argv[2], /tar -xf - -C "\$work"\n"\$node" "\$work\/scripts\/check-cli-copies\.mjs" --ssh "\$version"$/);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the remote check ships its files from this tree and relays the host report', () => {
  const calls = [];
  const lines = [];
  const bundle = Buffer.from('tar bytes');
  const reply = { status: 1, stdout: '  this process runs runlist → /old/runlist, rl → none\n✗ /old/runlist reads 0.1.0, not 1.2.3\n', stderr: '' };
  const result = checkRemoteCliCopies({ host: { ssh: 'worker-a', node: 'node' }, version: '1.2.3', root: '/checkout', log: line => lines.push(line), run: (program, args, options) => {
    calls.push({ program, args, options });
    return program === 'tar' ? { status: 0, stdout: bundle } : reply;
  } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /reads another version/);
  assert.deepEqual(calls[0].args, ['-cf', '-', '-C', '/checkout', ...SHIPPED_FILES]);
  assert.equal(calls[1].program, 'ssh');
  assert.equal(calls[1].options.input, bundle);
  assert.ok(calls[1].options.timeout > 0);
  assert.deepEqual(lines, ['    this process runs runlist → /old/runlist, rl → none', '  ✗ /old/runlist reads 0.1.0, not 1.2.3']);

  const unreachable = checkRemoteCliCopies({ host: { ssh: 'worker-a', node: 'node' }, version: '1.2.3', log: () => {}, run: program => program === 'tar' ? { status: 0, stdout: bundle } : { status: 255, stdout: '', stderr: 'no route' } });
  assert.deepEqual([unreachable.ok, unreachable.reason], [false, 'unreachable over SSH']);
});

test('a cliHost whose copies are stale after install and refresh stays owed', () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'runlist-copies-')));
  try {
    const file = path.join(dir, 'release-config.json');
    writeFileSync(file, JSON.stringify({ cliHosts: [{ ssh: 'worker-a', checkout: '/srv/runlist' }, { ssh: 'worker-b', checkout: '/srv/runlist' }] }));
    const checked = [];
    const lines = [];
    const { owed } = installCliHosts({
      root: dir, version: '1.2.3', commit: 'a'.repeat(40), env: { RUNLIST_RELEASE_CONFIG: file }, log: line => lines.push(line),
      run: (program, args) => args.at(-1).includes('--input-type=module')
        ? { status: 0, stdout: 'verified\n', stderr: '' }
        : { status: 0, stdout: JSON.stringify({ entry: '/x/bin/runlist.mjs', links: [{ link: '/home/u/.local/bin/runlist', entry: '/x/bin/runlist.mjs', changed: false }] }), stderr: '' },
      checkCopies: ({ host, version }) => {
        checked.push([host.ssh, version]);
        return host.ssh === 'worker-b' ? { ok: false, reason: 'a runlist or rl copy reads another version, or a shell runs none', result: { stderr: '' } } : { ok: true };
      },
    });
    assert.deepEqual(checked, [['worker-a', '1.2.3'], ['worker-b', '1.2.3']]);
    assert.deepEqual(owed, [{ host: 'worker-b', reason: 'a runlist or rl copy reads another version, or a shell runs none' }]);
    assert.match(lines.join('\n'), /1 CLI host\(s\) still owe 1\.2\.3.*npm run release:resume/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
