import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asString, currentSessionId, isArchivedPath, relTime, toRepoPath } from './util.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { promptDirectory } from './new.mjs';
import { dim, yellow } from './color.mjs';
import { buildIndex } from './index.mjs';
import { readJournalEntries, journalFilePath, readMisuseEntries } from './journal.mjs';
import { compareVersions } from './update.mjs';
import { findOwnedPlan } from './baton.mjs';
import { listOwnedPlans } from './pickup.mjs';
import { actionablePromptStatuses, comparePromptDocs, resolveStatusMetadata } from './status-metadata.mjs';

export { actionablePromptStatuses } from './status-metadata.mjs';

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
    if (cmp < 0) return `runlist plugin ${pluginVersion} is behind the CLI ${pkg.version} — run \`runlist update\` then restart.`;
    return `runlist CLI ${pkg.version} is behind the plugin ${pluginVersion} — run \`runlist update\` (or npm i -g dotmd-cli).`;
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
// Returns repo paths, oldest-created first — the same order no-arg `dotmd use`
// consumes them, so prompts[0] is always "the one you'd pick up next".
// The same answer from the prompt directory alone, reading frontmatter only.
// The full index read every body in the repo; at ~5k docs that took 10s and the
// SessionStart hook's 5s timeout killed hud before it printed anything.
export function findActionablePromptsInPromptDir(config) {
  const actionable = actionablePromptStatuses(config);
  const dir = promptDirectory(config);
  if (!existsSync(dir)) return [];
  const docs = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const abs = path.join(entry.parentPath ?? entry.path, entry.name);
    const repoPath = toRepoPath(abs, config.repoRoot);
    if (isArchivedPath(repoPath, config)) continue;
    let fm;
    try { fm = parseSimpleFrontmatter(extractFrontmatter(readFileSync(abs, 'utf8')).frontmatter ?? ''); }
    catch { continue; }
    const status = asString(fm.status);
    if (asString(fm.type) !== 'prompt' || !actionable.has(status)) continue;
    docs.push({ path: repoPath, status, created: asString(fm.created) || null, updated: asString(fm.updated) || null });
  }
  return docs.sort(comparePromptDocs).map(doc => doc.path);
}

// Text-mode hud: pending prompts and this session's plan, without the index.
export function buildHudFast(config) {
  let prompts = [];
  let owned = null;
  try { prompts = findActionablePromptsInPromptDir(config); } catch { /* hud must not fail */ }
  try {
    const records = listOwnedPlans(config);
    if (!records.diagnostics?.length && records.length === 1) owned = { path: records[0].plan, title: null, via: 'ownership' };
  } catch { /* hud must not fail */ }
  return { owned, prompts, misuseRecap: buildMisuseRecap(config) };
}

