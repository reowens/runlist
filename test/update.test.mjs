import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { compareVersions, readInstalledPlugin, planMarketplaceRepair, planUpdate, planPluginUpdates, verifyPluginScopeUpdates, verifyManagedHostUpdates, runUpdate, updateOptions, planClaudeProfileUpdates, publishedClaudePluginStatus } from '../src/update.mjs';
import { discoverClaudeProfiles } from '../src/agent-hosts.mjs';
import { installCodexPlugin } from '../src/codex-integration.mjs';
import { installOpencodePlugin, installedVersion } from '../src/host-integration.mjs';
import { detectVersionDrift } from '../src/hud.mjs';
import { verifyInstalledPluginVersion } from '../scripts/verify-installed-plugin.mjs';
import { updateInstalledPluginVersion } from '../scripts/update-installed-plugin.mjs';

function nativeInventory(binary) {
  const candidate = { path: binary, resolvedPath: binary, kind: 'native' };
  return { claude: { selected: candidate, candidates: [candidate], explicit: true },
    codex: { selected: null, candidates: [] }, opencode: { selected: null, candidates: [] } };
}

test('unreadable selected marketplace or settings data never becomes an update command', () => {
  const base = { configDir: '/selected-profile', storeKey: '/selected-store', registryState: 'readable',
    installed: { id: 'runlist@runlist', entries: [{ scope: 'user', version: '1.2.3' }] } };
  for (const extra of [
    { knownMarketplacesState: 'unreadable' },
    { settings: [{ configDir: base.configDir, state: 'unreadable' }] },
  ]) {
    const steps = planClaudeProfileUpdates([{ ...base, ...extra }], nativeInventory('/native/claude').claude);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].kind, 'refusal');
    assert.equal(steps[0].cmd, undefined);
  }
});

async function capturedUpdate(argv, opts) {
  const original = process.stdout.write, exitCode = process.exitCode;
  let stdout = '';
  process.exitCode = 0;
  process.stdout.write = chunk => { stdout += chunk; return true; };
  try {
    const result = await runUpdate(argv, {}, opts);
    return { stdout, stderr: '', status: process.exitCode ?? 0, result };
  } finally { process.stdout.write = original; process.exitCode = exitCode; }
}

