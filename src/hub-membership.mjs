import { readFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter } from './frontmatter.mjs';
import { resolveRefPath, toRepoPath } from './util.mjs';
import { detectBodyRunlistRefs, isHubDoc } from './hub.mjs';
import { resolveBodyLinkTarget } from './body-link.mjs';

// Membership drift: a hub's list of children and the plans that claim it via
// `parent_plan:` are two halves of one relationship, and either half can go
// stale on its own. dotmd already checks one direction — `checkRunlistBackPointers`
// warns when a `runlist:` child lacks the back-ref. These are the two arrows it
// doesn't cover.
//
// Membership only. The row is NEVER generated — same constraint as the status
// guard: the prose beside a row is why the row exists.
//
// ── What counts as a membership claim (measured, not assumed) ───────────────
//
// A body table row is NOT one. dotmd's own estate has an aggregator hub whose
// ranked queue draws plans from three other programs, and whose other tables row
// children purely to say "related" — the same pointer-row shape the status guard
// already declines to judge. Treating every rowed link as membership would flood
// correct hubs.
//
// What IS a claim: `runlist:` (frontmatter order) and the hub's BODY ORDER
// (`## Ranked queue` / `## Order of operations`) — the list `dotmd runlist next`
// actually walks. A plan there is one this hub would hand a session.
//
// ── Why "points at a different hub" is deliberately silent ──────────────────
//
// The scaffolded plan wanted a warning when a rowed child "moved to another
// hub". Measured against a real estate, sharing is legitimate and common: an
// aggregator hub ranks plans whose `parent_plan:` names the program hub that
// owns them, and demanding exclusivity would fire on every one of those rows
// with no fix that doesn't break the other hub's claim. So the guard fires only
// on the unambiguous half — a ranked plan claiming NO parent at all.

const ORPHAN_KIND = 'hub-membership-orphan';
const BACKREF_KIND = 'hub-membership-backref';

