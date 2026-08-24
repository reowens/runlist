import { describe, it, beforeEach, afterEach } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { sanitizeTelemetryArgv, sanitizeTelemetryText } from '../src/journal.mjs';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

let tmpDir;
let configPath;
let journalFile;
let journalBackup;

function setupProject(extraConfig = '') {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-journal-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  configPath = path.join(tmpDir, 'dotmd.config.mjs');
  writeFileSync(configPath, `export const root = 'docs';\n${extraConfig}`);
  journalFile = path.join(tmpDir, '.runlist', 'journal.jsonl');
  journalBackup = path.join(tmpDir, '.runlist', 'journal.jsonl.1');
}

function run(args, env = {}) {
  return spawnSync('node', [bin, ...args, '--config', configPath], {
    cwd: tmpDir, encoding: 'utf8',
    env: { ...process.env, ...env, NO_COLOR: '1', DOTMD_JOURNAL: env.DOTMD_JOURNAL ?? '' },
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('journal: opt-in default', () => {
  beforeEach(() => setupProject());

  it('no journal file is created when DOTMD_JOURNAL is unset and config is silent', () => {
    const r = run(['plans']);
    strictEqual(r.status, 0, r.stderr);
    ok(!existsSync(journalFile), `expected no journal file, found: ${journalFile}`);
  });
});

describe('journal: enabled via env', () => {
  beforeEach(() => setupProject());

  it('writes one JSONL line per invocation with all expected keys', () => {
    const r = run(['plans'], { DOTMD_JOURNAL: '1' });
    strictEqual(r.status, 0, r.stderr);
    ok(existsSync(journalFile), 'journal file should exist');
    const lines = readFileSync(journalFile, 'utf8').trim().split('\n');
    strictEqual(lines.length, 1, `expected 1 line, got ${lines.length}`);
    const entry = JSON.parse(lines[0]);
    for (const key of ['ts', 'sid', 'pid', 'argv', 'exit', 'ms', 'v']) {
      ok(key in entry, `missing key ${key} in entry: ${JSON.stringify(entry)}`);
    }
    strictEqual(entry.argv[0], 'plans');
    strictEqual(entry.exit, 0);
  });

  it('records non-zero exit and an err string on failure', () => {
    const r = run(['definitely-not-a-command'], { DOTMD_JOURNAL: '1' });
    ok(r.status !== 0, 'should fail');
    const lines = readFileSync(journalFile, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    strictEqual(entry.exit, 1);
    ok(typeof entry.err === 'string' && entry.err.length > 0,
      `expected err string, got: ${JSON.stringify(entry)}`);
    ok(!entry.err.includes('\n'),
      `err must be single-line for clean tail rendering: ${entry.err}`);
  });

  it('redacts prompt bodies, note/message values, and credential-shaped arguments', () => {
    const secret = 'UNIQUE_JOURNAL_SECRET_4f2a';
    const body = run(['new', 'prompt', 'secret-prompt', secret], { DOTMD_JOURNAL: '1' });
    strictEqual(body.status, 0, body.stderr);
    run(['definitely-not-a-command', '--note', secret, `API_TOKEN=${secret}`], { DOTMD_JOURNAL: '1' });
    const raw = readFileSync(journalFile, 'utf8');
    ok(!raw.includes(secret), raw);
    const entries = raw.trim().split('\n').map(JSON.parse);
    strictEqual(entries[0].schema, 2);
    strictEqual(entries[0].argv[3], '[redacted]');
    ok(entries[1].argv.includes('[redacted]'));
  });
});

describe('telemetry sanitizer', () => {
  it('preserves commands and paths while redacting sensitive values', () => {
    const secret = 'UNIQUE_SANITIZER_SECRET_7c9d';
    const argv = sanitizeTelemetryArgv(['new', 'prompt', 'resume-work', secret, '--token', secret, '--config', 'dotmd.config.mjs']);
    strictEqual(argv[0], 'new');
    strictEqual(argv[2], 'resume-work');
    strictEqual(argv[3], '[redacted]');
    strictEqual(argv[5], '[redacted]');
    strictEqual(argv[7], 'dotmd.config.mjs');
    const text = sanitizeTelemetryText(`git commit -m "${secret}"; sed -i 's/a/${secret}/' x; API_TOKEN=${secret}`);
    ok(!text.includes(secret), text);
    ok(text.includes('[redacted]'));
  });

  it('finds bodies across global flags, reordered prompt options, baton inline input, and database URLs', () => {
    const secret = 'UNIQUE_POSITIONAL_SECRET_0f8b';
    const cases = [
      ['--config', 'dotmd.config.mjs', 'new', 'prompt', '--status', 'pending', 'resume-work', secret],
      ['new', 'prompt', 'resume-work', secret, `${secret}_SECOND`],
      ['new', 'prompt', 'resume-work', `---\n${secret}`],
      ['prompts', 'new', 'resume-work', `---\n${secret}`],
      ['new', 'prompt', '--config', 'dotmd.config.mjs', 'resume-work', secret],
      ['baton', 'work', secret],
      ['query', `DATABASE_URL=postgres://user:${secret}@db.example/app`],
      ['query', '--client-secret', secret],
    ];
    for (const input of cases) {
      const output = sanitizeTelemetryArgv(input);
      ok(!JSON.stringify(output).includes(secret), `${input.join(' ')} -> ${JSON.stringify(output)}`);
    }
    const ownership = sanitizeTelemetryArgv(['--config', 'dotmd.config.mjs', 'use', 'docs/plans/work.md']);
    strictEqual(ownership[0], 'use');
    strictEqual(ownership[1], 'docs/plans/work.md');
  });
});

describe('journal: enabled via config', () => {
  beforeEach(() => setupProject(`export const journal = true;\n`));

  it('writes entries when config.journal is true (no env var needed)', () => {
    const r = run(['plans']);
    strictEqual(r.status, 0, r.stderr);
    ok(existsSync(journalFile), 'journal file should exist');
    const lines = readFileSync(journalFile, 'utf8').trim().split('\n');
    strictEqual(lines.length, 1);
  });

  it('does not write entries for dry-run or passive HUD invocations', () => {
    const dryRun = run(['plans', '--dry-run']);
    strictEqual(dryRun.status, 0, dryRun.stderr);
    const hud = run(['hud']);
    strictEqual(hud.status, 0, hud.stderr);
    const doctor = run(['doctor']);
    strictEqual(doctor.status, 0, doctor.stderr);
    ok(!existsSync(journalFile), 'preview/passive commands should not create a journal');
  });
});

describe('journal: concurrent writes', () => {
  beforeEach(() => setupProject());

  it('5 parallel invocations produce 5 well-formed lines (O_APPEND atomicity)', async () => {
    const procs = [];
    for (let i = 0; i < 5; i++) {
      procs.push(new Promise(resolve => {
        const child = spawnSync('node', [bin, 'plans', '--config', configPath], {
          cwd: tmpDir, encoding: 'utf8',
          env: { ...process.env, DOTMD_JOURNAL: '1', NO_COLOR: '1' },
        });
        resolve(child);
      }));
    }
    await Promise.all(procs);
    const raw = readFileSync(journalFile, 'utf8');
    const lines = raw.split('\n').filter(l => l.length > 0);
    strictEqual(lines.length, 5, `expected 5 lines, got ${lines.length}:\n${raw}`);
    for (const line of lines) {
      const entry = JSON.parse(line); // throws if malformed
      strictEqual(entry.argv[0], 'plans');
    }
  });
});

describe('journal: rotation', () => {
  beforeEach(() => setupProject());

  it('rotates to .1 backup when file exceeds 5MB', () => {
    mkdirSync(path.dirname(journalFile), { recursive: true });
    // 5MB + 1 byte of valid-ish padding (JSON parser will reject the line, but
    // rotation triggers on size before any parse attempt).
    const fakeEntry = JSON.stringify({ schema: 2, ts: new Date().toISOString(), sid: 'pre', pid: 0, argv: ['x'], exit: 0, ms: 1, v: '0.0.0' });
    const pad = ' '.repeat((5 * 1024 * 1024 + 1) - fakeEntry.length - 1);
    writeFileSync(journalFile, fakeEntry + pad + '\n');
    const before = statSync(journalFile).size;
    ok(before > 5 * 1024 * 1024, `seed should be >5MB, got ${before}`);

    const r = run(['plans'], { DOTMD_JOURNAL: '1' });
    strictEqual(r.status, 0, r.stderr);
    ok(existsSync(journalBackup), 'backup should be created');
    const newSize = statSync(journalFile).size;
    ok(newSize < before, `new file should be small (got ${newSize})`);
  });

  it('rotates on version change so active journal starts at current version', () => {
    mkdirSync(path.dirname(journalFile), { recursive: true });
    writeFileSync(journalFile, JSON.stringify({
      schema: 2,
      ts: new Date().toISOString(),
      sid: 'pre',
      pid: 0,
      argv: ['old'],
      exit: 0,
      ms: 1,
      v: '0.0.0',
    }) + '\n');

    const r = run(['plans'], { DOTMD_JOURNAL: '1' });
    strictEqual(r.status, 0, r.stderr);
    ok(existsSync(journalBackup), 'old-version journal should be backed up');
    const oldLines = readFileSync(journalBackup, 'utf8').trim().split('\n');
    strictEqual(JSON.parse(oldLines[0]).v, '0.0.0');

    const lines = readFileSync(journalFile, 'utf8').trim().split('\n');
    strictEqual(lines.length, 1, `expected only current-version entry, got:\n${readFileSync(journalFile, 'utf8')}`);
    const entry = JSON.parse(lines[0]);
    strictEqual(entry.argv[0], 'plans');
    ok(entry.v && entry.v !== '0.0.0', `expected current package version, got ${entry.v}`);
  });

  it('prunes stale rotation backups on write', () => {
    const first = run(['plans'], { DOTMD_JOURNAL: '1' });
    strictEqual(first.status, 0, first.stderr);

    writeFileSync(journalBackup, JSON.stringify({
      schema: 2,
      ts: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
      sid: 'old-backup',
      pid: 0,
      argv: ['old'],
      exit: 0,
      ms: 1,
      v: '0.0.0',
    }) + '\n');
    const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    utimesSync(journalBackup, old, old);

    const second = run(['plans'], { DOTMD_JOURNAL: '1' });
    strictEqual(second.status, 0, second.stderr);
    ok(!existsSync(journalBackup), 'stale backup should be pruned');
  });

  it('purges legacy unsanitized active and backup logs on the first schema-2 write', () => {
    mkdirSync(path.dirname(journalFile), { recursive: true });
    const secret = 'LEGACY_JOURNAL_SECRET_91ac';
    const legacy = JSON.stringify({ ts: new Date().toISOString(), argv: [secret], v: '0.69.0' }) + '\n';
    writeFileSync(journalFile, legacy);
    writeFileSync(journalBackup, legacy);

    const r = run(['plans'], { DOTMD_JOURNAL: '1' });
    strictEqual(r.status, 0, r.stderr);
    const current = readFileSync(journalFile, 'utf8');
    ok(!current.includes(secret));
    strictEqual(JSON.parse(current.trim()).schema, 2);
    ok(!existsSync(journalBackup), 'legacy backup was purged');
  });

  it('purges legacy journal entries before a reader can print them', () => {
    mkdirSync(path.dirname(journalFile), { recursive: true });
    const secret = 'LEGACY_READ_SECRET_d31f';
    writeFileSync(journalFile, JSON.stringify({ ts: new Date().toISOString(), argv: [secret] }) + '\n');
    const r = run(['journal', '--json'], { DOTMD_JOURNAL: '1' });
    strictEqual(r.status, 0, r.stderr);
    ok(!r.stdout.includes(secret), r.stdout);
  });
});

describe('dotmd journal (reader)', () => {
  beforeEach(() => setupProject());

  it('--tail N --json returns last N entries as a JSON array', () => {
    for (let i = 0; i < 5; i++) run(['plans'], { DOTMD_JOURNAL: '1' });
    const r = run(['journal', '--tail', '3', '--json']);
    strictEqual(r.status, 0, r.stderr);
    const arr = JSON.parse(r.stdout);
    ok(Array.isArray(arr), `expected array, got: ${r.stdout}`);
    strictEqual(arr.length, 3);
  });

  it('--errors filters out exit:0 entries', () => {
    run(['plans'], { DOTMD_JOURNAL: '1' });
    run(['bogus-command'], { DOTMD_JOURNAL: '1' });
    run(['plans'], { DOTMD_JOURNAL: '1' });
    const r = run(['journal', '--errors', '--json']);
    strictEqual(r.status, 0, r.stderr);
    const arr = JSON.parse(r.stdout);
    strictEqual(arr.length, 1, `expected 1 error entry, got ${arr.length}:\n${r.stdout}`);
    ok(arr[0].argv.includes('bogus-command'));
  });

  it('disabled-state message names RUNLIST_JOURNAL env var and journal config key', () => {
    // No journal file exists, env not set, config not set.
    const r = run(['journal']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stderr.includes('RUNLIST_JOURNAL'),
      `hint should name env var, got: ${r.stderr}`);
    ok(r.stderr.includes('journal: true'),
      `hint should name config key, got: ${r.stderr}`);
  });
});