test('compareVersions orders semver and tolerates junk', () => {
  assert.equal(compareVersions('0.53.0', '0.54.0'), -1);
  assert.equal(compareVersions('0.54.0', '0.53.0'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1); // numeric, not lexical
  assert.equal(compareVersions('nope', '1.0.0'), null);
  assert.equal(compareVersions('1.0.0', undefined), null);
});

function withHome(fn) {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dotmd-upd-')));
  try {
    const result = fn(home);
    if (result?.then) return result.finally(() => rmSync(home, { recursive: true, force: true }));
    rmSync(home, { recursive: true, force: true }); return result;
  } catch (err) { rmSync(home, { recursive: true, force: true }); throw err; }
}

// Mirrors what `claude plugin install` leaves behind: the install record AND a
// registration for each plugin's marketplace. Pass `marketplaces` to control
// the registry directly (an empty array = the registration is gone).
function writeInstalled(home, plugins, marketplaces) {
  const dir = path.join(home, '.claude', 'plugins');
  mkdirSync(dir, { recursive: true });
  const scoped = Object.fromEntries(Object.entries(plugins).map(([id, entries]) => [id, entries.map(entry => ({ scope: 'user', ...entry }))]));
  writeFileSync(path.join(dir, 'installed_plugins.json'), JSON.stringify({ version: '1', plugins: scoped }));
  const names = marketplaces ?? Object.keys(plugins).map(id => id.split('@')[1]);
  const known = Object.fromEntries(names.map(name => [name, { source: { source: 'github', repo: `x/${name}` } }]));
  writeFileSync(path.join(dir, 'known_marketplaces.json'), JSON.stringify(known));
}

test('readInstalledPlugin finds runlist@runlist', () => {
  withHome((home) => {
    writeInstalled(home, { 'runlist@runlist': [{ version: '0.54.0' }], 'grepmax@grepmax': [{ version: '0.17.17' }] });
    assert.deepEqual(readInstalledPlugin({ home }), { id: 'runlist@runlist', entries: [{ scope: 'user', version: '0.54.0' }], version: '0.54.0', marketplace: 'runlist', marketplaceRegistered: true });
  });
});

test('readInstalledPlugin recognizes the old ID and prefers the renamed plugin when both exist', () => {
  withHome((home) => {
    writeInstalled(home, { 'dotmd@dotmd': [{ version: '0.89.2' }] });
    assert.equal(readInstalledPlugin({ home }).id, 'dotmd@dotmd');
    writeInstalled(home, {
      'dotmd@dotmd': [{ version: '0.89.2' }],
      'runlist@runlist': [{ version: '0.89.3' }],
    });
    assert.equal(readInstalledPlugin({ home }).id, 'runlist@runlist');
  });
});

test('planUpdate migrates the old Claude plugin before uninstalling it', () => {
  const plugin = { id: 'dotmd@dotmd', version: '0.89.2', marketplace: 'dotmd', marketplaceRegistered: true };
  const steps = planUpdate({ pluginOnly: true }, { plugin, hasClaude: true, hasNpm: true });
  assert.deepEqual(steps.map(s => s.cmd.join(' ')), [
    'claude plugin marketplace add reowens/runlist',
    'claude plugin install runlist@runlist',
    'claude plugin uninstall dotmd@dotmd',
  ]);
  assert.equal(steps[2].needs, 'plugin');
});

test('readInstalledPlugin falls back to any dotmd@* marketplace', () => {
  withHome((home) => {
    writeInstalled(home, { 'dotmd@other': [{ version: '0.50.0' }] });
    assert.deepEqual(readInstalledPlugin({ home }), { id: 'dotmd@other', entries: [{ scope: 'user', version: '0.50.0' }], version: '0.50.0', marketplace: 'other', marketplaceRegistered: true });
  });
});

// The state `claude plugin list` renders as "failed to load: Marketplace dotmd
// not found": the install record survived, the registration did not. Calling
// that "installed" is what made `dotmd install claude` skip the repair.
test('readInstalledPlugin reports an install record whose marketplace is unregistered', () => {
  withHome((home) => {
    writeInstalled(home, { 'runlist@runlist': [{ version: '0.77.1' }] }, ['grepmax']);
    assert.equal(readInstalledPlugin({ home }).marketplaceRegistered, false);
    // No registry file at all reads the same way — nothing can load from it.
    rmSync(path.join(home, '.claude', 'plugins', 'known_marketplaces.json'));
    assert.equal(readInstalledPlugin({ home }).marketplaceRegistered, false);
  });
});

test('planMarketplaceRepair re-adds the marketplace before the plugin verb, and only for a source it knows', () => {
  const broken = { id: 'runlist@runlist', version: '0.77.1', marketplace: 'runlist', marketplaceRegistered: false };
  const steps = planMarketplaceRepair(broken, { hasClaude: true, verb: 'update' });
  assert.deepEqual(steps.map(s => s.kind), ['marketplace', 'plugin']);
  assert.deepEqual(steps[0].cmd, ['claude', 'plugin', 'marketplace', 'add', 'reowens/runlist']);
  assert.deepEqual(steps[1].cmd, ['claude', 'plugin', 'update', 'runlist@runlist']);
  assert.equal(steps[1].needs, 'marketplace');

  const manual = planMarketplaceRepair(broken, { hasClaude: false, verb: 'update' });
  assert.equal(manual[0].kind, 'manual');
  assert.deepEqual(manual[0].lines, ['/plugin marketplace add reowens/runlist', '/plugin update runlist@runlist']);

  const foreign = planMarketplaceRepair({ ...broken, id: 'dotmd@other', marketplace: 'other' }, { hasClaude: true, verb: 'update' });
  assert.equal(foreign[0].kind, 'skip');
  assert.match(foreign[0].reason, /does not know its source/);
});

test('planUpdate: unregistered marketplace → re-add it, then update', () => {
  const plugin = { id: 'runlist@runlist', version: '0.77.1', marketplace: 'runlist', marketplaceRegistered: false };
  const steps = planUpdate({ pluginOnly: true }, { plugin, hasClaude: true, hasNpm: true });
  assert.deepEqual(steps.map(s => s.kind), ['marketplace', 'plugin']);
});

test('readInstalledPlugin returns null when absent', () => {
  withHome((home) => {
    assert.equal(readInstalledPlugin({ home }), null); // no file
    writeInstalled(home, { 'grepmax@grepmax': [{ version: '0.17.17' }] });
    assert.equal(readInstalledPlugin({ home }), null); // no dotmd
  });
});

test('verifyInstalledPluginVersion requires an exact installed version', () => {
  withHome((home) => {
    writeInstalled(home, { 'runlist@runlist': [{ version: '0.69.0' }] });
    assert.equal(verifyInstalledPluginVersion('0.69.0', { home }).ok, true);
    assert.deepEqual(verifyInstalledPluginVersion('0.70.0', { home }), {
      ok: false,
      reason: 'runlist@runlist has 0.69.0, expected 0.70.0',
    });
  });
});

test('verifyInstalledPluginVersion reports a missing plugin', () => {
  withHome((home) => {
    assert.deepEqual(verifyInstalledPluginVersion('0.69.0', { home }), {
      ok: false,
      reason: 'runlist@runlist plugin is not installed',
    });
  });
});

test('verifyInstalledPluginVersion rejects alternate or mixed installed scopes', () => {
  withHome((home) => {
    writeInstalled(home, { 'dotmd@other': [{ version: '0.69.0' }] });
    assert.equal(verifyInstalledPluginVersion('0.69.0', { home }).ok, false);

    writeInstalled(home, { 'runlist@runlist': [{ version: '0.69.0' }, { version: '0.68.0' }] });
    assert.deepEqual(verifyInstalledPluginVersion('0.69.0', { home }), {
      ok: false,
      reason: 'runlist@runlist has 0.68.0, expected 0.69.0',
    });
  });
});

test('planUpdate: both halves when tools present and plugin installed', () => {
  const steps = planUpdate({}, { plugin: { id: 'runlist@runlist', version: '0.53.0' }, hasClaude: true, hasNpm: true });
  assert.deepEqual(steps.map(s => s.kind), ['cli', 'plugin']);
  assert.deepEqual(steps[0].cmd, ['npm', 'i', '-g', 'runlist@latest']);
  assert.deepEqual(steps[1].cmd, ['claude', 'plugin', 'update', 'runlist@runlist']);
});

test('planUpdate: --cli-only / --plugin-only restrict the steps', () => {
  const ctx = { plugin: { id: 'runlist@runlist', version: '0.53.0' }, hasClaude: true, hasNpm: true };
  assert.deepEqual(planUpdate({ cliOnly: true }, ctx).map(s => s.kind), ['cli']);
  assert.deepEqual(planUpdate({ pluginOnly: true }, ctx).map(s => s.kind), ['plugin']);
});

test('planUpdate: missing claude → plugin step becomes a skip with guidance', () => {
  const steps = planUpdate({ pluginOnly: true }, { plugin: { id: 'runlist@runlist', version: '0.53.0' }, hasClaude: false, hasNpm: true });
  assert.equal(steps[0].kind, 'skip');
  assert.match(steps[0].reason, /\/plugin update runlist@runlist/);
});

test('planUpdate: plugin not installed → skip', () => {
  const steps = planUpdate({ pluginOnly: true }, { plugin: null, hasClaude: true, hasNpm: true });
  assert.equal(steps[0].kind, 'skip');
  assert.match(steps[0].reason, /not installed/);
});

test('updates all recorded scopes at their projects, deduplicating only the same registration', () => {
  withHome(home => {
    const a = path.join(home, 'project one');
    const b = path.join(home, 'project two');
    const entries = [{ scope: 'user' }, { scope: 'project', projectPath: a }, { scope: 'local', projectPath: a },
      { scope: 'project', projectPath: b }, { scope: 'project', projectPath: a }];
    const plugin = { id: 'runlist@runlist', entries, marketplace: 'runlist', marketplaceRegistered: true };
    const steps = planUpdate({ pluginOnly: true }, { plugin, hasClaude: true });
    assert.deepEqual(steps.map(step => [step.cmd.at(-1), step.cwd]), [['user', undefined], ['project', a], ['local', a], ['project', b]]);
    assert.ok(steps.every(step => step.cmd.at(-2) === '--scope'));
    const repaired = planMarketplaceRepair({ ...plugin, marketplaceRegistered: false }, { hasClaude: true, verb: 'update' });
    assert.deepEqual(repaired.slice(1), steps.map(step => ({ ...step, needs: 'marketplace' })));
  });
});

test('unsupported scopes and missing project identities do not fall back to the current project or user', () => {
  const steps = planPluginUpdates({ id: 'runlist@runlist', entries: [
    { scope: 'managed' }, { scope: 'project' }, { scope: 'local', projectPath: 'relative' }, { scope: 'unknown' }, { scope: 'user' },
  ] });
  assert.deepEqual(steps.map(step => step.kind), ['refusal', 'refusal', 'refusal', 'refusal', 'plugin']);
  assert.deepEqual(steps.at(-1).cmd.slice(-2), ['--scope', 'user']);
});

test('fresh verification detects lost scopes, mixed versions and stale no-op updates', () => {
  withHome(home => {
    const before = { id: 'runlist@runlist', entries: [{ scope: 'user', version: '1.0.0' },
      { scope: 'project', projectPath: home, version: '0.9.0' }] };
    const check = after => verifyPluginScopeUpdates(before, after, { expectedVersion: '1.0.0' });
    assert.match(check({ ...before, entries: [before.entries[0]] }).reason, /registration disappeared/);
    assert.match(check(before).reason, /project .*has 0.9.0/);
    assert.equal(verifyPluginScopeUpdates(before, before).ok, false);
    const current = { ...before, entries: before.entries.map(entry => ({ ...entry, version: '1.0.0' })) };
    assert.deepEqual(check(current), { ok: true });
    assert.equal(check({ ...current, entries: [...current.entries, { scope: 'local', projectPath: home, version: '0.8.0' }] }).ok, false);
  });
});

test('release updater executes and verifies every scope without trusting command exit alone', () => {
  withHome(home => {
    const project = path.join(home, 'project with spaces');
    mkdirSync(project);
    let entries = [{ scope: 'user', version: '0.9.0' }, { scope: 'project', projectPath: project, version: '0.8.0' }];
    writeInstalled(home, { 'runlist@runlist': entries });
    const calls = [];
    const result = updateInstalledPluginVersion('1.0.0', { home, executables: nativeInventory('claude'), log() {}, run(command, args, options) {
      calls.push([command, args, options.cwd]);
      const scope = args.at(-1);
      entries = entries.map(entry => entry.scope === scope ? { ...entry, version: '1.0.0' } : entry);
      writeInstalled(home, { 'runlist@runlist': entries });
      return { status: 0 };
    } });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls.map(([, args, cwd]) => [args.at(-1), cwd]), [['user', undefined], ['project', project]]);
    assert.equal(verifyInstalledPluginVersion('1.0.0', { home }).ok, true);
    entries[1].version = '0.8.0';
    writeInstalled(home, { 'runlist@runlist': entries });
    assert.match(updateInstalledPluginVersion('1.0.0', { home, executables: nativeInventory('claude'), log() {}, run: () => ({ status: 0 }) }).reason, /project .*has 0.8.0/);
  });
});

