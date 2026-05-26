import { existsSync } from 'node:fs';
import {
  readJournalEntries,
  journalFilePath,
  isJournalEnabled,
} from './journal.mjs';
import { dim, green, red } from './color.mjs';

function parseArgs(argv) {
  const opts = { tail: null, errorsOnly: false, sessionFilter: null, since: null, byCommand: false, asJson: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tail') {
      const n = parseInt(argv[++i], 10);
      opts.tail = Number.isFinite(n) && n > 0 ? n : 20;
    } else if (a === '--errors') opts.errorsOnly = true;
    else if (a === '--session' && argv[i + 1]) opts.sessionFilter = argv[++i];
    else if (a === '--since' && argv[i + 1]) opts.since = argv[++i];
    else if (a === '--by-command') opts.byCommand = true;
    else if (a === '--json') opts.asJson = true;
  }
  // Default to last 20 when no view flag is given.
  if (opts.tail === null && !opts.errorsOnly && !opts.sessionFilter
      && !opts.since && !opts.byCommand) {
    opts.tail = 20;
  }
  return opts;
}

export function runJournal(argv, config) {
  const file = journalFilePath(config);
  if (!existsSync(file)) {
    if (!isJournalEnabled(config)) {
      process.stderr.write(
        'Journal is opt-in. Enable with `DOTMD_JOURNAL=1` (env) or `journal: true` (in dotmd.config.mjs).\n',
      );
      return;
    }
    process.stderr.write(`No journal entries yet at ${file}.\n`);
    return;
  }

  const opts = parseArgs(argv);
  let entries = readJournalEntries(config);
  if (opts.errorsOnly) entries = entries.filter(e => e.exit !== 0);
  if (opts.sessionFilter) entries = entries.filter(e => e.sid === opts.sessionFilter);
  if (opts.since) entries = entries.filter(e => typeof e.ts === 'string' && e.ts >= opts.since);

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
