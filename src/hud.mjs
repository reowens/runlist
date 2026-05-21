import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readLeases, findStaleLeases, currentSessionId } from './lease.mjs';
import { listQueuedHandoffs } from './handoff.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath } from './util.mjs';
import { green, yellow, dim } from './color.mjs';

const MAX_PREVIEW = 5;

function slug(repoPath) { return path.basename(repoPath, '.md'); }

function previewList(items, max = MAX_PREVIEW) {
  const slugs = items.slice(0, max).map(slug);
  const more = items.length > max ? `, +${items.length - max} more` : '';
  return slugs.join(', ') + more;
}

function findPendingPrompts(config) {
  const roots = config.docsRoots || (config.docsRoot ? [config.docsRoot] : []);
  const archiveDir = config.archiveDir || 'archived';
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
      if (asString(fm.status) !== 'pending') continue;
      found.push(toRepoPath(filePath, config.repoRoot));
    }
  }

  return found.sort();
}

export function buildHud(config) {
  const session = currentSessionId();
  const leases = readLeases(config);
  const owned = Object.values(leases).filter(l => l.session === session).map(l => l.path);
  const queued = listQueuedHandoffs(config).map(h => h.repoPath);
  const stale = findStaleLeases(config).map(l => l.path);
  const prompts = findPendingPrompts(config);

  return { owned, queued, stale, prompts };
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
  if (hud.queued.length > 0) {
    lines.push(green(`▶ ${hud.queued.length} handoff${hud.queued.length === 1 ? '' : 's'} queued: ${previewList(hud.queued)}  ${dim('(resume: dotmd pickup)')}`));
  }
  if (hud.prompts.length > 0) {
    lines.push(green(`▶ ${hud.prompts.length} pending prompt${hud.prompts.length === 1 ? '' : 's'}: ${previewList(hud.prompts)}  ${dim('(consume: `dotmd prompts use <file>` — do not cat/read)')}`));
  }
  if (hud.stale.length > 0) {
    lines.push(yellow(`⚠ ${hud.stale.length} stuck lease${hud.stale.length === 1 ? '' : 's'} >24h  ${dim('(run: dotmd release --stale)')}`));
  }

  if (lines.length === 0) return; // silent when clean
  process.stdout.write(lines.join('\n') + '\n');
}
