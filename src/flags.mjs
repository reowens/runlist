import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withPathLocks } from './atomic-mutation.mjs';
import { stateDir } from './naming.mjs';
import { die, hostSessionSource, nowIso, toRepoPath } from './util.mjs';
import { bold, dim, green, red, yellow } from './color.mjs';

// Flags: what anyone found that the person should know when they come back —
// a plan contradicting another, a decision open in one place and ruled in
// another, a citation that no longer says what it claims. A session, a person
// or a check adds one; no model is needed. A later pass may build context onto
// an open flag, but the flag stands on what its author wrote.
//
// Storage is an append-only event log (`add`, `accept`, `reject`, `resolve`),
// one JSON object per line, so nothing is overwritten and the triage record
// survives as written. The current state of a flag is derived from its events.
// Default path `.runlist/flags.jsonl`; `export const flags = { file }` moves it.

export const SEVERITIES = ['problem', 'warn', 'info'];
const TRIAGE = new Set(['accept', 'reject', 'resolve']);
const QUOTE_MAX = 200;

export function flagsFile(config) {
  const configured = config.raw?.flags?.file;
  return configured ? path.resolve(config.repoRoot, configured) : path.join(stateDir(config.repoRoot), 'flags.jsonl');
}

export function readFlagEvents(file) {
  if (!existsSync(file)) return [];
  const events = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* a torn line is skipped, never fatal */ }
  }
  return events;
}

export function deriveFlags(events) {
  const flags = new Map();
  for (const e of events) {
    if (e.event === 'add' && e.id && !flags.has(e.id)) {
      flags.set(e.id, { ...e, state: 'open', triage: null, history: [] });
      continue;
    }
    const flag = flags.get(e.id);
    if (!flag || !TRIAGE.has(e.event)) continue;
    flag.history.push({ event: e.event, at: e.at, by: e.by, note: e.note ?? null });
    if (e.event === 'accept') flag.triage = 'accepted';
    if (e.event === 'reject') { flag.triage = 'rejected'; flag.state = 'closed'; }
    if (e.event === 'resolve') flag.state = 'resolved';
  }
  return [...flags.values()];
}

function nextId(flags) {
  let max = 0;
  for (const f of flags) max = Math.max(max, Number(String(f.id).replace(/^F/, '')) || 0);
  return `F${max + 1}`;
}

// `--by check:<name>`, `--by model:<name>`, `--by person:<name>`; otherwise the
// session the environment names, or the person at the keyboard.
export function resolveAuthor(byArg, env = process.env) {
  if (byArg) {
    const m = byArg.match(/^(session|person|check|model):(.+)$/);
    if (!m) die('--by is <kind>:<name>, where kind is session, person, check or model.');
    return { kind: m[1], name: m[2].trim() };
  }
  const source = hostSessionSource(env);
  if (source?.scope === 'session') return { kind: 'session', name: source.host, session: source.id };
  return { kind: 'person', name: os.userInfo().username };
}

export function normalizeText(text) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

// `docs/plans/x.md:12` → file and line; the file must exist in the repo and
// the line must be inside it. The line's text is kept, so a later read can say
// whether the place still says what was flagged.
export function resolvePlace(place, config) {
  const m = place.match(/^(.*?)(?::(\d+))?$/);
  const rel = m[1];
  const line = m[2] ? Number(m[2]) : null;
  const abs = path.resolve(config.repoRoot, rel);
  if (!existsSync(abs)) die(`No such file: ${rel}`);
  const repoPath = toRepoPath(abs, config.repoRoot);
  if (repoPath.startsWith('..')) die(`${rel} is outside the repository.`);
  let quote = null;
  if (line !== null) {
    const lines = readFileSync(abs, 'utf8').split('\n');
    if (line < 1 || line > lines.length) die(`${repoPath} has ${lines.length} lines; there is no line ${line}.`);
    quote = lines[line - 1].trim().slice(0, QUOTE_MAX);
  }
  return { file: repoPath, line, quote };
}

