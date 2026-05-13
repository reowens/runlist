import path from 'node:path';
import { readLeases, findStaleLeases, currentSessionId } from './lease.mjs';
import { listQueuedHandoffs } from './handoff.mjs';
import { green, yellow, dim } from './color.mjs';

const MAX_PREVIEW = 5;

function slug(repoPath) { return path.basename(repoPath, '.md'); }

function previewList(items, max = MAX_PREVIEW) {
  const slugs = items.slice(0, max).map(slug);
  const more = items.length > max ? `, +${items.length - max} more` : '';
  return slugs.join(', ') + more;
}

export function buildHud(config) {
  const session = currentSessionId();
  const leases = readLeases(config);
  const owned = Object.values(leases).filter(l => l.session === session).map(l => l.path);
  const queued = listQueuedHandoffs(config).map(h => h.repoPath);
  const stale = findStaleLeases(config).map(l => l.path);

  return { owned, queued, stale };
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
  if (hud.stale.length > 0) {
    lines.push(yellow(`⚠ ${hud.stale.length} stuck lease${hud.stale.length === 1 ? '' : 's'} >24h  ${dim('(run: dotmd release --stale)')}`));
  }

  if (lines.length === 0) return; // silent when clean
  process.stdout.write(lines.join('\n') + '\n');
}
