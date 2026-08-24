import { existsSync, mkdirSync, appendFileSync, statSync, renameSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { currentSessionId } from './util.mjs';
import { readEnv, stateDir } from './naming.mjs';

const JOURNAL_FILE = 'journal.jsonl';
const JOURNAL_BACKUP = 'journal.jsonl.1';
const ROTATE_SIZE_BYTES = 5 * 1024 * 1024;
const ROTATE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const BACKUP_RETENTION_MS = ROTATE_AGE_MS;

const ERROR_LOG_FILE = 'dotmd-errors.log';
const ERROR_LOG_BACKUP = 'dotmd-errors.log.1';

const MISUSE_LOG_FILE = 'dotmd-misuse.log';
const MISUSE_LOG_BACKUP = 'dotmd-misuse.log.1';
const TELEMETRY_SCHEMA = 2;
const REDACTED = '[redacted]';
const SENSITIVE_VALUE_FLAGS = new Set([
  '--body', '--message', '--note',
  '--token', '--password', '--passphrase', '--secret', '--api-key', '--apikey',
  '--auth', '--authorization', '--cookie', '--header',
]);

function sanitizeCredentialShapes(value) {
  return String(value)
    .replace(/\b(Bearer\s+)[^\s'"`]+/gi, `$1${REDACTED}`)
    .replace(/\b([A-Z0-9_]*(?:TOKEN|PASSWORD|PASSPHRASE|SECRET|API_KEY|APIKEY|AUTH|DATABASE_URL|DB_URL|CONNECTION_STRING|DSN)[A-Z0-9_]*)=([^\s]+)/gi, `$1=${REDACTED}`)
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@]+@/gi, `$1${REDACTED}@`)
    .replace(/(-----BEGIN [^-]*PRIVATE KEY-----)[\s\S]*?(-----END [^-]*PRIVATE KEY-----)/g, `$1${REDACTED}$2`);
}

function sanitizeArgvWithSecrets(args) {
  const input = Array.isArray(args) ? args.map(value => String(value)) : [];
  const output = [...input];
  const secrets = [];
  const redactAt = (index) => {
    if (index < 0 || index >= output.length) return;
    if (output[index] && output[index] !== '-' && !output[index].startsWith('@')) secrets.push(output[index]);
    output[index] = REDACTED;
  };

  for (let i = 0; i < output.length; i++) {
    const arg = output[i];
    const sensitiveFlag = SENSITIVE_VALUE_FLAGS.has(arg)
      || /^--[^=]*(?:token|password|passphrase|secret|api[-_]?key|auth(?:orization)?|cookie)$/i.test(arg);
    if (sensitiveFlag) {
      redactAt(i + 1);
      i += 1;
      continue;
    }
    const eq = arg.indexOf('=');
    const flagName = eq > 0 ? arg.slice(0, eq) : '';
    if (eq > 0 && (SENSITIVE_VALUE_FLAGS.has(flagName)
      || /^--.*(?:token|password|passphrase|secret|api[-_]?key|auth(?:orization)?|cookie)$/i.test(flagName))) {
      const value = arg.slice(eq + 1);
      if (value) secrets.push(value);
      output[i] = `${arg.slice(0, eq)}=${REDACTED}`;
      continue;
    }
    output[i] = sanitizeCredentialShapes(arg);
    if (output[i] !== arg) secrets.push(arg);
  }

  const globalValueFlags = new Set(['--config', '--root', '--type']);
  let commandIndex = -1;
  for (let i = 0; i < input.length; i++) {
    if (globalValueFlags.has(input[i])) { i += 1; continue; }
    if (input[i].startsWith('-')) continue;
    commandIndex = i;
    break;
  }
  const command = input[commandIndex];
  const commandArgs = commandIndex >= 0 ? input.slice(commandIndex + 1) : [];
  const commandOffset = commandIndex + 1;
  const collectPositionals = (valueFlags, dashLeadingAfter = null) => {
    const positions = [];
    for (let i = 0; i < commandArgs.length; i++) {
      const arg = commandArgs[i];
      if (valueFlags.has(arg) || globalValueFlags.has(arg)) { i += 1; continue; }
      if (arg.startsWith('-') && arg !== '-'
        && !(dashLeadingAfter !== null && positions.length >= dashLeadingAfter)) continue;
      positions.push(commandOffset + i);
    }
    return positions;
  };
  if (command === 'new') {
    const positions = collectPositionals(new Set(['--status', '--title', '--runlist', '--body', '--message', '--root']), 2);
    if (positions.length >= 3 && input[positions[0]] === 'prompt') positions.slice(2).forEach(redactAt);
  } else if (command === 'prompts' || command === 'prompt') {
    const positions = collectPositionals(new Set(['--status', '--body', '--message', '--title']), 2);
    if (positions.length >= 3 && input[positions[0]] === 'new') positions.slice(2).forEach(redactAt);
  } else if (command === 'baton') {
    const positions = collectPositionals(new Set(['--status', '--note', '--body', '--message']));
    if (positions.length >= 2) positions.slice(1).forEach(redactAt);
  }

  const argv = commandIndex > 0
    ? [output[commandIndex], ...output.slice(commandIndex + 1), ...output.slice(0, commandIndex)]
    : output;
  return { argv, secrets };
}

export function sanitizeTelemetryArgv(args) {
  return sanitizeArgvWithSecrets(args).argv;
}

export function sanitizeTelemetryText(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join(REDACTED);
  }
  return sanitizeCredentialShapes(text)
    .replace(/((?:--body|--message|--note|--token|--password|--passphrase|--secret|--api-key|--apikey|--auth|--authorization|--cookie|--header)(?:=|\s+))([^\s]+)/gi, `$1${REDACTED}`)
    .replace(/(git\s+commit\b[^\n]*?(?:\s-m|\s--message)(?:=|\s+))((?:"[^"]*")|(?:'[^']*')|[^\s]+)/gi, `$1${REDACTED}`)
    .replace(/((?:sed|perl|g?awk)\b[^\n]*?\s(?:-e\s+)?)((?:"[^"]*")|(?:'[^']*'))/gi, `$1${REDACTED}`);
}

export function isJournalEnabled(config) {
  if (readEnv('JOURNAL') === '1') return true;
  if (readEnv('JOURNAL') === '0') return false;
  return config?.journal === true;
}

export function journalFilePath(config) {
  return path.join(stateDir(config.repoRoot), JOURNAL_FILE);
}

export function journalBackupPath(config) {
  return path.join(stateDir(config.repoRoot), JOURNAL_BACKUP);
}

function firstEntry(file) {
  try {
    const sample = readFileSync(file, 'utf8');
    const nl = sample.indexOf('\n');
    const first = nl >= 0 ? sample.slice(0, nl) : sample;
    if (!first.trim()) return null;
    const obj = JSON.parse(first);
    return obj;
  } catch {
    return null;
  }
}

function maybeRotate(file, backup, nextEntry = null) {
  pruneStaleBackup(backup);
  if (nextEntry?.schema != null) {
    for (const candidate of [file, backup]) {
      if (!existsSync(candidate)) continue;
      const existingSchema = firstEntry(candidate)?.schema;
      if (existingSchema !== nextEntry.schema) {
        try { unlinkSync(candidate); } catch {}
      }
    }
  }
  if (!existsSync(file)) return;
  let st;
  try { st = statSync(file); } catch { return; }
  if (nextEntry?.v) {
    const existingVersion = firstEntry(file)?.v;
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
    const sanitized = sanitizeArgvWithSecrets(entry?.argv);
    const safeEntry = {
      ...entry,
      schema: TELEMETRY_SCHEMA,
      ...(Array.isArray(entry?.argv) ? { argv: sanitized.argv } : {}),
      ...(entry?.err ? { err: sanitizeTelemetryText(entry.err, sanitized.secrets) } : {}),
    };
    const dir = stateDir(config.repoRoot);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = journalFilePath(config);
    maybeRotate(file, journalBackupPath(config), safeEntry);
    // O_APPEND is atomic for writes under PIPE_BUF (4KB on Linux, 512B on
    // macOS). Entries are well under either threshold, so concurrent CLI
    // invocations interleave cleanly without locking.
    appendFileSync(file, JSON.stringify(safeEntry) + '\n', { flag: 'a' });
  } catch {
    // Journal write must never break a command.
  }
}

function purgeLegacyTelemetry(file, backup) {
  for (const candidate of [file, backup]) {
    if (!existsSync(candidate)) continue;
    if (firstEntry(candidate)?.schema !== TELEMETRY_SCHEMA) {
      try { unlinkSync(candidate); } catch {}
    }
  }
}

export function readJournalEntries(config) {
  const file = journalFilePath(config);
  purgeLegacyTelemetry(file, journalBackupPath(config));
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
  const sanitized = sanitizeArgvWithSecrets(args);
  const entry = {
    schema: TELEMETRY_SCHEMA,
    ts: new Date().toISOString(),
    sid: currentSessionId(),
    pid: process.pid,
    argv: sanitized.argv,
    exit: process.exitCode ?? 0,
    ms: Date.now() - startMs,
    v: version,
  };
  if (err) {
    // Normalize whitespace so multi-line error messages (e.g. unknown-command
    // hints) render as a single line in `dotmd journal --tail`. Cap at 200
    // chars so a stray stack trace can't bloat the journal.
    const flat = sanitizeTelemetryText(err.message ?? err, sanitized.secrets).replace(/\s+/g, ' ').trim();
    entry.err = flat.length > 200 ? flat.slice(0, 197) + '...' : flat;
  }
  appendJournalEntry(config, entry);
}

// Global error log: always-on, cross-repo, captured per failed invocation.
// Independent of `isJournalEnabled` so silent failures stop disappearing.
// RUNLIST_ERROR_LOG_DIR overrides the default location (for tests, or for
// users who want the log somewhere other than ~/.claude/logs).

export function globalErrorLogDir() {
  return readEnv('ERROR_LOG_DIR') || path.join(os.homedir(), '.claude', 'logs');
}

export function globalErrorLogPath() {
  return path.join(globalErrorLogDir(), ERROR_LOG_FILE);
}

export function globalErrorLogBackupPath() {
  return path.join(globalErrorLogDir(), ERROR_LOG_BACKUP);
}

export function recordGlobalError({ config, startMs, args, err, version }) {
  if (!err) return;
  const sanitized = sanitizeArgvWithSecrets(args);
  const flatMsg = sanitizeTelemetryText(err.message ?? err, sanitized.secrets).replace(/\s+/g, ' ').trim();
  const entry = {
    schema: TELEMETRY_SCHEMA,
    ts: new Date().toISOString(),
    repo: config?.repoRoot || process.cwd(),
    sid: currentSessionId(),
    pid: process.pid,
    argv: sanitized.argv,
    exit: process.exitCode ?? 1,
    ms: typeof startMs === 'number' ? Date.now() - startMs : null,
    v: version,
    err: flatMsg.length > 500 ? flatMsg.slice(0, 497) + '...' : flatMsg,
  };
  if (err && err.name) entry.errName = err.name;
  if (err && err.stack) {
    // Keep the first few frames; stacks for DotmdError are short anyway and
    // for unexpected exceptions five frames is usually enough to localize.
    const stack = sanitizeTelemetryText(err.stack, sanitized.secrets).split('\n').slice(0, 6).join('\n');
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
    schema: TELEMETRY_SCHEMA,
    ts: new Date().toISOString(),
    repo: event.repo || process.cwd(),
    sid: currentSessionId(),
    pid: process.pid,
    tool: event.tool ?? null,
    rule: event.rule ?? null,
    decision: event.decision ?? null,
    detail: typeof event.detail === 'string'
      ? (sanitizeTelemetryText(event.detail).length > 300 ? sanitizeTelemetryText(event.detail).slice(0, 297) + '...' : sanitizeTelemetryText(event.detail))
      : null,
    v: event.version ?? null,
  };
  try {
    const dir = globalErrorLogDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = globalMisuseLogPath();
    maybeRotate(file, globalMisuseLogBackupPath(), entry);
    appendFileSync(file, JSON.stringify(entry) + '\n', { flag: 'a' });
  } catch {
    // Logging must never break the hook.
  }
}

export function readMisuseEntries() {
  const file = globalMisuseLogPath();
  purgeLegacyTelemetry(file, globalMisuseLogBackupPath());
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
