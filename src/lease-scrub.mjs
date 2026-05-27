import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { releaseStale } from './lease.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, nowIso } from './util.mjs';

// Inline status flip, kept local so this module doesn't have to pull in
// lifecycle.mjs (and the rest of its dep graph) on the SessionStart-hook hot
// path. Matches the shape of lifecycle.updateFrontmatter for these two keys.
function flipStatus(filePath, newStatus) {
  const raw = readFileSync(filePath, 'utf8');
  if (!raw.startsWith('---\n')) return;
  const endMarker = raw.indexOf('\n---\n', 4);
  if (endMarker === -1) return;
  let fm = raw.slice(4, endMarker);
  const body = raw.slice(endMarker + 5);
  const today = nowIso();
  const statusRe = /^status:.*$/m;
  const updatedRe = /^updated:.*$/m;
  fm = statusRe.test(fm) ? fm.replace(statusRe, `status: ${newStatus}`) : `${fm}\nstatus: ${newStatus}`;
  fm = updatedRe.test(fm) ? fm.replace(updatedRe, `updated: ${today}`) : `${fm}\nupdated: ${today}`;
  writeFileSync(filePath, `---\n${fm}\n---\n${body}`, 'utf8');
}

// Opportunistic stale-lease scrub for read-side commands. Drops any lease
// entries past STALE_LEASE_AGE_MS and best-effort flips the plan's frontmatter
// from in-session back to the lease's oldStatus. Silent: no stderr, no warn,
// no index regen. Returns array of scrubbed lease paths (empty in the common
// no-op case, which is the only thing that matters for cost).
export function scrubStaleSilently(config) {
  const result = releaseStale(config);
  if (result.released.length === 0) return [];
  for (const lease of result.released) {
    const newStatus = lease.oldStatus || 'active';
    const filePath = path.join(config.repoRoot, lease.path);
    try {
      const raw = readFileSync(filePath, 'utf8');
      const { frontmatter: fmRaw } = extractFrontmatter(raw);
      const parsedFm = parseSimpleFrontmatter(fmRaw);
      if (asString(parsedFm.status) === 'in-session') {
        flipStatus(filePath, newStatus);
      }
    } catch {
      // Best-effort: the lease entry is already gone; a missing or unreadable
      // file is fine for an opportunistic backstop.
    }
  }
  return result.released.map(l => l.path);
}