test('release updater continues independent scopes after a failure and retains project-specific diagnostics', () => {
  withHome(home => {
    const project = path.join(home, 'missing project');
    let entries = [{ scope: 'project', projectPath: project, version: '0.8.0' }, { scope: 'user', version: '0.9.0' }];
    writeInstalled(home, { 'runlist@runlist': entries });
    const calls = [];
    const result = updateInstalledPluginVersion('1.0.0', { home, executables: nativeInventory('claude'), log() {}, run(command, args, options) {
      calls.push(args.at(-1));
      if (options.cwd) return { status: null, error: new Error('project unavailable') };
      entries[1].version = '1.0.0';
      writeInstalled(home, { 'runlist@runlist': entries });
      return { status: 0 };
    } });
    assert.deepEqual(calls, ['project', 'user']);
    assert.equal(result.ok, false);
    assert.match(result.reason, /project unavailable/);
    assert.ok(result.reason.includes(project));
  });
});

test('update check and dry-run expose all scope versions and execution directories', async () => {
  await withHome(async home => {
    const project = path.join(home, 'project with spaces');
    mkdirSync(project);
    writeInstalled(home, { 'runlist@runlist': [{ scope: 'user', version: '99.0.0' }, { scope: 'project', projectPath: project, version: '0.1.0' }] });
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'runlist.mjs');
    const env = { ...process.env, CLAUDE_CONFIG_DIR: undefined, HOME: home, USERPROFILE: home, NO_COLOR: '1' };
    const check = spawnSync(process.execPath, [bin, 'update', '--check'], { cwd: home, encoding: 'utf8', env });
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /99.0.0 .*user/);
    assert.match(check.stdout, /0.1.0 .*project .*behind/);
    const fakeBin = path.join(home, 'bin');
    mkdirSync(fakeBin);
    const fakeClaude = path.join(fakeBin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    writeFileSync(fakeClaude, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
    chmodSync(fakeClaude, 0o755);
    const run = args => capturedUpdate(['--plugin-only', ...args], { home, env, executables: nativeInventory(fakeClaude), expectedVersion: JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version });
    const dry = await run(['--dry-run']);
    assert.equal(dry.status, 0, dry.stdout);
    assert.match(dry.stdout, /--scope user/);
    assert.ok(dry.stdout.includes(`--scope project (in ${project})`));
    const noOp = await run([]);
    assert.equal(noOp.status, 1, noOp.stdout + noOp.stderr);
    assert.match(noOp.stdout, /project .*has 0.1.0/);
  });
});

