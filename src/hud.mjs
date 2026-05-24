import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readLeases, findStaleLeases, currentSessionId } from './lease.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath } from './util.mjs';
import { green, yellow, red, dim } from './color.mjs';
import { buildIndex } from './index.mjs';

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
  const session = currentSessionId();
  const leases = readLeases(config);
  const owned = Object.values(leases).filter(l => l.session === session).map(l => l.path);
  const stale = findStaleLeases(config).map(l => l.path);
  const prompts = findActionablePrompts(config);

  // Validation error count — hud's "silent when clean" contract should treat
  // `check` errors as not-clean. Without this, a SessionStart hook firing hud
  // can leave the agent with no visible signal that a check is failing.
  // buildIndex wraps the same scan every other read command does; cost is fine.
  let errors = 0;
  try {
    const index = buildIndex(config);
    errors = index.errors.length;
  } catch { /* swallow — bad config shouldn't break the SessionStart hook */ }

  return { owned, stale, prompts, errors };
}

export function runHud(argv, config) {
  const json = argv.includes('--json');
  const hud = buildHud(config);

  if (json) {
    process.stdout.write(JSON.stringify(hud, null, 2) + '\n');
    return;
  }

  const lines = [];
  if (hud.owned.length > 0) {
    lines.push(green(`▶ You hold ${hud.owned.length} plan${hud.owned.length === 1 ? '' : 's'}: ${previewList(hud.owned)}`));
  }
  if (hud.prompts.length > 0) {
    lines.push(green(`▶ ${hud.prompts.length} pending prompt${hud.prompts.length === 1 ? '' : 's'}: ${previewList(hud.prompts)}  ${dim('(consume: `dotmd prompts use <file>` — do not cat/read)')}`));
  }
  if (hud.stale.length > 0) {
    lines.push(yellow(`⚠ ${hud.stale.length} stuck lease${hud.stale.length === 1 ? '' : 's'} >24h  ${dim('(run: dotmd release --stale)')}`));
  }
  if (hud.errors > 0) {
    lines.push(red(`✗ ${hud.errors} validation error${hud.errors === 1 ? '' : 's'}  ${dim('(run: dotmd check)')}`));
  }

  if (lines.length === 0) return; // silent when clean
  process.stdout.write(lines.join('\n') + '\n');
}
