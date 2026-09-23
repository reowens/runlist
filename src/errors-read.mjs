import { readGlobalErrors, globalErrorLogPath } from './journal.mjs';
import { die } from './util.mjs';
import { dim, red } from './color.mjs';

// `runlist errors` — the newest failed runlist commands, from the cross-repo
// error log every failing invocation appends to.
function parseArgs(argv) {
  const opts = { limit: 20, repo: null, asJson: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' || a === '--tail') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) die(`${a} takes a whole number of entries, 1 or more.`);
      opts.limit = n;
    } else if (a === '--repo' && argv[i + 1]) opts.repo = argv[++i];
    else if (a === '--json') opts.asJson = true;
  }
  return opts;
}

export function runErrors(argv) {
  const opts = parseArgs(argv);
  const entries = readGlobalErrors({ limit: opts.limit, repo: opts.repo });
  if (opts.asJson) { process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`); return; }
  if (!entries.length) { process.stdout.write(`No failed runlist commands recorded in ${globalErrorLogPath()}.\n`); return; }
  for (const e of entries) {
    const repo = e.repo ? dim(` ${e.repo.split('/').pop()}`) : '';
    process.stdout.write(`[${e.at}]${repo} ${e.command}\n  ${red(e.message ?? '(no message)')}\n`);
  }
}