test('updater and marketplace install repair execute each scope at its recorded directory', async () => {
  await withHome(async home => {
    const first = path.join(home, 'first project');
    const second = path.join(home, 'second project');
    const fakeBin = path.join(home, 'bin');
    for (const dir of [first, second, fakeBin]) mkdirSync(dir);
    const entries = [{ scope: 'user', version: '0.1.0' }, { scope: 'project', projectPath: first, version: '0.1.0' },
      { scope: 'local', projectPath: second, version: '0.1.0' }];
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
    const trace = path.join(home, 'calls.jsonl');
    const script = path.join(fakeBin, 'fake-claude.cjs');
    writeFileSync(script, `const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const home = ${JSON.stringify(home)};
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[1] === 'marketplace') {
  fs.writeFileSync(path.join(home, '.claude/plugins/known_marketplaces.json'), JSON.stringify({runlist: {source: {source: 'github', repo: 'example/runlist'}}}));
} else if (args[1] === 'update') {
  const file = path.join(home, '.claude/plugins/installed_plugins.json');
  const records = JSON.parse(fs.readFileSync(file));
  const scope = args[args.indexOf('--scope') + 1];
  for (const entry of records.plugins['runlist@runlist']) {
    if (entry.scope === scope && (scope === 'user' || entry.projectPath === process.cwd())) entry.version = ${JSON.stringify(version)};
  }
  fs.writeFileSync(file, JSON.stringify(records));
}
`);
    const wrapper = path.join(fakeBin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    writeFileSync(wrapper, process.platform === 'win32' ? `@"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'runlist.mjs');
    const env = { ...process.env, CLAUDE_CONFIG_DIR: undefined, HOME: home, USERPROFILE: home, NO_COLOR: '1', PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` };
    for (const args of [['update', '--plugin-only'], ['install', 'claude']]) {
      writeInstalled(home, { 'runlist@runlist': entries }, args[0] === 'install' ? [] : ['runlist']);
      writeFileSync(trace, '');
      const result = args[0] === 'update' ? await capturedUpdate(args.slice(1), { home, env, executables: nativeInventory(wrapper), run: (command, args, options) => spawnSync(command, args, { cwd: home, ...options }) })
        : spawnSync(process.execPath, [bin, ...args], { cwd: home, encoding: 'utf8', env });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const calls = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const updates = calls.filter(call => call.args[1] === 'update');
      assert.deepEqual(updates.map(call => [call.args.at(-1), call.cwd]), [['user', home], ['project', first], ['local', second]]);
      assert.equal(verifyInstalledPluginVersion(version, { home }).ok, true);
      if (args[0] === 'install') assert.equal(calls[0].args[1], 'marketplace');
    }
  });
});

test('update --dry-run previews global commands without executing them', () => {
  withHome((home) => {
    writeInstalled(home, { 'runlist@runlist': [{ version: '0.69.0' }] });
    const fakeBin = path.join(home, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    const sentinel = path.join(home, 'executed');
    for (const name of ['npm', 'claude']) {
      const file = path.join(fakeBin, process.platform === 'win32' ? `${name}.cmd` : name);
      if (process.platform === 'win32') writeFileSync(file, `@echo called > ${JSON.stringify(sentinel)}\r\n`);
      else {
        writeFileSync(file, `#!/bin/sh\nprintf called > ${JSON.stringify(sentinel)}\n`);
        chmodSync(file, 0o755);
      }
    }
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'update', '--dry-run'], {
      cwd: home,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: undefined, HOME: home, USERPROFILE: home, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[dry-run\] Would run: npm i -g/);
    assert.match(result.stdout, /\[dry-run\] Refused: cannot establish wrapper-to-profile mapping/);
    assert.equal(existsSync(sentinel), false);
  });
});

// A failed `claude plugin update` says nothing about the OpenCode file. The
// loop used to stop at the first failure, so OpenCode stayed stale and the
// output never said so.
test('update runs every host step past a failed one, then exits 1 naming the failure', () => {
  withHome((home) => {
    writeInstalled(home, { 'runlist@runlist': [{ version: '0.1.0' }] });
    const fakeBin = path.join(home, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    const claude = path.join(fakeBin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    if (process.platform === 'win32') writeFileSync(claude, '@exit /b 1\r\n');
    else { writeFileSync(claude, '#!/bin/sh\nexit 1\n'); chmodSync(claude, 0o755); }

    const ocDir = path.join(home, 'oc');
    const stale = installOpencodePlugin({ version: '0.1.0', env: { OPENCODE_CONFIG_DIR: ocDir }, homedir: home });
    assert.equal(installedVersion(stale.path), '0.1.0');

    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    const result = spawnSync('node', [bin, 'update', '--plugin-only'], {
      cwd: home,
      encoding: 'utf8',
      env: {
        ...process.env, CLAUDE_CONFIG_DIR: undefined, NO_COLOR: '1', HOME: home, USERPROFILE: home, OPENCODE_CONFIG_DIR: ocDir,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /cannot establish wrapper-to-profile mapping/);
    assert.match(result.stdout, /updated opencode integration/);
    assert.match(result.stdout, /1 step failed: cannot establish wrapper-to-profile mapping/);
    assert.notEqual(installedVersion(stale.path), '0.1.0');
  });
});

test('managed host verification rejects no-op updates, disappeared installs and stale Codex caches', () => {
  const current = { exists: true, version: '1.0.0', stale: false };
  const before = { opencode: current, codex: current };
  const after = { opencode: current, codex: { ...current, installed: { ok: true, version: '1.0.0' } } };
  assert.deepEqual(verifyManagedHostUpdates(before, after, '1.0.0'), []);
  assert.match(verifyManagedHostUpdates(before, { ...after, opencode: { ...current, version: '0.9.0' } }, '1.0.0').join(), /opencode.*expected 1.0.0/);
  assert.match(verifyManagedHostUpdates(before, { ...after, codex: { ...current, installed: { ok: true, version: '0.9.0' } } }, '1.0.0').join(), /Codex installed plugin.*0.9.0/);
  assert.equal(verifyManagedHostUpdates(before, {}, '1.0.0').length, 3);
  assert.deepEqual(verifyManagedHostUpdates({ opencode: { ...current, foreign: true } }, {}, '1.0.0'), []);
});

function writeNodeCommand(dir, name, body) {
  const script = path.join(dir, `${name}.cjs`);
  writeFileSync(script, body);
  const wrapper = path.join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
  writeFileSync(wrapper, process.platform === 'win32' ? `@"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(wrapper, 0o755);
}

test('self-update refreshes initially current hosts using the new CLI and assets, even with a different runlist on PATH', () => {
  withHome(home => {
    const root = path.resolve(import.meta.dirname, '..');
    const fixture = path.join(home, 'cli with spaces');
    const fakeBin = path.join(home, 'bin');
    mkdirSync(fixture); mkdirSync(fakeBin);
    for (const dir of ['bin', 'src', 'assets', 'plugins/runlist-codex']) cpSync(path.join(root, dir), path.join(fixture, dir), { recursive: true });
    const oldVersion = JSON.parse(readFileSync(path.join(root, 'package.json'))).version;
    const newVersion = '9.8.7';
    writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module', version: oldVersion }));
    const ocDir = path.join(home, 'oc');
    const oc = installOpencodePlugin({ version: oldVersion, env: { OPENCODE_CONFIG_DIR: ocDir }, homedir: home });
    installCodexPlugin({ version: oldVersion, homedir: home });
    const installed = path.join(home, 'installed-codex-version');
    writeFileSync(installed, oldVersion);
    writeNodeCommand(fakeBin, 'npm', `const fs = require('node:fs');
const root = ${JSON.stringify(fixture)};
fs.writeFileSync(root + '/package.json', JSON.stringify({type: 'module', version: ${JSON.stringify(newVersion)}}));
const plugin = root + '/plugins/runlist-codex/.codex-plugin/plugin.json';
const manifest = JSON.parse(fs.readFileSync(plugin)); manifest.version = ${JSON.stringify(newVersion)};
fs.writeFileSync(plugin, JSON.stringify(manifest));
fs.appendFileSync(root + '/assets/opencode/plugin.js', '\\n// new release asset\\n');`);
    writeNodeCommand(fakeBin, 'codex', `const fs = require('node:fs');
const installed = ${JSON.stringify(installed)};
if (process.argv[3] === 'add') fs.writeFileSync(installed, JSON.parse(fs.readFileSync(${JSON.stringify(path.join(home, 'plugins/runlist-codex/.codex-plugin/plugin.json'))})).version);
if (process.argv[3] === 'list') console.log(JSON.stringify({installed: [{pluginId: 'runlist-codex@personal', installed: true, version: fs.readFileSync(installed, 'utf8')}]}));`);
    const sentinel = path.join(home, 'wrong-cli-used');
    writeNodeCommand(fakeBin, 'runlist', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'wrong'); process.exitCode = 1;`);
    const result = spawnSync(process.execPath, [path.join(fixture, 'bin/runlist.mjs'), 'update'], {
      cwd: home, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: undefined, HOME: home, USERPROFILE: home, OPENCODE_CONFIG_DIR: ocDir,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, NO_COLOR: '1' },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(installedVersion(oc.path), newVersion);
    assert.match(readFileSync(oc.path, 'utf8'), /new release asset/);
    assert.equal(readFileSync(installed, 'utf8'), newVersion);
    assert.equal(existsSync(sentinel), false);
  });
});

test('release host updater refuses a version mismatch before touching installations', () => {
  withHome(home => {
    const root = path.resolve(import.meta.dirname, '..');
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/update-installed-hosts.mjs'), '0.0.0'], {
      cwd: home, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: undefined, HOME: home, USERPROFILE: home },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /host update requires this CLI version/);
    assert.equal(existsSync(path.join(home, 'plugins')), false);
  });
});

test('release host updater repairs cache-only drift after a Claude failure and rejects a successful Codex no-op', () => {
  withHome(home => {
    const root = path.resolve(import.meta.dirname, '..');
    const version = JSON.parse(readFileSync(path.join(root, 'package.json'))).version;
    const fakeBin = path.join(home, 'bin'); mkdirSync(fakeBin);
    const cache = path.join(home, 'codex-cache-version');
    writeNodeCommand(fakeBin, 'claude', 'process.exitCode = 1;');
    writeNodeCommand(fakeBin, 'codex', `const fs = require('node:fs');
const file = ${JSON.stringify(cache)};
if (process.argv[3] === 'add' && process.env.CODEX_NOOP !== '1') fs.writeFileSync(file, ${JSON.stringify(version)});
if (process.argv[3] === 'list') console.log(JSON.stringify({installed: [{pluginId: 'runlist-codex@personal', installed: true, version: fs.readFileSync(file, 'utf8')}]}));`);
    installCodexPlugin({ version, homedir: home }); // source is already current
    writeInstalled(home, { 'runlist@runlist': [{ version: '0.1.0' }] });
    const ocDir = path.join(home, 'oc');
    for (const noOp of [false, true]) {
      writeFileSync(cache, '0.1.0');
      const oc = installOpencodePlugin({ version: '0.1.0', env: { OPENCODE_CONFIG_DIR: ocDir }, homedir: home });
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/update-installed-hosts.mjs'), version], {
        cwd: home, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: undefined, HOME: home, USERPROFILE: home, OPENCODE_CONFIG_DIR: ocDir,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, NO_COLOR: '1', CODEX_NOOP: noOp ? '1' : '0' },
      });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /cannot establish wrapper-to-profile mapping/);
      assert.equal(installedVersion(oc.path), version, 'an independent host failure must not strand OpenCode');
      assert.equal(readFileSync(cache, 'utf8'), noOp ? '0.1.0' : version);
      assert.ok(!result.stdout.includes('Installed host integrations verified'));
      if (noOp) assert.match(result.stdout + result.stderr, /Codex.*has 0.1.0, expected/);
    }
  });
});

