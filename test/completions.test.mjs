import { describe, it, beforeEach, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

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

describe('dotmd completions', () => {
  it('bash output contains complete -F', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-comp-'));
    const result = run(['completions', 'bash']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('complete -F'), 'has complete -F directive');
    ok(result.stdout.includes('_dotmd'), 'has _dotmd function');
  });

  it('zsh output contains compdef', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-comp-'));
    const result = run(['completions', 'zsh']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('compdef _dotmd dotmd'), 'has compdef directive');
    ok(result.stdout.includes('_dotmd'), 'has _dotmd function');
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
});
