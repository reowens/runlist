import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncPluginVersions } from '../scripts/sync-plugin-version.mjs';

let root;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function setup() {
  root = mkdtempSync(path.join(os.tmpdir(), 'dotmd-plugin-sync-'));
  mkdirSync(path.join(root, 'plugins', 'dotmd', '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  writeFileSync(path.join(root, 'plugins', 'dotmd', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'dotmd', version: '1.0.0' }, null, 2) + '\n');
  writeFileSync(path.join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ plugins: [{ name: 'dotmd', version: '1.0.0' }] }, null, 2) + '\n');
}

test('syncPluginVersions updates both validated manifests', () => {
  setup();
  syncPluginVersions(root);

  const plugin = JSON.parse(readFileSync(path.join(root, 'plugins', 'dotmd', '.claude-plugin', 'plugin.json')));
  const marketplace = JSON.parse(readFileSync(path.join(root, '.claude-plugin', 'marketplace.json')));
  assert.equal(plugin.version, '1.2.3');
  assert.equal(marketplace.plugins[0].version, '1.2.3');
});

test('syncPluginVersions validates every manifest before writing either one', () => {
  setup();
  const pluginPath = path.join(root, 'plugins', 'dotmd', '.claude-plugin', 'plugin.json');
  const originalPlugin = readFileSync(pluginPath, 'utf8');
  writeFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [] }));

  assert.throws(() => syncPluginVersions(root), /invalid dotmd plugin manifest shape/);
  assert.equal(readFileSync(pluginPath, 'utf8'), originalPlugin);
});

test('syncPluginVersions rejects malformed JSON before writing either manifest', () => {
  setup();
  const pluginPath = path.join(root, 'plugins', 'dotmd', '.claude-plugin', 'plugin.json');
  const originalPlugin = readFileSync(pluginPath, 'utf8');
  writeFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), '{');

  assert.throws(() => syncPluginVersions(root), /Cannot sync plugin version/);
  assert.equal(readFileSync(pluginPath, 'utf8'), originalPlugin);
});
