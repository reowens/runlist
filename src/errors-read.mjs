import { readGlobalErrors, globalErrorLogPath } from './journal.mjs';
import { die } from './util.mjs';
import { dim, red } from './color.mjs';

// `runlist errors` — the newest failed runlist commands, from the cross-repo
// error log every failing invocation appends to.
function parseArgs(argv) {
  const opts = { limit: null, repo: null, asJson: false, byFamily: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' || a === '--tail') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) die(`${a} takes a whole number of entries, 1 or more.`);
      opts.limit = n;
    } else if (a === '--repo' && argv[i + 1]) opts.repo = argv[++i];
    else if (a === '--json') opts.asJson = true;
    else if (a === '--by-family') opts.byFamily = true;
  }
  if (opts.limit === null && !opts.byFamily) opts.limit = 20;
  return opts;
}

export function runErrors(argv) {
  const opts = parseArgs(argv);
  const entries = readGlobalErrors({ limit: opts.limit, repo: opts.repo, includeFamily: opts.byFamily });
  if (opts.byFamily) {
    const groups = [...new Set(entries.map(e => e.family))].sort().map(family => {
      const rows = entries.filter(e => e.family === family);
      return { family, total: rows.length, sessions: new Set(rows.map(e => e.session).filter(Boolean)).size, latest: rows[0] };
    });
    if (opts.asJson) process.stdout.write(JSON.stringify({ total: entries.length, groups }, null, 2) + '\n');
    else {
      process.stdout.write(`${entries.length} retained failures (${opts.limit ? `newest ${opts.limit} at most` : 'all retained'}).\n`);
      for (const row of groups) process.stdout.write(`${row.family}: ${row.total}, ${row.sessions} sessions\n  ${row.latest.message}\n`);
    }
    return;
  }
  if (opts.asJson) { process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`); return; }
  if (!entries.length) { process.stdout.write(`No failed runlist commands recorded in ${globalErrorLogPath()}.\n`); return; }
  for (const e of entries) {
    const repo = e.repo ? dim(` ${e.repo.split('/').pop()}`) : '';
    process.stdout.write(`[${e.at}]${repo} ${e.command}\n  ${red(e.message ?? '(no message)')}\n`);
  }
}
