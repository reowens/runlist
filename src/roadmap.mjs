import { buildRoadmapIndex, hubLabel } from './runlist.mjs';
import { resolveDocArg } from './index.mjs';
import { toRepoPath, die } from './util.mjs';
import { bold, dim, green } from './color.mjs';

// Strip ANSI for width math (query.mjs has its own copy but doesn't export it).
function visibleLen(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

// Structured form of one roadmap, shared by every `--json` path.
function roadmapJson(info) {
  return {
    path: info.doc.path,
    title: info.doc.title ?? null,
    status: info.doc.status ?? null,
    childCount: info.childCount,
    grandTotal: info.grandTotal,
    grandDone: info.grandDone,
    grandParked: info.grandParked,
    children: info.children.map(c => ({
      path: c.path,
      label: hubLabel(c.doc),
      kind: c.kind,
      total: c.total,
      doneCount: c.doneCount,
      parkedCount: c.parkedCount,
      nextPath: c.nextPath,
      nextLabel: c.nextLabel,
    })),
  };
}

// One child-runlist row: label · done/total · next → · one-line descriptor.
function roadmapChildRow(child, maxSlug, maxWidth) {
  const label = hubLabel(child.doc).padEnd(maxSlug);
  const roll = `${child.doneCount}/${child.total}`.padStart(7);
  const next = child.nextLabel ? `${green('→')} ${child.nextLabel}  ` : '';
  const status = child.doc.status && child.doc.status !== 'active' ? ` ${dim(`[${child.doc.status}]`)}` : '';
  const desc = (child.doc.nextStep || child.doc.currentState || child.doc.title || '').replace(/\s+/g, ' ').trim();
  const left = `  ${label}  ${dim(roll)}  `;
  const budget = Math.max(10, maxWidth - visibleLen(left) - visibleLen(next) - visibleLen(status) - 2);
  const descR = desc.length > budget ? desc.slice(0, Math.max(0, budget - 3)) + '...' : desc;
  return `${left}${next}${dim(descR)}${status}`;
}

// Full single-roadmap view: header with the recursive grand total, then one row
// per child runlist (its own done/total + that runlist's next pickup).
function renderRoadmap(info, maxWidth) {
  const lines = [];
  const pct = info.grandTotal > 0 ? Math.round((info.grandDone / info.grandTotal) * 100) : 0;
  const parked = info.grandParked > 0 ? `  ${dim(`${info.grandParked} parked`)}` : '';
  lines.push(`${bold(`Roadmap: ${info.doc.title || hubLabel(info.doc)}`)}   ${bold(`${info.grandDone}/${info.grandTotal}`)} ${dim(`(${pct}%)`)}${parked}`);
  if (info.children.length === 0) {
    lines.push(dim('  (no child runlists — wire runlists into related_plans:)'));
    return lines.join('\n') + '\n';
  }
  const maxSlug = Math.min(34, Math.max(...info.children.map(c => hubLabel(c.doc).length)));
  for (const c of info.children) lines.push(roadmapChildRow(c, maxSlug, maxWidth));
  return lines.join('\n') + '\n';
}

const NO_ROADMAPS = 'No roadmaps found. A roadmap is a plan with `execution_mode: roadmap` that composes runlists.\nScaffold one: dotmd new plan <name> --roadmap\n';

// `dotmd roadmaps` — the dashboard over every roadmap hub (mirrors `dotmd
// runlists`): one row per roadmap with its recursive grand total + child count.
export function runRoadmaps(index, argv, config) {
  const json = argv.includes('--json');
  const roadmaps = [...buildRoadmapIndex(index, config).values()]
    .sort((a, b) => (b.doc.daysSinceUpdate ?? 0) - (a.doc.daysSinceUpdate ?? 0));

  if (json) {
    process.stdout.write(JSON.stringify({ count: roadmaps.length, roadmaps: roadmaps.map(roadmapJson) }, null, 2) + '\n');
    return;
  }
  if (roadmaps.length === 0) {
    process.stdout.write(NO_ROADMAPS);
    return;
  }
  process.stdout.write(`\n${bold(`Roadmaps (${roadmaps.length})`)}\n`);
  const maxSlug = Math.min(34, Math.max(...roadmaps.map(r => hubLabel(r.doc).length)));
  for (const info of roadmaps) {
    const slug = hubLabel(info.doc).padEnd(maxSlug);
    const age = info.doc.daysSinceUpdate != null ? `${info.doc.daysSinceUpdate}d` : '—';
    const roll = `${info.grandDone}/${info.grandTotal}`.padStart(8);
    const kids = dim(`${info.childCount} ${info.childCount === 1 ? 'runlist' : 'runlists'}`);
    process.stdout.write(`  ${slug}  ${dim(age.padStart(4))}  ${dim(roll)}  ${kids}\n`);
  }
  process.stdout.write('\n');
}

// `dotmd roadmap [<hub>]` — the single-roadmap view. No arg: show the sole
// roadmap, or fall back to the `roadmaps` dashboard when there are several.
export function runRoadmap(index, argv, config) {
  const json = argv.includes('--json');
  const positional = argv.filter(a => !a.startsWith('-') && a !== 'next');
  const hubArg = positional[0] ?? null;

  const roadmaps = buildRoadmapIndex(index, config);

  if (hubArg) {
    const abs = resolveDocArg(hubArg, config, { dieOnMiss: false });
    if (!abs) die(`Roadmap not found: ${hubArg}`);
    const repoPath = toRepoPath(abs, config.repoRoot);
    const info = roadmaps.get(repoPath);
    if (!info) {
      die(`${repoPath} is not a roadmap hub (needs \`execution_mode: roadmap\`).\n` +
        `See \`dotmd roadmaps\` for roadmaps, or \`dotmd runlist ${hubArg}\` if it's a runlist.`);
    }
    if (json) { process.stdout.write(JSON.stringify(roadmapJson(info), null, 2) + '\n'); return; }
    process.stdout.write('\n' + renderRoadmap(info, process.stdout.columns || 100) + '\n');
    return;
  }

  if (roadmaps.size === 0) {
    if (json) { process.stdout.write(JSON.stringify({ count: 0, roadmaps: [] }, null, 2) + '\n'); return; }
    process.stdout.write(NO_ROADMAPS);
    return;
  }
  if (roadmaps.size === 1) {
    const info = [...roadmaps.values()][0];
    if (json) { process.stdout.write(JSON.stringify(roadmapJson(info), null, 2) + '\n'); return; }
    process.stdout.write('\n' + renderRoadmap(info, process.stdout.columns || 100) + '\n');
    return;
  }
  // Several roadmaps and no target named → the dashboard.
  return runRoadmaps(index, argv, config);
}

// Resolve which roadmap a `next` / pickup verb targets: an explicit hub arg, or
// the sole roadmap when there's exactly one. Dies with an actionable message
// otherwise (none → scaffold; several → name one).
function resolveRoadmapTarget(roadmaps, hubArg, config) {
  if (hubArg) {
    const abs = resolveDocArg(hubArg, config, { dieOnMiss: false });
    if (!abs) die(`Roadmap not found: ${hubArg}`);
    const info = roadmaps.get(toRepoPath(abs, config.repoRoot));
    if (!info) die(`${hubArg} is not a roadmap hub (needs \`execution_mode: roadmap\`).`);
    return info;
  }
  if (roadmaps.size === 0) die('No roadmaps found. Scaffold one: dotmd new plan <name> --roadmap');
  if (roadmaps.size > 1) {
    const listed = [...roadmaps.values()].map(r => `  ${hubLabel(r.doc)}`).join('\n');
    die(`Multiple roadmaps — name one: dotmd roadmap next <hub>\n${listed}`);
  }
  return [...roadmaps.values()][0];
}

// `dotmd roadmap [<hub>] next` — the cross-runlist next-pickup. Walk the
// roadmap's child runlists in `related_plans` (priority) order and open the FIRST
// startable plan found inside any of them — the "what do I do next across the
// whole roadmap?" verb. Each child's `nextPath` was already resolved by
// buildRoadmapIndex (sprint via its runlist order, coordination via its body
// order, a leaf-plan child = itself). When nothing is startable anywhere, list
// each child runlist with why, so the blocker is visible.
export async function runRoadmapNext(index, argv, config, opts = {}) {
  const json = argv.includes('--json');
  const hubArg = argv.find(a => !a.startsWith('-')) ?? null;
  const roadmaps = buildRoadmapIndex(index, config);
  const info = resolveRoadmapTarget(roadmaps, hubArg, config);

  const target = info.children.find(c => c.nextPath);
  if (!target) {
    const lines = info.children.map(c => {
      const state = c.total === 0 ? 'empty'
        : c.doneCount >= c.total ? 'all done'
        : c.parkedCount > 0 ? `${c.parkedCount} parked` : 'no pickup-able child';
      return `  ${hubLabel(c.doc)} (${c.doneCount}/${c.total} · ${state})`;
    }).join('\n');
    die(`No pickup-able plan across roadmap ${hubLabel(info.doc)} — every child runlist is done or parked:\n${lines}\n` +
      `Unstick one (e.g. \`dotmd set active <child>\`), or inspect a runlist: \`dotmd runlist <hub>\`.`);
  }

  if (!json) {
    process.stdout.write(dim(`roadmap ${hubLabel(info.doc)} → ${hubLabel(target.doc)} → next pickup:\n`));
  }
  const { startPlan } = await import('./lifecycle.mjs');
  const startArgs = [target.nextPath];
  if (argv.includes('--full')) startArgs.push('--full');
  if (argv.includes('--no-index')) startArgs.push('--no-index');
  if (json) startArgs.push('--json');
  await startPlan(startArgs, config, opts);
}