test('release attempts desktop after a host failure and clears intent only when both phases succeed', { skip: process.platform === 'win32' && 'release automation is POSIX-only' }, () => {
  withHome(home => {
    const script = readFileSync(new URL('../scripts/postversion.sh', import.meta.url), 'utf8');
    const phase = script.slice(script.indexOf('echo "→ refreshing and verifying installed host integrations"'));
    const calls = path.join(home, 'calls');
    writeNodeCommand(home, 'node', `const fs = require('node:fs');
const name = process.argv[2]; fs.appendFileSync(${JSON.stringify(calls)}, name + '\\n');
if (name.endsWith('update-installed-hosts.mjs')) process.exitCode = Number(process.env.HOST_EXIT);
if (name.endsWith('release-desktop.mjs')) process.exitCode = Number(process.env.DESKTOP_EXIT);`);
    for (const [hosts, desktop] of [[1, 0], [0, 1], [0, 0]]) {
      writeFileSync(calls, '');
      const result = spawnSync('bash', ['-c', `set -euo pipefail\nrelease_failed() { echo resumable >&2; }\ntrap release_failed ERR\nVERSION=1.0.0\nSHA=fixture\nPACKAGE=runlist\n${phase}`], {
        encoding: 'utf8', env: { ...process.env, PATH: `${home}${path.delimiter}${process.env.PATH}`, HOST_EXIT: String(hosts), DESKTOP_EXIT: String(desktop) },
      });
      assert.equal(result.status, hosts || desktop ? 1 : 0, result.stdout + result.stderr);
      const executed = readFileSync(calls, 'utf8');
      assert.ok(executed.includes('scripts/update-installed-hosts.mjs'));
      assert.ok(executed.includes('scripts/release-desktop.mjs'));
      assert.equal(executed.includes('scripts/release-intent.mjs'), hosts === 0 && desktop === 0);
      if (hosts || desktop) assert.match(result.stderr, /resumable/);
    }
  });
});

