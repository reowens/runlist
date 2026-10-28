import { afterEach, describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { validateCommandArgs } from '../src/commands.mjs';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'runlist.mjs');
let root;

function run(args, session = 'reader') {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', RUNLIST_SESSION_ID: session },
  });
}

function setup() {
  root = mkdtempSync(path.join(os.tmpdir(), 'runlist-corrections-'));
  const git = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
  strictEqual(git.status, 0, git.stderr);
  mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(path.join(root, 'docs', 'prompts'), { recursive: true });
  writeFileSync(path.join(root, 'runlist.config.mjs'), "export const root = 'docs';\n");
  const lines = ['---', 'type: plan', 'status: active', 'title: Example', '---', '# Example', '## Phase 1'];
  while (lines.length < 120) lines.push(`Work item ${lines.length + 1}`);
  writeFileSync(path.join(root, 'docs', 'plans', 'example.md'), `${lines.join('\n')}\n`);
  writeFileSync(path.join(root, 'docs', 'prompts', 'resume-example.md'),
    '---\ntype: prompt\nstatus: pending\nplan: ../plans/example.md\n---\nResume example.\n');
  const claimed = run(['use', 'docs/plans/example.md'], 'peer');
  strictEqual(claimed.status, 0, claimed.stderr);
}

function state() {
  const paths = ['docs', '.runlist/ownership'].flatMap(dir =>
    readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => path.join(entry.parentPath, entry.name)));
  return paths.sort().map(file => [path.relative(root, file), readFileSync(file, 'utf8')]);
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe('corrective command guidance', () => {
  it('rejects the captured requests with bounded alternatives and preserves peer claims and prompts', () => {
    setup();
    const before = state();
    const cases = [
      [['edit', '--help'], /runlist set <status> <file>/],
      [['claims', '--help'], /runlist doctor --claims/],
      [['claims', '--help'], /read-only/],
      [['link', 'docs/plans/example.md', 'docs/prompts/resume-example.md'], /runlist xref <file>/],
      [['show', 'docs/plans/example.md', '--section', 'Phase 1', '--from', '93', '--lines', '12'], /Drop --lines/],
      [['edit', 'docs/plans/example.md'], /file editor/],
      [['claims'], /another session's claim/],
      [['link', '--help'], /runlist prompts show <name>/],
    ];
    for (const [args, expected] of cases) {
      const result = run(args);
      strictEqual(result.status, 1, `${args.join(' ')}\n${result.stderr}`);
      match(result.stderr, expected);
      ok(!result.stderr.includes('Did you mean'), result.stderr);
      ok(result.stderr.split('\n').length <= 15, result.stderr);
      ok(Buffer.byteLength(result.stderr) <= 4096, result.stderr);
      deepStrictEqual(state(), before);
    }

    for (const [args, expected] of [
      [['doctor', '--claims'], /session peer/],
      [['show', 'docs/plans/example.md', '--section', 'Phase 1', '--from', '93'], /93\s+Work item/],
      [['prompts', 'show', 'resume-example'], /Resume example/],
      [['xref', 'docs/plans/example.md'], /example/],
    ]) {
      const result = run(args);
      strictEqual(result.status, 0, result.stderr);
      match(result.stdout, expected);
      deepStrictEqual(state(), before);
    }
    for (const [command, args] of [
      ['set', ['active', 'docs/plans/example.md']],
      ['runlist', ['add', 'hub', 'example']],
    ]) deepStrictEqual(validateCommandArgs(command, args), args);
  });

  it('offers corrective help with broken config while leaving other unknown commands rejected', () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'runlist-corrections-broken-'));
    writeFileSync(path.join(root, 'runlist.config.mjs'), "throw new Error('broken config');\n");
    for (const [command, expected] of [
      ['edit', /runlist set/], ['claims', /runlist doctor --claims/], ['link', /runlist xref/],
    ]) {
      const result = run([command, '--help']);
      strictEqual(result.status, 1);
      match(result.stderr, expected);
      ok(!result.stderr.includes('broken config'), result.stderr);
    }
    const unknown = run(['unknown-example', '--help']);
    strictEqual(unknown.status, 1);
    match(unknown.stderr, /Unknown command: unknown-example/);
  });
});
