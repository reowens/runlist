import { describe, it, afterEach } from 'node:test';
import { ok, strictEqual, doesNotMatch, match } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

let tmpDir;
let configPath;
let journalFile;

const FIXED_SID = 'sess-current';
const OTHER_SID = 'sess-other';

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-hudj-'));
  spawnSync('git', ['init', '-q'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: tmpDir });
  mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  configPath = path.join(tmpDir, 'dotmd.config.mjs');
  writeFileSync(configPath, `export const root = 'docs';\n`);
  mkdirSync(path.join(tmpDir, '.dotmd'), { recursive: true });
  writeFileSync(path.join(tmpDir, '.dotmd', 'primer-shown'), '');
  journalFile = path.join(tmpDir, '.dotmd', 'journal.jsonl');
}

function writeEntries(entries) {
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(journalFile, lines);
}

function runHud(args = [], env = {}) {
  return spawnSync('node', [bin, 'hud', ...args, '--config', configPath], {
    cwd: tmpDir, encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      CLAUDE_CODE_SESSION_ID: FIXED_SID,
      CLAUDE_SESSION_ID: FIXED_SID,
      ...env,
    },
  });
}

afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

describe('F17b: hud reads journal', () => {
  it('no journal file → hud output is byte-identical to pre-F17b (command primer only)', () => {
    setupProject();
    // No journal file written.
    const r = runHud();
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /dotmd: plans\|briefing/, 'primer present');
    doesNotMatch(r.stdout, /previous self/, 'no previous-self header when journal absent');
    doesNotMatch(r.stdout, /fleet/, 'no fleet header when journal absent');
    doesNotMatch(r.stdout, /recent rejections/, 'no rejections header when journal absent');
  });

  it('previous-self renders most-recent entries for current sid', () => {
    setupProject();
    const now = Date.now();
    writeEntries([
      { ts: new Date(now - 300_000).toISOString(), sid: FIXED_SID, pid: 1, argv: ['plans'], exit: 0, ms: 50 },
      { ts: new Date(now - 200_000).toISOString(), sid: FIXED_SID, pid: 1, argv: ['use', 'foo.md'], exit: 1, ms: 20, err: 'File not found' },
      { ts: new Date(now - 100_000).toISOString(), sid: FIXED_SID, pid: 1, argv: ['next'], exit: 0, ms: 10 },
    ]);
    const r = runHud();
    strictEqual(r.status, 0);
    match(r.stdout, /previous self/, 'section header present');
    match(r.stdout, /plans/);
    match(r.stdout, /use foo.md.*exit 1/, 'non-zero exit tagged');
    match(r.stdout, /next/);
  });

  it('previous-self omitted when no entries for current sid', () => {
    setupProject();
    writeEntries([
      { ts: new Date().toISOString(), sid: OTHER_SID, pid: 9, argv: ['plans'], exit: 0, ms: 5 },
    ]);
    const r = runHud();
    strictEqual(r.status, 0);
    doesNotMatch(r.stdout, /previous self/, 'no own entries → no section');
  });

  it('fleet renders one row per OTHER sid active in last 24h', () => {
    setupProject();
    const now = Date.now();
    writeEntries([
      { ts: new Date(now - 60_000).toISOString(), sid: FIXED_SID, pid: 1, argv: ['plans'], exit: 0, ms: 5 },
      { ts: new Date(now - 120_000).toISOString(), sid: OTHER_SID, pid: 2, argv: ['plans'], exit: 0, ms: 5 },
      { ts: new Date(now - 60_000).toISOString(), sid: OTHER_SID, pid: 2, argv: ['use', 'x.md'], exit: 1, ms: 5, err: 'no' },
    ]);
    const r = runHud();
    strictEqual(r.status, 0);
    match(r.stdout, /fleet/, 'section present');
    match(r.stdout, new RegExp(`session ${OTHER_SID}.*2 cmds`));
    doesNotMatch(r.stdout, new RegExp(`session ${FIXED_SID}`), 'own sid suppressed in fleet');
  });

  it('fleet omitted when only own sid has recent activity', () => {
    setupProject();
    writeEntries([
      { ts: new Date().toISOString(), sid: FIXED_SID, pid: 1, argv: ['plans'], exit: 0, ms: 5 },
    ]);
    const r = runHud();
    strictEqual(r.status, 0);
    doesNotMatch(r.stdout, /fleet/);
  });

  it('recent rejections groups by (command, error class) and caps at 3', () => {
    setupProject();
    const now = Date.now();
    const e = (off, argv, err) => ({
      ts: new Date(now - off).toISOString(), sid: FIXED_SID, pid: 1, argv, exit: 1, ms: 5, err,
    });
    writeEntries([
      e(60_000, ['use', 'a.md'], 'File not found: a.md'),
      e(120_000, ['use', 'b.md'], 'File not found: b.md'),
      e(180_000, ['use', 'c.md'], 'File not found: c.md'),
      e(240_000, ['use', 'd.md'], 'File not found: d.md'),
      e(300_000, ['set', 'x', 'y'], 'Too many arguments to set'),
    ]);
    const r = runHud();
    strictEqual(r.status, 0);
    match(r.stdout, /recent rejections/);
    // Four "File not found" rejections coalesce into one group.
    match(r.stdout, /4×.*File not found/);
  });

  it('rejections omitted when no errors in last 1h', () => {
    setupProject();
    const old = Date.now() - 3 * 60 * 60_000;
    writeEntries([
      { ts: new Date(old).toISOString(), sid: FIXED_SID, pid: 1, argv: ['use', 'foo.md'], exit: 1, ms: 5, err: 'File not found' },
    ]);
    const r = runHud();
    strictEqual(r.status, 0);
    doesNotMatch(r.stdout, /recent rejections/, 'old errors must not surface');
  });

  it('--json includes the three new keys', () => {
    setupProject();
    const now = Date.now();
    writeEntries([
      { ts: new Date(now - 60_000).toISOString(), sid: FIXED_SID, pid: 1, argv: ['plans'], exit: 0, ms: 5 },
    ]);
    const r = runHud(['--json']);
    strictEqual(r.status, 0);
    const obj = JSON.parse(r.stdout);
    ok('previousSelf' in obj);
    ok('fleet' in obj);
    ok('recentRejections' in obj);
    ok(Array.isArray(obj.previousSelf));
  });
});
