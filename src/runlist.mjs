import { readFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import {
  asString,
  die,
  isArchivedPath,
  normalizeStringList,
  resolveRefPath,
  toRepoPath,
} from './util.mjs';
import { resolveDocArg } from './index.mjs';
import { bold, cyan, dim, green, red, yellow } from './color.mjs';

const PICKUPABLE_STATUSES = new Set(['active', 'planned', 'in-session']);

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

    const next = children.find(c => !c.missing && !c.archived) ?? null;
    hubs.set(hub.path, {
      hub,
      total: children.length,
      doneCount: children.filter(c => c.archived).length,
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
  if (doc.executionMode === 'coordination') return true;
  const base = (doc.path.split('/').pop() || '').replace(/\.md$/, '');
  return base === 'runlist' || base.endsWith('-runlist');
}

// Map each coordination hub to a `childCount` derived from its `related_plans:`
// cluster (resolved against the index; peers/self excluded). It's an
// approximation — `related_plans` is a *related* cluster, not a strict child
// list — so it's shown as a rough "N plans" hint, not an authoritative count.
export function buildCoordinationIndex(index, config) {
  const docByPath = new Map(index.docs.map(d => [d.path, d]));
  const byBasename = new Map();
  for (const d of index.docs) {
    const base = d.path.split('/').pop();
    if (!byBasename.has(base)) byBasename.set(base, d);
  }

  const hubs = new Map();
  for (const doc of index.docs) {
    if (!isCoordinationHub(doc)) continue;
    const dir = path.dirname(path.join(config.repoRoot, doc.path));
    const refs = doc.refFields?.related_plans ?? [];
    const childPaths = new Set();
    for (const ref of refs) {
      const abs = resolveRefPath(ref, dir, config.repoRoot);
      let child = abs ? docByPath.get(toRepoPath(abs, config.repoRoot)) ?? null : null;
      if (!child) child = byBasename.get(ref.split('/').pop()) ?? null;
      if (child && child.path !== doc.path && (child.type === 'plan' || child.type == null)) {
        childPaths.add(child.path);
      }
    }
    hubs.set(doc.path, { doc, childCount: childPaths.size, childPaths });
  }
  return hubs;
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
      const { frontmatter: childFmRaw } = extractFrontmatter(childRaw);
      const childFm = parseSimpleFrontmatter(childFmRaw);
      out.push({
        ref,
        path: repoPath,
        status: asString(childFm.status) ?? null,
        title: asString(childFm.title) ?? path.basename(abs, '.md'),
        parentPlan: childFm.parent_plan ?? null,
        missing: false,
      });
    } catch {
      out.push({ ref, path: repoPath, status: null, title: null, missing: true });
    }
  }
  return out;
}

function detectBodyRunlistRefs(body) {
  if (!body) return [];
  const sectionRe = /^##\s+(Order of operations|Runlist|Execution order|Implementation order|Plan order)\s*$/gim;
  const refs = [];
  let match;
  while ((match = sectionRe.exec(body)) !== null) {
    const start = match.index + match[0].length;
    const rest = body.slice(start);
    const next = rest.search(/^##\s+/m);
    const section = next >= 0 ? rest.slice(0, next) : rest;

    const linkRe = /\[[^\]]+\]\(([^)]+\.md(?:#[^)]+)?)\)/g;
    let link;
    while ((link = linkRe.exec(section)) !== null) refs.push(link[1]);

    const checklistRe = /^\s*[-*]\s+\[[ xX]\]\s+([^\s)]+\.md(?:#[^\s)]+)?)/gm;
    let item;
    while ((item = checklistRe.exec(section)) !== null) refs.push(item[1]);
  }
  return [...new Set(refs)];
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
    const isNext = !nextPicked && !archiveStatuses.has(c.status);
    if (isNext) nextPicked = true;
    const marker = isNext ? green('→') : ' ';
    const statusTag = `[${colorStatus(c.status)}]`;
    lines.push(`  ${marker} ${idx}. ${statusTag} ${c.path}`);
  }
  if (!nextPicked) {
    lines.push('');
    lines.push(dim('  All children archived. Hub is ready for archive.'));
  }
  return lines.join('\n') + '\n';
}

export async function runRunlist(argv, config, opts = {}) {
  const json = argv.includes('--json');
  const positional = argv.filter(a => !a.startsWith('-'));

  // Subcommand dispatch: `runlist <hub>` (show) vs `runlist next <hub>` (pickup)
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

  // sub === 'next' — find first non-archived non-missing child and pick it up.
  const target = children.find(c => !c.missing && !archiveStatuses.has(c.status));
  if (!target) {
    if (children.length === 0) die(`Hub ${hubRepoPath} has empty \`runlist:\` — nothing to pick up.`);
    const allArchived = children.every(c => !c.missing && archiveStatuses.has(c.status));
    if (allArchived) {
      die(`All children in runlist ${hubRepoPath} are archived. Hub is ready for \`dotmd archive ${hubRepoPath}\`.`);
    }
    const missing = children.filter(c => c.missing).map(c => c.ref);
    die(`No pickup-able child in runlist ${hubRepoPath}. Unresolved refs: ${missing.join(', ')}`);
  }

  // Pre-check status: pickup will die on non-pickup-able statuses, but with
  // a generic message. Surface the runlist context first so the agent knows
  // which list is blocked and on which item.
  if (!PICKUPABLE_STATUSES.has(target.status)) {
    die(
      `Next child in runlist ${hubRepoPath} is ${target.path} (status: ${target.status}).\n` +
      `Resolve the blocker before continuing the runlist.\n` +
      `  dotmd set active ${target.path}   # if ready to resume\n` +
      `  dotmd use ${target.path}          # to inspect`,
    );
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
