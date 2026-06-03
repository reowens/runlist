import { existsSync } from 'node:fs';
import { readMisuseEntries, globalMisuseLogPath } from './journal.mjs';
import { dim, red, yellow } from './color.mjs';

// `dotmd misuse` — read the cross-repo guard log. Every wrong-move the
// PreToolUse guard intercepts lands here; this is the operator's window into
// "what are sessions getting wrong, and how often."
function parseArgs(argv) {
  const opts = { tail: null, byRule: false, asJson: false, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tail') { const n = parseInt(argv[++i], 10); opts.tail = Number.isFinite(n) && n > 0 ? n : 20; }
    else if (a === '--by-rule') opts.byRule = true;
    else if (a === '--json') opts.asJson = true;
    else if (a === '--repo' && argv[i + 1]) opts.repo = argv[++i];
  }
  if (opts.tail === null && !opts.byRule) opts.tail = 20;
  return opts;
}

export function runMisuse(argv, _config) {
  const file = globalMisuseLogPath();
  if (!existsSync(file)) {
    process.stderr.write(
      'No misuse log yet. The PreToolUse guard (`dotmd guard`) writes here when it intercepts a wrong move.\n' +
      'Wire it up: add a PreToolUse hook that runs `dotmd guard` (see `dotmd help guard`).\n',
    );
    return;
  }

  const opts = parseArgs(argv);
  let entries = readMisuseEntries();
  if (opts.repo) entries = entries.filter(e => (e.repo || '').includes(opts.repo));

  if (opts.byRule) {
    const groups = new Map();
    for (const e of entries) {
      const key = e.rule || '(unknown)';
      if (!groups.has(key)) groups.set(key, { rule: key, count: 0, deny: 0, warn: 0 });
      const g = groups.get(key);
      g.count++;
      if (e.decision === 'deny') g.deny++; else if (e.decision === 'warn') g.warn++;
    }
    const rows = [...groups.values()].sort((a, b) => b.count - a.count);
    if (opts.asJson) { process.stdout.write(JSON.stringify(rows, null, 2) + '\n'); return; }
    if (!rows.length) { process.stdout.write('No misuse events recorded.\n'); return; }
    for (const r of rows) {
      process.stdout.write(`${r.rule.padEnd(16)} ${String(r.count).padStart(4)}×  ${red(`${r.deny} deny`)} / ${yellow(`${r.warn} warn`)}\n`);
    }
    return;
  }

  if (opts.tail) entries = entries.slice(-opts.tail);
  if (opts.asJson) { process.stdout.write(JSON.stringify(entries, null, 2) + '\n'); return; }
  if (!entries.length) { process.stdout.write('No misuse events recorded.\n'); return; }

  for (const e of entries) {
    const tag = e.decision === 'deny' ? red('DENY') : yellow('warn');
    const repo = e.repo ? dim(` ${e.repo.split('/').pop()}`) : '';
    process.stdout.write(`[${e.ts}] ${tag} ${e.rule || '?'}${repo} ${dim(e.detail || '')}\n`);
  }
}