// --- hud version-drift detector ---

function withPluginRoot(version, underCache, fn) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'dotmd-pr-'));
  const root = underCache
    ? path.join(base, '.claude', 'plugins', 'cache', 'runlist', 'runlist', version)
    : path.join(base, 'dev', 'plugins', 'runlist');
  mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'runlist', version }));
  try { return fn(root); } finally { rmSync(base, { recursive: true, force: true }); }
}

test('detectVersionDrift: silent when CLAUDE_PLUGIN_ROOT unset', () => {
  assert.equal(detectVersionDrift({}), null);
});

test('detectVersionDrift: silent for directory-source (not under cache)', () => {
  // A very old version, but a non-cache path → no nag (content tracks live).
  withPluginRoot('0.0.1', false, (root) => {
    assert.equal(detectVersionDrift({ CLAUDE_PLUGIN_ROOT: root }), null);
  });
});

test('detectVersionDrift: warns when cached plugin is behind the CLI', () => {
  withPluginRoot('0.0.1', true, (root) => {
    const msg = detectVersionDrift({ CLAUDE_PLUGIN_ROOT: root });
    assert.match(msg, /plugin 0\.0\.1 is behind the CLI/);
    assert.match(msg, /runlist update/);
  });
});

test('detectVersionDrift: warns when CLI is behind a newer cached plugin', () => {
  withPluginRoot('99.0.0', true, (root) => {
    const msg = detectVersionDrift({ CLAUDE_PLUGIN_ROOT: root });
    assert.match(msg, /CLI .* is behind the plugin 99\.0\.0/);
  });
});

function writeProfile(configDir, entries, { catalog, official = true } = {}) {
  const plugins = path.join(configDir, 'plugins');
  mkdirSync(plugins, { recursive: true });
  writeFileSync(path.join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: { 'runlist@runlist': entries } }));
  writeFileSync(path.join(plugins, 'known_marketplaces.json'), JSON.stringify({ runlist: {
    source: { source: 'github', repo: official ? 'reowens/runlist' : 'other/runlist' }, ...(catalog ? { installLocation: catalog } : {}),
  } }));
}

function fakeProfileUpdate(command, args, options) {
  if (args[1] === 'update') {
    const file = path.join(options.env.CLAUDE_CONFIG_DIR, 'plugins/installed_plugins.json');
    const registry = JSON.parse(readFileSync(file));
    for (const entry of registry.plugins['runlist@runlist']) {
      if (entry.scope === args.at(-1) && (entry.scope === 'user' || entry.projectPath === options.cwd)) entry.version = '1.2.3';
    }
    writeFileSync(file, JSON.stringify(registry));
  }
  return { status: 0 };
}

