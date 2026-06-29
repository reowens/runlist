import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter, replaceFrontmatter } from './frontmatter.mjs';
import { extractFirstHeading } from './extractors.mjs';
import {
  asString,
  die,
  escapeRegex,
  isArchivedPath,
  normalizeStringList,
  nowIso,
  resolveRefPath,
  toRepoPath,
  toSlug,
  warn,
} from './util.mjs';
import { resolveDocArg } from './index.mjs';
import { runlistChildContent, slugify, titleize } from './new.mjs';
import { bold, cyan, dim, green, red, yellow } from './color.mjs';

const PICKUPABLE_STATUSES = new Set(['active', 'planned', 'in-session']);

// A child is the runlist's NEXT PICKUP only when a session could start it right
// now — i.e. its status is one `dotmd use` accepts. The "parked" statuses
// (blocked/partial/paused/awaiting/queued-after) are deliberately NOT
// pickup-able: each needs its own unstuck action (monitor / spawn successor /
// re-evaluate / ask / check predecessor) before work resumes. So next-pickup
// resolution skips them and advances to the first child that's actually
// startable. Skipping ≠ done, though: a parked child is not archived, so it
// never counts toward `done/total` — that tally tracks closed (archived) only.
// This keeps the `→` marker in agreement with `runlist next`, which already
// gates on PICKUPABLE_STATUSES.
function isPickupable(status) {
  return PICKUPABLE_STATUSES.has(status);
}

// Build a hub/child map straight from the in-memory index — no disk IO. A doc
// is a runlist *hub* when its `runlist:` frontmatter (`refFields.runlist`) is
// non-empty. Each ref resolves to a doc in the index by path, falling back to
// basename so children that were archived (and physically moved into an
// archive dir) still resolve. Used by the `dotmd plans` triage view to fold
// children under their hub and tag hubs as runlists rather than plain plans.
//
// Returns:
//   hubs:       Map<hubPath, { hub, total, doneCount, children, nextChildPath }>
//                 children: [{ ref, doc, path, status, archived, missing }] in runlist order
//   childToHub: Map<childPath, hubPath>  (first hub wins on the rare double-claim)
export function buildRunlistIndex(index, config) {
  const archiveStatuses = config.lifecycle?.archiveStatuses ?? new Set(['archived']);
  const docByPath = new Map(index.docs.map(d => [d.path, d]));
  const byBasename = new Map();
  for (const d of index.docs) {
    const base = d.path.split('/').pop();
    if (!byBasename.has(base)) byBasename.set(base, d);
  }

  const hubs = new Map();
  const childToHub = new Map();
  for (const hub of index.docs) {
    const refs = hub.refFields?.runlist ?? [];
    if (refs.length === 0) continue;
    const hubDir = path.dirname(path.join(config.repoRoot, hub.path));

    const children = [];
    for (const ref of refs) {
      const abs = resolveRefPath(ref, hubDir, config.repoRoot);
      let childDoc = abs ? docByPath.get(toRepoPath(abs, config.repoRoot)) ?? null : null;
      if (!childDoc) childDoc = byBasename.get(ref.split('/').pop()) ?? null;
      if (childDoc) {
        const archived = archiveStatuses.has(childDoc.status) || isArchivedPath(childDoc.path, config);
        children.push({ ref, doc: childDoc, path: childDoc.path, status: childDoc.status, archived, missing: false });
        if (!childToHub.has(childDoc.path)) childToHub.set(childDoc.path, hub.path);
      } else {
        children.push({ ref, doc: null, path: null, status: null, archived: false, missing: true });
      }
    }

    // Next pickup = first child a session can actually start. Skip archived
    // (done) AND parked children alike; advance to the first pickup-able one.
    const next = children.find(c => !c.missing && !c.archived && isPickupable(c.status)) ?? null;
    hubs.set(hub.path, {
      hub,
      total: children.length,
      doneCount: children.filter(c => c.archived).length,
      // Live-but-not-startable children (parked: blocked/partial/paused/…). Lets
      // the `dotmd plans` fold say "N parked" instead of mislabelling a hub with
      // a parked-but-unfinished child as "all archived".
      parkedCount: children.filter(c => !c.missing && !c.archived && !isPickupable(c.status)).length,
      children,
      nextChildPath: next?.path ?? null,
    });
  }

  return { hubs, childToHub };
}

// A *coordination hub* is a prose-first plan that sits above a cluster of other
// plans — a "runlist" in the platform sense (master-runlist, ai-runlist, …)
// rather than a strictly-ordered frontmatter `runlist:` sprint. The signal is
// already in frontmatter (`execution_mode: coordination`), with the
// `*-runlist` / `runlist` naming convention as a fallback for the few hubs that
// predate the field. These plans aren't units of executable work — they're
// navigation maps — so the triage view tags them and lifts them out of the
// leaf-plan flow rather than treating them as one more active plan.
export function isCoordinationHub(doc) {
  if (!doc) return false;
  if (doc.type && doc.type !== 'plan') return false;
  // Broad "held-out navigational hub" predicate: both coordination hubs and the
  // tier-3 roadmap (`execution_mode: roadmap`) are lifted out of the active count
  // and into a hub section. `isRoadmapHub` is the finer split the tier-3 views
  // use to promote a roadmap above the Runlists section; here a roadmap counts as
  // a coordination hub so all the existing held-out plumbing covers it for free.
  if (doc.executionMode === 'coordination' || doc.executionMode === 'roadmap') return true;
  const base = (doc.path.split('/').pop() || '').replace(/\.md$/, '');
  return base === 'runlist' || base.endsWith('-runlist');
}

// A *roadmap* is the tier-3 hub: a coordination hub whose children are themselves
// hubs (runlists / coordination hubs), with progress rolled up across them. The
// signal is explicit — `execution_mode: roadmap` — with NO slug-convention
// fallback (unlike coordination hubs' `*-runlist`): there's no naming convention
// for roadmaps, and `dotmd check` nudges the structural case (a coordination hub
// that points at other hubs) toward the explicit field rather than auto-promoting.
export function isRoadmapHub(doc) {
  if (!doc) return false;
  if (doc.type && doc.type !== 'plan') return false;
  return doc.executionMode === 'roadmap';
}

