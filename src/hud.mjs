import { maskInlineCodeSpans } from './markdown-code-spans.mjs';
import { flagsHudLine, openFlags } from './flags.mjs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asString, currentSessionId, isArchivedPath, relTime, shellQuote, toRepoPath } from './util.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { promptDirectory } from './new.mjs';
import { dim, yellow } from './color.mjs';
import { buildIndex } from './index.mjs';
import { readJournalEntries, journalFilePath, readMisuseEntries } from './journal.mjs';
import { compareVersions } from './update.mjs';
import { findOwnedPlan } from './baton.mjs';
import { listOwnedPlans, surveyOwnershipClaims } from './pickup.mjs';
import { handoffNotDoneLine, pendingHandoffsForSession } from './handoff-record.mjs';
import { actionablePromptStatuses, comparePromptDocs } from './status-metadata.mjs';
import { handoffsAnchor, isHandoffsMode, wouldCreateHandoffsConfig } from './handoffs-mode.mjs';

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
    return `runlist CLI ${pkg.version} is behind the plugin ${pluginVersion} — run \`runlist update\` (or npm i -g runlist).`;
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
// Returns repo paths, oldest-created first — the same order no-arg `runlist use`
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
  let hasOwnedPlans = true; // Unknown ownership must not advertise a fresh session.
  try { prompts = findActionablePromptsInPromptDir(config); } catch { /* hud must not fail */ }
  try {
    const records = listOwnedPlans(config);
    hasOwnedPlans = records.length > 0 || Boolean(records.diagnostics?.length);
    if (!records.diagnostics?.length && records.length === 1) owned = { path: records[0].plan, title: null, via: 'ownership' };
  } catch { /* hud must not fail */ }
  return { owned, hasOwnedPlans, prompts, misuseRecap: buildMisuseRecap(config), deadClaimsLine: deadClaimsHudLine(config) };
}

// A claim whose session is provably gone wedges `set`, `archive` and `baton` on
// that plan until someone releases it, and nothing at session start said so:
// three platform claims sat dead for up to 25 days, and the session that found
// them had to read `doctor --help` to learn the verb. Name them and the command.
export function deadClaimsHudLine(config, { top = 3 } = {}) {
  let claims;
  try { claims = surveyOwnershipClaims(config); } catch { return null; }
  const dead = claims.filter(claim => !claim.corrupt && claim.liveness === 'dead');
  if (!dead.length) return null;
  const n = dead.length;
  const shown = dead.slice(0, top).map(claim => claim.plan).join(', ');
  const more = n > top ? `, +${n - top} more` : '';
  return `[runlist] ${n} plan${n === 1 ? ' is' : 's are'} claimed by a session that is gone (${shown}${more}) — \`runlist doctor --claims --apply\` releases ${n === 1 ? 'it' : 'them'}; \`runlist doctor --claims\` lists every claim.`;
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

// Coarse error-class for rejection grouping. Most runlist die() messages follow
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
  'commit-prompt': 'follow the project prompt Git policy: `runlist config get promptTracking`',
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
    deadClaims: (() => { try { return surveyOwnershipClaims(config).filter(c => !c.corrupt && c.liveness === 'dead').map(c => ({ plan: c.plan, sessionId: c.sessionId, since: c.since })); } catch { return []; } })(),
    flags: (() => { try { return openFlags(config).map(f => ({ id: f.id, severity: f.severity, file: f.file, line: f.line, text: f.text })); } catch { return []; } })(),
  };
}

// Subagent primer: a spawned subagent (Explore, Plan, general-purpose) starts
// with ZERO project context and no SessionStart history. Without this,
// subagents reflexively grep/cat/commit managed docs instead of using runlist.
// It fires on every SubagentStart and CwdChanged, so every byte here is paid
// again and again: the read verbs, the three wrong-moves the guard exists to
// stop, and a pointer for the rare child handoff. Statuses are not listed —
// `runlist set` names the valid ones when given a wrong one.
// Handoffs-only projects have no plans and no status lines to guard; a child
// needs only the prompt rules and its own handoff form.
const HANDOFFS_SUBAGENT_PRIMER = [
  'runlist keeps session handoffs (saved prompts) here; planning is off.',
  'Do NOT cat/read a saved prompt file (`runlist prompts show <name>` peeks, `runlist use <name>` consumes); follow `runlist config get promptTracking` for Git.',
  'Return completed results to the parent. Unfinished handoff: `runlist baton --subagent <task-slug> @<draft-file> --parent resume-<parent>`.',
].join('\n');

