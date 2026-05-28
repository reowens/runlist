import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readLeases, findStaleLeases, currentSessionId, isLeaseStale, STALE_LEASE_AGE_MS } from './lease.mjs';
import { scrubStaleSilently } from './lease-scrub.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath } from './util.mjs';
import { dim, yellow } from './color.mjs';
import { buildIndex } from './index.mjs';
import { refreshStaleSlashCommands } from './claude-commands.mjs';
import { readJournalEntries, journalFilePath } from './journal.mjs';

const MAX_PREVIEW = 5;

function slug(repoPath) { return path.basename(repoPath, '.md'); }

function previewList(items, max = MAX_PREVIEW) {
  const slugs = items.slice(0, max).map(slug);
  const more = items.length > max ? `, +${items.length - max} more` : '';
  return slugs.join(', ') + more;
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
  const leases = readLeases(config);
  const leaseBySession = new Map();
  for (const lease of Object.values(leases)) {
    if (!lease?.session) continue;
    if (!leaseBySession.has(lease.session)) leaseBySession.set(lease.session, []);
    leaseBySession.get(lease.session).push(lease);
  }

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
    const myLeases = leaseBySession.get(otherSid) ?? [];
    const stalest = myLeases.find(isLeaseStale);
    return {
      sid: otherSid,
      cmds: row.count,
      lastAgo: relTime(new Date(row.lastTs).toISOString(), now),
      holding: myLeases.map(l => l.path),
      stale: Boolean(stalest),
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
  // Drop stale lease entries (and flip their plan frontmatter back to
  // oldStatus) before reading anything. Without this, hud would surface
  // zombie in-session plans from crashed sessions as "you hold N plans" if
  // the SessionStart hook sees its own (now-stale) lease from a previous
  // session that shared the same env-supplied session id.
  try { scrubStaleSilently(config); } catch { /* hot-path: never break hud */ }
  const session = currentSessionId();
  const leases = readLeases(config);
  const owned = Object.values(leases).filter(l => l.session === session).map(l => l.path);
  const stale = findStaleLeases(config).map(l => l.path);
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
    const index = buildIndex(config, { errorsOnly: true });
    errors = index.errors.length;
  } catch { /* swallow — bad config shouldn't break the SessionStart hook */ }

  const { previousSelf, fleet, recentRejections } = buildJournalSections(config);

  return { owned, stale, prompts, errors, previousSelf, fleet, recentRejections };
}

export function runHud(argv, config) {
  const json = argv.includes('--json');
  const hud = buildHud(config);

  // Self-heal stale slash-command files. Wrapped: a broken scaffolder must
  // never kill the SessionStart hook (would block every session). Skipped in
  // --json mode to keep the structured shape stable for programmatic callers.
  let refreshed = [];
  if (!json) {
    try { refreshed = refreshStaleSlashCommands(config); }
    catch { /* swallow — see comment above */ }
  }

  if (json) {
    process.stdout.write(JSON.stringify(hud, null, 2) + '\n');
    return;
  }

  const lines = [];

  // Always-on command primer. Replaces the prior plan-state / prompts /
  // stuck-leases / validation-errors lines — those signals belong inside
  // their own commands (`plans`, `prompts`), not in the SessionStart hook.
  // hud's job is purely to remind the agent which verbs exist, since that's
  // the one thing the agent reaches for `--help` to recover. Keep it tight:
  // one line, the minimum verb set.
  lines.push(dim('dotmd: plans|briefing  set <status> [<file>]  new <type> <slug>  use [<file>]  archive <file>  (use [no-arg] → oldest pending prompt)'));

  if (refreshed.length > 0) {
    const from = refreshed[0].from;
    const to = refreshed[0].to;
    const names = refreshed.map(r => r.name).join(', ');
    lines.push(dim(`↻ slash commands refreshed (v${from} → v${to}): ${names}`));
  }

  // F17b: three journal-aware sections. Silent-when-clean: each block emits
  // only when it has entries.
  if (hud.previousSelf?.length) {
    lines.push(dim('— previous self —'));
    for (const e of hud.previousSelf) {
      const cmd = (e.argv ?? []).join(' ');
      const exitTag = e.exit === 0 ? '' : `, exit ${e.exit}`;
      lines.push(dim(`  ${cmd} (${e.ago}${exitTag})`));
    }
  }

  if (hud.fleet?.length) {
    lines.push(dim('— fleet (last 24h) —'));
    for (const f of hud.fleet) {
      const heldTag = f.holding?.length
        ? ` · holding ${f.holding.map(p => path.basename(p, '.md')).join(', ')}`
        : '';
      const staleTag = f.stale ? yellow(' [stale]') : '';
      lines.push(dim(`  session ${f.sid} · ${f.cmds} cmds · last ${f.lastAgo}${heldTag}`) + staleTag);
    }
  }

  if (hud.recentRejections?.length) {
    lines.push(dim('— recent rejections (last 1h) —'));
    for (const r of hud.recentRejections) {
      lines.push(dim(`  ${r.count}× "${r.cls}" on \`${r.cmd}\``));
    }
  }

  process.stdout.write(lines.join('\n') + '\n');
}