// Where the flagged text is now: unchanged, moved to another line, or gone.
export function locateFlag(flag, config) {
  if (flag.line == null) return { status: existsSync(path.resolve(config.repoRoot, flag.file)) ? 'here' : 'gone' };
  let lines;
  try { lines = readFileSync(path.resolve(config.repoRoot, flag.file), 'utf8').split('\n'); }
  catch { return { status: 'gone' }; }
  if ((lines[flag.line - 1] ?? '').trim().slice(0, QUOTE_MAX) === flag.quote) return { status: 'here', line: flag.line };
  if (flag.quote) {
    const at = lines.findIndex(l => l.trim().slice(0, QUOTE_MAX) === flag.quote);
    if (at !== -1) return { status: 'moved', line: at + 1 };
  }
  return { status: 'changed' };
}

function withFlagsLock(config, fn) {
  const file = flagsFile(config);
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return withPathLocks([file], { repoRoot: config.repoRoot }, () => fn(file));
}

function append(file, event) {
  appendFileSync(file, `${JSON.stringify(event)}\n`, { flag: 'a' });
}

export function addFlag(config, { place, text, severity = 'warn', by = null }) {
  if (!text || !text.trim()) die('A flag says what is wrong: runlist flag add <file[:line]> "<what is wrong>"');
  if (!SEVERITIES.includes(severity)) die(`--severity is one of ${SEVERITIES.join(', ')}.`);
  const where = resolvePlace(place, config);
  const author = typeof by === 'object' && by ? by : resolveAuthor(by);
  return withFlagsLock(config, file => {
    const flags = deriveFlags(readFlagEvents(file));
    const key = normalizeText(text);
    const same = flags.find(f => f.state === 'open' && f.file === where.file && f.line === where.line && normalizeText(f.text) === key);
    if (same) return { flag: same, added: false };
    const event = { event: 'add', id: nextId(flags), at: nowIso(), ...where, text: text.trim(), severity, by: author };
    append(file, event);
    return { flag: { ...event, state: 'open', triage: null, history: [] }, added: true };
  });
}

export function triageFlag(config, { id, event, note = null, by = null }) {
  const author = typeof by === 'object' && by ? by : resolveAuthor(by);
  return withFlagsLock(config, file => {
    const flag = deriveFlags(readFlagEvents(file)).find(f => f.id === id);
    if (!flag) die(`No flag ${id}.`);
    if (flag.state !== 'open') die(`${id} is already ${flag.state === 'closed' ? 'rejected' : flag.state}.`);
    append(file, { event, id, at: nowIso(), by: author, ...(note ? { note } : {}) });
    return flag;
  });
}

export function openFlags(config) {
  const rank = f => SEVERITIES.indexOf(f.severity);
  return deriveFlags(readFlagEvents(flagsFile(config)))
    .filter(f => f.state === 'open')
    .sort((a, b) => rank(a) - rank(b) || String(b.at).localeCompare(String(a.at)));
}

// A check's flags follow what the check reports: each error it reports is
// flagged once, and a flag it raised earlier that it no longer reports is
// resolved, so the list never holds a problem the check has stopped seeing.
export function syncCheckFlags(config, checkName, findings) {
  const by = { kind: 'check', name: checkName };
  const current = new Set(findings.map(f => `${f.file}\0${normalizeText(f.text)}`));
  let added = 0;
  let resolved = 0;
  for (const finding of findings) {
    if (!existsSync(path.resolve(config.repoRoot, finding.file))) continue;
    if (addFlag(config, { place: finding.file, text: finding.text, severity: 'problem', by }).added) added++;
  }
  for (const flag of openFlags(config)) {
    if (flag.by?.kind !== 'check' || flag.by?.name !== checkName) continue;
    if (current.has(`${flag.file}\0${normalizeText(flag.text)}`)) continue;
    triageFlag(config, { id: flag.id, event: 'resolve', note: `no longer reported by ${checkName}`, by });
    resolved++;
  }
  return { added, resolved };
}

function authorLabel(by) {
  if (!by) return 'unknown';
  return by.kind === 'session' ? `${by.name} session ${String(by.session ?? '').slice(0, 8)}` : `${by.kind} ${by.name}`;
}

function placeLabel(flag, config) {
  const where = locateFlag(flag, config);
  const base = flag.line != null ? `${flag.file}:${flag.line}` : flag.file;
  if (where.status === 'moved') return `${base} ${dim(`(now line ${where.line})`)}`;
  if (where.status === 'changed') return `${base} ${yellow('(text there has changed)')}`;
  if (where.status === 'gone') return `${base} ${yellow('(file gone)')}`;
  return base;
}

