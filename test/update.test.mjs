import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { compareVersions, readInstalledPlugin, planUpdate } from '../src/update.mjs';
import { detectVersionDrift } from '../src/hud.mjs';

test('compareVersions orders semver and tolerates junk', () => {
  assert.equal(compareVersions('0.53.0', '0.54.0'), -1);
  assert.equal(compareVersions('0.54.0', '0.53.0'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1); // numeric, not lexical
  assert.equal(compareVersions('nope', '1.0.0'), null);
  assert.equal(compareVersions('1.0.0', undefined), null);
});

function withHome(fn) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dotmd-upd-'));
  try { return fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

function writeInstalled(home, plugins) {
  const dir = path.join(home, '.claude', 'plugins');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'installed_plugins.json'), JSON.stringify({ version: '1', plugins }));
}

test('readInstalledPlugin finds dotmd@dotmd', () => {
  withHome((home) => {
    writeInstalled(home, { 'dotmd@dotmd': [{ version: '0.54.0' }], 'grepmax@grepmax': [{ version: '0.17.17' }] });
    assert.deepEqual(readInstalledPlugin({ home }), { id: 'dotmd@dotmd', version: '0.54.0' });
  });
});

test('readInstalledPlugin falls back to any dotmd@* marketplace', () => {
  withHome((home) => {
    writeInstalled(home, { 'dotmd@other': [{ version: '0.50.0' }] });
    assert.deepEqual(readInstalledPlugin({ home }), { id: 'dotmd@other', version: '0.50.0' });
  });
});

test('readInstalledPlugin returns null when absent', () => {
  withHome((home) => {
    assert.equal(readInstalledPlugin({ home }), null); // no file
    writeInstalled(home, { 'grepmax@grepmax': [{ version: '0.17.17' }] });
    assert.equal(readInstalledPlugin({ home }), null); // no dotmd
  });
});

test('planUpdate: both halves when tools present and plugin installed', () => {
  const steps = planUpdate({}, { plugin: { id: 'dotmd@dotmd', version: '0.53.0' }, hasClaude: true, hasNpm: true });
  assert.deepEqual(steps.map(s => s.kind), ['cli', 'plugin']);
  assert.deepEqual(steps[0].cmd, ['npm', 'i', '-g', 'dotmd-cli@latest']);
  assert.deepEqual(steps[1].cmd, ['claude', 'plugin', 'update', 'dotmd@dotmd']);
});

test('planUpdate: --cli-only / --plugin-only restrict the steps', () => {
  const ctx = { plugin: { id: 'dotmd@dotmd', version: '0.53.0' }, hasClaude: true, hasNpm: true };
  assert.deepEqual(planUpdate({ cliOnly: true }, ctx).map(s => s.kind), ['cli']);
  assert.deepEqual(planUpdate({ pluginOnly: true }, ctx).map(s => s.kind), ['plugin']);
});

test('planUpdate: missing claude → plugin step becomes a skip with guidance', () => {
  const steps = planUpdate({ pluginOnly: true }, { plugin: { id: 'dotmd@dotmd', version: '0.53.0' }, hasClaude: false, hasNpm: true });
  assert.equal(steps[0].kind, 'skip');
  assert.match(steps[0].reason, /\/plugin update dotmd@dotmd/);
});

test('planUpdate: plugin not installed → skip', () => {
  const steps = planUpdate({ pluginOnly: true }, { plugin: null, hasClaude: true, hasNpm: true });
  assert.equal(steps[0].kind, 'skip');
  assert.match(steps[0].reason, /not installed/);
});

// --- hud version-drift detector ---

function withPluginRoot(version, underCache, fn) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'dotmd-pr-'));
  const root = underCache
    ? path.join(base, '.claude', 'plugins', 'cache', 'dotmd', 'dotmd', version)
    : path.join(base, 'dev', 'plugins', 'dotmd');
  mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'dotmd', version }));
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
    assert.match(msg, /dotmd update/);
  });
});

test('detectVersionDrift: warns when CLI is behind a newer cached plugin', () => {
  withPluginRoot('99.0.0', true, (root) => {
    const msg = detectVersionDrift({ CLAUDE_PLUGIN_ROOT: root });
    assert.match(msg, /CLI .* is behind the plugin 99\.0\.0/);
  });
});
