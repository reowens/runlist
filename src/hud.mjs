import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, currentSessionId } from './util.mjs';
import { dim, yellow } from './color.mjs';
import { buildIndex } from './index.mjs';
import { refreshStaleSlashCommands } from './claude-commands.mjs';
import { readJournalEntries, journalFilePath } from './journal.mjs';
import { compareVersions } from './update.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

// Detect when the running plugin's bundled version disagrees with this CLI's
// version. Since every release bumps both in lockstep, a mismatch means exactly
// one channel is behind. Network-free: the plugin's hook sets CLAUDE_PLUGIN_ROOT
// to the plugin dir, whose plugin.json carries its version. Gated to the
// version-keyed *cache* install — a directory-source plugin tracks content live
// and its version label lags benignly, so we don't nag local dev. Returns a
// one-line notice or null (silent when in sync). Surfaces to the agent because
// hud output is injected as SessionStart/SubagentStart context.
export function detectVersionDrift(env = process.env) {
  try {
    const root = env.CLAUDE_PLUGIN_ROOT;
    if (!root) return null;
    const cacheSeg = `${path.sep}plugins${path.sep}cache${path.sep}`;
    if (!root.includes(cacheSeg)) return null;
    const pj = path.join(root, '.claude-plugin', 'plugin.json');
    if (!existsSync(pj)) return null;
    const pluginVersion = JSON.parse(readFileSync(pj, 'utf8')).version;
    const cmp = compareVersions(pluginVersion, pkg.version);
    if (cmp === null || cmp === 0) return null;
    if (cmp < 0) return `dotmd plugin ${pluginVersion} is behind the CLI ${pkg.version} — run \`dotmd update\` then restart.`;
    return `dotmd CLI ${pkg.version} is behind the plugin ${pluginVersion} — run \`dotmd update\` (or npm i -g dotmd-cli).`;
  } catch {
    return null;
  }
}

// Statuses that count as "actionable" for a prompt are derived from config:
// types.prompt.context.expanded (the statuses the user wants prominently shown).
// Falls back to ['pending'] when no prompt type is configured (defensive default
// for stripped-down configs). This means a user who customizes
// types.prompt.statuses to add e.g. `urgent: { context: 'expanded' }` gets that
// status surfaced too, without needing a code change.
export function actionablePromptStatuses(config) {
  const promptCtx = config.typeContextConfig?.get('prompt');
  const expanded = promptCtx?.expanded;
  if (Array.isArray(expanded) && expanded.length > 0) return new Set(expanded);
  return new Set(['pending']);
}

function findActionablePrompts(config) {
  const roots = config.docsRoots || (config.docsRoot ? [config.docsRoot] : []);
  const archiveDir = config.archiveDir || 'archived';
  const actionable = actionablePromptStatuses(config);
  const found = [];
  const seen = new Set();

  for (const root of roots) {
    // A root may either contain a prompts/ subdir (the common case, e.g. root=docs)
    // or be the prompts/ dir itself (e.g. root=docs/prompts — see #6).
    const dir = path.basename(root) === 'prompts' ? root : path.join(root, 'prompts');
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (!existsSync(dir)) continue;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      if (!entry.name.endsWith('.md')) continue;
      const filePath = path.join(dir, entry.name);
      // Skip any nested archived/ collisions just in case
      if (filePath.includes(`/${archiveDir}/`)) continue;
      let raw;
      try { raw = readFileSync(filePath, 'utf8'); } catch { continue; }
      const { frontmatter } = extractFrontmatter(raw);
      if (!frontmatter) continue;
      const fm = parseSimpleFrontmatter(frontmatter);
      if (asString(fm.type) !== 'prompt') continue;
      if (!actionable.has(asString(fm.status))) continue;
      found.push(toRepoPath(filePath, config.repoRoot));
    }
  }

  return found.sort();
}

// F17b: hud reads journal. Three additive sections, gated on
// existsSync(journalFilePath). Silent-when-clean — sections are omitted when
// they have nothing to say. Caps keep hud single-screen even when the journal
// is dense.

const PREVIOUS_SELF_CAP = 3;
const FLEET_CAP = 5;
const REJECTIONS_CAP = 3;
const FLEET_WINDOW_MS = 24 * 60 * 60 * 1000;
const REJECTIONS_WINDOW_MS = 60 * 60 * 1000;

