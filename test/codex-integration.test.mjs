import { afterEach, describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, match, ok } from 'node:assert';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { codexHooksStatus, codexPaths, codexStatus, installCodexPlugin, installedCodexStatus, mergeCodexHooks, removeCodexHooks } from '../src/codex-integration.mjs';

let home;
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const bin = path.join(root, 'bin', 'runlist.mjs');
const hook = path.join(root, 'plugins', 'runlist-codex', 'bin', 'runlist-hook');
const fresh = () => { home = mkdtempSync(path.join(os.tmpdir(), 'runlist-codex-')); return home; };
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = null; });

describe('Codex plugin distribution', () => {
  it('installs the packaged skill and hooks into the personal marketplace and updates in place', () => {
    const h = fresh();
    const preview = installCodexPlugin({ version, homedir: h, dryRun: true });
    strictEqual(preview.action, 'installed');
    ok(!existsSync(preview.plugin));
    const first = installCodexPlugin({ version, homedir: h });
    strictEqual(first.action, 'installed');
    ok(!existsSync(path.join(first.plugin, 'hooks')));
    ok(existsSync(first.hooksFile));
    ok(existsSync(path.join(first.plugin, 'skills', 'runlist', 'SKILL.md')));
    strictEqual(readFileSync(path.join(first.plugin, 'skills', 'runlist', 'SKILL.md'), 'utf8'),
      readFileSync(path.join(root, 'plugins', 'runlist-codex', 'skills', 'runlist', 'SKILL.md'), 'utf8'));
    const manifest = JSON.parse(readFileSync(first.marketplace, 'utf8'));
    strictEqual(manifest.plugins[0].source.path, './plugins/runlist-codex');
    strictEqual(installCodexPlugin({ version, homedir: h }).action, 'current');
    writeFileSync(path.join(first.plugin, '.runlist-generated.json'), JSON.stringify({ version: '0.0.0' }));
    strictEqual(installCodexPlugin({ version, homedir: h }).action, 'updated');
    strictEqual(codexStatus({ version, homedir: h }).stale, false);
  });

  it('adds its hooks after the user\'s, without moving or changing them', () => {
    const h = fresh();
    const { hooksFile } = codexPaths(h);
    const mine = { matcher: 'x', hooks: [{ type: 'command', command: 'my-hook', timeout: 9 }] };
    mkdirSync(path.dirname(hooksFile), { recursive: true });
    writeFileSync(hooksFile, JSON.stringify({ note: 'keep', hooks: { PreToolUse: [mine], PostToolUse: [mine] } }));
    const result = installCodexPlugin({ version, homedir: h });
    strictEqual(result.hooksChanged, true);
    const written = JSON.parse(readFileSync(hooksFile, 'utf8'));
    strictEqual(written.note, 'keep');
    deepStrictEqual(written.hooks.PostToolUse, [mine]);
    deepStrictEqual(written.hooks.PreToolUse[0], mine);
    ok(written.hooks.PreToolUse[1].hooks[0].command.endsWith('/bin/runlist-hook" guard'));
    strictEqual(written.hooks.PreToolUse.length, 2);
    ok(written.hooks.SessionStart && written.hooks.UserPromptSubmit && written.hooks.SubagentStart);
  });

  it('keeps the hook file byte-identical across a plugin update', () => {
    const h = fresh();
    const first = installCodexPlugin({ version, homedir: h });
    const before = readFileSync(first.hooksFile, 'utf8');
    writeFileSync(path.join(first.plugin, '.runlist-generated.json'), JSON.stringify({ version: '0.0.0' }));
    const second = installCodexPlugin({ version, homedir: h });
    strictEqual(second.action, 'updated');
    strictEqual(second.hooksChanged, false);
    strictEqual(readFileSync(first.hooksFile, 'utf8'), before);
  });

  it('puts back only the hooks when the plugin is current', () => {
    const h = fresh();
    const first = installCodexPlugin({ version, homedir: h });
    rmSync(first.hooksFile);
    const status = codexStatus({ version, homedir: h });
    strictEqual(status.stale, true);
    strictEqual(status.pluginStale, false);
    strictEqual(status.hooks.state, 'missing');
    const repaired = installCodexPlugin({ version, homedir: h });
    strictEqual(repaired.action, 'updated');
    strictEqual(repaired.hooksChanged, true);
    strictEqual(codexStatus({ version, homedir: h }).stale, false);
  });

  it('repairs its own stale or doubled hook without moving the others', () => {
    const h = fresh();
    const { hooksFile, plugin } = codexPaths(h);
    const old = { hooks: [{ type: 'command', command: `sh "${plugin}/bin/runlist-hook" old`, timeout: 1 }] };
    const other = { hooks: [{ type: 'command', command: 'other', timeout: 1 }] };
    mkdirSync(path.dirname(hooksFile), { recursive: true });
    writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: [old, other, old] } }));
    installCodexPlugin({ version, homedir: h });
    strictEqual(codexStatus({ version, homedir: h }).hooks.state, 'current');
    const list = JSON.parse(readFileSync(hooksFile, 'utf8')).hooks.PreToolUse;
    strictEqual(list.length, 2);
    ok(list[0].hooks[0].command.endsWith('" guard'));
    deepStrictEqual(list[1], other);
  });

  it('refuses a hooks file it cannot read, before changing anything', () => {
    const h = fresh();
    const { hooksFile, plugin } = codexPaths(h);
    mkdirSync(path.dirname(hooksFile), { recursive: true });
    writeFileSync(hooksFile, '{ not json');
    const refused = installCodexPlugin({ version, homedir: h });
    strictEqual(refused.action, 'refused');
    ok(refused.reason.includes(hooksFile));
    strictEqual(readFileSync(hooksFile, 'utf8'), '{ not json');
    ok(!existsSync(plugin));
  });

  it('never moves a hook it does not own', () => {
    const root = '/h/plugins/runlist-codex';
    const ours = args => ({ type: 'command', command: `sh "${root}/bin/runlist-hook" ${args}`, timeout: 1 });
    const mine = name => ({ type: 'command', command: name, timeout: 9 });
    const merge = list => mergeCodexHooks({ hooks: { PreToolUse: list } }, root);
    const flat = list => list.flatMap((group, g) => group.hooks.map((hook, h) => `${g}:${h}:${hook.command}`));
    for (const list of [
      [{ hooks: [ours('old')] }, { hooks: [ours('old')] }, { hooks: [mine('a')] }],
      [{ hooks: [ours('old')] }, { hooks: [mine('a')] }, { hooks: [ours('old')] }, { hooks: [mine('b')] }],
      [{ matcher: 'x', hooks: [ours('old'), mine('a')] }, { hooks: [mine('b')] }],
      [{ matcher: 'x', hooks: [mine('a'), ours('old'), mine('b')] }],
      [{ hooks: [mine('a')] }, { hooks: [ours('old')] }, { hooks: [ours('old')] }],
    ]) {
      const theirs = flat(list).filter(entry => !entry.includes('/runlist-hook'));
      const merged = merge(list).data.hooks.PreToolUse;
      deepStrictEqual(flat(merged).filter(entry => !entry.includes('/runlist-hook')), theirs);
      for (const entry of flat(merged).filter(item => item.includes('/runlist-hook'))) ok(entry.endsWith('" guard'), entry);
    }
    deepStrictEqual(merge([{ hooks: [ours('old')] }, { hooks: [ours('old')] }, { hooks: [mine('a')] }]).doubled, ['PreToolUse']);
    deepStrictEqual(merge([{ hooks: [ours('old')] }, { hooks: [mine('a')] }, { hooks: [ours('old')] }]).doubled, []);
    strictEqual(merge([{ matcher: 'x', hooks: [ours('old'), mine('a')] }]).data.hooks.PreToolUse[0].matcher, 'x');
  });

  it('reports a doubled hook it cannot safely remove', () => {
    const h = fresh();
    const { hooksFile, plugin } = codexPaths(h);
    const wanted = () => JSON.parse(readFileSync(hooksFile, 'utf8'));
    installCodexPlugin({ version, homedir: h });
    const file = wanted();
    file.hooks.PreToolUse = [file.hooks.PreToolUse[0], file.hooks.PreToolUse[0], { hooks: [{ type: 'command', command: 'mine' }] }];
    writeFileSync(hooksFile, JSON.stringify(file));
    const status = codexHooksStatus({ hooksFile, pluginRoot: plugin });
    strictEqual(status.state, 'current');
    match(status.reason, /more than once in PreToolUse/);
  });

  it('leaves commands it did not write alone', () => {
    const root = '/h/plugins/runlist-codex';
    for (const command of [
      `my-audit --then sh "${root}/bin/runlist-hook" guard`,
      `sh "${root}/bin/runlist-hook" guard; my-audit`,
      'sh "/dev/checkout/plugins/runlist-codex/bin/runlist-hook" guard',
    ]) {
      const group = { hooks: [{ type: 'command', command }] };
      const list = mergeCodexHooks({ hooks: { PreToolUse: [group] } }, root).data.hooks.PreToolUse;
      deepStrictEqual(list[0], group);
      strictEqual(list.length, 2);
    }
  });

  it('does not rewrite a hook whose keys were reordered or whose timeout was tuned', () => {
    const h = fresh();
    const { hooksFile } = installCodexPlugin({ version, homedir: h });
    const file = JSON.parse(readFileSync(hooksFile, 'utf8'));
    const [session] = file.hooks.SessionStart;
    file.hooks.SessionStart = [{ hooks: [{ ...session.hooks[0], timeout: 30 }], matcher: session.matcher }];
    const text = JSON.stringify(file);
    writeFileSync(hooksFile, text);
    strictEqual(codexStatus({ version, homedir: h }).hooks.state, 'current');
    writeFileSync(path.join(codexPaths(h).plugin, '.runlist-generated.json'), JSON.stringify({ version: '0.0.0' }));
    installCodexPlugin({ version, homedir: h });
    strictEqual(readFileSync(hooksFile, 'utf8'), text);
  });

  it('refuses a hooks file linked to nothing, and keeps the link', { skip: process.platform === 'win32' }, () => {
    const h = fresh();
    const { hooksFile, plugin } = codexPaths(h);
    mkdirSync(path.dirname(hooksFile), { recursive: true });
    symlinkSync(path.join(h, 'not-yet.json'), hooksFile);
    const refused = installCodexPlugin({ version, homedir: h });
    strictEqual(refused.action, 'refused');
    match(refused.reason, /link to a file that does not exist/);
    ok(lstatSync(hooksFile).isSymbolicLink());
    ok(!existsSync(plugin));
  });

  it('keeps the published plugin when the hooks cannot be written', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    const h = fresh();
    const { hooksFile, plugin, marketplace } = codexPaths(h);
    const dir = path.dirname(hooksFile);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o555);
    const result = installCodexPlugin({ version, homedir: h });
    chmodSync(dir, 0o755);
    strictEqual(result.action, 'installed');
    match(result.hooksError, /could not write/);
    ok(existsSync(path.join(plugin, 'bin', 'runlist-hook')));
    ok(JSON.parse(readFileSync(marketplace, 'utf8')).plugins.some(entry => entry.name === 'runlist-codex'));
    strictEqual(codexStatus({ version, homedir: h }).hooks.state, 'missing');
  });

  it('removes only its own hooks and counts what that moves', () => {
    const h = fresh();
    const { hooksFile, plugin } = codexPaths(h);
    const mine = { hooks: [{ type: 'command', command: 'mine' }] };
    mkdirSync(path.dirname(hooksFile), { recursive: true });
    writeFileSync(hooksFile, JSON.stringify({ note: 'keep', hooks: { PostToolUse: [mine], SessionStart: [mine] } }));
    installCodexPlugin({ version, homedir: h });
    const installed = JSON.parse(readFileSync(hooksFile, 'utf8'));
    installed.hooks.SessionStart.push(mine);
    const text = JSON.stringify(installed);
    writeFileSync(hooksFile, text);
    const preview = removeCodexHooks({ homedir: h, dryRun: true });
    strictEqual(preview.removed, 4);
    strictEqual(preview.moved, 1);
    strictEqual(readFileSync(hooksFile, 'utf8'), text);
    removeCodexHooks({ homedir: h });
    deepStrictEqual(JSON.parse(readFileSync(hooksFile, 'utf8')), { note: 'keep', hooks: { PostToolUse: [mine], SessionStart: [mine, mine] } });
    strictEqual(removeCodexHooks({ homedir: h }).removed, 0);
    ok(existsSync(plugin));
  });

  it('install codex --remove takes the hooks out and names the plugin step', () => {
    const h = fresh();
    const { hooksFile } = installCodexPlugin({ version, homedir: h });
    const run = spawnSync(process.execPath, [bin, 'install', 'codex', '--remove'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h },
    });
    strictEqual(run.status, 0, run.stderr);
    match(run.stdout, /Removed 4 runlist hooks/);
    match(run.stdout, /codex plugin remove runlist-codex@personal/);
    deepStrictEqual(JSON.parse(readFileSync(hooksFile, 'utf8')).hooks, {});
  });

  it('previews without writing hooks, and only a caller\'s own env moves an explicit home', t => {
    const h = fresh();
    const preview = installCodexPlugin({ version, homedir: h, dryRun: true });
    strictEqual(preview.hooksChanged, true);
    ok(!existsSync(preview.hooksFile));
    process.env.CODEX_HOME = path.resolve('/elsewhere');
    t.after(() => { delete process.env.CODEX_HOME; });
    strictEqual(codexPaths(h).hooksFile, path.join(h, '.codex', 'hooks.json'));
    strictEqual(codexPaths(os.homedir()).hooksFile, path.join(path.resolve('/elsewhere'), 'hooks.json'));
    strictEqual(codexPaths(h, { CODEX_HOME: path.resolve('/elsewhere') }).hooksFile, path.join(path.resolve('/elsewhere'), 'hooks.json'));
    strictEqual(codexPaths(h, {}).hooksFile, path.join(h, '.codex', 'hooks.json'));
  });

  it('follows a linked hooks file instead of replacing the link', { skip: process.platform === 'win32' }, () => {
    const h = fresh();
    const { hooksFile } = codexPaths(h);
    const real = path.join(h, 'dotfiles-hooks.json');
    writeFileSync(real, '{}');
    mkdirSync(path.dirname(hooksFile), { recursive: true });
    symlinkSync(real, hooksFile);
    installCodexPlugin({ version, homedir: h });
    ok(lstatSync(hooksFile).isSymbolicLink());
    ok(JSON.parse(readFileSync(real, 'utf8')).hooks.SessionStart);
  });

  it('refuses to replace a foreign plugin or marketplace entry', () => {
    const h = fresh();
    const plugin = path.join(h, 'plugins', 'runlist-codex');
    mkdirSync(plugin, { recursive: true });
    writeFileSync(path.join(plugin, 'custom.txt'), 'keep');
    const refused = installCodexPlugin({ version, homedir: h });
    strictEqual(refused.action, 'refused');
    strictEqual(readFileSync(path.join(plugin, 'custom.txt'), 'utf8'), 'keep');
    rmSync(plugin, { recursive: true });
    mkdirSync(path.join(h, '.agents', 'plugins'), { recursive: true });
    writeFileSync(path.join(h, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
      name: 'personal', plugins: [{ name: 'runlist-codex', source: { source: 'local', path: './other' } }],
    }));
    strictEqual(installCodexPlugin({ version, homedir: h }).action, 'refused');
    ok(!existsSync(plugin));
  });

  it('ships the Codex plugin files in the npm tarball', () => {
    const packed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], {
      cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
    });
    strictEqual(packed.status, 0, packed.stderr);
    const output = JSON.parse(packed.stdout);
    const p = Array.isArray(output) ? output[0] : output.runlist;
    const files = new Set(p.files.map(f => f.path));
    ok(files.has('plugins/runlist-codex/.codex-plugin/plugin.json'));
    ok(files.has('plugins/runlist-codex/bin/runlist-hook'));
    ok(files.has('plugins/runlist-codex/skills/runlist/SKILL.md'));
  });

  it('installs through the CLI and keeps JSON output parseable', () => {
    const h = fresh();
    const fakeBin = path.join(h, 'bin');
    mkdirSync(fakeBin);
    const calls = path.join(h, 'codex-calls');
    const stub = path.join(fakeBin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    if (process.platform === 'win32') {
      writeFileSync(stub, `@echo off\r\necho %*>>"%CODEX_CALLS%"\r\nif "%2"=="list" echo {"installed":[{"pluginId":"runlist-codex@personal","installed":true,"version":"${version}"}]}\r\n`);
    } else {
      writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CODEX_CALLS"\nif [ "$2" = list ]; then printf '%s\\n' '{"installed":[{"pluginId":"runlist-codex@personal","installed":true,"version":"${version}"}]}'; fi\n`);
      chmodSync(stub, 0o755);
    }
    const run = spawnSync(process.execPath, [bin, 'install', 'codex', '--json'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, HOME: h, USERPROFILE: h, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, CODEX_CALLS: calls },
    });
    strictEqual(run.status, 0, run.stderr);
    strictEqual(JSON.parse(run.stdout).pluginAdd, 'installed');
    match(readFileSync(calls, 'utf8'), /plugin add runlist-codex@personal/);
    match(readFileSync(calls, 'utf8'), /plugin list --marketplace personal --json/);
  });

  it('verifies the host installation independently from the generated source version', () => {
    const h = fresh();
    installCodexPlugin({ version, homedir: h });
    const read = output => installedCodexStatus({ homedir: h, run: () => ({ status: 0, stdout: JSON.stringify(output) }) });
    strictEqual(read({ installed: [{ pluginId: 'runlist-codex@personal', installed: true, version: '0.1.0' }] }).version, '0.1.0');
    strictEqual(read({ installed: [] }).ok, false);
    strictEqual(read({ available: [] }).ok, false);
    strictEqual(installedCodexStatus({ homedir: h, run: () => ({ status: 0, stdout: 'invalid' }) }).ok, false);
    strictEqual(installedCodexStatus({ homedir: h, run: () => ({ status: 1 }) }).ok, false);
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
    const env = { ...process.env, HOME: h, USERPROFILE: h, CLAUDE_CONFIG_DIR: undefined, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, RUNLIST_ERROR_LOG_DIR: path.join(h, 'logs') };
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
    const fakeBin = path.join(h, 'bin');
    mkdirSync(fakeBin);
    const stub = path.join(fakeBin, 'runlist');
    writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`);
    chmodSync(stub, 0o755);
    const unrelated = spawnSync('sh', [hook, 'guard'], {
      cwd: h, env: { ...process.env, HOME: h, USERPROFILE: h, CLAUDE_CONFIG_DIR: undefined, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
      input: JSON.stringify({ tool_name: 'mcp__filesystem__read_file', tool_input: { path: 'docs/prompts/x.md' } }), encoding: 'utf8',
    });
    strictEqual(unrelated.status, 0);
    strictEqual(unrelated.stdout.trim(), '{}');
    const shell = process.platform === 'win32'
      ? spawnSync('where', ['sh'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0]
      : 'sh';
    const absent = spawnSync(shell, [hook, '--hint', 'hud'], { cwd: h, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    strictEqual(absent.status, 0);
    match(absent.stdout, /neither runlist nor dotmd was found on the PATH this app sees.*\n.*npm install -g runlist/);
    strictEqual(absent.stdout.trim().split('\n').length, 2);
  });
});

describe('Codex same-version source integrity', () => {
  it('detects changed, missing and extra managed assets without trusting the marker version', () => {
    const h = fresh();
    const installed = installCodexPlugin({ version, homedir: h });
    const skill = path.join(installed.plugin, 'skills/runlist/SKILL.md');
    writeFileSync(skill, readFileSync(skill, 'utf8') + '\nchanged source\n');
    strictEqual(codexStatus({ version, homedir: h }).sourceParity.state, 'mismatch');
    strictEqual(installCodexPlugin({ version, homedir: h }).action, 'updated');
    rmSync(path.join(installed.plugin, 'bin/runlist-hook'));
    strictEqual(codexStatus({ version, homedir: h }).stale, true);
    installCodexPlugin({ version, homedir: h });
    writeFileSync(path.join(installed.plugin, 'extra-hook.js'), 'changed');
    strictEqual(codexStatus({ version, homedir: h }).sourceParity.state, 'mismatch');
    installCodexPlugin({ version, homedir: h });
    strictEqual(codexStatus({ version, homedir: h }).sourceParity.state, 'match');
  });

  it('inspects a host-provided installed path independently and leaves absent path parity unknown', () => {
    const h = fresh();
    const source = installCodexPlugin({ version, homedir: h });
    // A separately generated tree stands in for the host cache.
    const secondHome = path.join(h, 'second-home');
    const second = installCodexPlugin({ version, homedir: secondHome });
    const read = installedPath => installedCodexStatus({ homedir: h, run: () => ({ status: 0, stdout: JSON.stringify({ installed: [
      { pluginId: 'runlist-codex@personal', installed: true, version, ...(installedPath ? { installPath: installedPath } : {}) },
    ] }) }) });
    strictEqual(read().sourceParity.state, 'unknown');
    strictEqual(read(second.plugin).sourceParity.state, 'match');
    writeFileSync(path.join(second.plugin, 'bin/runlist-hook'), 'changed');
    strictEqual(read(second.plugin).ok, false);
    strictEqual(read(second.plugin).sourceParity.state, 'mismatch');
    strictEqual(read(second.plugin).loaded, 'unknown');
    strictEqual(codexStatus({ version, homedir: h }).stale, false, source.plugin);
    const offline = installedCodexStatus({ homedir: h, offline: true, run() { throw new Error('must not execute'); } });
    strictEqual(offline.state, 'unknown');
  });
});