const SUBAGENT_PRIMER = [
  'runlist manages plans/docs/prompts. Orient: `runlist plans`. Read: `runlist show <file>`, then `runlist show <file> --section "<heading>"`, never whole.',
  'Do NOT: cat/read a docs/prompts/*.md (`runlist prompts show <name>` peeks, `runlist use <name>` consumes); ignore promptTracking (`runlist config get promptTracking`); hand-edit status (`runlist set <status> <file>`).',
  "Return completed results to the parent. Unfinished handoff: `runlist baton --subagent <task-slug> @<draft-file> --parent resume-<parent>`. Use a distinct non-plan slug under a parent-owned plan; preserve its claim. `runlist baton --template` prints an outline; inspect a pending prompt before --replace.",
].join('\n');

// The plugin's SessionStart/SubagentStart hooks fire in EVERY repo (it's enabled
// globally), but the primer only helps where runlist is actually used. Gate on a
// discovered config: `runlist init` writes runlist.config.mjs, so "has a config" is
// the zero-false-positive signal for "this is a runlist repo." A bare docs/ dir is
// deliberately NOT enough — too many repos have one. In a non-runlist repo the hook
// then contributes nothing to the session: no primer, no index build, no heal.
// UserPromptSubmit: when the user asks for a baton, tell the session the exact
// form for its situation before it goes looking. Sessions ran `baton --help`
// before nearly every baton even with the form in CLAUDE.md, because the right
// form depends on whether this session owns a plan, which only runlist knows.
//
// Only a request fires it. Matching the word anywhere answered questions about
// batons ("what is the deal with the baton?") with handoff steps, and sessions
// read that as a go to hand off. So the prompt is read clause by clause: a
// clause that opens as a question never counts, and "baton" counts only as a
// verb (opening the clause, after "and"/"then", or "do a baton"), never as the
// subject of a sentence ("baton prints its name first").
const HANDOFF_PHRASE = /\bhand[\s-]?off\b|\bresume[\s-]prompt\b|\bsave (?:a |the )?resume\b|\bpick (?:it|this|that) (?:back )?up (?:next time|next session|later|tomorrow)\b/i;
const LEAD_WORDS = String.raw`(?:(?:ok(?:ay)?|alright|right|anyway|hey|now|then|and|also|but|so|yes|yep|great|good|cool|thanks|please|pls|go ahead and|let'?s|lets|time to)\b[,\s]*)*`;
const POLITE = String.raw`(?:(?:can|could|would|will) you (?:please )?(?:mind )?)`;
const SESSION_REQUEST_START = String.raw`(?:^|,\s*)${LEAD_WORDS}${POLITE}?(?:(?:I want to|let'?s|lets|please) )?`;
// Save forms name the session's work and a continuation time, or explicitly
// end the workday. "Save where we are" is itself a session snapshot request;
// require a request at the clause start, including after a context-setting
// comma, and a clause end (also before a semicolon continuation).
// Keep the suffixes narrow: progress indicators and session objects are code.
const SESSION_SAVE = [
  new RegExp(String.raw`${SESSION_REQUEST_START}save where we are\s*[.!?;]?$`, 'i'),
  /\bsave (?:where we are|our progress) (?:for (?:later|tomorrow|now|today|next (?:time|session))|so (?:I|we) can continue (?:later|tomorrow|next (?:time|session)))\b/i,
  new RegExp(String.raw`${SESSION_REQUEST_START}wrap up for (?:today|the day|tonight)\s*[.!?;]?$`, 'i'),
  /\bstop here for now(?: and|,)? (?:continue|pick (?:it|this) up) (?:tomorrow|later|next (?:time|session))\s*[.!?;]?$/i,
  new RegExp(String.raw`${SESSION_REQUEST_START}stop (?:here )?for (?:today|the day|tonight)\s*[.!?;]?$`, 'i'),
  /\b(?:let'?s|lets|I think we can) call it a day\s*[.!?;]?$/i,
  /\b(?:we'll|we will|I'll|I will|let'?s|lets) continue (?:in (?:a |the )?new session|(?:this )?tomorrow)\s*[.!?;]?$/i,
  new RegExp(String.raw`${SESSION_REQUEST_START}save where we're at for tomorrow\s*[.!?;]?$`, 'i'),
  new RegExp(String.raw`${SESSION_REQUEST_START}(?:let'?s|lets) pause here and continue tomorrow\s*[.!?;]?$`, 'i'),
];
// Strip all explicit load/resume forms before the broad handoff save matcher.
const LOAD_HANDOFF = String.raw`\b(?:load|resume|open|use) (?:my|the|our|that) handoff\b`;
// A continuation can start another clause with "and then". Other words after
// stopped/left off describe code or another activity, rather than saved work.
const PICKUP_END = String.raw`(?: (?:yesterday|last (?:time|session))(?!'s)\b)?(?=\s*(?:$|[.!?;,]|and then\b))`;
const PICKUP_PHRASE = String.raw`(?:(?:pick up|continue|resume) (?:from )?where (?:we|I|you) (?:left off|stopped)\b${PICKUP_END}|(?:continue|resume|pick up) from (?:last (?:time|session)|yesterday)(?!'s)\b|${LOAD_HANDOFF}(?=\s*(?:$|[.!?;,]|and\b)))`;
const BATON_AS_NOUN = String.raw`(?:(?:do|doing|make|write|leave|save|pass|run|drop) (?:a |the |your |another |one more )?)`;
// A word here after "baton" makes it the subject or a noun ("baton is",
// "baton prints", "baton command"), not a request.
const NOT_A_VERB = String.raw`(?!\s+(?:is|isn'?t|was|wasn'?t|are|were|does|doesn'?t|did|didn'?t|do|has|had|have|seems|should|shall|would|will|won'?t|can|can'?t|could|keeps|kept|works|worked|fails|failed|prints|printed|says|said|saves|saved|refuses|refused|output|outputs|command|commands|text|hint|hook|line|skill|tool|step|steps|definition|prompt|prompts)\b)(?!'s\b)`;
const BATON_REQUEST = [
  new RegExp(String.raw`^${LEAD_WORDS}${POLITE}?(?:please )?${BATON_AS_NOUN}?batons?\b${NOT_A_VERB}`, 'i'),
  new RegExp(String.raw`(?:\band|\bthen|&)\s+(?:please )?${BATON_AS_NOUN}?batons?\b${NOT_A_VERB}`, 'i'),
  new RegExp(String.raw`\b(?:do|make|write|leave|save|pass) (?:a |your |another |one more )baton\b`, 'i'),
  new RegExp(String.raw`\bcontext is getting tight,\s+(?:please )?baton\b${NOT_A_VERB}`, 'i'),
];
const QUESTION_START = new RegExp(String.raw`^${LEAD_WORDS}(?:what'?s|whats|what|why|how|when|where|who|whose|which|is|isn'?t|are|aren'?t|was|wasn'?t|were|does|doesn'?t|did|didn'?t|has|have|had|should|shall|do(?! (?:a |the |your |another |one more )?baton)|(?:can|could|would|will)(?! you\b))\b`, 'i');

// The harness hands background-task events to UserPromptSubmit as if typed.
// A finished agent's report that names its handoff file is not a request.
const SYSTEM_EVENT = /\[SYSTEM NOTIFICATION\b/i;
const T3_RELAY_HEADER = /^[ \t]*Delegated task \S+(?: \([^\n]*?\))?(?: \[[a-z_]+\]| reached a terminal state)[:.]/im;
// This question explicitly asks to recover earlier work, rather than asking
// how the handoff mechanism works. Other question-led clauses stay silent.
const PICKUP_QUESTION = new RegExp(String.raw`^${LEAD_WORDS}(?:hmm[,\s]+)?(?:what was I working on (?:in the )?last session|where were we)[?.!]*$`, 'i');
const PICKUP_REQUEST = new RegExp(String.raw`^${LEAD_WORDS}${POLITE}?(?:please )?${PICKUP_PHRASE}`, 'i');

function requestText(prompt) {
  if (typeof prompt !== 'string' || SYSTEM_EVENT.test(prompt)) return '';
  prompt = prompt.replaceAll('’', "'");
  prompt = prompt.replace(/<task-notification\b[^>]*>[\s\S]*?<\/task-notification>/gi, ' ');
  let fence = null;
  const prose = prompt.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length
          && /^\s*$/.test(line.slice(line.indexOf(marker) + marker.length))) fence = null;
      return '';
    }
    if (marker) { fence = marker; return ''; }
    if (/^(?: {4}|\t)|^ {0,3}>/.test(line)) return '';
    return line;
  }).join('\n');
  // T3 reports can contain blank lines and further relay headers. Everything
  // from the first prose header onward belongs to the relay; only prior prose
  // is the user's. A header inside code or a quote is not a relay envelope.
  // Claude notifications have explicit closing tags instead.
  const relay = T3_RELAY_HEADER.exec(prose);
  const userProse = relay ? prose.slice(0, relay.index) : prose;
  return maskInlineCodeSpans(userProse).replace(/"[^"\n]*"/g, ' ');
}

