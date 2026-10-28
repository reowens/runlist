import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { PERSISTENT_CLI_WARNING } from '../src/installation.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/runlist.mjs');
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
let root, tools, ephemeral, env;
function stub(directory, name, body = '') {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name + (process.platform === 'win32' ? '.cmd' : ''));
  writeFileSync(file, process.platform === 'win32' ? `@echo off\r\n${body}\r\n` : `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'runlist-install-test-'));
  tools = path.join(root, 'tools');
  ephemeral = path.join(root, 'cache/_npx/abc123/node_modules/.bin');
  stub(ephemeral, 'runlist');
  const calls = process.platform === 'win32' ? 'echo %*>>"%HOST_CALLS%"' : 'printf "%s\\n" "$*" >> "$HOST_CALLS"';
  stub(tools, 'claude', calls);
  stub(tools, 'codex', `${calls}\n${process.platform === 'win32'
    ? `if "%2"=="list" echo {"installed":[{"pluginId":"runlist-codex@personal","installed":true,"version":"${version}"}]}`
    : `if [ "$2" = list ]; then printf '%s\\n' '{"installed":[{"pluginId":"runlist-codex@personal","installed":true,"version":"${version}"}]}'; fi`}`);
  if (process.platform !== 'win32') stub(tools, 'which', 'command -v "$1"');
  const system = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32') : null;
  env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude'),
    CODEX_HOME: path.join(root, '.codex'), OPENCODE_CONFIG_DIR: path.join(root, 'opencode'),
    PATH: [ephemeral, tools, system].filter(Boolean).join(path.delimiter), npm_command: 'exec',
    INIT_CWD: root, npm_config_local_prefix: root, npm_package_json: '', HOST_CALLS: path.join(root, 'host-calls'),
    NO_COLOR: '1', FORCE_COLOR: '0', RUNLIST_JOURNAL: '0', DOTMD_JOURNAL: '0' };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function install(args) {
  return spawnSync(process.execPath, [bin, 'install', ...args], { cwd: root, env, encoding: 'utf8', timeout: 20_000 });
}

for (const host of ['claude', 'codex', 'opencode']) {
  test(`${host} install warns under npx in preview and still applies the explicit action`, () => {
    const preview = install([host, '--dry-run']);
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.equal(preview.stderr, `Warning: ${PERSISTENT_CLI_WARNING}\n`);
    assert.equal(existsSync(env.HOST_CALLS), false);
    const applied = install([host]);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.equal(applied.stderr, `Warning: ${PERSISTENT_CLI_WARNING}\n`);
    if (host === 'opencode') assert.equal(existsSync(path.join(root, 'opencode/plugin/runlist.js')), true);
    else assert.match(readFileSync(env.HOST_CALLS, 'utf8'), /plugin (install|add)/);
  });

  test(`${host} install warns with only rl on the lasting PATH`, () => {
    stub(tools, 'rl');
    env.PATH = env.PATH.split(path.delimiter).filter(dir => dir !== ephemeral).join(path.delimiter);
    const result = install([host, '--dry-run']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, `Warning: ${PERSISTENT_CLI_WARNING}\n`);
    assert.equal(JSON.parse(install([host, '--dry-run', '--json']).stdout).persistentCliMissing, true);
  });

  test(`${host} install JSON exposes the missing CLI without contaminating stdout`, () => {
    const result = install([host, '--dry-run', '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).persistentCliMissing, true);
    assert.equal(result.stderr, '');
  });

  test(`${host} install keeps existing output when a lasting CLI follows the npx copy`, () => {
    const missing = install([host, '--dry-run']);
    const missingJson = JSON.parse(install([host, '--dry-run', '--json']).stdout);
    const lasting = path.join(root, 'lasting-bin');
    stub(lasting, 'runlist');
    env.PATH += path.delimiter + lasting;
    const present = install([host, '--dry-run']);
    assert.equal(present.status, 0, present.stderr);
    assert.equal(present.stdout, missing.stdout);
    assert.equal(present.stderr, '');
    delete missingJson.persistentCliMissing;
    assert.deepEqual(JSON.parse(install([host, '--dry-run', '--json']).stdout), missingJson);
  });
}

test('a project devDependency alone is missing from the lasting host PATH', () => {
  const local = path.join(root, 'node_modules/.bin');
  stub(local, 'runlist');
  env.PATH = [local, tools, process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32') : null].filter(Boolean).join(path.delimiter);
  const result = install(['claude', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /globally installed `runlist` on PATH.*npm install -g runlist.*restart\/reload/);
});

for (const context of ['dlx', 'run', 'exec']) test(`Yarn ${context} temporary wrappers warn only with BERRY_BIN_FOLDER set`, () => {
  const binDir = path.join(root, 'temp/xfs-1a2b3c4d');
  const target = context === 'dlx'
    ? path.join(root, 'temp/xfs-feedface/dlx-1234/node_modules/runlist/bin/runlist.mjs')
    : path.join(root, 'node_modules/runlist/bin/runlist.mjs');
  stub(binDir, 'runlist', `exec "node" '${target}' "$@"`);
  env.PATH = [binDir, tools].join(path.delimiter);
  env.BERRY_BIN_FOLDER = binDir;
  env.npm_execpath = path.join(binDir, 'yarn');
  const result = install(['claude', '--dry-run']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, `Warning: ${PERSISTENT_CLI_WARNING}\n`);
  assert.equal(JSON.parse(install(['claude', '--dry-run', '--json']).stdout).persistentCliMissing, true);
  delete env.BERRY_BIN_FOLDER;
  const unmarked = install(['claude', '--dry-run']);
  assert.equal(unmarked.status, 0, unmarked.stdout + unmarked.stderr);
  assert.equal(unmarked.stderr, '');
});

test('pnpm dlx with a custom cache directory warns before installing', () => {
  const binDir = path.join(root, 'pnpm-cache/dlx/0123456789abcdef0123456789abcdef/fixture-id/node_modules/.bin');
  stub(binDir, 'runlist');
  env.PATH = [binDir, tools].join(path.delimiter);
  delete env.npm_command;
  const result = install(['claude', '--dry-run']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, `Warning: ${PERSISTENT_CLI_WARNING}\n`);
});

test('removal does not warn about a CLI needed only for hooks', () => {
  const result = install(['opencode', '--remove']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});
