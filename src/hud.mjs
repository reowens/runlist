import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readLeases, findStaleLeases, currentSessionId } from './lease.mjs';
import { scrubStaleSilently } from './lease-scrub.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath } from './util.mjs';
import { dim } from './color.mjs';
import { buildIndex } from './index.mjs';
import { refreshStaleSlashCommands } from './claude-commands.mjs';

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

  return { owned, stale, prompts, errors };
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
  lines.push(dim('dotmd: plans|briefing  set <status> [<file>]  new <type> <slug>  prompts next|use|new  archive <file>'));

  if (refreshed.length > 0) {
    const from = refreshed[0].from;
    const to = refreshed[0].to;
    const names = refreshed.map(r => r.name).join(', ');
    lines.push(dim(`↻ slash commands refreshed (v${from} → v${to}): ${names}`));
  }

  process.stdout.write(lines.join('\n') + '\n');
}