function clauses(prompt) {
  return prompt.split(/(?<=[.!?;\n])/).map(clause => clause.trim()).filter(Boolean);
}

export function isHandoffAsk(prompt) {
  return clauses(requestText(prompt)).some(clause => !QUESTION_START.test(clause)
    && (BATON_REQUEST.some(re => re.test(clause)) || SESSION_SAVE.some(re => re.test(clause))
      // A request to load a handoff is the opposite of saving one.
      || HANDOFF_PHRASE.test(clause.replace(new RegExp(LOAD_HANDOFF, 'gi'), ''))));
}

// Before a repository has any runlist config the hook only answers an explicit
// request to save the session: a baton, or one of the session-save phrases. The
// bare word "handoff" is common in code, and nothing here is runlist's yet.
export function isExplicitSaveAsk(prompt) {
  return clauses(requestText(prompt)).some(clause => !QUESTION_START.test(clause)
    && (BATON_REQUEST.some(re => re.test(clause)) || SESSION_SAVE.some(re => re.test(clause))));
}

export function isPickupAsk(prompt) {
  return clauses(requestText(prompt)).some(clause => PICKUP_QUESTION.test(clause)
    || (!QUESTION_START.test(clause) && PICKUP_REQUEST.test(clause)));
}

// The repo's own definition of baton (`templates.prompt.baton` in its config),
// when it has one. Read from the loaded config only: the hook path never builds
// the index.
export function repoBatonDefinition(config) {
  const text = config?.raw?.templates?.prompt?.baton;
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}