// Map each coordination hub to a `childCount` derived from its `related_plans:`
// cluster (resolved against the index; peers/self excluded). It's an
// approximation — `related_plans` is a *related* cluster, not a strict child
// list — so it's shown as a rough "N plans" hint, not an authoritative count.
// Each hub also gets a `nextPickup` (or null) parsed from its body order — the
// first non-archived ranked child — so prose-first hubs surface a next-pickup
// target the way sprint `runlist:` hubs do. Reads each hub's file (a small,
// bounded set), so this is no longer pure in-memory like `buildRunlistIndex`.
export function buildCoordinationIndex(index, config) {
  const docByPath = new Map(index.docs.map(d => [d.path, d]));
  const byBasename = new Map();
  for (const d of index.docs) {
    const base = d.path.split('/').pop();
    if (!byBasename.has(base)) byBasename.set(base, d);
  }
  const archiveStatuses = config.lifecycle?.archiveStatuses ?? new Set(['archived']);

  // Resolve a path-or-basename ref (from frontmatter or body) to an indexed doc.
  const resolveRef = (ref, dir) => {
    const abs = resolveRefPath(ref, dir, config.repoRoot);
    let child = abs ? docByPath.get(toRepoPath(abs, config.repoRoot)) ?? null : null;
    if (!child) child = byBasename.get(ref.split('/').pop()) ?? null;
    return child;
  };

  const hubs = new Map();
  for (const doc of index.docs) {
    if (!isCoordinationHub(doc)) continue;
    const dir = path.dirname(path.join(config.repoRoot, doc.path));
    const refs = doc.refFields?.related_plans ?? [];
    // Resolve the `related_plans` cluster to child plan docs (deduped by path;
    // self and non-plans excluded). This is the membership set the rollup counts
    // over — `related_plans` is the only child signal a prose-first coordination
    // hub carries in frontmatter (its *body* order drives next-pickup, not
    // membership). It's an approximation — a *related* cluster can include peer
    // or parent runlists — so the done/total is a progress hint, not a contract.
    const childPaths = new Set();
    const children = [];
    for (const ref of refs) {
      const child = resolveRef(ref, dir);
      if (!child || child.path === doc.path) continue;
      if (!(child.type === 'plan' || child.type == null)) continue;
      if (childPaths.has(child.path)) continue;
      childPaths.add(child.path);
      const archived = archiveStatuses.has(child.status) || isArchivedPath(child.path, config);
      children.push({ path: child.path, status: child.status ?? null, archived });
    }
    // Rollup, mirroring buildRunlistIndex: done = archived; parked = live but not
    // startable (blocked/partial/paused/awaiting/queued-after). `childCount`
    // stays an alias of `total` so existing callers (sorters, JSON) keep working.
    const doneCount = children.filter(c => c.archived).length;
    const parkedCount = children.filter(c => !c.archived && !isPickupable(c.status)).length;
    const nextPickup = resolveHubNextPickup(doc, dir, resolveRef, archiveStatuses, config);
    hubs.set(doc.path, {
      doc,
      childCount: childPaths.size,
      total: childPaths.size,
      doneCount,
      parkedCount,
      childPaths,
      children,
      nextPickup,
    });
  }
  return hubs;
}

// Build the tier-3 rollup. For each roadmap hub, resolve its children (the
// `related_plans:` cluster, exactly like a coordination hub's membership) and
// roll each child's own done/total up into a grand total. A child that is itself
// a hub contributes its hub rollup — sprint via `buildRunlistIndex`, coordination
// via `buildCoordinationIndex`; a plain-plan child contributes one unit. The
// grand total is the SUM of the children's totals (not a deduped union), so it
// always equals the sum of the per-child rows the dashboard renders — two child
// runlists that share a plan double-count it, the same "progress hint, not a
// contract" approximation coordination-hub rollup already carries.
//
// Reuses precomputed `coordination` / `runlist` indexes when the caller has them
// (the views build coordination already); otherwise builds what it needs. Returns
//   Map<roadmapPath, { doc, children, childCount, grandTotal, grandDone, grandParked }>
// with each child = { doc, path, kind: 'runlist'|'coordination'|'plan', total,
// doneCount, parkedCount, nextPickup } in `related_plans` order.
export function buildRoadmapIndex(index, config, precomputed = {}) {
  const roadmaps = index.docs.filter(isRoadmapHub);
  if (roadmaps.length === 0) return new Map();

  const coordination = precomputed.coordination ?? buildCoordinationIndex(index, config);
  const runlist = precomputed.runlist ?? buildRunlistIndex(index, config);
  const archiveStatuses = config.lifecycle?.archiveStatuses ?? new Set(['archived']);

  const docByPath = new Map(index.docs.map(d => [d.path, d]));
  const byBasename = new Map();
  for (const d of index.docs) {
    const base = d.path.split('/').pop();
    if (!byBasename.has(base)) byBasename.set(base, d);
  }
  const resolveRef = (ref, dir) => {
    const abs = resolveRefPath(ref, dir, config.repoRoot);
    let child = abs ? docByPath.get(toRepoPath(abs, config.repoRoot)) ?? null : null;
    if (!child) child = byBasename.get(ref.split('/').pop()) ?? null;
    return child;
  };

  // Rollup numbers for one child of a roadmap, dispatched by what the child IS:
  // a sprint runlist hub, a coordination hub, or a plain leaf plan.
  const childRollup = (child) => {
    if (runlist.hubs.has(child.path)) {
      const h = runlist.hubs.get(child.path);
      return { kind: 'runlist', total: h.total, doneCount: h.doneCount, parkedCount: h.parkedCount, nextPickup: null };
    }
    if (coordination.has(child.path)) {
      const h = coordination.get(child.path);
      return { kind: 'coordination', total: h.total, doneCount: h.doneCount, parkedCount: h.parkedCount, nextPickup: h.nextPickup };
    }
    const archived = archiveStatuses.has(child.status) || isArchivedPath(child.path, config);
    const parked = !archived && !isPickupable(child.status);
    return { kind: 'plan', total: 1, doneCount: archived ? 1 : 0, parkedCount: parked ? 1 : 0, nextPickup: null };
  };

  const out = new Map();
  for (const doc of roadmaps) {
    const dir = path.dirname(path.join(config.repoRoot, doc.path));
    const refs = doc.refFields?.related_plans ?? [];
    const seen = new Set();
    const children = [];
    let grandTotal = 0, grandDone = 0, grandParked = 0;
    for (const ref of refs) {
      const child = resolveRef(ref, dir);
      if (!child || child.path === doc.path) continue;
      if (!(child.type === 'plan' || child.type == null)) continue;
      if (seen.has(child.path)) continue;
      seen.add(child.path);
      const roll = childRollup(child);
      grandTotal += roll.total;
      grandDone += roll.doneCount;
      grandParked += roll.parkedCount;
      children.push({ doc: child, path: child.path, ...roll });
    }
    out.set(doc.path, { doc, children, childCount: children.length, grandTotal, grandDone, grandParked });
  }
  return out;
}

