import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'runlist.mjs');

test('install claude without the claude CLI also names the Claude Desktop route', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'runlist-install-desktop-'));
  try {
    // Only the Node binary's own directory is needed on PATH; no `claude` lives there.
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), NO_COLOR: '1', PATH: path.dirname(process.execPath) };
    const result = spawnSync(process.execPath, [bin, 'install', 'claude'], { cwd: home, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /\/plugin marketplace add reowens\/runlist\n\s+\/plugin install runlist@runlist/);
    assert.match(result.stdout, /In Claude Desktop instead: Code tab → \+ → Add plugins, add the marketplace reowens\/runlist, then install runlist\./);
    assert.match(result.stdout, /unconfirmed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install claude --remove without the claude CLI does not suggest the install route', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'runlist-install-desktop-'));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), NO_COLOR: '1', PATH: path.dirname(process.execPath) };
    const result = spawnSync(process.execPath, [bin, 'install', 'claude', '--remove'], { cwd: home, encoding: 'utf8', env });
    assert.doesNotMatch(result.stdout, /In Claude Desktop instead/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
