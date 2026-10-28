import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hostDoctorOptions, runDoctorHosts } from '../src/doctor-hosts.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/runlist.mjs');
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runlist-host-doctor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), repo = path.join(root, 'project');
  mkdirSync(home); mkdirSync(repo);
  return { root, home, repo };
}
function files(root) {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? [[file, 'dir'], ...files(file)] : [[file, readFileSync(file).toString('base64')]];
  });
}
function fakeInventory(f) {
  const profile = path.join(f.home, '.claude');
  const selected = { path: path.join(f.home, 'bin', 'claude'), kind: 'native' };
  return { schemaVersion: 1, readOnly: true, candidate: { version: '1.2.3', kind: 'package' },
    executables: { claude: { selected, candidates: [selected] }, codex: { selected: { path: 'codex' }, candidates: [] }, opencode: { selected: { path: 'opencode' }, candidates: [] } },
    hosts: {
      claude: { state: 'stale', profiles: [{ configDir: profile, configDirs: [profile, path.join(f.home, '.claude-robot')],
        storeKey: `${profile}/plugins`, installed: { id: 'runlist@runlist' }, state: 'stale', repair: { targetable: true } }], requirements: ['Reload Claude; live loading unknown.'] },
      codex: { state: 'stale', repair: { targetable: true }, requirements: ['Start a new Codex thread.'] },
      opencode: { state: 'foreign', repair: { targetable: false, reason: 'Preserve unmarked file.' }, requirements: ['Restart OpenCode.'] },
    }, warnings: [] };
}

test('host repair options require explicit targets and reject mixed document modes', () => {
  assert.throws(() => hostDoctorOptions(['--hosts', '--apply']), /requires explicitly selected/);
  assert.throws(() => hostDoctorOptions(['--hosts', '--repair', 'all']), /must name/);
  assert.throws(() => hostDoctorOptions(['--hosts', '--project']), /Unsupported/);
  assert.throws(() => hostDoctorOptions(['--hosts', '--claude-config', 'relative']), /absolute/);
});

