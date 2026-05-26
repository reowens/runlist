import { existsSync, mkdirSync, appendFileSync, statSync, renameSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { currentSessionId } from './lease.mjs';

const JOURNAL_DIR = '.dotmd';
const JOURNAL_FILE = 'journal.jsonl';
const JOURNAL_BACKUP = 'journal.jsonl.1';
const ROTATE_SIZE_BYTES = 5 * 1024 * 1024;
const ROTATE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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

function maybeRotate(file, config) {
  if (!existsSync(file)) return;
  let st;
  try { st = statSync(file); } catch { return; }
  if (st.size > ROTATE_SIZE_BYTES) {
    try { renameSync(file, journalBackupPath(config)); } catch {}
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
      try { renameSync(file, journalBackupPath(config)); } catch {}
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
    maybeRotate(file, config);
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
