import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const adapter = join(root, 'plugins/runlist-codex/bin/subagent-start.mjs');
const cli = join(root, 'bin/runlist.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'runlist-child-hook-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const posixTest = (name, run) => test(name, { skip: process.platform === 'win32' && 'POSIX sh plugin wrapper' }, run);

function fixture(name, config) {
  const cwd = join(scratch, name);
  mkdirSync(join(cwd, 'bin'), { recursive: true });
  mkdirSync(join(cwd, 'docs/prompts'), { recursive: true });
  if (config) writeFileSync(join(cwd, 'runlist.config.mjs'), config);
  symlinkSync('/bin/sh', join(cwd, 'bin/sh'));
  const env = {
    ...process.env, HOME: cwd, USERPROFILE: cwd, CLAUDE_CONFIG_DIR: undefined,
    PATH: join(cwd, 'bin'), NO_COLOR: '1', FORCE_COLOR: '0',
    RUNLIST_ERROR_LOG_DIR: join(cwd, 'logs'),
  };
  return { cwd, env };
}

function stub(options, name = 'runlist', body = `exec ${quote(process.execPath)} ${quote(cli)} "$@"`) {
  const path = join(options.cwd, 'bin', name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function invoke(options) {
  const result = spawnSync(process.execPath, [adapter], {
    ...options, encoding: 'utf8', timeout: 7_000, input: '{"hook_event_name":"SubagentStart"}',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

function context(output) {
  const value = JSON.parse(output).hookSpecificOutput;
  assert.equal(value.hookEventName, 'SubagentStart');
  return value.additionalContext;
}

test('Codex registers the child adapter with its own 5-second budget', () => {
  const hooks = JSON.parse(readFileSync(join(root, 'plugins/runlist-codex/hooks/hooks.json'), 'utf8')).hooks;
  assert.deepEqual(hooks.SubagentStart, [{
    matcher: '*', hooks: [{ type: 'command', command: 'node "${PLUGIN_ROOT}/bin/subagent-start.mjs"', timeout: 5 }],
  }]);
  assert.ok(hooks.PreToolUse && hooks.SessionStart && hooks.UserPromptSubmit);
});

for (const [name, config, planning] of [
  ['planning', "export const root = 'docs';\n", true],
  ['handoffs', "export const mode = 'handoffs';\nexport const root = 'docs/prompts';\n", false],
]) {
  posixTest(`child context uses the existing HUD source in ${name} mode`, () => {
    const options = fixture(name, config);
    stub(options);
    const expected = spawnSync(process.execPath, [cli, 'hud', '--subagent'], {
      ...options, encoding: 'utf8', timeout: 4_000,
    });
    assert.equal(expected.status, 0, expected.stderr);
    const actual = context(invoke(options));
    assert.equal(actual, expected.stdout.trim());
    assert.equal(actual.includes('runlist show'), planning);
    assert.match(actual, /runlist prompts show/);
    assert.match(actual, /Return completed results to the parent/);
    assert.match(actual, /runlist baton --subagent/);
  });
}

posixTest('unrelated repositories receive no child context', () => {
  const options = fixture('unrelated');
  stub(options);
  assert.equal(invoke(options), '');
});

posixTest('an absent CLI stays silent so the repository fallback remains available', () => {
  assert.equal(invoke(fixture('absent', "export const root = 'docs';\n")), '');
});

posixTest('the legacy executable still supplies the HUD primer', () => {
  const options = fixture('legacy', "export const root = 'docs';\n");
  stub(options, 'dotmd');
  assert.match(context(invoke(options)), /runlist show/);
});

posixTest('a failed HUD is reported without injecting partial guidance', () => {
  const options = fixture('failed');
  stub(options, 'runlist', 'printf "partial primer\\n"; printf "fixture failure\\n" >&2; exit 7');
  assert.equal(context(invoke(options)), 'Runlist child orientation failed: fixture failure');
});

posixTest('a stalled HUD returns before the outer hook deadline', () => {
  const options = fixture('timeout');
  stub(options, 'runlist', `exec ${quote(process.execPath)} -e 'setInterval(() => {}, 1000)'`);
  assert.match(context(invoke(options)), /Runlist child orientation failed:.*ETIMEDOUT/);
});
