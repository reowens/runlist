import { afterEach, describe, it } from 'node:test';
import { strictEqual, match, ok } from 'node:assert';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { codexStatus, installCodexPlugin } from '../src/codex-integration.mjs';

let home;
const root = path.resolve(import.meta.dirname, '..');
const bin = path.join(root, 'bin', 'runlist.mjs');
const hook = path.join(root, 'plugins', 'runlist-codex', 'bin', 'runlist-hook');
const fresh = () => { home = mkdtempSync(path.join(os.tmpdir(), 'runlist-codex-')); return home; };
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = null; });

describe('Codex plugin distribution', () => {
  it('installs the packaged skill and hooks into the personal marketplace and updates in place', () => {
    const h = fresh();
    const preview = installCodexPlugin({ version: '0.88.1', homedir: h, dryRun: true });
    strictEqual(preview.action, 'installed');
    ok(!existsSync(preview.plugin));
    const first = installCodexPlugin({ version: '0.88.1', homedir: h });
    strictEqual(first.action, 'installed');
    ok(existsSync(path.join(first.plugin, 'hooks', 'hooks.json')));
    ok(existsSync(path.join(first.plugin, 'skills', 'runlist', 'SKILL.md')));
    const manifest = JSON.parse(readFileSync(first.marketplace, 'utf8'));
    strictEqual(manifest.plugins[0].source.path, './plugins/runlist-codex');
    strictEqual(installCodexPlugin({ version: '0.88.1', homedir: h }).action, 'current');
    writeFileSync(path.join(first.plugin, '.runlist-generated.json'), JSON.stringify({ version: '0.88.0' }));
    strictEqual(installCodexPlugin({ version: '0.88.1', homedir: h }).action, 'updated');
    strictEqual(codexStatus({ version: '0.88.1', homedir: h }).stale, false);
  });

  it('refuses to replace a foreign plugin or marketplace entry', () => {
    const h = fresh();
    const plugin = path.join(h, '.agents', 'plugins', 'plugins', 'runlist-codex');
    mkdirSync(plugin, { recursive: true });
    writeFileSync(path.join(plugin, 'custom.txt'), 'keep');
    const refused = installCodexPlugin({ version: '0.88.1', homedir: h });
    strictEqual(refused.action, 'refused');
    strictEqual(readFileSync(path.join(plugin, 'custom.txt'), 'utf8'), 'keep');
    rmSync(plugin, { recursive: true });
    writeFileSync(path.join(h, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
      name: 'personal', plugins: [{ name: 'runlist-codex', source: { source: 'local', path: './other' } }],
    }));
    strictEqual(installCodexPlugin({ version: '0.88.1', homedir: h }).action, 'refused');
    ok(!existsSync(plugin));
  });

  it('ships the Codex plugin files in the npm tarball', () => {
    const p = JSON.parse(spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' }).stdout)[0];
    const files = new Set(p.files.map(f => f.path));
    ok(files.has('plugins/runlist-codex/.codex-plugin/plugin.json'));
    ok(files.has('plugins/runlist-codex/hooks/hooks.json'));
    ok(files.has('plugins/runlist-codex/skills/runlist/SKILL.md'));
  });

  it('installs through the CLI and keeps JSON output parseable', () => {
    const h = fresh();
    const fakeBin = path.join(h, 'bin');
    mkdirSync(fakeBin);
    const calls = path.join(h, 'codex-calls');
    const stub = path.join(fakeBin, 'codex');
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CODEX_CALLS"\n`);
    chmodSync(stub, 0o755);
    const run = spawnSync(process.execPath, [bin, 'install', 'codex', '--json'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, HOME: h, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, CODEX_CALLS: calls },
    });
    strictEqual(run.status, 0, run.stderr);
    strictEqual(JSON.parse(run.stdout).pluginAdd, 'installed');
    match(readFileSync(calls, 'utf8'), /plugin add runlist-codex@personal/);
  });
});

describe('Codex hook payloads', () => {
  it('uses the real CLI for status patch denial and MCP prompt-read context', () => {
    const h = fresh();
    const repo = path.join(h, 'repo');
    mkdirSync(path.join(repo, 'docs', 'plans'), { recursive: true });
    mkdirSync(path.join(repo, 'docs', 'prompts'), { recursive: true });
    writeFileSync(path.join(repo, 'dotmd.config.mjs'), "export const root = 'docs';\n");
    writeFileSync(path.join(repo, 'docs', 'plans', 'x.md'), '---\ntype: plan\nstatus: active\n---\n');
    writeFileSync(path.join(repo, 'docs', 'prompts', 'resume-x.md'), '---\ntype: prompt\nstatus: pending\n---\nbody\n');
    spawnSync('git', ['init', '-q'], { cwd: repo });
    const fakeBin = path.join(h, 'bin');
    mkdirSync(fakeBin);
    const stub = path.join(fakeBin, 'runlist');
    writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`);
    chmodSync(stub, 0o755);
    const env = { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, RUNLIST_ERROR_LOG_DIR: path.join(h, 'logs') };
    const call = payload => spawnSync('sh', [hook, 'guard'], { cwd: repo, env, input: JSON.stringify(payload), encoding: 'utf8' });
    const patch = call({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: docs/plans/x.md\n@@\n-status: active\n+status: archived\n*** End Patch' } });
    strictEqual(patch.status, 0, patch.stderr);
    strictEqual(JSON.parse(patch.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const read = call({ tool_name: 'mcp__filesystem__read_text_file', tool_input: { path: 'docs/prompts/resume-x.md' } });
    strictEqual(read.status, 0, read.stderr);
    match(JSON.parse(read.stdout).hookSpecificOutput.additionalContext, /runlist use/);
  });

  it('is silent in unrelated repos and gives a one-time install hint when the CLI is unavailable', () => {
    const h = fresh();
    const unrelated = spawnSync('sh', [hook, 'guard'], {
      cwd: h, input: JSON.stringify({ tool_name: 'mcp__filesystem__read_file', tool_input: { path: 'docs/prompts/x.md' } }), encoding: 'utf8',
    });
    strictEqual(unrelated.status, 0);
    strictEqual(unrelated.stdout.trim(), '{}');
    const absent = spawnSync('sh', [hook, '--hint', 'hud'], { cwd: h, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    strictEqual(absent.status, 0);
    match(absent.stdout, /npm i -g dotmd-cli/);
  });
});