function relTime(ts, now = Date.now()) {
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return '?';
  const delta = Math.max(0, now - t);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// Coarse error-class for rejection grouping. Most dotmd die() messages follow
// `<class>: <variable detail>` (e.g. "File not found: docs/foo.md", "Already
// archived: docs/plans/x.md", "Too many arguments to status"). Take the chunk
// before the first colon, cap at 6 words, normalize whitespace. Cheap;
// good-enough until a proper taxonomy emerges from real journal data.
function errorClass(err) {
  if (typeof err !== 'string') return '';
  const flat = err.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const prefix = flat.split(':')[0];
  return prefix.split(' ').slice(0, 6).join(' ');
}

export function buildJournalSections(config, now = Date.now()) {
  const journalFile = journalFilePath(config);
  if (!existsSync(journalFile)) return { previousSelf: [], fleet: [], recentRejections: [] };

  let entries;
  try { entries = readJournalEntries(config); }
  catch { return { previousSelf: [], fleet: [], recentRejections: [] }; }
  if (!entries.length) return { previousSelf: [], fleet: [], recentRejections: [] };

  const sid = currentSessionId();

  // 1. Previous self: this sid's last N entries (excluding the current
  // invocation, which is recorded only at process exit so it isn't in the
  // file yet). Newest-first.
  const previousSelf = entries
    .filter(e => e?.sid === sid)
    .slice(-PREVIOUS_SELF_CAP)
    .reverse()
    .map(e => ({
      argv: Array.isArray(e.argv) ? e.argv : [],
      exit: e.exit ?? 0,
      ts: e.ts,
      ago: relTime(e.ts, now),
    }));

  // 2. Fleet: per-other-sid summary for entries in the last 24h.
  const fleetCutoff = now - FLEET_WINDOW_MS;
  const bySid = new Map();
  for (const e of entries) {
    if (!e?.sid || e.sid === sid) continue;
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t) || t < fleetCutoff) continue;
    if (!bySid.has(e.sid)) bySid.set(e.sid, { count: 0, lastTs: 0 });
    const row = bySid.get(e.sid);
    row.count++;
    if (t > row.lastTs) row.lastTs = t;
  }
  const fleet = [...bySid.entries()].map(([otherSid, row]) => {
    return {
      sid: otherSid,
      cmds: row.count,
      lastAgo: relTime(new Date(row.lastTs).toISOString(), now),
    };
  }).sort((a, b) => b.cmds - a.cmds).slice(0, FLEET_CAP);

  // 3. Recent rejections: top error-class groups for exit!=0 entries in the
  // last hour. Group key = `${cmd} :: ${errClass}`.
  const rejCutoff = now - REJECTIONS_WINDOW_MS;
  const groups = new Map();
  for (const e of entries) {
    if ((e?.exit ?? 0) === 0) continue;
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t) || t < rejCutoff) continue;
    const cmd = e.argv?.[0] ?? '(none)';
    const cls = errorClass(e.err);
    if (!cls) continue;
    const key = `${cmd} :: ${cls}`;
    if (!groups.has(key)) groups.set(key, { cmd, cls, count: 0 });
    groups.get(key).count++;
  }
  const recentRejections = [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, REJECTIONS_CAP);

  return { previousSelf, fleet, recentRejections };
}

export function buildHud(config) {
  const prompts = findActionablePrompts(config);

  // Validation error count — hud's "silent when clean" contract should treat
  // `check` errors as not-clean. Without this, a SessionStart hook firing hud
  // can leave the agent with no visible signal that a check is failing.
  // `errorsOnly: true` skips warning-only cross-doc passes (git staleness,
  // bidirectional refs, claude-commands) that hud never reads — ~6× faster on
  // SessionStart for platform-scale corpora. Per-file validation + checkIndex
  // still run, so the error count matches `dotmd check`'s.
  let errors = 0;
  try {
    // `autoHealIndex: true` mirrors `dotmd check` — drift from non-regen
    // mutation paths (`lint --fix`, direct file edits, etc.) heals silently
    // at SessionStart so the agent doesn't open every session with a
    // spurious "Run `dotmd index`" error in the hud error count.
    const index = buildIndex(config, { errorsOnly: true, autoHealIndex: true });
    errors = index.errors.length;
  } catch { /* swallow — bad config shouldn't break the SessionStart hook */ }

  const { previousSelf, fleet, recentRejections } = buildJournalSections(config);

  return { prompts, errors, previousSelf, fleet, recentRejections };
}