export function checkHubMembershipDrift(docs, config) {
  const warnings = [];
  // Per-doc: warning suppression is type-scoped, so a status name quiet for one
  // type stays loud for another that declared the same name.
  const quiet = (d) => (config.lifecycle?.isTerminal?.(d.status, d.type)
      ?? config.lifecycle?.terminalStatuses?.has(d.status))
    || config.lifecycle?.skipsWarnings(d.status, d.type);
  const byPath = new Map(docs.map(doc => [doc.path, doc]));
  const refFields = [
    ...(config.referenceFields?.bidirectional ?? []),
    ...(config.referenceFields?.unidirectional ?? []),
  ];

  const dirOf = (doc) => path.dirname(path.join(config.repoRoot, doc.path));
  const resolve = (ref, dir) => {
    const abs = resolveRefPath(String(ref).replace(/#.*$/, ''), dir, config.repoRoot);
    return abs ? byPath.get(toRepoPath(abs, config.repoRoot)) ?? null : null;
  };
  const resolveBody = (link, dir) => {
    if (link.targetKind && link.targetKind !== 'document') return null;
    const result = resolveBodyLinkTarget(link.href, dir, config.repoRoot);
    return result.ok ? byPath.get(toRepoPath(result.path, config.repoRoot)) ?? null : null;
  };

  // Everything a hub says about other docs: every configured reference field
  // plus every body link. Config-driven rather than a hardcoded field list, so a
  // repo that renames its reference fields keeps working.
  const knownTo = (hub) => {
    const dir = dirOf(hub);
    const known = new Set();
    for (const field of refFields) {
      for (const ref of (hub.refFields?.[field] ?? [])) {
        const target = resolve(ref, dir);
        if (target) known.add(target.path);
      }
    }
    for (const link of (hub.bodyLinks ?? [])) {
      const target = resolveBody(link, dir);
      if (target) known.add(target.path);
    }
    return known;
  };

  // ── Arrow 1: a claim only the child makes ────────────────────────────────
  // The plan says `parent_plan: <hub>` and the hub references it NOWHERE — not
  // in a reference field, not as a body link. One side of the relationship
  // silently dropped the other, and every hub view (fold, rollup, next-pickup)
  // is computed from the hub's side, so the child is invisible where it thinks
  // it lives. Warns on the HUB: the hub's list is the half that lost the entry.
  const knownCache = new Map();
  for (const child of docs) {
    if (quiet(child)) continue;
    const parents = child.refFields?.parent_plan ?? [];
    if (parents.length === 0) continue;
    const dir = dirOf(child);
    for (const ref of parents) {
      const hub = resolve(ref, dir);
      // Only hubs are asked to carry a membership list. A plain plan named as a
      // parent rows nothing, and demanding a link back there would be a new
      // opinion rather than a drift check.
      if (!hub || hub.path === child.path || !isHubDoc(hub)) continue;
      if (quiet(hub)) continue;
      if (!knownCache.has(hub.path)) knownCache.set(hub.path, knownTo(hub));
      if (knownCache.get(hub.path).has(child.path)) continue;
      warnings.push({
        path: hub.path,
        level: 'warning',
        message: `\`${child.path}\` claims \`parent_plan: ${ref}\` but this hub references it nowhere — no reference field, no body link. Add it to the hub's list, or fix the child's \`parent_plan:\`. A membership only one side records is invisible to every hub view (fold, rollup, next-pickup), which all read the hub's half.`,
        meta: { kind: ORPHAN_KIND, child: child.path, ref },
      });
    }
  }

  // ── Arrow 2: a claim only the hub makes ──────────────────────────────────
  // The hub's BODY ORDER ranks a plan — the list `dotmd runlist next <hub>`
  // walks, so this hub would hand a session that plan — and the plan carries no
  // `parent_plan:` at all. This is the same finding `checkRunlistBackPointers`
  // makes for frontmatter `runlist:` children, extended to the body-order hubs
  // it can't see; children already covered there are skipped, so one missing
  // back-ref is never reported twice. Warns on the CHILD, matching that check:
  // it's the file that needs the edit.
  for (const hub of docs) {
    if (!isHubDoc(hub) || quiet(hub)) continue;
    let body;
    try { ({ body } = extractFrontmatter(readFileSync(path.join(config.repoRoot, hub.path), 'utf8'))); }
    catch { continue; }
    const ranked = detectBodyRunlistRefs(body);
    if (ranked.length === 0) continue;
    const dir = dirOf(hub);
    const inFrontmatterRunlist = new Set();
    for (const ref of (hub.refFields?.runlist ?? [])) {
      const target = resolve(ref, dir);
      if (target) inFrontmatterRunlist.add(target.path);
    }

    const seen = new Set();
    for (const ref of ranked) {
      const child = resolve(ref, dir);
      if (!child || child.path === hub.path || seen.has(child.path)) continue;
      seen.add(child.path);
      if (quiet(child)) continue;                 // closed work is normal history
      if (inFrontmatterRunlist.has(child.path)) continue;    // checkRunlistBackPointers owns it
      if (isHubDoc(child)) continue;                         // a hub under a hub is the roadmap tier
      if (child.type && child.type !== 'plan') continue;     // `parent_plan` is a plan relationship
      if ((child.refFields?.parent_plan ?? []).length > 0) continue;
      warnings.push({
        path: child.path,
        level: 'warning',
        message: `is ranked in the body order of \`${hub.path}\` (the list \`dotmd runlist next\` walks) but has no \`parent_plan:\`. Add \`parent_plan: ${hub.path}\` so reverse-link tooling (pickup-card Related:, graph) stays consistent.`,
        meta: { kind: BACKREF_KIND, hub: hub.path },
      });
    }
  }

  return warnings;
}

export const HUB_MEMBERSHIP_KINDS = Object.freeze({ orphan: ORPHAN_KIND, backref: BACKREF_KIND });