const RESUME_DRAFT = 'Write the resume first (current work and exact next move, decisions and waiting approvals, durable evidence paths, unverified claims and authorization boundaries; not a recap). `runlist baton --template` prints the checkout’s editable outline. Draft in a temporary file; keep working material at durable repo-relative paths.';
const BATON_TAIL = 'Baton prints the prompt name it saved as its last line; tell the user that name. No `--help` needed.';

// Handoffs only — a repository with no config yet, or one in handoffs mode —
// has no plans, so the form is always a name the session picks itself.
export function buildHandoffsOnlyContext(config, { firstHandoff = false } = {}) {
  const command = 'Save it with `runlist baton <slug> @<file>`, choosing a short slug that names the work (it saves resume-<slug>).';
  const first = firstHandoff ? ' There is no runlist config here yet: baton also sets one up for handoffs (runlist.config.mjs, prompts in docs/prompts/) unless it finds runlist documents saved before setup, and prints what it did; relay that.' : '';
  const definition = repoBatonDefinition(config);
  if (definition) return `[runlist] Baton: ${command}${first} Where the definition below names a command, use this form. ${BATON_TAIL}\nThis repo defines baton (templates.prompt.baton in its runlist config):\n${definition}`;
  return `[runlist] Baton: ${RESUME_DRAFT} ${command}${first} ${BATON_TAIL}`;
}

