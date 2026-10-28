import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from '../src/frontmatter.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/runlist.mjs');
let root;
let env;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'runlist-setup-cli-'));
  env = { ...process.env, HOME: root, USERPROFILE: root, NO_COLOR: '1',
    XDG_CONFIG_HOME: path.join(root, '.config'), CLAUDE_CONFIG_DIR: path.join(root, '.claude'),
    CODEX_HOME: path.join(root, '.codex'), RUNLIST_JOURNAL: '0', DOTMD_JOURNAL: '0' };
  const result = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function cli(args) {
  return spawnSync(process.execPath, [bin, ...args], { cwd: root, env, encoding: 'utf8', timeout: 20_000 });
}
function snapshot(dir = root) {
  return readdirSync(dir).sort().flatMap(name => {
    const file = path.join(dir, name), stat = lstatSync(file), relative = path.relative(root, file);
    if (stat.isSymbolicLink()) return [[relative, 'link', readlinkSync(file)]];
    if (stat.isDirectory()) return [[relative, 'directory'], ...snapshot(file)];
    return [[relative, readFileSync(file).toString('base64')]];
  });
}

test('noninteractive setup previews without creating files or migrating legacy state', () => {
  mkdirSync(path.join(root, '.dotmd'));
  writeFileSync(path.join(root, '.dotmd', 'keep.txt'), 'legacy state\n');
  const before = snapshot();
  const result = cli(['setup', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(typeof JSON.parse(result.stdout), 'object');
  assert.deepEqual(snapshot(), before);
});

test('dry-run overrides --yes even with a root, plan, adoption and ignore changes selected', () => {
  mkdirSync(path.join(root, 'notes'));
  writeFileSync(path.join(root, 'notes', 'design.md'), '# Design notes\n');
  const before = snapshot();
  const result = cli(['setup', '--yes', '--dry-run', '--json', '--docs-root', 'notes', '--gitignore',
    '--first-plan', 'example', '--current-state', 'Requirements are agreed.', '--next-step', 'Build a prototype.',
    '--adopt', 'notes/design.md']);
  assert.equal(result.status, 0, result.stderr);
  JSON.parse(result.stdout);
  assert.deepEqual(snapshot(), before);
});

test('applied first-plan setup uses authored state, checks cleanly and leaves ignore/Git state alone', () => {
  const excludePath = path.join(root, '.git', 'info', 'exclude');
  const beforeExclude = readFileSync(excludePath);
  const result = cli(['setup', '--yes', '--json', '--docs-root', 'notes', '--host', 'none',
    '--first-plan', 'example', '--current-state', 'Requirements are agreed.', '--next-step', 'Build a prototype.']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  JSON.parse(result.stdout);
  const file = path.join(root, 'notes', 'plans', 'example.md');
  assert.equal(existsSync(path.join(root, 'notes', 'plans', 'example-plan.md')), false);
  const metadata = parseSimpleFrontmatter(extractFrontmatter(readFileSync(file, 'utf8')).frontmatter);
  assert.equal(metadata.type, 'plan');
  assert.equal(metadata.current_state, 'Requirements are agreed.');
  assert.equal(metadata.next_step, 'Build a prototype.');
  assert.equal(existsSync(path.join(root, 'docs')), false);
  assert.equal(existsSync(path.join(root, '.gitignore')), false);
  assert.equal(existsSync(path.join(root, '.git', 'index')), false);
  assert.deepEqual(readFileSync(excludePath), beforeExclude);
  const check = cli(['check', '--json']);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const report = JSON.parse(check.stdout);
  assert.equal(report.errorCount, 0);
  assert.equal(report.warningCount, 0);
});

test('explicit adoption edits only the selected note and preserves existing JavaScript hooks', () => {
  mkdirSync(path.join(root, 'notes'));
  const source = "// authored config\nexport const root = 'notes';\nexport function onCreate(doc) { return doc; }\n";
  writeFileSync(path.join(root, 'runlist.config.mjs'), source);
  writeFileSync(path.join(root, 'notes', 'selected.md'), '# Selected note\n');
  writeFileSync(path.join(root, 'notes', 'untouched.md'), '# Untouched note\n');
  const result = cli(['setup', '--yes', '--json', '--adopt', 'notes/selected.md']);
  JSON.parse(result.stdout);
  const selected = parseSimpleFrontmatter(extractFrontmatter(readFileSync(path.join(root, 'notes', 'selected.md'), 'utf8')).frontmatter);
  assert.equal(selected.type, 'doc');
  assert.equal(selected.status, 'draft');
  assert.match(selected.updated, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(readFileSync(path.join(root, 'notes', 'untouched.md'), 'utf8'), '# Untouched note\n');
  assert.equal(readFileSync(path.join(root, 'runlist.config.mjs'), 'utf8'), source);
  assert.equal(existsSync(path.join(root, '.gitignore')), false);
  const check = JSON.parse(cli(['check', '--json']).stdout);
  assert.ok(check.errors.some(error => error.path?.endsWith('untouched.md')), JSON.stringify(check.errors));
  assert.equal(check.errors.some(error => error.path?.endsWith('selected.md')), false, JSON.stringify(check.errors));
});

test('invalid plan choices fail before any setup writes', () => {
  const before = snapshot();
  for (const args of [
    ['--first-plan', 'example'],
    ['--first-plan', 'example', '--current-state', 'Known state.'],
    ['--prompt-tracking', 'invalid'],
    ['--host', 'invalid'],
    ['--root', 'notes'],
    ['--type', 'plan'],
  ]) {
    const result = cli(['setup', '--yes', '--json', ...args]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(snapshot(), before);
  }
});

test('a host installation preview describes a proposed action and creates no host files', () => {
  const before = snapshot();
  const result = cli(['setup', '--json', '--host', 'codex', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const action = report.actions.find(item => item.id === 'host');
  assert.match(action.preview, /Would install/);
  assert.deepEqual(snapshot(), before);
});

test('an explicit untracked choice replaces the legacy default without changing hooks or ignores', () => {
  const source = "export const root = 'notes';\nexport function onCreate(doc) { return doc; }\n";
  writeFileSync(path.join(root, 'runlist.config.mjs'), source);
  const result = cli(['setup', '--yes', '--json', '--prompt-tracking', 'untracked']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const current = JSON.parse(cli(['config', 'get', 'promptTracking', '--json']).stdout);
  assert.equal(current.value, 'untracked');
  assert.equal(current.source, 'config');
  assert.equal(readFileSync(path.join(root, 'runlist.config.mjs'), 'utf8'), source + "export const promptTracking = 'untracked';\n");
  assert.equal(existsSync(path.join(root, '.gitignore')), false);
});

test('human apply output reports completed actions without replaying dry-run instructions', () => {
  const result = cli(['setup', '--yes', '--docs-root', 'notes']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(root, 'runlist.config.mjs')), true);
  assert.match(result.stdout, /Completed: [1-9]/);
  assert.doesNotMatch(result.stdout, /\[dry-run\]|Ready to initialize/);
  assert.equal(existsSync(path.join(root, 'notes', 'plans', 'example-plan.md')), false);
});

function hostPath({ local = false, persistent = false } = {}) {
  const tools = path.join(root, 'host-tools');
  mkdirSync(tools);
  const stub = (directory, name, body = '') => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, name + (process.platform === 'win32' ? '.cmd' : '')),
      process.platform === 'win32' ? `@echo off\r\n${body}\r\n` : `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  stub(tools, 'claude', process.platform === 'win32' ? 'echo %*>>"%HOST_CALLS%"' : 'printf "%s\\n" "$*" >> "$HOST_CALLS"');
  if (process.platform !== 'win32') stub(tools, 'which', 'command -v "$1"');
  const temporary = local ? path.join(root, 'node_modules/.bin') : path.join(root, 'cache/_npx/abc123/node_modules/.bin');
  stub(temporary, 'runlist');
  if (persistent) stub(tools, 'runlist');
  const system = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32') : null;
  Object.assign(env, { PATH: [temporary, tools, system].filter(Boolean).join(path.delimiter),
    npm_command: 'exec', INIT_CWD: root, npm_config_local_prefix: root, npm_package_json: '',
    HOST_CALLS: path.join(root, 'host-calls') });
}

for (const local of [false, true]) for (const apply of [false, true]) {
  test(`setup ${apply ? 'apply' : 'preview'} JSON keeps a ${local ? 'project-local' : 'npx'} CLI prerequisite outstanding`, () => {
    hostPath({ local });
    const before = snapshot();
    const result = cli(['setup', '--host', 'claude', '--json', ...(apply ? ['--yes'] : ['--dry-run'])]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.checks.host.persistentCliMissing, true);
    const outstanding = report.outstanding.filter(item => item.id === 'persistent-cli');
    assert.equal(outstanding.length, 1);
    assert.match(outstanding[0].description, /lasting runlist CLI on PATH.*npm install -g runlist.*restart\/reload/);
    assert.equal(report.completed.some(item => item.id === 'persistent-cli'), false);
    assert.doesNotMatch(JSON.stringify(report.completed), /lasting runlist CLI|npm install -g runlist/);
    if (apply) {
      assert.equal(report.completed.find(item => item.id === 'host').description, 'claude install verb completed');
      assert.match(readFileSync(env.HOST_CALLS, 'utf8'), /plugin install/);
    } else assert.deepEqual(snapshot(), before);
  });
}

for (const apply of [false, true]) test(`setup ${apply ? 'apply' : 'preview'} prints the CLI warning under Outstanding`, () => {
  hostPath();
  const result = cli(['setup', '--host', 'claude', ...(apply ? ['--yes'] : ['--dry-run'])]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [completed, outstanding] = result.stdout.split(/\nOutstanding: \d+\n/);
  assert.match(outstanding, /lasting runlist CLI on PATH.*npm install -g runlist.*restart\/reload/);
  assert.doesNotMatch(completed.split(/\nCompleted: \d+\n/)[1], /lasting runlist CLI/);
});

for (const apply of [false, true]) test(`setup ${apply ? 'apply' : 'preview'} has no new warning with a lasting CLI`, () => {
  hostPath({ persistent: true });
  const result = cli(['setup', '--host', 'claude', '--json', ...(apply ? ['--yes'] : ['--dry-run'])]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(Object.hasOwn(report.checks.host, 'persistentCliMissing'), false);
  assert.equal(report.outstanding.some(item => item.id === 'persistent-cli'), false);
  assert.doesNotMatch(result.stdout + result.stderr, /lasting runlist CLI|npm install -g runlist/);
});
