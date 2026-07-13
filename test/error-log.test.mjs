import { describe, it, beforeEach, afterEach } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, utimesSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

let tmpDir;
let logDir;
let configPath;
let errorLogFile;
let errorLogBackup;

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-errlog-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  configPath = path.join(tmpDir, 'dotmd.config.mjs');
  writeFileSync(configPath, `export const root = 'docs';\n`);
  logDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-errlog-out-'));
  errorLogFile = path.join(logDir, 'dotmd-errors.log');
  errorLogBackup = path.join(logDir, 'dotmd-errors.log.1');
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
    for (const key of ['schema', 'ts', 'repo', 'sid', 'pid', 'argv', 'exit', 'ms', 'v', 'err']) {
      ok(key in entry, `missing key ${key}: ${JSON.stringify(entry)}`);
    }
    strictEqual(entry.argv[0], 'definitely-not-a-command');
    strictEqual(entry.exit, 1);
    strictEqual(entry.repo, tmpDir);
    strictEqual(entry.schema, 2);
    ok(entry.err.length > 0, 'err message should not be empty');
  });

  it('does not write an entry on successful invocations', () => {
    const r = run(['plans']);
    strictEqual(r.status, 0, r.stderr);
    ok(!existsSync(errorLogFile), `no error log expected, found: ${errorLogFile}`);
  });

  it('does not write an entry when a dry-run invocation fails', () => {
    const r = run(['definitely-not-a-command', '--dry-run']);
    ok(r.status !== 0, 'command should fail');
    ok(!existsSync(errorLogFile), 'dry-run failure should not create external log state');
  });

  it('does not write an entry when passive HUD fails during config loading', () => {
    writeFileSync(configPath, `throw new Error('broken passive config');\n`);
    const r = run(['hud']);
    ok(r.status !== 0, 'HUD should report the config failure');
    ok(!existsSync(errorLogFile), 'passive HUD failure should not create external log state');
  });

  it('guard --dry-run evaluates without writing the misuse log', () => {
    const payload = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: 'docs/prompts/private.md' },
    });
    const r = spawnSync('node', [bin, 'guard', '--dry-run', '--config', configPath], {
      cwd: tmpDir,
      encoding: 'utf8',
      input: payload,
      env: { ...process.env, NO_COLOR: '1', DOTMD_ERROR_LOG_DIR: logDir },
    });
    strictEqual(r.status, 0, r.stderr);
    ok(/additionalContext/.test(r.stdout), 'guard still previews its decision');
    ok(!existsSync(path.join(logDir, 'dotmd-misuse.log')), 'dry-run guard wrote no misuse log');
  });

  it('guard is a no-op and writes no misuse record outside a dotmd repository', () => {
    const unrelated = mkdtempSync(path.join(os.tmpdir(), 'dotmd-unrelated-'));
    try {
      const payload = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'docs/prompts/private.md' } });
      const r = spawnSync('node', [bin, 'guard'], {
        cwd: unrelated,
        encoding: 'utf8',
        input: payload,
        env: { ...process.env, NO_COLOR: '1', DOTMD_ERROR_LOG_DIR: logDir },
      });
      strictEqual(r.status, 0, r.stderr);
      strictEqual(r.stdout.trim(), '{}');
      ok(!existsSync(path.join(logDir, 'dotmd-misuse.log')));
    } finally {
      rmSync(unrelated, { recursive: true, force: true });
    }
  });

  it('guard fails open with {} when a discovered config cannot load', () => {
    writeFileSync(configPath, `throw new Error('broken guard config');\n`);
    const payload = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'docs/prompts/private.md' } });
    const r = spawnSync('node', [bin, 'guard', '--config', configPath], {
      cwd: tmpDir,
      encoding: 'utf8',
      input: payload,
      env: { ...process.env, NO_COLOR: '1', DOTMD_ERROR_LOG_DIR: logDir },
    });
    strictEqual(r.status, 0, r.stderr);
    strictEqual(r.stdout.trim(), '{}');
    ok(!existsSync(path.join(logDir, 'dotmd-misuse.log')));
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

  it('redacts sensitive argv and error text before persistence', () => {
    const secret = 'UNIQUE_ERROR_SECRET_7e31';
    const r = run(['definitely-not-a-command', '--message', secret, `API_TOKEN=${secret}`]);
    ok(r.status !== 0);
    const raw = readFileSync(errorLogFile, 'utf8');
    ok(!raw.includes(secret), raw);
    const entry = JSON.parse(raw.trim());
    ok(entry.argv.includes('[redacted]'));
  });

  it('guard logs retain only sanitized rule detail', () => {
    const secret = 'UNIQUE_GUARD_SECRET_a920';
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: `sed -i 's/status: ${secret}/status: archived/' docs/plans/x.md` },
    });
    const r = spawnSync('node', [bin, 'guard', '--config', configPath], {
      cwd: tmpDir,
      encoding: 'utf8',
      input: payload,
      env: { ...process.env, NO_COLOR: '1', DOTMD_ERROR_LOG_DIR: logDir },
    });
    strictEqual(r.status, 0, r.stderr);
    const misuse = readFileSync(path.join(logDir, 'dotmd-misuse.log'), 'utf8');
    ok(!misuse.includes(secret), misuse);
    const entry = JSON.parse(misuse.trim());
    strictEqual(entry.schema, 2);
    strictEqual(entry.detail, 'status-edit docs/plans/x.md');
  });

  it('guard write purges legacy unsanitized misuse logs and backups', () => {
    const misuseFile = path.join(logDir, 'dotmd-misuse.log');
    const misuseBackup = `${misuseFile}.1`;
    const secret = 'LEGACY_MISUSE_SECRET_51bb';
    const legacy = JSON.stringify({ ts: new Date().toISOString(), detail: secret, v: '0.69.0' }) + '\n';
    writeFileSync(misuseFile, legacy);
    writeFileSync(misuseBackup, legacy);
    const payload = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'docs/prompts/live.md' } });
    const r = spawnSync('node', [bin, 'guard', '--config', configPath], {
      cwd: tmpDir,
      encoding: 'utf8',
      input: payload,
      env: { ...process.env, NO_COLOR: '1', DOTMD_ERROR_LOG_DIR: logDir },
    });
    strictEqual(r.status, 0, r.stderr);
    const current = readFileSync(misuseFile, 'utf8');
    ok(!current.includes(secret));
    strictEqual(JSON.parse(current.trim()).schema, 2);
    ok(!existsSync(misuseBackup), 'legacy misuse backup was purged');
  });

  it('misuse reader purges legacy detail before rendering it', () => {
    const misuseFile = path.join(logDir, 'dotmd-misuse.log');
    const secret = 'LEGACY_MISUSE_READ_SECRET_1e2c';
    writeFileSync(misuseFile, JSON.stringify({ ts: new Date().toISOString(), detail: secret }) + '\n');
    const r = run(['misuse', '--json']);
    strictEqual(r.status, 0, r.stderr);
    ok(!r.stdout.includes(secret), r.stdout);
  });

  it('rotates on version change so active error log starts at current version', () => {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(errorLogFile, JSON.stringify({
      schema: 2,
      ts: new Date().toISOString(),
      repo: tmpDir,
      sid: 'pre',
      pid: 0,
      argv: ['old-bad-command'],
      exit: 1,
      ms: 1,
      v: '0.0.0',
      err: 'old failure',
    }) + '\n');

    const r = run(['definitely-not-a-command']);
    ok(r.status !== 0, 'command should fail');
    ok(existsSync(errorLogBackup), 'old-version error log should be backed up');
    const backup = JSON.parse(readFileSync(errorLogBackup, 'utf8').trim().split('\n')[0]);
    strictEqual(backup.v, '0.0.0');

    const lines = readFileSync(errorLogFile, 'utf8').trim().split('\n');
    strictEqual(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    strictEqual(entry.argv[0], 'definitely-not-a-command');
    ok(entry.v && entry.v !== '0.0.0', `expected current package version, got ${entry.v}`);
  });

  it('prunes stale rotation backups on write', () => {
    const first = run(['definitely-not-a-command']);
    ok(first.status !== 0, 'command should fail');

    writeFileSync(errorLogBackup, JSON.stringify({
      schema: 2,
      ts: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
      repo: tmpDir,
      sid: 'old-backup',
      pid: 0,
      argv: ['old-bad-command'],
      exit: 1,
      ms: 1,
      v: '0.0.0',
      err: 'old failure',
    }) + '\n');
    const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    utimesSync(errorLogBackup, old, old);

    const second = run(['definitely-not-a-command']);
    ok(second.status !== 0, 'command should fail');
    ok(!existsSync(errorLogBackup), 'stale backup should be pruned');
  });

  it('purges legacy unsanitized active and backup logs on the next write', () => {
    const secret = 'LEGACY_ERROR_SECRET_2d11';
    const legacy = JSON.stringify({ ts: new Date().toISOString(), argv: [secret], v: '0.69.0' }) + '\n';
    writeFileSync(errorLogFile, legacy);
    writeFileSync(errorLogBackup, legacy);
    run(['definitely-not-a-command']);
    const current = readFileSync(errorLogFile, 'utf8');
    ok(!current.includes(secret));
    strictEqual(JSON.parse(current.trim()).schema, 2);
    ok(!existsSync(errorLogBackup), 'legacy backup was purged');
  });
});
