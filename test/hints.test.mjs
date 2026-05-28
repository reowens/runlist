import { describe, it, beforeEach, afterEach } from 'node:test';
import { ok, strictEqual, doesNotMatch, match } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

let tmpDir;
let configPath;
let journalFile;

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-hints-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  configPath = path.join(tmpDir, 'dotmd.config.mjs');
  writeFileSync(configPath, `export const root = 'docs';\n`);
  mkdirSync(path.join(tmpDir, '.dotmd'), { recursive: true });
  journalFile = path.join(tmpDir, '.dotmd', 'journal.jsonl');
}

const FIXED_SID = 'test-session-fixed';

// Run the CLI with a fixed CLAUDE_SESSION_ID so journal entries we pre-write
// here share the same sid the dispatcher will compute. Disable journal write
// (read-only path) unless the caller wants writes too.
function run(args, env = {}) {
  // Pin currentSessionId() to a known value. CLAUDE_CODE_SESSION_ID has higher
  // priority than CLAUDE_SESSION_ID, so set both — and override either if the
  // parent process leaks them.
  return spawnSync('node', [bin, ...args, '--config', configPath], {
    cwd: tmpDir, encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      DOTMD_JOURNAL: '1',
      CLAUDE_CODE_SESSION_ID: FIXED_SID,
      CLAUDE_SESSION_ID: FIXED_SID,
      ...env,
    },
  });
}

function writeJournalEntry(entry) {
  writeFileSync(journalFile, JSON.stringify(entry) + '\n', { flag: 'a' });
}

afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

describe('F17c: repeat-failure hints', () => {
  beforeEach(setupProject);

  it('first failure: no Tip line', () => {
    // Cold journal, single failing invocation. Output should NOT contain `Tip:`.
    const r = run(['use', 'no-such-file.md']);
    ok(r.status !== 0, 'use of missing file should fail');
    doesNotMatch(r.stderr, /^Tip:/m, `first failure must not include a Tip: line. stderr: ${r.stderr}`);
  });

  it('second failure with overlapping argv appends a Tip', () => {
    // Pre-write a prior failure for this session within the lookup window.
    writeJournalEntry({
      ts: new Date(Date.now() - 60_000).toISOString(),
      sid: FIXED_SID,
      pid: 12345,
      argv: ['use', 'no-such-file.md'],
      exit: 1,
      ms: 30,
      v: '0.0.0-test',
      err: 'File not found: no-such-file.md',
    });
    const r = run(['use', 'no-such-file.md']);
    ok(r.status !== 0);
    match(r.stderr, /Tip:/, `second failure should include Tip:. stderr: ${r.stderr}`);
    match(r.stderr, /pointing at a path that doesn't exist/i,
      `Tip body should reflect File-not-found template. stderr: ${r.stderr}`);
  });

  it('prior failure in a DIFFERENT session does not trigger a hint', () => {
    writeJournalEntry({
      ts: new Date(Date.now() - 60_000).toISOString(),
      sid: 'some-other-session',
      pid: 99999,
      argv: ['use', 'no-such-file.md'],
      exit: 1,
      ms: 30,
      v: '0.0.0-test',
      err: 'File not found: no-such-file.md',
    });
    const r = run(['use', 'no-such-file.md']);
    ok(r.status !== 0);
    doesNotMatch(r.stderr, /^Tip:/m,
      `cross-session prior failure must not produce a hint. stderr: ${r.stderr}`);
  });

  it('prior failure older than 10 minutes does not trigger a hint', () => {
    writeJournalEntry({
      ts: new Date(Date.now() - 30 * 60_000).toISOString(),
      sid: FIXED_SID,
      pid: 12345,
      argv: ['use', 'no-such-file.md'],
      exit: 1,
      ms: 30,
      v: '0.0.0-test',
      err: 'File not found: no-such-file.md',
    });
    const r = run(['use', 'no-such-file.md']);
    ok(r.status !== 0);
    doesNotMatch(r.stderr, /^Tip:/m,
      `stale prior failure must not produce a hint. stderr: ${r.stderr}`);
  });

  it('DOTMD_NO_HINTS=1 disables the hint even when journal would emit one', () => {
    writeJournalEntry({
      ts: new Date(Date.now() - 60_000).toISOString(),
      sid: FIXED_SID,
      pid: 12345,
      argv: ['use', 'no-such-file.md'],
      exit: 1,
      ms: 30,
      v: '0.0.0-test',
      err: 'File not found: no-such-file.md',
    });
    const r = run(['use', 'no-such-file.md'], { DOTMD_NO_HINTS: '1' });
    ok(r.status !== 0);
    doesNotMatch(r.stderr, /^Tip:/m,
      `DOTMD_NO_HINTS=1 must suppress the Tip line. stderr: ${r.stderr}`);
  });

  it('journal disabled: no hint and no journal-file IO', () => {
    // No DOTMD_JOURNAL env, no config.journal=true → journal disabled.
    writeJournalEntry({
      ts: new Date(Date.now() - 60_000).toISOString(),
      sid: FIXED_SID,
      pid: 12345,
      argv: ['use', 'no-such-file.md'],
      exit: 1,
      ms: 30,
      v: '0.0.0-test',
      err: 'File not found: no-such-file.md',
    });
    const r = run(['use', 'no-such-file.md'], { DOTMD_JOURNAL: '0' });
    ok(r.status !== 0);
    doesNotMatch(r.stderr, /^Tip:/m,
      `journal disabled must suppress hints. stderr: ${r.stderr}`);
  });

  it('template match: prior "No pending prompts" surfaces the queue-or-explicit-file tip', () => {
    writeJournalEntry({
      ts: new Date(Date.now() - 60_000).toISOString(),
      sid: FIXED_SID,
      pid: 12345,
      argv: ['next'],
      exit: 1,
      ms: 10,
      v: '0.0.0-test',
      err: 'No pending prompts. Pass a file to use a plan or doc.',
    });
    const r = run(['next']);
    ok(r.status !== 0);
    match(r.stderr, /Tip:.*queue one|pass an explicit prompt file/i,
      `expected next-with-empty-queue template. stderr: ${r.stderr}`);
  });
});
