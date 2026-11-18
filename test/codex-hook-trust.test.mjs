import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexHookDefinitions, codexPaths } from '../src/codex-integration.mjs';
import { readCodexHookTrust, formatCodexHookTrust } from '../src/codex-hook-trust.mjs';

test('live trust distinguishes user hooks, leftover plugin hooks and unavailable evidence', { skip: process.platform === 'win32' }, async t => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'runlist-hook-trust-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const paths = codexPaths(cwd, {});
  const binary = path.join(cwd, 'codex');
  writeFileSync(binary, `#!${process.execPath}
const readline = require('node:readline');
let initialized = false;
readline.createInterface({input: process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') { initialized = true; return; }
  if (msg.id === 1) return console.log(JSON.stringify({id:1,result:{}}));
  if (!initialized || msg.method !== 'hooks/list' || msg.params.cwds[0] !== process.cwd()) process.exit(1);
  if (process.env.STALL) return;
  console.log(JSON.stringify({id:2,result:JSON.parse(process.env.RESPONSE)}));
});`, { mode: 0o755 });
  const hooks = Object.entries(codexHookDefinitions(paths.plugin)).map(([event, def]) => ({
    eventName: event[0].toLowerCase() + event.slice(1), command: def.hooks[0].command,
    sourcePath: paths.hooksFile, source: 'user', trustStatus: 'trusted', enabled: true,
  }));
  const entry = { cwd, hooks, errors: [], warnings: [] };
  const probe = (entries, extra = {}, timeout) => readCodexHookTrust({ cwd, home: cwd, binary, timeout,
    env: { RESPONSE: JSON.stringify({ data: entries }), ...extra } });
  assert.equal((await probe([entry])).state, 'ready');
  const report = await probe([{ ...entry, hooks: [
    { ...hooks[0], trustStatus: 'modified' }, { ...hooks[1], enabled: false },
    { ...hooks[2], source: 'project' }, { ...hooks[3], command: 'different' },
    { ...hooks[0], source: 'plugin', pluginId: 'runlist-codex@personal', trustStatus: 'untrusted' },
  ] }]);
  assert.equal(report.state, 'review');
  assert.deepEqual(report.hooks.map(h => h.trust), ['modified', 'trusted', 'missing', 'missing']);
  assert.equal(report.hooks[1].enabled, false);
  assert.equal(report.pluginHooks.length, 1);
  assert.match(formatCodexHookTrust(report), /leftover plugin hook/);
  assert.match(formatCodexHookTrust(report), /\/hooks/);
  for (const entries of [[], [{ ...entry, errors: [{}] }], [{ ...entry, cwd: '/different' }]]) {
    assert.equal((await probe(entries)).state, 'unknown');
  }
  assert.equal((await probe([entry], { STALL: '1' }, 150)).state, 'unknown');
  assert.equal((await readCodexHookTrust({ binary: path.join(cwd, 'missing') })).state, 'unknown');
});