test('host selection is host-only and selector validation fails before any work', () => {
  assert.equal(updateOptions(['--host', 'codex']).pluginOnly, true);
  assert.throws(() => updateOptions(['--host', 'codex', '--cli-only']), /conflicts/);
  assert.throws(() => updateOptions(['--host', 'elsewhere']), /must be/);
  assert.throws(() => updateOptions(['--claude-config', 'relative']), /absolute/);
  assert.throws(() => updateOptions(['--claude-bin']), /requires a value/);
});

test('offline JSON check and dry-run never execute discovered host binaries', async () => {
  await withHome(async home => {
    const bin = path.join(home, 'bin'); mkdirSync(bin);
    const sentinel = path.join(home, 'executed');
    for (const name of ['claude', 'codex', 'opencode', 'npm']) writeNodeCommand(bin, name,
      `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');`);
    writeProfile(path.join(home, '.claude'), [{ scope: 'user', version: '1.2.3' }]);
    const env = { HOME: home, USERPROFILE: home, PATH: bin };
    const check = await capturedUpdate(['--check', '--json'], { home, env, run() { throw new Error('offline execution'); } });
    const report = JSON.parse(check.stdout);
    assert.equal(report.offline, true);
    assert.equal(report.hostReport.hosts.claude.loaded, 'unknown');
    assert.equal(report.hostReport.executables.claude.candidates.length, 1);
    assert.equal(report.hostReport.hosts.claude.profiles[0].plugins[0].catalog.state, 'unknown');
    await capturedUpdate(['--host', 'claude', '--dry-run'], { home, env, run() { throw new Error('preview execution'); } });
    assert.equal(existsSync(sentinel), false);
  });
});

test('selected Claude profiles use the exact executable, environment and scoped project directory', async () => {
  await withHome(async home => {
    const defaultProfile = path.join(home, '.claude');
    const selectedProfile = path.join(home, '.claude-work');
    const project = path.join(home, 'project'); mkdirSync(project);
    writeProfile(defaultProfile, [{ scope: 'user', version: '0.1.0' }]);
    writeProfile(selectedProfile, [{ scope: 'user', version: '0.1.0' }, { scope: 'project', projectPath: project, version: '0.1.0' }]);
    writeFileSync(path.join(selectedProfile, 'unmanaged.txt'), 'keep');
    const binary = path.join(home, 'native executable');
    const calls = [];
    const result = await capturedUpdate(['--host', 'claude', '--claude-config', selectedProfile], {
      home, env: { PATH: '', CLAUDE_CONFIG_DIR: defaultProfile }, executables: nativeInventory(binary), expectedVersion: '1.2.3',
      run(command, args, options) { calls.push({ command, args, options }); return fakeProfileUpdate(command, args, options); },
    });
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(calls.map(call => call.args.slice(0, 3)), [['plugin', 'marketplace', 'update'], ['plugin', 'update', 'runlist@runlist'], ['plugin', 'update', 'runlist@runlist']]);
    assert.ok(calls.every(call => call.command === binary && call.options.env.CLAUDE_CONFIG_DIR === selectedProfile));
    assert.equal(calls.at(-1).options.cwd, project);
    assert.equal(readInstalledPlugin({ home, configDir: defaultProfile }).version, '0.1.0');
    assert.equal(readFileSync(path.join(selectedProfile, 'unmanaged.txt'), 'utf8'), 'keep');
  });
});

test('shared physical Claude stores update once and an explicitly selected alias supplies the environment', { skip: process.platform === 'win32' && 'requires directory symlinks' }, async () => {
  await withHome(async home => {
    const original = path.join(home, '.claude'), alias = path.join(home, '.claude-shared');
    writeProfile(original, [{ scope: 'user', version: '0.1.0' }]);
    mkdirSync(alias); symlinkSync(path.join(original, 'plugins'), path.join(alias, 'plugins'), 'dir');
    const calls = [];
    const opts = { home, env: { PATH: '' }, executables: nativeInventory('/injected/native'), expectedVersion: '1.2.3',
      run(command, args, options) { calls.push(options.env.CLAUDE_CONFIG_DIR); return fakeProfileUpdate(command, args, options); } };
    const result = await capturedUpdate(['--host', 'claude', '--claude-config', alias], opts);
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(calls, [alias, alias]);
    calls.length = 0;
    await capturedUpdate(['--host', 'claude'], opts);
    assert.deepEqual(calls, [original, original]);
  });
});

test('marketplace failure blocks only its own store and fresh verification checks every installed scope', async () => {
  await withHome(async home => {
    const first = path.join(home, '.claude'), second = path.join(home, '.claude-work');
    writeProfile(first, [{ scope: 'user', version: '0.1.0' }]);
    writeProfile(second, [{ scope: 'user', version: '0.1.0' }]);
    const calls = [];
    const result = await capturedUpdate(['--host', 'claude'], {
      home, env: { PATH: '' }, executables: nativeInventory('/injected/native'), expectedVersion: '1.2.3',
      run(command, args, options) {
        calls.push([options.env.CLAUDE_CONFIG_DIR, args[1]]);
        if (options.env.CLAUDE_CONFIG_DIR === first) return { status: 1 };
        return fakeProfileUpdate(command, args, options);
      },
    });
    assert.equal(result.status, 1);
    assert.deepEqual(calls, [[first, 'marketplace'], [second, 'marketplace'], [second, 'update']]);
    assert.match(result.stdout, /user has 0.1.0, expected 1.2.3/);
    assert.equal(readInstalledPlugin({ home, configDir: second }).version, '1.2.3');
  });
});