// Subagent primer: a spawned subagent (Explore, Plan, general-purpose) starts
// with ZERO project context and no SessionStart history — it has never seen the
// command sheet the top-level session got. Without this, subagents reflexively
// grep/cat/commit managed docs instead of using dotmd. Keep it to a few dense
// lines: the verbs + the three wrong-moves the guard exists to stop, so the
// subagent self-corrects before the guard ever has to fire.
const SUBAGENT_PRIMER = [
  'dotmd manages this repo\'s plans/docs/prompts (markdown + YAML frontmatter).',
  'Verbs: plans|briefing | query <filters> | use [<file>] | set <status> <file> | new <type> <slug> | archive <file>.',
  'Do NOT: cat/read a docs/prompts/*.md (use `dotmd use <file>` — it prints + archives atomically);',
  'git add/commit a prompt (they are session-local, often gitignored); hand-edit a `status:` field (use `dotmd set`).',
].join('\n');

// The plugin's SessionStart/SubagentStart hooks fire in EVERY repo (it's enabled
// globally), but the primer only helps where dotmd is actually used. Gate on a
// discovered config: `dotmd init` writes dotmd.config.mjs, so "has a config" is
// the zero-false-positive signal for "this is a dotmd repo." A bare docs/ dir is
// deliberately NOT enough — too many repos have one. In a non-dotmd repo the hook
// then contributes nothing to the session: no primer, no index build, no heal.
function isDotmdRepo(config) {
  return Boolean(config?.configFound);
}

export function runHud(argv, config) {
  const json = argv.includes('--json');

  const drift = detectVersionDrift();
  const dotmdRepo = isDotmdRepo(config);

  // SubagentStart hook entry point — emit the compact primer and return. No
  // index build, no journal read, no slash-command heal: a subagent doesn't
  // need the operator-facing machinery, just the verbs and the guardrails.
  if (argv.includes('--subagent')) {
    if (!dotmdRepo) return; // silent in repos that don't use dotmd
    process.stdout.write(dim(SUBAGENT_PRIMER) + '\n');
    if (drift) process.stdout.write(yellow(drift) + '\n');
    return;
  }

  // Non-dotmd repo, and not a programmatic --json caller → contribute nothing to
  // the session. Skip the index build, slash-heal, primer, and drift line.
  if (!dotmdRepo && !json) return;

  const hud = buildHud(config);

  // Self-heal stale slash-command files. Wrapped: a broken scaffolder must
  // never kill the SessionStart hook (would block every session). Runs for its
  // side effect only — the refresh is no longer announced in stdout (see the
  // primer-only contract below). Skipped in --json mode to keep the structured
  // shape stable for programmatic callers.
  if (!json) {
    try { refreshStaleSlashCommands(config); }
    catch { /* swallow — see comment above */ }
  }

  if (json) {
    process.stdout.write(JSON.stringify({ ...hud, drift: drift ?? null }, null, 2) + '\n');
    return;
  }

  // SessionStart contract: emit ONLY the command primer — the verb cheat-sheet
  // that tells the agent which dotmd verbs exist. Everything else hud used to
  // print (held/prompts/stuck/errors state, slash-command refresh notices, and
  // the journal-aware previous-self / fleet / recent-rejections sections) is
  // deliberately suppressed here: those signals nudged agents into phantom
  // follow-up work — e.g. "errors: 1 (run dotmd check)" prompting a check run
  // for state that belongs inside its own command. Each of those signals lives
  // in its proper command (`plans`, `prompts`, `check`) and stays available via
  // `dotmd hud --json` for programmatic callers. The hook's job is purely to
  // teach the verbs, never to report status.
  process.stdout.write(dim('dotmd: plans|briefing  set <status> [<file>]  new <type> <slug>  use [<file>]  archive <file>  (use [no-arg] → oldest pending prompt)') + '\n');
  if (drift) process.stdout.write(yellow(drift) + '\n');
}