test('offline CLI inventory never imports project JavaScript or migrates legacy state', t => {
  const f = fixture(t), marker = path.join(f.repo, 'MUST_NOT_EXECUTE');
  writeFileSync(path.join(f.repo, 'runlist.config.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); throw Error('project config must not run');\n`);
  mkdirSync(path.join(f.repo, '.dotmd')); writeFileSync(path.join(f.repo, '.dotmd', 'keep'), 'legacy');
  const before = files(f.root);
  for (const args of [['doctor', '--hosts', '--json'], ['update', '--check', '--json']]) {
    const result = spawnSync(process.execPath, [bin, ...args], { cwd: f.repo, encoding: 'utf8',
      env: { ...process.env, HOME: f.home, USERPROFILE: f.home, CLAUDE_CONFIG_DIR: path.join(f.home, '.claude'),
        CODEX_HOME: path.join(f.home, '.codex'), XDG_CONFIG_HOME: path.join(f.home, '.config'), PATH: '', RUNLIST_JOURNAL: '0', DOTMD_JOURNAL: '0' } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.readOnly, true);
    if (args[0] === 'update') assert.equal(report.publishedAvailability, 'not-queried-offline');
    assert.deepEqual(files(f.root), before);
  }
});

test('dry-run overrides selected apply repairs and invokes no runner', async t => {
  const f = fixture(t), data = fakeInventory(f); let output = '';
  const report = await runDoctorHosts(['--hosts', '--repair', 'claude', '--apply', '--json'], { repoRoot: f.repo }, {
    dryRun: true, home: f.home, inventory: () => structuredClone(data), out: { write: text => { output += text; } },
    run() { assert.fail('dry-run invoked a repair'); },
  });
  assert.equal(report.repairs.mode, 'preview');
  assert.equal(report.repairs.actions.length, 1, 'shared Claude store is one action');
  assert.equal(JSON.parse(output).readOnly, true);
});

test('selected repairs continue after independent failures and reject successful commands with stale artifacts', async t => {
  const f = fixture(t), data = fakeInventory(f), called = [], savedExit = process.exitCode;
  try {
    const report = await runDoctorHosts(['--hosts', '--repair', 'claude', '--repair', 'codex', '--repair', 'opencode', '--apply', '--json'], { repoRoot: f.repo }, {
      home: f.home, inventory: () => structuredClone(data), out: { write() {} },
      run(action) { called.push(action.host); if (action.host === 'claude') return { status: 1 };
        data.hosts.codex.state = 'current'; return { status: 0 }; },
    });
    assert.deepEqual(called, ['claude', 'codex']);
    assert.equal(report.repairs.completed.length, 1);
    assert.equal(report.repairs.failed.length, 2);
    assert.equal(process.exitCode, 1);
    assert.equal(report.hosts.opencode.state, 'foreign');
    const stale = await runDoctorHosts(['--hosts', '--repair', 'claude', '--apply', '--json'], { repoRoot: f.repo }, {
      home: f.home, inventory: () => structuredClone(data), out: { write() {} }, run: () => ({ status: 0 }),
    });
    assert.equal(stale.repairs.completed.length, 0);
    assert.match(stale.repairs.failed[0].reason, /remains stale/);
  } finally { process.exitCode = savedExit; }
});

test('an explicit shared-store alias remains the targeted Claude profile', async t => {
  const f = fixture(t), data = fakeInventory(f), alias = path.join(f.home, '.claude-robot'); let targeted;
  const report = await runDoctorHosts(['--hosts', '--repair', 'claude', '--claude-config', alias, '--apply', '--json'], { repoRoot: f.repo }, {
    home: f.home, inventory: () => structuredClone(data), out: { write() {} },
    run(action) { targeted = action; data.hosts.claude.profiles[0].state = 'current'; return { status: 0 }; },
  });
  assert.equal(targeted.configDir, alias);
  assert.equal(report.repairs.completed.length, 1);
});

test('blocked repairs offer native preview commands instead of repeating a refused apply', async t => {
  const f = fixture(t), data = fakeInventory(f);
  const native = data.executables.claude.selected;
  data.executables.claude.selected = { path: path.join(f.home, 'wrapper'), kind: 'wrapper' };
  data.executables.claude.candidates.unshift(data.executables.claude.selected);
  data.hosts.claude.profiles[0].repair = { targetable: false, reason: 'Wrapper mapping unknown.' };
  const report = await runDoctorHosts(['--hosts', '--repair', 'claude', '--repair', 'opencode', '--json'], { repoRoot: f.repo }, {
    home: f.home, inventory: () => structuredClone(data), out: { write() {} }, run() { assert.fail('preview wrote'); },
  });
  const action = report.repairs.actions[0];
  assert.equal(action.command, undefined);
  assert.ok(action.nextCommands[0].includes(native.path));
  assert.ok(!action.nextCommands[0].includes('--apply'));
  const foreign = report.repairs.actions[1];
  assert.equal(foreign.command, undefined);
  assert.match(foreign.remedy, /Keep the unmarked/);
});

test('current OpenCode files need no repair and never invoke a runner or claim live loading', async t => {
  const f = fixture(t), data = fakeInventory(f);
  data.hosts.opencode.state = 'current';
  data.hosts.opencode.repair = { targetable: true };
  const report = await runDoctorHosts(['--hosts', '--repair', 'opencode', '--apply', '--json'], { repoRoot: f.repo }, {
    home: f.home, inventory: () => structuredClone(data), out: { write() {} }, run() { assert.fail('current file was rewritten'); },
  });
  assert.equal(report.readOnly, true);
  assert.equal(report.repairs.actions[0].status, 'current');
  assert.equal(report.repairs.completed[0].installedOrLoaded, 'not attested by filesystem inventory');
});