// Conventional container dirs whose name adds no disambiguation to a hub label.
const HUB_CONTAINER_DIRS = new Set(['plans', 'prompts', 'archive', 'archived']);

// Display label for a hub. A bare basename loses context for hubs that live in
// a subdirectory (e.g. `docs/plans/pos/runlist.md` would read as just
// `runlist`), so prefix the immediate parent dir unless it's a conventional
// container. → `pos/runlist`, but `billing-runlist` stays as-is. Shared by the
// `dotmd plans` Runlists section, `dotmd runlists`, and `dotmd health` so a hub
// reads the same everywhere.
export function hubLabel(doc) {
  const slug = toSlug(doc);
  const parent = path.basename(path.dirname(doc.path));
  return HUB_CONTAINER_DIRS.has(parent) ? slug : `${parent}/${slug}`;
}

// Bare hub slugs resolve through the shared resolver; the caller keeps its
// runlist-specific miss message, so no die-on-miss here.
function resolveHubInput(input, config) {
  return resolveDocArg(input, config, { dieOnMiss: false });
}

// Read a hub plan's `runlist:` and resolve each entry to a repo-relative path
// plus its current status. Missing files are reported with `missing: true`;
// callers decide how to render them. Pure: no IO beyond file reads.
function resolveRunlistRefs(refs, hubAbsPath, config) {
  const hubDir = path.dirname(hubAbsPath);
  const out = [];
  for (const ref of refs) {
    const abs = resolveRefPath(ref, hubDir, config.repoRoot);
    if (!abs) {
      out.push({ ref, path: null, status: null, title: null, missing: true });
      continue;
    }
    const repoPath = toRepoPath(abs, config.repoRoot);
    try {
      const childRaw = readFileSync(abs, 'utf8');
      const { frontmatter: childFmRaw, body: childBody } = extractFrontmatter(childRaw);
      const childFm = parseSimpleFrontmatter(childFmRaw);
      out.push({
        ref,
        path: repoPath,
        status: asString(childFm.status) ?? null,
        // Fall back to the body H1 (like the main index) before the bare
        // filename — runlist child stubs carry their title as an H1, not a
        // `title:` field, so this keeps the synced body order list readable.
        title: asString(childFm.title) ?? extractFirstHeading(childBody) ?? path.basename(abs, '.md'),
        parentPlan: childFm.parent_plan ?? null,
        missing: false,
      });
    } catch {
      out.push({ ref, path: repoPath, status: null, title: null, missing: true });
    }
  }
  return out;
}