export function buildHandoffContext(config) {
  if (isHandoffsMode(config)) return buildHandoffsOnlyContext(config);
  // Ownership records name their plans and are checked against those files
  // alone; building the index here cost 9s in a repo of ~5k docs, past the
  // hook's timeout.
  let ownedPaths = [];
  try {
    const records = listOwnedPlans(config);
    if (!records.diagnostics?.length) ownedPaths = records.map(record => record.plan);
  } catch { /* fall through to the no-plan form */ }
  const done = 'Baton does not report the handoff done until the plan\'s next_step has been updated after the prompt was saved: update the plan body first, then run';
  let who;
  let command;
  if (ownedPaths.length === 1) {
    who = `this session owns ${ownedPaths[0]}.`;
    command = `Save the prompt with \`runlist baton @<file>\`: it releases the plan to active (\`--status paused|awaiting|partial|blocked\` and \`--note "why"\` if that fits better). ${done} \`runlist baton --done --next-step "<next move>"\`.`;
  } else if (ownedPaths.length > 1) {
    who = `this session owns ${ownedPaths.length} plans (${ownedPaths.join(', ')}), so name the one to hand off.`;
    command = `Save it with \`runlist baton <plan-file> @<file>\`. ${done} \`runlist baton --done <plan-file> --next-step "<next move>"\`.`;
  } else {
    who = 'this session owns no plan.';
    command = 'Save the prompt with `runlist baton <slug> @<file>` (saves resume-<slug>, changes nothing else), or `runlist baton <plan-file> @<file>` to hand off a plan by path.';
  }
  const tail = BATON_TAIL;
  const definition = repoBatonDefinition(config);
  if (definition) {
    return `[runlist] Baton: ${who} ${command} Where the definition below names a command, use this form. ${tail}\nThis repo defines baton (templates.prompt.baton in its runlist config):\n${definition}`;
  }
  return `[runlist] Baton: ${who} ${RESUME_DRAFT} ${command} ${tail}`;
}

export async function runPromptSubmitHud(config, { readStdin, cwd = process.cwd() } = {}) {
  // With no config, only a Git project can take a first handoff (baton refuses
  // elsewhere); everything else stays silent, as in any repo runlist isn't in.
  const configured = isRunlistRepo(config);
  if (!configured && handoffsAnchor(cwd).refusal) return;
  let prompt = '';
  try {
    const raw = await readStdin();
    if (raw && raw.trim()) prompt = JSON.parse(raw).prompt ?? '';
  } catch { return; }
  if (!configured) {
    if (!isExplicitSaveAsk(prompt)) return;
    // Plans claimed before any config exist only where someone planned without
    // setup; the claim records are the cheap way to know, as in a configured repo.
    let owns = false;
    try { owns = listOwnedPlans(config).length > 0; } catch { /* no claims to read */ }
    process.stdout.write((owns ? buildHandoffContext(config) : buildHandoffsOnlyContext(config, { firstHandoff: wouldCreateHandoffsConfig(cwd, config) })) + '\n');
    return;
  }
  // Saving wins when both intents are explicit: save now, resume later.
  if (isHandoffAsk(prompt)) {
    process.stdout.write(buildHandoffContext(config) + '\n');
  } else if (isPickupAsk(prompt)) {
    let prompts;
    try { prompts = findActionablePromptsInPromptDir(config); } catch { return; }
    if (prompts.length) process.stdout.write(`[runlist] Pickup: ${pendingPromptsLine(prompts, { pickup: true, planning: !isHandoffsMode(config) })}\n`);
  }
}

// A count, not names: a queue of dozens printed a dozen names nobody asked
// about, and `runlist prompts` lists them when the user names one.
export function pendingPromptsLine(prompts, { pickup = false, planning = true } = {}) {
  const n = prompts.length;
  if (pickup) {
    const names = n <= 5 ? ` (${prompts.join(', ')})` : '';
    const entry = hasPickupCommand() ? '`/pickup` or `runlist use <name>`' : '`runlist use <name>`';
    const effect = planning ? 'archives the prompt and claims its linked plan' : 'archives the prompt and prints it';
    return `If the user is asking to resume saved work: ${n} pending prompt${n === 1 ? '' : 's'}${names}; ${entry} consumes one (${effect}).${n > 1 ? ' Ask which one; never consume the oldest by default.' : ''}`;
  }
  return `${n} pending prompt${n === 1 ? '' : 's'}: resume one only when the user asks for it (\`runlist prompts\` lists them, \`runlist use <name>\` resumes one, \`runlist prompts show <name>\` peeks); never consume the oldest by default.`;
}

function isRunlistRepo(config) {
  return Boolean(config?.configFound);
}

function hasPickupCommand() {
  // Codex also exports CLAUDE_PLUGIN_ROOT for compatible hooks, but its plugin
  // has no slash commands. Offer the command only when it is actually shipped.
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  return Boolean(root?.trim() && existsSync(path.join(root, 'commands', 'pickup.md')));
}

