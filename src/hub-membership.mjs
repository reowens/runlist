import { readFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, normalizeStringList, resolveRefPath, toRepoPath } from './util.mjs';
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

function quietDoc(status, type, config) {
  return (config.lifecycle?.isTerminal?.(status, type)
      ?? config.lifecycle?.terminalStatuses?.has(status))
    || config.lifecycle?.skipsWarnings(status, type);
}

function configuredRunlist(parsed, config) {
  const fields = [
    ...(config.referenceFields?.bidirectional ?? []),
    ...(config.referenceFields?.unidirectional ?? []),
  ];
  if (!fields.includes('runlist')) return { paths: [], directions: [] };
  const paths = [];
  const directions = [];
  for (const entry of normalizeStringList(parsed.runlist)) {
    const oneWay = entry.match(/^>\s*(.+)$/);
    paths.push(oneWay ? oneWay[1].trim() : entry);
    directions.push(oneWay ? 'one-way' : 'two-way');
  }
  return { paths, directions };
}

// One shared definition of mechanically repairable membership evidence. It
// reads the exact hub/child bytes it returns so callers can bind those snapshots
// into an atomic mutation: frontmatter `runlist:` (except `>` one-way entries)
// plus the body order read by `dotmd runlist next`. Ordinary body links remain
// pointers, and an existing parent — same or different — is never a candidate.
export function collectMembershipBackrefCandidates(docs, config, { hubPaths = null } = {}) {
  const byPath = new Map(docs.map(doc => [doc.path, doc]));
  const evidence = new Map();

  const resolve = (ref, dir) => {
    const abs = resolveRefPath(String(ref).replace(/#.*$/, ''), dir, config.repoRoot);
    return abs ? byPath.get(toRepoPath(abs, config.repoRoot)) ?? null : null;
  };

  for (const indexedHub of docs) {
    if (hubPaths && !hubPaths.has(indexedHub.path)) continue;
    // The index is the discovery snapshot. Re-read only docs it identified as
    // hubs; current bytes below can still demote one safely, while a doc that
    // became a hub after indexing is simply discovered on the next run.
    if (!isHubDoc(indexedHub)) continue;
    const hubAbs = path.join(config.repoRoot, indexedHub.path);
    let hubRaw;
    let hubFrontmatter;
    let body;
    try {
      hubRaw = readFileSync(hubAbs, 'utf8');
      ({ frontmatter: hubFrontmatter, body } = extractFrontmatter(hubRaw));
    } catch { continue; }
    const parsedHub = parseSimpleFrontmatter(hubFrontmatter);
    const runlist = configuredRunlist(parsedHub, config);
    const currentHub = {
      ...indexedHub,
      type: asString(parsedHub.type) ?? null,
      status: asString(parsedHub.status) ?? null,
      executionMode: asString(parsedHub.execution_mode) ?? null,
      refFields: { ...indexedHub.refFields, runlist: runlist.paths },
      refFieldDirections: { ...indexedHub.refFieldDirections, runlist: runlist.directions },
    };
    if (!isHubDoc(currentHub) || quietDoc(currentHub.status, currentHub.type, config)) continue;

    const hubDir = path.dirname(hubAbs);
    const runlistTargets = new Map();
    for (let index = 0; index < runlist.paths.length; index++) {
      const child = resolve(runlist.paths[index], hubDir);
      if (!child || child.path === currentHub.path) continue;
      runlistTargets.set(child.path, runlist.directions[index]);
      if (runlist.directions[index] === 'one-way') continue;
      addEvidence(child, 'frontmatter-runlist', runlist.paths[index]);
    }
    for (const ref of detectBodyRunlistRefs(body)) {
      const child = resolve(ref, hubDir);
      if (!child || child.path === currentHub.path) continue;
      // A frontmatter entry owns this pair. A `>` entry is an explicit opt-out;
      // a normal entry was already recorded above. Either way, body order must
      // not create a second or contradictory authorization.
      if (runlistTargets.has(child.path)) continue;
      addEvidence(child, 'body-order', ref);
    }

    function addEvidence(indexedChild, source, ref) {
      const childAbs = path.join(config.repoRoot, indexedChild.path);
      let childRaw;
      let childFrontmatter;
      try {
        childRaw = readFileSync(childAbs, 'utf8');
        ({ frontmatter: childFrontmatter } = extractFrontmatter(childRaw));
      } catch { return; }
      const parsedChild = parseSimpleFrontmatter(childFrontmatter);
      const childType = asString(parsedChild.type) ?? null;
      const childStatus = asString(parsedChild.status) ?? null;
      if (quietDoc(childStatus, childType, config)) return;
      // Preserve the validator's brownfield behavior: an untyped legacy doc is
      // still plan-like enough to diagnose. The writer applies the stricter
      // type: plan boundary before it mutates anything.
      if (childType && childType !== 'plan') return;
      const childRunlist = configuredRunlist(parsedChild, config);
      const currentChild = {
        ...indexedChild,
        type: childType,
        status: childStatus,
        executionMode: asString(parsedChild.execution_mode) ?? null,
        refFields: { ...indexedChild.refFields, runlist: childRunlist.paths },
      };
      if (isHubDoc(currentChild)) return;
      if (normalizeStringList(parsedChild.parent_plan).length > 0) return;

      const key = `${indexedChild.path}\0${currentHub.path}`;
      const existing = evidence.get(key);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        if (!existing.refs.includes(ref)) existing.refs.push(ref);
        return;
      }
      evidence.set(key, {
        child: indexedChild,
        hub: currentHub,
        childPath: indexedChild.path,
        hubPath: currentHub.path,
        childAbs,
        hubAbs,
        childRaw,
        childType,
        hubRaw,
        sources: [source],
        refs: [ref],
      });
    }
  }

  const byChild = new Map();
  for (const item of evidence.values()) {
    if (!byChild.has(item.childPath)) byChild.set(item.childPath, []);
    byChild.get(item.childPath).push(item);
  }
  const candidates = [];
  const ambiguous = [];
  for (const [childPath, items] of byChild) {
    if (items.length === 1) candidates.push(items[0]);
    else ambiguous.push({ childPath, hubPaths: items.map(item => item.hubPath).sort(), evidence: items });
  }
  candidates.sort((a, b) => a.childPath.localeCompare(b.childPath));
  ambiguous.sort((a, b) => a.childPath.localeCompare(b.childPath));
  return { candidates, ambiguous, evidence: [...evidence.values()] };
}

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
  const { evidence } = collectMembershipBackrefCandidates(docs, config);
  for (const item of evidence) {
    if (!item.sources.includes('body-order')) continue;
    const { child, hub } = item;
    warnings.push({
      path: child.path,
      level: 'warning',
      message: `is ranked in the body order of \`${hub.path}\` (the list \`dotmd runlist next\` walks) but has no \`parent_plan:\`. Add \`parent_plan: ${hub.path}\` so reverse-link tooling (pickup-card Related:, graph) stays consistent.`,
      meta: { kind: BACKREF_KIND, hub: hub.path, source: 'body-order' },
    });
  }

  return warnings;
}

export const HUB_MEMBERSHIP_KINDS = Object.freeze({ orphan: ORPHAN_KIND, backref: BACKREF_KIND });
