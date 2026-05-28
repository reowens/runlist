import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import {
  asString,
  die,
  normalizeStringList,
  resolveDocPath,
  resolveRefPath,
  toRepoPath,
  toSlug,
} from './util.mjs';
import { bold, cyan, dim, green, red, yellow } from './color.mjs';

const PICKUPABLE_STATUSES = new Set(['active', 'planned', 'in-session']);

// resolveDocPath only tries cwd / repo-root / docs-root joins, so bare plan
// slugs like `clear-the-deck` don't resolve when plans live under
// `<docsRoot>/plans/`. The other commands (`dotmd set <slug>`, `dotmd plans`)
// take slugs — runlist should too. Try the direct resolve first, then
// fall back to `<root>/plans/<slug>.md` under each configured doc root.
function resolveHubInput(input, config) {
  const direct = resolveDocPath(input, config);
  if (direct) return direct;

  if (!input.endsWith('.md')) {
    const withExt = resolveDocPath(input + '.md', config);
    if (withExt) return withExt;
  }

  const slugFile = input.endsWith('.md') ? input : `${input}.md`;
  const roots = config.docsRoots || (config.docsRoot ? [config.docsRoot] : []);
  for (const root of roots) {
    const candidate = path.join(root, 'plans', slugFile);
    if (existsSync(candidate)) return candidate;
    // Multi-root layouts may already have a `plans` root, so also try the
    // root itself.
    const rootCandidate = path.join(root, slugFile);
    if (existsSync(rootCandidate)) return rootCandidate;
  }

  return null;
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
      `  dotmd status ${target.path} active   # if ready to resume\n` +
      `  dotmd pickup ${target.path}          # to inspect`,
    );
  }

  // Delegate to runPickup — same lease semantics, same VH append, same card
  // render. Dynamic import to avoid circular module-load cost when the
  // runlist command isn't used.
  const { runPickup } = await import('./lifecycle.mjs');
  const pickupArgs = [target.path];
  if (argv.includes('--takeover')) pickupArgs.push('--takeover');
  if (argv.includes('--full')) pickupArgs.push('--full');
  if (argv.includes('--no-index')) pickupArgs.push('--no-index');
  if (argv.includes('--show-files')) pickupArgs.push('--show-files');
  if (json) pickupArgs.push('--json');
  await runPickup(pickupArgs, config, opts);
}