// Directory entries only: any Markdown file is history, including held and
// archived prompts. Resolve the type directory via the same loader as hud;
// recursive listing includes config.archiveDir without assuming its spelling.
function handoffIntroLine(config, hud) {
  // OpenCode injects hud into its system prompt every turn (plugin.js),
  // including when RUNLIST_SESSION_ID overrides the host's identity source.
  if (process.env.OPENCODE || process.env.OPENCODE_PID || hud.prompts.length || hud.hasOwnedPlans) return null;
  try {
    const dir = promptDirectory(config);
    if (existsSync(dir) && readdirSync(dir, { withFileTypes: true, recursive: true })
      .some(entry => entry.isFile() && entry.name.endsWith('.md'))) return null;
  } catch { return null; } // Unreadable history cannot establish a fresh repo.
  const pickup = hasPickupCommand()
    ? '/pickup resumes it next time' : 'the next session lists saved handoffs at start';
  return `[runlist] Handoffs: say "baton" to save where you are before you stop; ${pickup}.`;
}

export function runHud(argv, config) {
  const json = argv.includes('--json');

  const drift = detectVersionDrift();
  const runlistRepo = isRunlistRepo(config);

  // SubagentStart hook entry point — emit the compact primer and return. No
  // index build, no journal read, no slash-command heal: a subagent doesn't
  // need the operator-facing machinery, just the verbs and the guardrails.
  if (argv.includes('--subagent')) {
    if (!runlistRepo) return; // silent in repos that don't use runlist
    process.stdout.write(dim(isHandoffsMode(config) ? HANDOFFS_SUBAGENT_PRIMER : SUBAGENT_PRIMER) + '\n');
    if (drift) process.stdout.write(yellow(drift) + '\n');
    return;
  }

  // Non-runlist repo, and not a programmatic --json caller → contribute nothing to
  // the session. Skip the index build, slash-heal, primer, and drift line.
  if (!runlistRepo && !json) return;

  if (json) {
    const hud = buildHud(config);
    process.stdout.write(JSON.stringify({ ...hud, drift: drift ?? null }, null, 2) + '\n');
    return;
  }

  const hud = buildHudFast(config);

  // SessionStart contract: ONLY signals that carry a direct instruction for
  // this session, plus a one-line introduction until the first handoff. No
  // command sheet or status list: the runlist skill carries the verbs, and `runlist set` names
  // the valid statuses when given a wrong one. Passive state (error counts,
  // previous-self / fleet / recent-rejections) stays suppressed — it nudged
  // agents into phantom follow-up work and lives in its own commands and
  // `runlist hud --json`. What prints:
  //   - pending prompts, as a count: earlier sessions queued work, and the
  //     line says to resume one only when the user asks. A new session nearly
  //     always has a task from the user, the hook cannot see it, and the
  //     oldest prompt is rarely the useful one.
  //   - open flags, as a count: the person asked that every session start
  //     knowing where things stand. Worded as awareness, not an instruction.
  //   - an in-session plan attributed to this sid via durable ownership: this
  //     session (pre-compaction) owns it and should continue or hand it off.
  //     Global in-session counts never provide a fallback.
  //   - an unfinished handoff, a repeat-offense misuse rule, and plans held by
  //     sessions that are gone: each names the command that clears it.
  const intro = handoffIntroLine(config, hud);
  if (intro) process.stdout.write(dim(intro) + '\n');
  const queue = [];
  if (hud.prompts.length > 0) queue.push(pendingPromptsLine(hud.prompts));
  const flagsLine = flagsHudLine(config);
  if (flagsLine) queue.push(flagsLine);
  if (queue.length) process.stdout.write(yellow(`[runlist] ${queue.join(' ')}`) + '\n');
  if (hud.owned && hud.owned.via === 'ownership') {
    process.stdout.write(yellow(`[runlist] in-session (yours): ${hud.owned.path} — continue it; hand off with \`runlist baton @/tmp/draft.md\` before stopping.`) + '\n');
  }
  // A handoff this session started and did not finish (a compaction or a stop
  // between saving the prompt and updating the plan).
  try {
    for (const record of pendingHandoffsForSession(config)) process.stdout.write(yellow(`[runlist] ${handoffNotDoneLine(record, `runlist baton --done ${shellQuote(record.plan)}`)}`) + '\n');
  } catch { /* advisory */ }
  if (hud.misuseRecap) process.stdout.write(yellow(`[runlist] ${hud.misuseRecap}`) + '\n');
  if (hud.deadClaimsLine) process.stdout.write(yellow(hud.deadClaimsLine) + '\n');
  if (drift) process.stdout.write(yellow(drift) + '\n');
}