function findActionablePrompts(config, index) {
  const actionable = actionablePromptStatuses(config);
  return index.docs
    .filter(doc => doc.type === 'prompt' && actionable.has(doc.status) && !isArchivedPath(doc.path, config))
    .sort(comparePromptDocs)
    .map(doc => doc.path);
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

// Misuse recap: when sessions in THIS repo keep tripping the same guard rule,
// say so once at SessionStart — the shipped self-correcting-hints pattern
// pointed at repeat offenses. One line, only for the top rule, only past the
// threshold; silent otherwise.
const MISUSE_RECAP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MISUSE_RECAP_THRESHOLD = 3;

const MISUSE_CORRECTIONS = {
  'edit-status': 'never hand-edit `status:`; use `runlist set <status> <file>`',
  'cat-prompt': 'consume prompts with `runlist use <file>`; peek without consuming via `runlist prompts show <file>`',
  'read-prompt': 'consume prompts with `runlist use <file>`; peek without consuming via `runlist prompts show <file>`',
  'commit-prompt': 'saved prompts are session-local; never git add/commit them',
};

export function buildMisuseRecap(config, now = Date.now()) {
  let entries;
  try { entries = readMisuseEntries(); } catch { return null; }
  if (!entries.length) return null;
  const cutoff = now - MISUSE_RECAP_WINDOW_MS;
  const counts = new Map();
  for (const e of entries) {
    if (!e?.rule || (e.repo || '') !== config.repoRoot) continue;
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    counts.set(e.rule, (counts.get(e.rule) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < MISUSE_RECAP_THRESHOLD) return null;
  const [rule, count] = top;
  const fix = MISUSE_CORRECTIONS[rule] ?? 'see `runlist misuse`';
  return `sessions here tripped ${rule} ${count}× this week — ${fix}`;
}

export function buildHud(config) {
  let prompts = [];
  const skippedValidationHooks = ['validate', 'transformDoc', 'formatSnapshot']
    .filter(name => typeof config.hooks?.[name] === 'function');

  // Validation error count — hud's "silent when clean" contract should treat
  // `check` errors as not-clean. Without this, a SessionStart hook firing hud
  // can leave the agent with no visible signal that a check is failing.
  // `errorsOnly: true` skips warning-only cross-doc passes (git staleness,
  // bidirectional refs, claude-commands) that hud never reads. Built-in
  // per-file validation + checkIndex still run; user hooks are deliberately
  // suppressed because SessionStart is passive.
  let builtInErrors = 0;
  // `owned` answers "which plan is THIS session's?" for programmatic callers
  // (the baton flow reads it) — derived only from a valid durable ownership
  // record. Null when ownership is absent, stale, corrupt, or ambiguous.
  let owned = null;
  try {
    const index = buildIndex(config, {
      errorsOnly: true,
      autoHealIndex: false,
      invokeHooks: false,
    });
    prompts = findActionablePrompts(config, index);
    builtInErrors = index.errors.length;
    const o = findOwnedPlan(config, index);
    if (o.plan) owned = { path: o.plan.path, title: o.plan.title ?? null, via: o.via };
  } catch { /* swallow — bad config shouldn't break the SessionStart hook */ }

  const { previousSelf, fleet, recentRejections } = buildJournalSections(config);
  const misuseRecap = buildMisuseRecap(config);

  const validationComplete = skippedValidationHooks.length === 0;
  return {
    owned,
    prompts,
    errors: validationComplete ? builtInErrors : null,
    ...(validationComplete ? {} : {
      builtInErrors,
      validationPreview: { status: 'built-in-only', skippedHooks: skippedValidationHooks },
    }),
    previousSelf,
    fleet,
    recentRejections,
    misuseRecap,
  };
}

// Subagent primer: a spawned subagent (Explore, Plan, general-purpose) starts
// with ZERO project context and no SessionStart history — it has never seen the
// command sheet the top-level session got. Without this, subagents reflexively
// grep/cat/commit managed docs instead of using dotmd. Keep it to a few dense
// lines: the verbs + the three wrong-moves the guard exists to stop, so the
// subagent self-corrects before the guard ever has to fire.
const SUBAGENT_PRIMER = [
  'runlist manages this repo\'s plans/docs/prompts (markdown + YAML frontmatter).',
  'Verbs: plans|briefing | query <filters> | use [<file>] | set <status> <file> | new <type> <slug> | archive <file>.',
  'Do NOT: cat/read a docs/prompts/*.md (use `runlist use <file>` — archive/claim commits before at-most-once output);',
  'git add/commit a prompt (they are session-local, often gitignored); hand-edit a `status:` field (use `runlist set`).',
].join('\n');

export function buildPlanStatusPrimer(config, { maxChars = 220 } = {}) {
  const statuses = (resolveStatusMetadata(config).byType.plan ?? []).map(item => item.name);
  const fallback = 'run `runlist statuses list --type plan`';
  if (statuses.length === 0) return `Plan statuses unavailable; ${fallback}.`;
  const prefix = 'Plan statuses: ';
  const full = `${prefix}${statuses.join(', ')}`;
  if (full.length <= maxChars) return full;

  const shown = [];
  for (const status of statuses) {
    const omitted = statuses.length - shown.length - 1;
    const candidate = `${prefix}${[...shown, status].join(', ')}, ... (+${omitted}; ${fallback})`;
    if (candidate.length > maxChars) break;
    shown.push(status);
  }
  const omitted = statuses.length - shown.length;
  return `${prefix}${shown.join(', ')}${shown.length ? ', ' : ''}... (+${omitted}; ${fallback})`;
}

// The plugin's SessionStart/SubagentStart hooks fire in EVERY repo (it's enabled
// globally), but the primer only helps where dotmd is actually used. Gate on a
// discovered config: `dotmd init` writes dotmd.config.mjs, so "has a config" is
// the zero-false-positive signal for "this is a dotmd repo." A bare docs/ dir is
// deliberately NOT enough — too many repos have one. In a non-dotmd repo the hook
// then contributes nothing to the session: no primer, no index build, no heal.
// UserPromptSubmit: when the user asks for a baton, tell the session the exact
// form for its situation before it goes looking. Sessions ran `baton --help`
// before nearly every baton even with the form in CLAUDE.md, because the right
// form depends on whether this session owns a plan, which only runlist knows.
const HANDOFF_ASK = /\bbaton\b|\bhand[\s-]?off\b|\bresume[\s-]prompt\b|\bsave (?:a |the )?resume\b|\bpick (?:it|this|that) (?:back )?up (?:next time|later|tomorrow)\b/i;

export function isHandoffAsk(prompt) {
  return typeof prompt === 'string' && HANDOFF_ASK.test(prompt);
}

export function buildHandoffContext(config) {
  // Ownership records name their plans and are checked against those files
  // alone; building the index here cost 9s in a repo of ~5k docs, past the
  // hook's timeout.
  let ownedPaths = [];
  try {
    const records = listOwnedPlans(config);
    if (!records.diagnostics?.length) ownedPaths = records.map(record => record.plan);
  } catch { /* fall through to the no-plan form */ }
  const draft = 'Write the resume first (the next concrete decision, any gotchas, the plan/doc paths it concerns; not a recap) to a file in your scratchpad.';
  const tail = 'Baton prints the prompt name it saved; tell the user that name. No `--help` needed.';
  if (ownedPaths.length === 1) {
    return `[runlist] Baton: this session owns ${ownedPaths[0]}. ${draft} Then run \`runlist baton @<file>\`: it saves the prompt, releases the plan to active (\`--status paused|awaiting|partial|blocked\` and \`--note "why"\` if that fits better), and prints the commit to run. ${tail}`;
  }
  if (ownedPaths.length > 1) {
    return `[runlist] Baton: this session owns ${ownedPaths.length} plans (${ownedPaths.join(', ')}), so name the one to hand off. ${draft} Then run \`runlist baton <plan-file> @<file>\`. ${tail}`;
  }
  return `[runlist] Baton: this session owns no plan. ${draft} Then run \`runlist baton <slug> @<file>\` (saves resume-<slug>, changes nothing else), or \`runlist baton <plan-file> @<file>\` to hand off a plan by path. ${tail}`;
}

export async function runPromptSubmitHud(config, { readStdin } = {}) {
  if (!isDotmdRepo(config)) return;
  let prompt = '';
  try {
    const raw = await readStdin();
    if (raw && raw.trim()) prompt = JSON.parse(raw).prompt ?? '';
  } catch { return; }
  if (!isHandoffAsk(prompt)) return;
  process.stdout.write(buildHandoffContext(config) + '\n');
}

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
    process.stdout.write(dim(buildPlanStatusPrimer(config)) + '\n');
    if (drift) process.stdout.write(yellow(drift) + '\n');
    return;
  }

  // Non-dotmd repo, and not a programmatic --json caller → contribute nothing to
  // the session. Skip the index build, slash-heal, primer, and drift line.
  if (!dotmdRepo && !json) return;

  if (json) {
    const hud = buildHud(config);
    process.stdout.write(JSON.stringify({ ...hud, drift: drift ?? null }, null, 2) + '\n');
    return;
  }

  const hud = buildHudFast(config);

  // SessionStart contract: the command primer, plus ONLY signals that carry a
  // direct instruction for this session. Passive state (error counts,
  // slash-command refresh notices, previous-self / fleet / recent-rejections)
  // stays suppressed — those nudged agents into phantom follow-up work (e.g.
  // "errors: 1" prompting a check run) and live in their proper commands and
  // `dotmd hud --json`. Two signals ARE instructions and must print, because
  // the handoff loop dies without them (sessions were saving batons that no
  // next session ever picked up):
  //   - pending prompts: the previous session queued work for THIS one;
  //     consuming it is the very next action.
  //   - an in-session plan attributed to this sid via durable ownership: this
  //     session (pre-compaction) owns it and should continue or hand it off.
  //     Global in-session counts never provide a fallback.
  // The misuse recap stays for the same reason: a repeat-offense rule means
  // the primer alone isn't landing, so name the habit to break.
  process.stdout.write(dim('runlist: plans|briefing  set <status> [<file>]  new <type> <slug>  use [<file>]  archive <file>  baton [<plan-or-slug>] @<draft-file> (save a resume prompt; releases the in-session plan if any)  (use [no-arg] → oldest pending prompt)') + '\n');
  process.stdout.write(dim(buildPlanStatusPrimer(config)) + '\n');
  if (hud.owned && hud.owned.via === 'ownership') {
    process.stdout.write(yellow(`[runlist] in-session (yours): ${hud.owned.path} — continue it; hand off with \`runlist baton @/tmp/draft.md\` before stopping.`) + '\n');
  }
  if (hud.prompts.length > 0) {
    const n = hud.prompts.length;
    process.stdout.write(yellow(`[runlist] ${n} pending prompt${n === 1 ? '' : 's'} queued for this session — unless the user asks for something else, start by running \`runlist use\` to consume the oldest (${hud.prompts[0]}) and act on it. Peek first: \`runlist prompts show <file>\`; list: \`runlist prompts\`.`) + '\n');
  }
  if (hud.misuseRecap) process.stdout.write(yellow(`[runlist] ${hud.misuseRecap}`) + '\n');
  if (drift) process.stdout.write(yellow(drift) + '\n');
}