test('published Claude parity includes top-level hooks.json and rejects a same-version no-op', async () => {
  await withHome(async home => {
    const catalog = path.join(home, 'catalog'), source = path.join(catalog, 'plugins/runlist');
    const installed = path.join(home, 'installed');
    mkdirSync(path.join(catalog, '.claude-plugin'), { recursive: true });
    mkdirSync(path.join(source, '.claude-plugin'), { recursive: true });
    writeFileSync(path.join(catalog, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'runlist', plugins: [{ name: 'runlist', source: './plugins/runlist' }] }));
    writeFileSync(path.join(source, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'runlist', version: '1.2.3' }));
    writeFileSync(path.join(source, 'hooks.json'), '{"hooks":{}}');
    cpSync(source, installed, { recursive: true });
    const configDir = path.join(home, '.claude');
    writeProfile(configDir, [{ scope: 'user', version: '1.2.3', installPath: installed }], { catalog });
    const profile = discoverClaudeProfiles({ home, env: {} })[0];
    assert.equal(publishedClaudePluginStatus(profile.installed, profile).state, 'match');
    writeFileSync(path.join(installed, 'hooks.json'), '{"hooks":{"changed":true}}');
    assert.equal(publishedClaudePluginStatus(profile.installed, profile).state, 'mismatch');
    const result = await capturedUpdate(['--host', 'claude'], { home, env: { PATH: '' }, executables: nativeInventory('/injected/native'), run: () => ({ status: 0 }) });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /assets differ from the refreshed registered official marketplace catalog/);
  });
});

test('profile readers honor process environment but explicit home fixtures stay home-based', () => {
  withHome(home => {
    const configDir = path.join(home, '.claude-work');
    writeProfile(path.join(home, '.claude'), [{ scope: 'user', version: '0.1.0' }]);
    writeProfile(configDir, [{ scope: 'user', version: '2.0.0' }]);
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      assert.equal(readInstalledPlugin().version, '2.0.0');
      assert.equal(readInstalledPlugin({ home }).version, '0.1.0');
      assert.equal(readInstalledPlugin({ home, env: { CLAUDE_CONFIG_DIR: configDir } }).version, '2.0.0');
      assert.equal(readInstalledPlugin({ home, configDir }).version, '2.0.0');
    } finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; }
  });
});

test('missing integrations remain absent and explicit unknown wrappers cannot mutate profiles', async () => {
  await withHome(async home => {
    const configDir = path.join(home, '.claude-work');
    writeProfile(configDir, [{ scope: 'user', version: '1.2.3' }]);
    const inventory = nativeInventory('/injected/wrapper'); inventory.claude.selected.kind = 'wrapper';
    const result = await capturedUpdate(['--host', 'claude', '--claude-config', configDir], {
      home, env: { PATH: '' }, executables: inventory, run() { throw new Error('wrapper executed'); },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /--claude-bin.*native.*--claude-config/);
    const absent = await capturedUpdate(['--host', 'codex'], { home, env: { PATH: '' }, executables: nativeInventory('/injected/native'), run() { throw new Error('missing integration install'); } });
    assert.equal(absent.status, 0);
    assert.equal(existsSync(path.join(home, 'plugins')), false);
  });
});

test('Claude legacy migration preserves scope and project identity for install and uninstall', () => {
  const project = path.resolve(os.tmpdir(), 'legacy project');
  const legacy = { id: 'dotmd@dotmd', entries: [{ scope: 'user' }, { scope: 'project', projectPath: project }] };
  const steps = planUpdate({ pluginOnly: true }, { plugin: legacy, hasClaude: true });
  assert.deepEqual(steps.filter(step => step.kind === 'plugin').map(step => [step.cmd, step.cwd]), [
    [['claude', 'plugin', 'install', 'runlist@runlist', '--scope', 'user'], undefined],
    [['claude', 'plugin', 'install', 'runlist@runlist', '--scope', 'project'], project],
  ]);
  assert.deepEqual(steps.filter(step => step.kind === 'legacy').map(step => [step.cmd, step.cwd]), [
    [['claude', 'plugin', 'uninstall', 'dotmd@dotmd', '--scope', 'user'], undefined],
    [['claude', 'plugin', 'uninstall', 'dotmd@dotmd', '--scope', 'project'], project],
  ]);
});

test('unreadable Claude registries and unavailable explicit executables refuse rather than falling back', () => {
  const inventory = nativeInventory('/injected/native');
  const unreadable = planClaudeProfileUpdates([{ configDir: '/profile', registryPath: '/profile/plugins/installed_plugins.json', registryState: 'unreadable' }], inventory);
  assert.equal(unreadable[0].kind, 'refusal');
  const unavailable = planClaudeProfileUpdates([{ configDir: '/profile', installed: { id: 'runlist@runlist', entries: [{ scope: 'user' }] }, storeKey: '/profile/plugins' }], { selected: null, candidates: [], explicit: true });
  assert.equal(unavailable[0].kind, 'refusal');
  assert.match(unavailable[0].reason, /--claude-bin is unavailable/);
});

test('release helpers cannot claim every installed profile verified when one registry is unreadable', () => {
  withHome(home => {
    writeProfile(path.join(home, '.claude'), [{ scope: 'user', version: '1.2.3' }]);
    const broken = path.join(home, '.claude-other/plugins'); mkdirSync(broken, { recursive: true });
    writeFileSync(path.join(broken, 'installed_plugins.json'), '{invalid');
    assert.match(verifyInstalledPluginVersion('1.2.3', { home }).reason, /registry unreadable/);
    const result = updateInstalledPluginVersion('1.2.3', { home, env: { PATH: '' }, executables: nativeInventory('/injected/native'), log() {}, run: () => ({ status: 0 }) });
    assert.equal(result.ok, false);
    assert.match(result.reason, /registry unreadable/);
  });
});