const severityLabel = s => (s === 'problem' ? red(s) : s === 'warn' ? yellow(s) : dim(s));

// One line for the session-start banner, or null when nothing is open.
export function flagsHudLine(config, { top = 3 } = {}) {
  let open;
  try { open = openFlags(config); } catch { return null; }
  if (open.length === 0) return null;
  const problems = open.filter(f => f.severity === 'problem').length;
  const items = open.slice(0, top).map(f => `${f.id} ${f.line != null ? `${f.file}:${f.line}` : f.file} ${f.text.slice(0, 80)}`).join('; ');
  return `[runlist] ${open.length} open flag${open.length === 1 ? '' : 's'}${problems ? `, ${problems} problem${problems === 1 ? '' : 's'}` : ''}, for awareness: ${items}. List: \`runlist flags\`.`;
}

export function runFlags(argv, config) {
  const json = argv.includes('--json');
  const all = argv.includes('--all');
  const events = readFlagEvents(flagsFile(config));
  const flags = deriveFlags(events)
    .filter(f => all || f.state === 'open')
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || String(b.at).localeCompare(String(a.at)));
  if (json) {
    process.stdout.write(`${JSON.stringify(flags.map(f => ({ ...f, location: locateFlag(f, config) })), null, 2)}\n`);
    return;
  }
  if (flags.length === 0) {
    process.stdout.write(dim(all ? 'No flags.\n' : 'No open flags.\n'));
    return;
  }
  for (const f of flags) {
    const state = f.state === 'open' ? (f.triage === 'accepted' ? green('accepted') : '') : dim(f.state === 'closed' ? 'rejected' : f.state);
    process.stdout.write(`${bold(f.id)} ${severityLabel(f.severity)} ${placeLabel(f, config)} ${state}\n`);
    process.stdout.write(`  ${f.text}\n`);
    process.stdout.write(dim(`  ${authorLabel(f.by)}, ${f.at}`) + '\n');
  }
}

export function runFlag(argv, config) {
  const [sub, ...rest] = argv;
  const positional = [];
  let severity;
  let by = null;
  let note = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--severity' && rest[i + 1]) { severity = rest[++i]; continue; }
    if (a === '--by' && rest[i + 1]) { by = rest[++i]; continue; }
    if (a === '--note' && rest[i + 1]) { note = rest[++i]; continue; }
    if (a === '--config') { i++; continue; }
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  const usage = 'Usage: runlist flag add <file[:line]> "<what is wrong>" [--severity problem|warn|info]\n'
    + '       runlist flag accept|reject|resolve <id> [--note "..."]\n'
    + '       runlist flag show <id>';

  if (sub === 'add') {
    const [place, ...words] = positional;
    if (!place) die(usage);
    const { flag, added } = addFlag(config, { place, text: words.join(' '), severity, by });
    process.stdout.write(added ? `${green('Flagged')} ${flag.id} ${placeLabel(flag, config)}\n` : `${dim('Already open as')} ${flag.id}\n`);
    return;
  }
  if (TRIAGE.has(sub)) {
    const [id] = positional;
    if (!id) die(usage);
    triageFlag(config, { id, event: sub, note, by });
    process.stdout.write(`${green({ accept: 'Accepted', reject: 'Rejected', resolve: 'Resolved' }[sub])} ${id}\n`);
    return;
  }
  if (sub === 'show') {
    const flag = deriveFlags(readFlagEvents(flagsFile(config))).find(f => f.id === positional[0]);
    if (!flag) die(`No flag ${positional[0] ?? ''}.`);
    process.stdout.write(`${bold(flag.id)} ${severityLabel(flag.severity)} ${placeLabel(flag, config)}\n  ${flag.text}\n`);
    if (flag.quote) process.stdout.write(dim(`  flagged line: ${flag.quote}`) + '\n');
    process.stdout.write(dim(`  raised by ${authorLabel(flag.by)}, ${flag.at}`) + '\n');
    for (const h of flag.history) process.stdout.write(dim(`  ${h.event} by ${authorLabel(h.by)}, ${h.at}${h.note ? `: ${h.note}` : ''}`) + '\n');
    return;
  }
  die(usage);
}
