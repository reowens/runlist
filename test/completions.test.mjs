import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { COMPLETION_COMMANDS, commandCompletionWords } from '../src/commands.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

function run(args, opts = {}) {
  return spawnSync('node', [BIN, ...args], {
    cwd: tmpDir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    ...opts,
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('runlist completions', () => {
  it('bash output contains complete -F', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-comp-'));
    const result = run(['completions', 'bash']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('complete -F'), 'has complete -F directive');
    ok(result.stdout.includes('_runlist'), 'has _runlist function');
    ok(result.stdout.includes('runlist dotmd'), 'registers canonical and legacy binaries');
  });

  it('zsh output contains compdef', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-comp-'));
    const result = run(['completions', 'zsh']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('compdef _runlist runlist dotmd'), 'has dual-name compdef directive');
    ok(result.stdout.includes('_runlist'), 'has _runlist function');
  });

  it('unknown shell exits with error', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-comp-'));
    const result = run(['completions', 'fish']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('Unsupported shell'), 'shows unsupported shell error');
  });

  it('no shell argument exits with error', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-comp-'));
    const result = run(['completions']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('Usage'), 'shows usage');
  });

  for (const shell of ['bash', 'zsh']) {
    it(`${shell} output lists every public schema command and alias`, () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-comp-'));
      const out = run(['completions', shell]).stdout;
      const missing = COMPLETION_COMMANDS.filter(c => !new RegExp(`(^|[\\s'"(])${c}([\\s'"),]|$)`, 'm').test(out));
      strictEqual(missing.length, 0, `missing from ${shell} completions: ${missing.join(', ')}`);
      for (const removed of ['pickup', 'unpickup', 'release', 'finish', 'handoff', 'self-check']) {
        ok(!new RegExp(`(^|[\\s'"])${removed}([\\s'"]|$)`, 'm').test(out), `${removed} should stay hidden`);
      }
    });

    it(`${shell} output derives options and subcommands from the schema`, () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-comp-'));
      const out = run(['completions', shell]).stdout;
      for (const command of ['roadmap', 'runlist', 'bulk-tag', 'new', 'statuses']) {
        for (const word of commandCompletionWords(command)) {
          ok(out.includes(word), `${shell} completion missing ${command} word ${word}`);
        }
      }
      ok(out.includes('--print'), `${shell} completion should expose index --print`);
      ok(!out.includes('--write'), `${shell} completion should not expose removed index --write`);
    });
  }
});