// Extract ordered plan refs from a hub's body prose. Two shapes:
//   - link-list sections (`## Order of operations`, `## Runlist`, …) — every
//     `.md` link or checklist item, in document order.
//   - ranked-queue tables (`## Ranked queue`, …) — the first `.md` link in each
//     table row (the ranked plan); header/separator rows contribute none.
// Coordination hubs encode their next-pickup order in the table shape; sprint-
// ish hubs use the link list. Deduped, first occurrence wins, order preserved.
function detectBodyRunlistRefs(body) {
  if (!body) return [];
  const refs = [];
  const linkRe = /\[[^\]]+\]\(([^)]+\.md(?:#[^)]+)?)\)/;
  const sliceSection = (start) => {
    const rest = body.slice(start);
    const next = rest.search(/^##\s+/m);
    return next >= 0 ? rest.slice(0, next) : rest;
  };

  const linkSectionRe = /^##\s+(?:Order of operations|Runlist|Execution order|Implementation order|Plan order)\b.*$/gim;
  let match;
  while ((match = linkSectionRe.exec(body)) !== null) {
    const section = sliceSection(match.index + match[0].length);
    const allLinks = new RegExp(linkRe.source, 'g');
    let link;
    while ((link = allLinks.exec(section)) !== null) refs.push(link[1]);

    const checklistRe = /^\s*[-*]\s+\[[ xX]\]\s+([^\s)]+\.md(?:#[^\s)]+)?)/gm;
    let item;
    while ((item = checklistRe.exec(section)) !== null) refs.push(item[1]);
  }

  // Ranked-queue tables: the first `.md` link per row is the ranked plan. A
  // header (`| Rank | Plan | … |`) and separator (`|---|`) carry no link and are
  // skipped naturally. Heading may carry trailing text (`## Ranked queue (next
  // pickup)`), so match the leading words, not an exact line.
  const queueSectionRe = /^##\s+(?:Ranked queue|Queue|Pickup order|Heads)\b.*$/gim;
  while ((match = queueSectionRe.exec(body)) !== null) {
    const section = sliceSection(match.index + match[0].length);
    for (const rawLine of section.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('|')) continue;
      const link = linkRe.exec(line);
      if (link) refs.push(link[1]);
    }
  }

  return [...new Set(refs)];
}

// Label for a hub's next-pickup child: its slug with the hub's leading module
// segment stripped when shared (so `founder-runlist` → `founder-brand-conflicts`
// reads as `brand-conflicts`), mirroring how sprint children drop the hub
// prefix. Falls back to the full slug when there's no shared leading segment.
function coordinationChildLabel(childDoc, hubDoc) {
  const childSlug = toSlug(childDoc);
  const seg = toSlug(hubDoc).split('-')[0];
  if (seg.length >= 2 && childSlug.startsWith(`${seg}-`) && childSlug.length > seg.length + 1) {
    return childSlug.slice(seg.length + 1);
  }
  return childSlug;
}

// Read a coordination hub's body order (a `## Ranked queue` table or a
// `## Order of operations` link list) and return its NEXT PICKUP: the first
// ranked child that isn't archived, resolved to its live status from the index.
// Prose-first hubs keep their sequence in the body, invisible to the
// frontmatter-only index — this surfaces `next → <child>` the way sprint
// `runlist:` hubs already do. Returns null when the hub has no parseable body
// order or every ranked child is archived. Best-effort: a read failure degrades
// to null, never throws.
function resolveHubNextPickup(hubDoc, hubDir, resolveRef, archiveStatuses, config) {
  let body;
  try {
    ({ body } = extractFrontmatter(readFileSync(path.join(config.repoRoot, hubDoc.path), 'utf8')));
  } catch {
    return null;
  }
  for (const ref of detectBodyRunlistRefs(body)) {
    const child = resolveRef(ref, hubDir);
    if (!child || child.path === hubDoc.path) continue;
    if (child.type && child.type !== 'plan') continue;
    const archived = archiveStatuses.has(child.status) || isArchivedPath(child.path, config);
    if (archived) continue;
    // Skip parked ranked children too (blocked/partial/paused/awaiting/
    // queued-after) — the hub's next-pickup is the first startable plan, the
    // same gate sprint runlists use, so a hub never points `→` at a child a
    // session can't actually pick up.
    if (!isPickupable(child.status)) continue;
    return { path: child.path, status: child.status ?? null, label: coordinationChildLabel(child, hubDoc) };
  }
  return null;
}

function readRunlistChildren(hubAbsPath, config) {
  const raw = readFileSync(hubAbsPath, 'utf8');
  const { frontmatter: fmRaw, body } = extractFrontmatter(raw);
  const fm = parseSimpleFrontmatter(fmRaw);
  const refs = normalizeStringList(fm.runlist);

  if (refs.length > 0) {
    return { children: resolveRunlistRefs(refs, hubAbsPath, config), source: 'frontmatter' };
  }

  const bodyRefs = detectBodyRunlistRefs(body);
  return {
    children: resolveRunlistRefs(bodyRefs, hubAbsPath, config),
    source: bodyRefs.length > 0 ? 'body' : 'empty',
  };
}

const STATUS_TAG_COLORS = {
  'in-session': (s) => bold(red(s)),
  'active': green,
  'planned': (s) => s,
  'blocked': yellow,
  'partial': (s) => dim(green(s)),
  'paused': (s) => yellow(s),
  'awaiting': yellow,
  'queued-after': (s) => dim(cyan(s)),
  'archived': dim,
};

function colorStatus(status) {
  const fn = STATUS_TAG_COLORS[status] ?? ((s) => s);
  return fn(status ?? 'unknown');
}

function renderRunlist(hubRepoPath, children, opts = {}) {
  const lines = [];
  lines.push(bold(`runlist: ${hubRepoPath}`));
  if (children.length === 0) {
    lines.push(dim('  (empty — add child plan paths to the hub plan\'s `runlist:` field, or add markdown links under `## Order of operations`)'));
    return lines.join('\n') + '\n';
  }
  if (opts.source === 'body') {
    lines.push(dim('  (from body links — add these paths to frontmatter `runlist:` to make the order canonical)'));
  }

  const archiveStatuses = opts.archiveStatuses ?? new Set(['archived']);
  let nextPicked = false;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    const idx = String(i + 1).padStart(2);
    if (c.missing) {
      lines.push(`  ${idx}. ${red('missing')}  ${c.ref}`);
      continue;
    }
    // → marks the first child a session can actually start: skip archived and
    // parked (blocked/partial/paused/awaiting/queued-after) alike.
    const isNext = !nextPicked && isPickupable(c.status);
    if (isNext) nextPicked = true;
    const marker = isNext ? green('→') : ' ';
    const statusTag = `[${colorStatus(c.status)}]`;
    lines.push(`  ${marker} ${idx}. ${statusTag} ${c.path}`);
  }
  if (!nextPicked) {
    lines.push('');
    // No pickup-able child. Distinguish "done — ready to archive" from "stuck —
    // a parked child needs unsticking" so the agent knows which it is.
    const parked = children.filter(c => !c.missing && !archiveStatuses.has(c.status));
    lines.push(dim(parked.length === 0
      ? '  All children archived. Hub is ready for archive.'
      : `  No pickup-able child — ${parked.length} parked. Unstick one (e.g. \`dotmd set active <child>\`) to continue.`));
  }
  return lines.join('\n') + '\n';
}

// --- `runlist add` mutation (Phase 1) -------------------------------------

// Replace a top-level frontmatter field (its `key:` line + any indented
// continuation block) with `serialized`, or append it when absent. The regex
// mirrors what `mergeBodyFrontmatter` uses so the rewritten field keeps the
// scaffold's shape. Shared by the block-array (`runlist:`) and scalar
// (`parent_plan:`, `updated:`) writers below.
function upsertFrontmatterField(fm, key, serialized) {
  const re = new RegExp(`^${escapeRegex(key)}:.*(\\n[ \\t]+.*)*`, 'm');
  if (re.test(fm)) return fm.replace(re, serialized);
  return fm.replace(/\s*$/, '') + '\n' + serialized;
}

function serializeBlockArray(key, items) {
  if (items.length === 0) return `${key}:`;
  return `${key}:\n${items.map(v => `  - ${v}`).join('\n')}`;
}

// Hub-relative ref for a child path: a bare basename when the child sits in the
// hub's directory (the common case, matching how `--runlist` writes refs), else
// a relative path (forward slashes) so the ref resolves from the hub. This is
// the hub-relative resolution that lets an existing plan elsewhere be wired in
// (the thrice-parked "point a hub at an existing plan" carryover).
function hubRelativeRef(childAbs, hubDir) {
  const rel = path.relative(hubDir, childAbs).split(path.sep).join('/');
  return rel;
}

// Resolve one `runlist add` child token against an existing hub. Returns one of:
//   { kind: 'existing', abs, repoPath, ref }   — token names a plan that exists
//   { kind: 'scaffold', abs, repoPath, ref, slug, title }  — bare slug to create
// Dies on an unresolvable path (a `/`-bearing token that points nowhere — we
// scaffold from bare slugs only, never invent a nested path).
function classifyChildToken(token, hubDir, hubSlug, pos, config) {
  // Existing plan? Try hub-relative first (Phase 3 resolution), then the shared
  // resolver (repo-relative / by-basename across the index).
  const hubRel = resolveRefPath(token, hubDir, config.repoRoot)
    || (token.endsWith('.md') ? null : resolveRefPath(`${token}.md`, hubDir, config.repoRoot));
  const abs = hubRel || resolveDocArg(token, config, { dieOnMiss: false });
  if (abs) {
    return {
      kind: 'existing',
      abs,
      repoPath: toRepoPath(abs, config.repoRoot),
      ref: hubRelativeRef(abs, hubDir),
    };
  }

  // Not found. Scaffold a stub — but only from a bare slug. A `/`-bearing token
  // is a path to a file that doesn't exist; refuse rather than guess.
  if (token.includes('/') || token.includes(path.sep)) {
    die(`No plan found at "${token}". Pass a bare slug (e.g. \`cleanup\`) to scaffold a new child, or a path to an existing plan.`);
  }
  const childSlug = slugify(token.replace(/\.md$/, ''));
  if (!childSlug) die(`Child token resolves to an empty slug: "${token}"`);
  const nn = String(pos).padStart(2, '0');
  const file = `${hubSlug}-${nn}-${childSlug}.md`;
  const childAbs = path.join(hubDir, file);
  return {
    kind: 'scaffold',
    abs: childAbs,
    repoPath: toRepoPath(childAbs, config.repoRoot),
    ref: file,
    slug: childSlug,
    title: titleize(token.replace(/\.md$/, '')),
  };
}

// Set `parent_plan:` on an existing child to point back at the hub, unless it
// already resolves to the hub. Never clobbers a parent_plan that points
// elsewhere (warns instead — the child may belong to another hub). Returns
// true when it wrote, false when it left the file alone.
function setChildParentPlan(childAbs, hubAbs, config, { dryRun }) {
  const raw = readFileSync(childAbs, 'utf8');
  const { frontmatter: fmRaw } = extractFrontmatter(raw);
  if (fmRaw == null) return false;
  const fm = parseSimpleFrontmatter(fmRaw);
  const childDir = path.dirname(childAbs);
  const existing = asString(fm.parent_plan);
  if (existing) {
    const resolved = resolveRefPath(existing, childDir, config.repoRoot);
    if (resolved === hubAbs) return false; // already points at this hub
    warn(`${toRepoPath(childAbs, config.repoRoot)} already has parent_plan: ${existing} — left as-is (not pointing it at the hub).`);
    return false;
  }
  const ref = path.relative(childDir, hubAbs).split(path.sep).join('/');
  if (dryRun) return true;
  let newFm = upsertFrontmatterField(fmRaw, 'parent_plan', `parent_plan: ${ref}`);
  newFm = upsertFrontmatterField(newFm, 'updated', `updated: ${nowIso()}`);
  writeFileSync(childAbs, replaceFrontmatter(raw, newFm), 'utf8');
  return true;
}

// `dotmd runlist add <hub> <child...>` — append children to a hub's `runlist:`
// array, scaffolding a `planned` stub for any bare-slug child that doesn't yet
// exist (mirroring `dotmd new plan --runlist`) and wiring each child's
// `parent_plan:` back-ref. Coordination hubs (body-order, no `runlist:` array)
// are out of this path — guarded with an actionable message.
async function runRunlistAdd(positional, config, { dryRun, json }) {
  const hubInput = positional[0];
  const childTokens = positional.slice(1);
  if (!hubInput || childTokens.length === 0) {
    die('Usage: dotmd runlist add <hub-plan> <child...>  (one or more child slugs or plan paths)');
  }

  const hubAbs = resolveHubInput(hubInput, config);
  if (!hubAbs) die(`Hub plan not found: ${hubInput}`);
  const hubRepoPath = toRepoPath(hubAbs, config.repoRoot);
  const hubDir = path.dirname(hubAbs);
  const hubSlug = path.basename(hubAbs, '.md');

  const hubRaw = readFileSync(hubAbs, 'utf8');
  const { frontmatter: hubFmRaw } = extractFrontmatter(hubRaw);
  if (hubFmRaw == null) die(`Hub ${hubRepoPath} has no frontmatter.`);
  const hubFm = parseSimpleFrontmatter(hubFmRaw);
  const existingRefs = normalizeStringList(hubFm.runlist);
  const isCoord = hubFm.execution_mode === 'coordination';

  // Coordination hubs keep their order in the body (`## Ranked queue` /
  // `## Order of operations`), not a `runlist:` array. Mutating that prose-first
  // order is a separate path; for now point the user at it rather than writing a
  // `runlist:` array onto a hub that deliberately doesn't use one.
  if (isCoord && existingRefs.length === 0) {
    die(
      `${hubRepoPath} is a coordination hub (execution_mode: coordination) — it keeps its order in the body\n` +
      `(\`## Ranked queue\` table or \`## Order of operations\` list), not a \`runlist:\` array.\n` +
      `Add the plan as a ranked row/link there. \`runlist add\` manages sprint \`runlist:\` arrays.`,
    );
  }

  // Resolve every token up front (so a bad token aborts before any write), then
  // dedupe against refs already in the runlist (by resolved abs path).
  const resolvedExisting = new Set();
  for (const ref of existingRefs) {
    const abs = resolveRefPath(ref, hubDir, config.repoRoot);
    if (abs) resolvedExisting.add(abs);
  }

  const toAdd = [];
  let pos = existingRefs.length;
  for (const token of childTokens) {
    pos += 1;
    const c = classifyChildToken(token, hubDir, hubSlug, pos, config);
    if (c.abs === hubAbs) { warn(`Skipping "${token}" — a hub can't list itself.`); pos -= 1; continue; }
    if (resolvedExisting.has(c.abs)) { warn(`Skipping "${token}" — already in the runlist (${c.repoPath}).`); pos -= 1; continue; }
    resolvedExisting.add(c.abs);
    toAdd.push(c);
  }
  if (toAdd.length === 0) die('Nothing to add — all children were already in the runlist or skipped.');

  const hubTitle = asString(hubFm.title) ?? titleize(hubSlug);
  const today = nowIso();
  const newRefs = [...existingRefs, ...toAdd.map(c => c.ref)];

  if (json) {
    process.stdout.write(JSON.stringify({
      hub: hubRepoPath,
      added: toAdd.map(c => ({ ref: c.ref, path: c.repoPath, scaffolded: c.kind === 'scaffold' })),
      runlist: newRefs,
      dryRun: !!dryRun,
    }, null, 2) + '\n');
    if (dryRun) return;
  }

  const prefix = dryRun ? `${dim('[dry-run]')} ` : '';
  if (!json) process.stdout.write(bold(`${prefix}runlist add → ${hubRepoPath}`) + '\n');

  for (const c of toAdd) {
    if (c.kind === 'scaffold') {
      if (!dryRun) {
        if (existsSync(c.abs)) {
          warn(`Child already exists, left as-is: ${c.repoPath}`);
        } else {
          writeFileSync(c.abs, runlistChildContent(c.title, hubSlug, hubTitle, 'planned', today), 'utf8');
        }
      }
      if (!json) process.stdout.write(`${prefix}  ${green('+')} ${c.repoPath} ${dim('(scaffolded · planned)')}\n`);
    } else {
      const wrote = setChildParentPlan(c.abs, hubAbs, config, { dryRun });
      const note = wrote ? 'existing · parent_plan set' : 'existing';
      if (!json) process.stdout.write(`${prefix}  ${green('+')} ${c.repoPath} ${dim(`(${note})`)}\n`);
    }
  }

  // Write the hub's `runlist:` array (+ bump `updated:`, + sync the body order
  // list). The child stubs are already on disk, so title resolution works.
  if (!dryRun) writeHubRunlist(hubAbs, newRefs, config, today);

  if (!json) {
    process.stdout.write(dim(`  runlist now has ${newRefs.length} ${newRefs.length === 1 ? 'child' : 'children'}.`) + '\n');
    if (!dryRun) {
      process.stdout.write(dim(`  Show: dotmd runlist ${hubRepoPath}   ·   pick up next: dotmd runlist next ${hubRepoPath}`) + '\n');
    }
  }
}

// --- `runlist remove` / `runlist reorder` mutation (Phase 2) ---------------

// Heading alternatives that carry a `## Order of operations`-style link list
// mirroring the `runlist:` array (the `new plan --runlist` scaffold writes one).
const ORDER_SECTION_RE = /^##\s+(?:Order of operations|Runlist|Execution order|Implementation order|Plan order)\b.*$/im;

// Keep a hub's body `## Order of operations` link list in sync with the
// authoritative `runlist:` array. Regenerates the numbered link block from
// `orderedRefs`, preserving each item's display title and trailing status
// marker (⬜/✅/…) for children that remain — so a hand-checked-off item keeps
// its mark across an add/remove/reorder. No such section → body untouched (we
// never invent one). Only the contiguous run of list-item lines is rewritten;
// surrounding prose (e.g. the "pick up the next child" note) is preserved.
function syncOrderList(body, orderedRefs, titleFor) {
  const m = body.match(ORDER_SECTION_RE);
  if (!m || m.index === undefined) return body;
  const headingEnd = m.index + m[0].length;
  const rest = body.slice(headingEnd);
  const nextRel = rest.search(/^##\s+/m);
  const sectionEnd = nextRel >= 0 ? headingEnd + nextRel : body.length;

  const lines = body.slice(headingEnd, sectionEnd).split('\n');
  const isItem = (l) => /^\s*(?:\d+\.|[-*])\s+/.test(l) && /\.md(?:[#)\s]|$)/.test(l);
  let start = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isItem(lines[i])) { if (start === -1) start = i; end = i; }
    else if (start !== -1) break; // first non-item after the block ends it
  }
  if (start === -1) return body; // section present but no list to sync

  const linkRe = /\[([^\]]+)\]\(([^)]+\.md)(?:#[^)]*)?\)/;
  const prior = new Map(); // basename → { title, marker }
  for (let i = start; i <= end; i++) {
    const lk = linkRe.exec(lines[i]);
    if (lk) {
      prior.set(lk[2].split('/').pop(), { title: lk[1], marker: lines[i].slice(lk.index + lk[0].length).trim() });
    } else {
      const bare = /(\S+\.md)/.exec(lines[i]);
      if (bare) prior.set(bare[1].split('/').pop(), { title: null, marker: lines[i].slice(bare.index + bare[0].length).trim() });
    }
  }

  const rebuilt = orderedRefs.map((ref, i) => {
    const prev = prior.get(ref.split('/').pop());
    const title = prev?.title ?? titleFor(ref);
    const marker = prev?.marker ? ` ${prev.marker}` : ' ⬜';
    return `${i + 1}. [${title}](${ref})${marker}`;
  });

  const newLines = [...lines.slice(0, start), ...rebuilt, ...lines.slice(end + 1)];
  return body.slice(0, headingEnd) + newLines.join('\n') + body.slice(sectionEnd);
}

// Authoritative hub write: set `runlist:` to `newRefs`, bump `updated:`, and
// resync the body order list. Shared by add/remove/reorder so all three keep
// the frontmatter array and the body link list consistent.
function writeHubRunlist(hubAbs, newRefs, config, today) {
  const raw = readFileSync(hubAbs, 'utf8');
  const { frontmatter: fmRaw, body } = extractFrontmatter(raw);
  let newFm = upsertFrontmatterField(fmRaw, 'runlist', serializeBlockArray('runlist', newRefs));
  newFm = upsertFrontmatterField(newFm, 'updated', `updated: ${today}`);

  const titles = new Map();
  for (const r of resolveRunlistRefs(newRefs, hubAbs, config)) {
    if (r.title) titles.set(r.ref.split('/').pop(), r.title);
  }
  const titleFor = (ref) => titles.get(ref.split('/').pop()) ?? titleize(path.basename(ref, '.md'));
  const newBody = syncOrderList(body, newRefs, titleFor);

  writeFileSync(hubAbs, `---\n${newFm}\n---\n${newBody}`, 'utf8');
}

// Match a child token to one of the hub's existing runlist refs. Resolves
// hub-relative (then by slug/basename across the index), then compares against
// each ref's resolved abs path, with a basename fallback for refs that don't
// resolve to a file. Returns the matched ref string, or null.
function findRefForToken(token, existingRefs, hubDir, config) {
  const tokenAbs = resolveRefPath(token, hubDir, config.repoRoot)
    || (token.endsWith('.md') ? null : resolveRefPath(`${token}.md`, hubDir, config.repoRoot))
    || resolveDocArg(token, config, { dieOnMiss: false });
  const tokBase = token.endsWith('.md') ? token.split('/').pop() : `${token.split('/').pop()}.md`;
  // Exact: resolved-path match or basename match.
  for (const ref of existingRefs) {
    const refAbs = resolveRefPath(ref, hubDir, config.repoRoot);
    if (tokenAbs && refAbs && refAbs === tokenAbs) return ref;
    if (ref.split('/').pop() === tokBase) return ref;
  }
  // Convenience: the short slug a sprint child was scaffolded from — e.g.
  // `cleanup` matches `auth-revamp-03-cleanup.md`. Unique-or-bust so an
  // ambiguous slug never silently picks the wrong child.
  const slug = tokBase.replace(/\.md$/, '');
  const suffixMatches = existingRefs.filter(ref => {
    const base = ref.split('/').pop().replace(/\.md$/, '');
    return base === slug || base.endsWith(`-${slug}`);
  });
  if (suffixMatches.length === 1) return suffixMatches[0];
  if (suffixMatches.length > 1) {
    die(`"${token}" matches multiple children: ${suffixMatches.join(', ')}. Use the full filename.`);
  }
  return null;
}

// Clear a removed child's `parent_plan:` when it points back at this hub (so the
// reverse link doesn't dangle). Leaves a parent_plan pointing elsewhere alone.
function clearChildParentPlan(childAbs, hubAbs, config, { dryRun }) {
  let raw;
  try { raw = readFileSync(childAbs, 'utf8'); } catch { return false; }
  const { frontmatter: fmRaw } = extractFrontmatter(raw);
  if (fmRaw == null) return false;
  const fm = parseSimpleFrontmatter(fmRaw);
  const existing = asString(fm.parent_plan);
  if (!existing) return false;
  if (resolveRefPath(existing, path.dirname(childAbs), config.repoRoot) !== hubAbs) return false;
  if (dryRun) return true;
  let newFm = upsertFrontmatterField(fmRaw, 'parent_plan', 'parent_plan:');
  newFm = upsertFrontmatterField(newFm, 'updated', `updated: ${nowIso()}`);
  writeFileSync(childAbs, replaceFrontmatter(raw, newFm), 'utf8');
  return true;
}

// Shared front half of remove/reorder: resolve the hub, read its `runlist:`,
// die if it isn't a sprint hub with an array to mutate.
function loadSprintHub(hubInput, verb, config) {
  if (!hubInput) die(`Usage: dotmd runlist ${verb} <hub-plan> <child...>`);
  const hubAbs = resolveHubInput(hubInput, config);
  if (!hubAbs) die(`Hub plan not found: ${hubInput}`);
  const hubRepoPath = toRepoPath(hubAbs, config.repoRoot);
  const hubDir = path.dirname(hubAbs);
  const raw = readFileSync(hubAbs, 'utf8');
  const { frontmatter: fmRaw } = extractFrontmatter(raw);
  const fm = fmRaw == null ? {} : parseSimpleFrontmatter(fmRaw);
  const existingRefs = normalizeStringList(fm.runlist);
  if (existingRefs.length === 0) {
    die(`${hubRepoPath} has no \`runlist:\` array to ${verb} from.` +
      (fm.execution_mode === 'coordination' ? ' (It is a coordination hub — order lives in the body.)' : ''));
  }
  return { hubAbs, hubRepoPath, hubDir, existingRefs };
}

async function runRunlistRemove(positional, config, { dryRun, json, clearParent }) {
  const { hubAbs, hubRepoPath, hubDir, existingRefs } = loadSprintHub(positional[0], 'remove', config);
  const childTokens = positional.slice(1);
  if (childTokens.length === 0) die('Usage: dotmd runlist remove <hub-plan> <child...>');

  const removeRefs = [];
  for (const token of childTokens) {
    const ref = findRefForToken(token, existingRefs, hubDir, config);
    if (!ref) die(`"${token}" is not in the runlist of ${hubRepoPath}.`);
    if (!removeRefs.includes(ref)) removeRefs.push(ref);
  }
  const newRefs = existingRefs.filter(r => !removeRefs.includes(r));
  const today = nowIso();

  if (json) {
    process.stdout.write(JSON.stringify({ hub: hubRepoPath, removed: removeRefs, runlist: newRefs, clearedParent: !!clearParent, dryRun: !!dryRun }, null, 2) + '\n');
  } else {
    process.stdout.write(bold(`${dryRun ? dim('[dry-run]') + ' ' : ''}runlist remove → ${hubRepoPath}`) + '\n');
    for (const ref of removeRefs) process.stdout.write(`${dryRun ? dim('[dry-run]') + ' ' : ''}  ${red('-')} ${ref}\n`);
  }

  if (!dryRun) writeHubRunlist(hubAbs, newRefs, config, today);
  if (clearParent) {
    for (const ref of removeRefs) {
      const abs = resolveRefPath(ref, hubDir, config.repoRoot);
      if (abs && clearChildParentPlan(abs, hubAbs, config, { dryRun }) && !json) {
        process.stdout.write(`${dryRun ? dim('[dry-run]') + ' ' : ''}  ${dim(`cleared parent_plan on ${toRepoPath(abs, config.repoRoot)}`)}\n`);
      }
    }
  }
  if (!json) process.stdout.write(dim(`  runlist now has ${newRefs.length} ${newRefs.length === 1 ? 'child' : 'children'}.`) + '\n');
}

// Parse `reorder` argv: skip the subcommand + flags, capture `--before`/`--after`
// values (their operands would otherwise leak into the child list).
function parseReorderArgs(argv) {
  const pos = [];
  let before = null, after = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'reorder') continue;
    if (a === '--before') { before = argv[++i] ?? null; continue; }
    if (a === '--after') { after = argv[++i] ?? null; continue; }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  return { hubInput: pos[0], children: pos.slice(1), before, after };
}

async function runRunlistReorder(argv, config, { dryRun, json }) {
  const { hubInput, children, before, after } = parseReorderArgs(argv);
  if (!hubInput || children.length === 0) {
    die('Usage: dotmd runlist reorder <hub> <child> --before|--after <other>\n   or: dotmd runlist reorder <hub> <child1> <child2> ...  (full new order)');
  }
  const { hubAbs, hubRepoPath, hubDir, existingRefs } = loadSprintHub(hubInput, 'reorder', config);

  let newRefs;
  if (before || after) {
    if (children.length !== 1) die('--before/--after move exactly one child. Pass a single child, or list every child for a full reorder.');
    const moving = findRefForToken(children[0], existingRefs, hubDir, config);
    if (!moving) die(`"${children[0]}" is not in the runlist of ${hubRepoPath}.`);
    const anchorTok = before || after;
    const anchor = findRefForToken(anchorTok, existingRefs, hubDir, config);
    if (!anchor) die(`"${anchorTok}" is not in the runlist of ${hubRepoPath}.`);
    if (moving === anchor) die('A child cannot be moved relative to itself.');
    const without = existingRefs.filter(r => r !== moving);
    const idx = without.indexOf(anchor);
    const insertAt = before ? idx : idx + 1;
    newRefs = [...without.slice(0, insertAt), moving, ...without.slice(insertAt)];
  } else {
    if (children.length !== existingRefs.length) {
      die(`Full reorder needs all ${existingRefs.length} children in the new order; got ${children.length}. Use --before/--after to move just one.`);
    }
    newRefs = children.map(tok => {
      const ref = findRefForToken(tok, existingRefs, hubDir, config);
      if (!ref) die(`"${tok}" is not in the runlist of ${hubRepoPath}.`);
      return ref;
    });
    if (new Set(newRefs).size !== newRefs.length) die('The new order repeats a child — list each exactly once.');
  }

  if (newRefs.join('\n') === existingRefs.join('\n')) die('New order matches the current order — nothing to do.');
  const today = nowIso();

  if (json) {
    process.stdout.write(JSON.stringify({ hub: hubRepoPath, runlist: newRefs, dryRun: !!dryRun }, null, 2) + '\n');
  } else {
    process.stdout.write(bold(`${dryRun ? dim('[dry-run]') + ' ' : ''}runlist reorder → ${hubRepoPath}`) + '\n');
    newRefs.forEach((ref, i) => process.stdout.write(`${dryRun ? dim('[dry-run]') + ' ' : ''}  ${String(i + 1).padStart(2)}. ${ref}\n`));
  }
  if (!dryRun) writeHubRunlist(hubAbs, newRefs, config, today);
}

export async function runRunlist(argv, config, opts = {}) {
  const json = argv.includes('--json');
  const positional = argv.filter(a => !a.startsWith('-'));

  // Subcommand dispatch: mutators (`add`/`remove`/`reorder`) vs `next` (pickup)
  // vs `show` (default).
  if (positional[0] === 'add') {
    return runRunlistAdd(positional.slice(1), config, { dryRun: opts.dryRun, json });
  }
  if (positional[0] === 'remove') {
    return runRunlistRemove(positional.slice(1), config, { dryRun: opts.dryRun, json, clearParent: argv.includes('--clear-parent') });
  }
  if (positional[0] === 'reorder') {
    return runRunlistReorder(argv, config, { dryRun: opts.dryRun, json });
  }

  const sub = positional[0] === 'next' ? 'next' : 'show';
  const hubInput = sub === 'next' ? positional[1] : positional[0];

  if (!hubInput) {
    die(sub === 'next'
      ? 'Usage: dotmd runlist next <hub-plan>'
      : 'Usage: dotmd runlist <hub-plan>');
  }

  const hubAbs = resolveHubInput(hubInput, config);
  if (!hubAbs) die(`Hub plan not found: ${hubInput}`);
  const hubRepoPath = toRepoPath(hubAbs, config.repoRoot);

  const runlist = readRunlistChildren(hubAbs, config);
  const { children, source } = runlist;
  const archiveStatuses = config.lifecycle?.archiveStatuses ?? new Set(['archived']);

  if (sub === 'show') {
    if (json) {
      process.stdout.write(JSON.stringify({
        hub: hubRepoPath,
        source,
        children,
      }, null, 2) + '\n');
      return;
    }
    process.stdout.write(renderRunlist(hubRepoPath, children, { archiveStatuses, source }));
    return;
  }

  // sub === 'next' — pick up the first child a session can actually start.
  // Skip both archived (done) and parked (blocked/partial/paused/awaiting/
  // queued-after) children: the runlist advances to the first pickup-able one,
  // so the picked target is guaranteed in a `dotmd use`-able status.
  const target = children.find(c => !c.missing && !archiveStatuses.has(c.status) && isPickupable(c.status));
  if (!target) {
    if (children.length === 0) die(`Hub ${hubRepoPath} has empty \`runlist:\` — nothing to pick up.`);
    // Live (non-archived, non-missing) children that exist but aren't startable.
    const parked = children.filter(c => !c.missing && !archiveStatuses.has(c.status));
    if (parked.length > 0) {
      // Every remaining child is parked — surface them with statuses + the
      // unstick verbs so the agent can resume one instead of being told a
      // generic "no pickup" with no path forward.
      const listed = parked.map(c => `  ${c.path} (status: ${c.status})`).join('\n');
      die(
        `No pickup-able child in runlist ${hubRepoPath} — every remaining child is parked:\n` +
        `${listed}\n` +
        `Unstick one before continuing:\n` +
        `  dotmd set active <child>   # if ready to resume\n` +
        `  dotmd use <child>          # to inspect`,
      );
    }
    const allArchived = children.some(c => !c.missing) && children.every(c => c.missing || archiveStatuses.has(c.status));
    if (allArchived) {
      die(`All children in runlist ${hubRepoPath} are archived. Hub is ready for \`dotmd archive ${hubRepoPath}\`.`);
    }
    const missing = children.filter(c => c.missing).map(c => c.ref);
    die(`No pickup-able child in runlist ${hubRepoPath}. Unresolved refs: ${missing.join(', ')}`);
  }

  // Open the next child: set it in-session (frontmatter) and render its card.
  // Dynamic import to avoid circular module-load cost when the runlist command
  // isn't used.
  const { startPlan } = await import('./lifecycle.mjs');
  const startArgs = [target.path];
  if (argv.includes('--full')) startArgs.push('--full');
  if (argv.includes('--no-index')) startArgs.push('--no-index');
  if (argv.includes('--show-files')) startArgs.push('--show-files');
  if (json) startArgs.push('--json');
  await startPlan(startArgs, config, opts);
}
