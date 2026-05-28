import { describe, it, beforeEach, afterEach } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

let tmpDir;
let logDir;
let configPath;
let errorLogFile;

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-errlog-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  configPath = path.join(tmpDir, 'dotmd.config.mjs');
  writeFileSync(configPath, `export const root = 'docs';\n`);
  logDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-errlog-out-'));
  errorLogFile = path.join(logDir, 'dotmd-errors.log');
}

function run(args, env = {}) {
  return spawnSync('node', [bin, ...args, '--config', configPath], {
    cwd: tmpDir, encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      NO_COLOR: '1',
      DOTMD_JOURNAL: env.DOTMD_JOURNAL ?? '',
      DOTMD_ERROR_LOG_DIR: logDir,
    },
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  if (logDir) rmSync(logDir, { recursive: true, force: true });
});

describe('global error log: always-on on failure', () => {
  beforeEach(() => setupProject());

  it('writes a JSONL entry when a command fails, even with journal disabled', () => {
    const r = run(['definitely-not-a-command']);
    ok(r.status !== 0, 'command should fail');
    ok(existsSync(errorLogFile), `error log should exist at ${errorLogFile}`);
    const lines = readFileSync(errorLogFile, 'utf8').trim().split('\n');
    strictEqual(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    for (const key of ['ts', 'repo', 'sid', 'pid', 'argv', 'exit', 'ms', 'v', 'err']) {
      ok(key in entry, `missing key ${key}: ${JSON.stringify(entry)}`);
    }
    strictEqual(entry.argv[0], 'definitely-not-a-command');
    strictEqual(entry.exit, 1);
    strictEqual(entry.repo, tmpDir);
    ok(entry.err.length > 0, 'err message should not be empty');
  });

  it('does not write an entry on successful invocations', () => {
    const r = run(['plans']);
    strictEqual(r.status, 0, r.stderr);
    ok(!existsSync(errorLogFile), `no error log expected, found: ${errorLogFile}`);
  });

  it('appends one entry per failed invocation', () => {
    run(['definitely-not-a-command']);
    run(['another-bad-command']);
    const lines = readFileSync(errorLogFile, 'utf8').trim().split('\n');
    strictEqual(lines.length, 2);
    const argvs = lines.map(l => JSON.parse(l).argv[0]);
    ok(argvs.includes('definitely-not-a-command'));
    ok(argvs.includes('another-bad-command'));
  });
});
