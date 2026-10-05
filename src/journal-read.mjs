import { existsSync } from 'node:fs';
import {
  readJournalEntries,
  journalFilePath,
  isJournalEnabled,
} from './journal.mjs';
import { dim, green, red } from './color.mjs';

function parseArgs(argv) {
  const opts = { tail: null, errorsOnly: false, sessionFilter: null, since: null, byCommand: false, helpTopics: false, asJson: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tail') {
      const n = parseInt(argv[++i], 10);
      opts.tail = Number.isFinite(n) && n > 0 ? n : 20;
    } else if (a === '--errors') opts.errorsOnly = true;
    else if (a === '--session' && argv[i + 1]) opts.sessionFilter = argv[++i];
    else if (a === '--since' && argv[i + 1]) opts.since = argv[++i];
    else if (a === '--by-command') opts.byCommand = true;
    else if (a === '--help-topics') opts.helpTopics = true;
    else if (a === '--json') opts.asJson = true;
  }
  // Default to last 20 when no view flag is given.
  if (opts.tail === null && !opts.errorsOnly && !opts.sessionFilter
      && !opts.since && !opts.byCommand && !opts.helpTopics) {
    opts.tail = 20;
  }
  return opts;
}

export function runJournal(argv, config) {
  const file = journalFilePath(config);
  const retained = readJournalEntries(config);
  if (!retained.length && !existsSync(file)) {
    if (!isJournalEnabled(config)) {
      process.stderr.write(
        'Journal is opt-in. Enable with `RUNLIST_JOURNAL=1` (env) or `journal: true` (in runlist.config.mjs).\n',
      );
      return;
    }
    process.stderr.write(`No journal entries yet at ${file}.\n`);
    return;
  }

  const opts = parseArgs(argv);
  let entries = retained;
  if (opts.errorsOnly) entries = entries.filter(e => e.exit !== 0);
  if (opts.sessionFilter) entries = entries.filter(e => e.sid === opts.sessionFilter);
  if (opts.since) entries = entries.filter(e => typeof e.ts === 'string' && e.ts >= opts.since);

  if (opts.helpTopics) {
    if (opts.tail) entries = entries.slice(-opts.tail);
    const help = entries.filter(e => e.helpTopic);
    const topics = [...new Set(help.map(e => e.helpTopic))].sort().map(topic => {
      const rows = help.filter(e => e.helpTopic === topic);
      return { topic, total: rows.length, sessions: new Set(rows.map(e => e.sid).filter(Boolean)).size, errors: rows.filter(e => e.exit !== 0).length };
    });
    const summary = {
      totalInvocations: entries.length,
      observedInvocations: entries.filter(e => e.outcome != null).length,
      legacyInvocations: entries.filter(e => e.outcome == null).length,
      helpInvocations: help.length,
      sessions: new Set(entries.map(e => e.sid).filter(Boolean)).size,
      versions: [...new Set(entries.map(e => e.v).filter(Boolean))].sort(),
      first: entries[0]?.ts ?? null, last: entries.at(-1)?.ts ?? null,
      coverage: 'Retained opt-in invocations; passive context, HUD, and dry runs are excluded. Legacy entries may predate help capture.',
      topics,
    };
    if (opts.asJson) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    else {
      process.stdout.write(`${summary.helpInvocations} help calls / ${summary.totalInvocations} retained invocations; ${summary.sessions} sessions.\n${summary.coverage}\n`);
      for (const row of topics) process.stdout.write(`${row.topic.padEnd(20)} ${row.total} help calls, ${row.sessions} sessions, ${row.errors} errors\n`);
    }
    return;
  }

  if (opts.byCommand) {
    const groups = new Map();
    for (const e of entries) {
      const cmd = (e.argv && e.argv[0]) || '(none)';
      if (!groups.has(cmd)) groups.set(cmd, []);
      groups.get(cmd).push(e);
    }
    const rows = [...groups.entries()].map(([cmd, list]) => {
      const total = list.length;
      const errors = list.filter(e => e.exit !== 0).length;
      const times = list.map(e => e.ms ?? 0).sort((a, b) => a - b);
      const median = times.length ? times[Math.floor(times.length / 2)] : 0;
      return { cmd, total, errors, median };
    }).sort((a, b) => b.total - a.total);

    if (opts.asJson) {
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      return;
    }
    for (const r of rows) {
      const errPart = r.errors > 0 ? ` ${red(`${r.errors} err`)}` : '';
      process.stdout.write(`${r.cmd.padEnd(20)} ${String(r.total).padStart(4)}× median ${r.median}ms${errPart}\n`);
    }
    return;
  }

  if (opts.tail) entries = entries.slice(-opts.tail);

  if (opts.asJson) {
    process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
    return;
  }

  for (const e of entries) {
    const argvStr = Array.isArray(e.argv) ? e.argv.join(' ') : '';
    const exitPart = e.exit === 0 ? green('ok') : red(`exit ${e.exit}`);
    const errPart = e.err ? ` ${dim(`(${e.err})`)}` : '';
    process.stdout.write(`[${e.ts}] ${argvStr} (${exitPart}, ${e.ms ?? '?'}ms)${errPart}\n`);
  }
}
