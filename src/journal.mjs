import { existsSync, mkdirSync, appendFileSync, statSync, renameSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { currentSessionId } from './util.mjs';

const JOURNAL_DIR = '.dotmd';
const JOURNAL_FILE = 'journal.jsonl';
const JOURNAL_BACKUP = 'journal.jsonl.1';
const ROTATE_SIZE_BYTES = 5 * 1024 * 1024;
const ROTATE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const BACKUP_RETENTION_MS = ROTATE_AGE_MS;

const ERROR_LOG_FILE = 'dotmd-errors.log';
const ERROR_LOG_BACKUP = 'dotmd-errors.log.1';

const MISUSE_LOG_FILE = 'dotmd-misuse.log';
const MISUSE_LOG_BACKUP = 'dotmd-misuse.log.1';

export function isJournalEnabled(config) {
  if (process.env.DOTMD_JOURNAL === '1') return true;
  if (process.env.DOTMD_JOURNAL === '0') return false;
  return config?.journal === true;
}

export function journalFilePath(config) {
  return path.join(config.repoRoot, JOURNAL_DIR, JOURNAL_FILE);
}

export function journalBackupPath(config) {
  return path.join(config.repoRoot, JOURNAL_DIR, JOURNAL_BACKUP);
}

function firstEntryVersion(file) {
  try {
    const sample = readFileSync(file, 'utf8');
    const nl = sample.indexOf('\n');
    const first = nl >= 0 ? sample.slice(0, nl) : sample;
    if (!first.trim()) return null;
    const obj = JSON.parse(first);
    return obj?.v == null ? null : String(obj.v);
  } catch {
    return null;
  }
}

function maybeRotate(file, backup, nextEntry = null) {
  pruneStaleBackup(backup);
  if (!existsSync(file)) return;
  let st;
  try { st = statSync(file); } catch { return; }
  if (nextEntry?.v) {
    const existingVersion = firstEntryVersion(file);
    if (existingVersion !== String(nextEntry.v)) {
      try { renameSync(file, backup); } catch {}
      return;
    }
  }
  if (st.size > ROTATE_SIZE_BYTES) {
    try { renameSync(file, backup); } catch {}
    return;
  }
  if (st.size === 0) return;
  // Age check: only the first line's ts matters for "oldest entry" — cheap
  // peek instead of streaming the whole file.
  try {
    const sample = readFileSync(file, 'utf8');
    const nl = sample.indexOf('\n');
    const first = nl >= 0 ? sample.slice(0, nl) : sample;
    if (!first) return;
    const obj = JSON.parse(first);
    const t = new Date(obj.ts).getTime();
    if (!Number.isNaN(t) && (Date.now() - t) > ROTATE_AGE_MS) {
      try { renameSync(file, backup); } catch {}
    }
  } catch {}
}

function pruneStaleBackup(backup) {
  if (!existsSync(backup)) return;
  try {
    const st = statSync(backup);
    if ((Date.now() - st.mtimeMs) > BACKUP_RETENTION_MS) {
      try { unlinkSync(backup); } catch {}
    }
  } catch {}
}

export function appendJournalEntry(config, entry) {
  if (!isJournalEnabled(config)) return;
  if (!config?.repoRoot) return;
  try {
    const dir = path.join(config.repoRoot, JOURNAL_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = journalFilePath(config);
    maybeRotate(file, journalBackupPath(config), entry);
    // O_APPEND is atomic for writes under PIPE_BUF (4KB on Linux, 512B on
    // macOS). Entries are well under either threshold, so concurrent CLI
    // invocations interleave cleanly without locking.
    appendFileSync(file, JSON.stringify(entry) + '\n', { flag: 'a' });
  } catch {
    // Journal write must never break a command.
  }
}

export function readJournalEntries(config) {
  const file = journalFilePath(config);
  if (!existsSync(file)) return [];
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

export function recordCliInvocation({ config, startMs, args, err, version }) {
  if (!config) return;
  const entry = {
    ts: new Date().toISOString(),
    sid: currentSessionId(),
    pid: process.pid,
    argv: args,
    exit: process.exitCode ?? 0,
    ms: Date.now() - startMs,
    v: version,
  };
  if (err) {
    // Normalize whitespace so multi-line error messages (e.g. unknown-command
    // hints) render as a single line in `dotmd journal --tail`. Cap at 200
    // chars so a stray stack trace can't bloat the journal.
    const flat = String(err.message ?? err).replace(/\s+/g, ' ').trim();
    entry.err = flat.length > 200 ? flat.slice(0, 197) + '...' : flat;
  }
  appendJournalEntry(config, entry);
}

// Global error log: always-on, cross-repo, captured per failed invocation.
// Independent of `isJournalEnabled` so silent failures stop disappearing.
// DOTMD_ERROR_LOG_DIR overrides the default location (for tests, or for
// users who want the log somewhere other than ~/.claude/logs).

export function globalErrorLogDir() {
  return process.env.DOTMD_ERROR_LOG_DIR || path.join(os.homedir(), '.claude', 'logs');
}

export function globalErrorLogPath() {
  return path.join(globalErrorLogDir(), ERROR_LOG_FILE);
}

export function globalErrorLogBackupPath() {
  return path.join(globalErrorLogDir(), ERROR_LOG_BACKUP);
}

export function recordGlobalError({ config, startMs, args, err, version }) {
  if (!err) return;
  const flatMsg = String(err.message ?? err).replace(/\s+/g, ' ').trim();
  const entry = {
    ts: new Date().toISOString(),
    repo: config?.repoRoot || process.cwd(),
    sid: currentSessionId(),
    pid: process.pid,
    argv: args,
    exit: process.exitCode ?? 1,
    ms: typeof startMs === 'number' ? Date.now() - startMs : null,
    v: version,
    err: flatMsg.length > 500 ? flatMsg.slice(0, 497) + '...' : flatMsg,
  };
  if (err && err.name) entry.errName = err.name;
  if (err && err.stack) {
    // Keep the first few frames; stacks for DotmdError are short anyway and
    // for unexpected exceptions five frames is usually enough to localize.
    const stack = String(err.stack).split('\n').slice(0, 6).join('\n');
    entry.stack = stack.length > 1000 ? stack.slice(0, 997) + '...' : stack;
  }
  try {
    const dir = globalErrorLogDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = globalErrorLogPath();
    maybeRotate(file, globalErrorLogBackupPath(), entry);
    appendFileSync(file, JSON.stringify(entry) + '\n', { flag: 'a' });
  } catch {
    // Logging must never break exit.
  }
}

// Misuse log: always-on, cross-repo, append-only record of every wrong-move the
// PreToolUse guard intercepts (committing a gitignored prompt, `cat`-ing a
// prompt instead of `dotmd use`, hand-editing a `status:` field, …). This is
// the ONLY place those mistakes become visible — they never invoke dotmd, so
// neither the per-repo journal nor the global error log would otherwise see
// them. Shares the error log's directory and rotation so `~/.claude/logs` is
// the single home for "what went wrong." Read it with `dotmd misuse`.
export function globalMisuseLogPath() {
  return path.join(globalErrorLogDir(), MISUSE_LOG_FILE);
}

export function globalMisuseLogBackupPath() {
  return path.join(globalErrorLogDir(), MISUSE_LOG_BACKUP);
}

export function recordGuardEvent(event) {
  if (!event) return;
  const entry = {
    ts: new Date().toISOString(),
    repo: event.repo || process.cwd(),
    sid: currentSessionId(),
    pid: process.pid,
    tool: event.tool ?? null,
    rule: event.rule ?? null,
    decision: event.decision ?? null,
    detail: typeof event.detail === 'string'
      ? (event.detail.length > 300 ? event.detail.slice(0, 297) + '...' : event.detail)
      : null,
    v: event.version ?? null,
  };
  try {
    const dir = globalErrorLogDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = globalMisuseLogPath();
    maybeRotate(file, globalMisuseLogBackupPath());
    appendFileSync(file, JSON.stringify(entry) + '\n', { flag: 'a' });
  } catch {
    // Logging must never break the hook.
  }
}

export function readMisuseEntries() {
  const file = globalMisuseLogPath();
  if (!existsSync(file)) return [];
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}
