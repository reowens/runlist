import { existsSync } from 'node:fs';
import { readJournalEntries, isJournalEnabled, journalFilePath } from './journal.mjs';
import { currentSessionId } from './lease.mjs';

// F17c: repeat-failure hints. When an agent runs the same broken invocation
// twice in the same session within HINT_WINDOW_MS, the second die() output is
// suffixed with a Tip: paragraph informed by the prior failure's recorded
// stderr. First failures stay terse — don't punish humans typing a command
// for the first time. The lookup is skipped cleanly when the journal is
// disabled or DOTMD_NO_HINTS=1, so this costs nothing for non-opt-in users.

const HINT_WINDOW_MS = 10 * 60 * 1000;
const OVERLAP_THRESHOLD = 0.75;

const TEMPLATES = [
  {
    match: /Too many arguments|Usage:/i,
    hint: ({ count, argv }) =>
      `${count}× the same shape on \`${argv[0]} ${argv[1] ?? ''}\` in this session. Run \`dotmd ${argv[0]} --help\` for the expected positional args.`,
  },
  {
    match: /Already (consumed|archived)/i,
    hint: ({ count, argv }) =>
      `${count}× attempts to use a path that is already archived. Use \`dotmd prompts list\` to see what is actually pending, or \`dotmd next\` for the oldest live prompt.`,
  },
  {
    match: /No pending prompts/i,
    hint: ({ count }) =>
      `${count}× \`dotmd next\` with no pending prompts in the queue. Either queue one with \`dotmd new prompt <slug> "..."\` or pass an explicit prompt file to \`dotmd use\`.`,
  },
  {
    match: /Unknown command/i,
    hint: ({ count }) =>
      `${count}× the same unknown command. Run \`dotmd --help\` to list available commands; the dispatch already prints a did-you-mean for close misses.`,
  },
  {
    match: /File not found|does not resolve/i,
    hint: ({ count, argv }) =>
      `${count}× pointing at a path that doesn't exist. Confirm the file with \`dotmd query\` or \`dotmd plans\` — paths resolve relative to repo root or doc roots, not the cwd.`,
  },
  {
    match: /Lease conflict|in-session|held by/i,
    hint: ({ count }) =>
      `${count}× lease conflict in this session. Run \`dotmd plans --status in-session\` to see what's held; pass \`--takeover\` if the holder is stale, or close the other session first.`,
  },
  {
    match: /Unknown status|Unknown surface/i,
    hint: ({ count }) =>
      `${count}× rejected by the taxonomy validator. Run \`dotmd statuses list\` or \`dotmd surfaces\` to print the valid values for this project.`,
  },
];

// Global value-consuming flags must be skipped together with the token that
// follows them — otherwise `--config /tmp/foo` injects the tempdir path as
// "positional" and dilutes Jaccard overlap below threshold. Keep this list
// aligned with the global flag-strip list in bin/dotmd.mjs (SCRUB_*).
const VALUE_FLAGS = new Set([
  '--config', '--root', '--type', '--limit', '--sort', '--group',
  '--status', '--owner', '--module', '--surface', '--domain',
  '--audience', '--execution-mode', '--updated-since',
  '--summarize-limit', '--model',
]);

function nonFlagSet(argv) {
  const out = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith('-')) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    out.add(a);
  }
  return out;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  const aArr = [...a];
  const inter = aArr.filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

// Returns a hint string (no `Tip:` prefix) or null. The caller is responsible
// for formatting. Failures inside this function are swallowed — a malformed
// journal must never break the error-reporting path.
export function findRepeatFailureHint(failingArgv, config) {
  try {
    if (process.env.DOTMD_NO_HINTS === '1') return null;
    if (!config) return null;
    if (!isJournalEnabled(config)) return null;
    if (!existsSync(journalFilePath(config))) return null;
    if (!Array.isArray(failingArgv) || failingArgv.length === 0) return null;

    const sid = currentSessionId();
    const now = Date.now();
    const cutoff = now - HINT_WINDOW_MS;
    const failingShape = nonFlagSet(failingArgv);

    const entries = readJournalEntries(config);
    const matches = [];
    for (const entry of entries) {
      if (!entry || entry.sid !== sid) continue;
      if (!Array.isArray(entry.argv) || entry.argv.length === 0) continue;
      if (entry.argv[0] !== failingArgv[0]) continue;
      if ((entry.exit ?? 0) === 0) continue;
      const ts = new Date(entry.ts).getTime();
      if (Number.isNaN(ts) || ts < cutoff) continue;
      const priorShape = nonFlagSet(entry.argv);
      if (jaccard(failingShape, priorShape) < OVERLAP_THRESHOLD) continue;
      matches.push({ entry, ts });
    }

    if (matches.length === 0) return null;
    matches.sort((a, b) => b.ts - a.ts);
    const last = matches[0].entry;
    const count = matches.length + 1;
    const prevErr = last.err ?? '';
    const ageMin = Math.max(1, Math.round((now - matches[0].ts) / 60000));

    for (const tmpl of TEMPLATES) {
      if (tmpl.match.test(prevErr)) {
        return tmpl.hint({ count, argv: failingArgv, prev: last, ageMin });
      }
    }

    return `${count}× the same failing shape on \`${failingArgv[0]}\` in this session (last attempt ${ageMin}m ago). Check the args — \`dotmd ${failingArgv[0]} --help\` shows what's expected.`;
  } catch {
    return null;
  }
}
