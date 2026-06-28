import path from 'node:path';
import { buildIndex } from './index.mjs';
import { bold, dim, green, yellow, red } from './color.mjs';
import { buildCoordinationIndex, hubLabel } from './runlist.mjs';
import { isArchivedPath } from './util.mjs';

export function runHealth(argv, config) {
  const json = argv.includes('--json');
  const index = buildIndex(config);

  // Only plans (type: plan or untyped docs in plans root)
  const allPlans = index.docs.filter(d => d.type === 'plan' || (!d.type && d.root?.includes('plan')));
  // Coordination hubs (prose-first runlists) are navigation maps, not execution
  // units — they carry no checklist and skew active-plan aging — so lift the
  // LIVE ones out of the pipeline + active set into a dedicated Runlists tally,
  // mirroring `dotmd plans` / `dotmd runlists`. Archived hubs stay in `plans` so
  // the archived/velocity counts are unchanged. No coordination hubs → `plans`
  // equals the full set and every count below is identical to before.
  const coordination = buildCoordinationIndex(index, config);
  const closedStatuses = new Set([
    ...(config.lifecycle?.archiveStatuses ?? []),
    ...(config.lifecycle?.terminalStatuses ?? []),
  ]);
  const isLiveHub = (d) => coordination.has(d.path) && !closedStatuses.has(d.status) && !isArchivedPath(d.path, config);
  const runlistHubs = allPlans.filter(isLiveHub)
    // Most stale first — health is an aging lens, and it matches `dotmd runlists`'
    // default. Unknown-age hubs sort last so they never top the list.
    .sort((a, b) => (b.daysSinceUpdate ?? -1) - (a.daysSinceUpdate ?? -1));
  const plans = allPlans.filter(d => !isLiveHub(d));
  const now = Date.now();

  // Status distribution
  const byStatus = {};
  for (const doc of plans) {
    const s = doc.status ?? 'unknown';
    byStatus[s] = (byStatus[s] || 0) + 1;
  }

  // Active plan aging (days since created)
  const activePlans = plans.filter(d => d.status === 'active');
  const activeAges = activePlans.map(d => {
    const created = d.created ? new Date(d.created).getTime() : null;
    return created ? Math.floor((now - created) / 86400000) : null;
  }).filter(a => a !== null);

  // Recently archived (last 30 days by updated date)
  const recentlyArchived = plans
    .filter(d => d.status === 'archived' && d.updated)
    .filter(d => {
      const updated = new Date(d.updated).getTime();
      return (now - updated) < 30 * 86400000;
    });

  // Paused plan aging
  const pausedPlans = plans.filter(d => d.status === 'paused');
  const pausedAges = pausedPlans.map(d => {
    const updated = d.updated ? new Date(d.updated).getTime() : null;
    return updated ? Math.floor((now - updated) / 86400000) : null;
  }).filter(a => a !== null);

  // Blocked plan count + aging
  const blockedPlans = plans.filter(d => d.status === 'blocked');

  // Checklist progress on active plans
  const activeWithChecklists = activePlans.filter(d => d.checklist?.total > 0);
  const avgCompletion = activeWithChecklists.length > 0
    ? activeWithChecklists.reduce((sum, d) => sum + (d.checklist.completed / d.checklist.total), 0) / activeWithChecklists.length
    : null;

  // Plans with deferred items (search body — not available here, use checklist proxy)
  const readyPlans = plans.filter(d => d.status === 'ready');
  const plannedPlans = plans.filter(d => d.status === 'planned');

  if (json) {
    process.stdout.write(JSON.stringify({
      totalPlans: plans.length,
      byStatus,
      active: {
        count: activePlans.length,
        ages: activeAges,
        avgAge: activeAges.length > 0 ? Math.round(activeAges.reduce((a, b) => a + b, 0) / activeAges.length) : null,
        maxAge: activeAges.length > 0 ? Math.max(...activeAges) : null,
        avgChecklistCompletion: avgCompletion ? Math.round(avgCompletion * 100) : null,
      },
      paused: { count: pausedPlans.length, ages: pausedAges },
      blocked: { count: blockedPlans.length },
      ready: { count: readyPlans.length },
      planned: { count: plannedPlans.length },
      recentlyArchived: { count: recentlyArchived.length, last30d: recentlyArchived.map(d => path.basename(d.path, '.md')) },
      runlists: { count: runlistHubs.length, hubs: runlistHubs.map(d => ({ path: d.path, title: d.title, status: d.status, childCount: coordination.get(d.path)?.childCount ?? 0, nextPickup: coordination.get(d.path)?.nextPickup ?? null })) },
    }, null, 2) + '\n');
    return;
  }

  process.stdout.write(bold('Plan Health') + '\n\n');

  // Pipeline — ordered by the configured status vocab, then any present-but-
  // unconfigured statuses (custom ones a repo defines, by count). Deriving from
  // the live status set means in-session/partial/awaiting/etc. all show, and a
  // dead status never leaves an empty row — unlike the old hand-kept list that
  // drifted out of sync with the vocabulary.
  process.stdout.write(bold('Pipeline:') + '\n');
  const statusOrder = config.statusOrder ?? [];
  const present = Object.keys(byStatus).filter(s => byStatus[s] > 0);
  const ordered = [
    ...statusOrder.filter(s => present.includes(s)),
    ...present.filter(s => !statusOrder.includes(s)).sort((a, b) => byStatus[b] - byStatus[a]),
  ];
  const pad = Math.max(10, ...ordered.map(s => s.length));
  for (const s of ordered) {
    const count = byStatus[s];
    const bar = '█'.repeat(Math.min(count, 40));
    process.stdout.write(`  ${s.padEnd(pad)} ${String(count).padStart(4)}  ${dim(bar)}\n`);
  }
  process.stdout.write('\n');

  // Runlists (coordination hubs) — held out of the leaf-plan pipeline above and
  // surfaced as their own tally so they don't inflate the active count. Newest
  // first, mirroring `dotmd runlists`; capped with a "more" footer.
  if (runlistHubs.length > 0) {
    process.stdout.write(`${bold('Runlists:')} ${runlistHubs.length}  ${dim('· dotmd runlists')}\n`);
    for (const doc of runlistHubs.slice(0, 8)) {
      const slug = hubLabel(doc).padEnd(28);
      const age = doc.daysSinceUpdate != null ? `${doc.daysSinceUpdate}d` : '?d';
      const info = coordination.get(doc.path);
      const relStr = info?.childCount ? `  ${dim(`${info.childCount} related`)}` : '';
      const nextStr = info?.nextPickup ? `  ${green('→')} ${info.nextPickup.label}` : '';
      process.stdout.write(`  ${slug} ${dim(age.padStart(4))}${relStr}${nextStr}\n`);
    }
    if (runlistHubs.length > 8) {
      process.stdout.write(`  ${dim(`...and ${runlistHubs.length - 8} more`)}\n`);
    }
    process.stdout.write('\n');
  }

  // Active plan health
  if (activePlans.length > 0) {
    process.stdout.write(bold('Active plans:') + '\n');
    const avgAge = activeAges.length > 0 ? Math.round(activeAges.reduce((a, b) => a + b, 0) / activeAges.length) : 0;
    const maxAge = activeAges.length > 0 ? Math.max(...activeAges) : 0;
    process.stdout.write(`  Count: ${activePlans.length}  Avg age: ${avgAge}d  Max age: ${maxAge}d\n`);
    if (avgCompletion !== null) {
      process.stdout.write(`  Avg checklist: ${Math.round(avgCompletion * 100)}%\n`);
    }
    for (const doc of activePlans) {
      const age = doc.created ? Math.floor((now - new Date(doc.created).getTime()) / 86400000) : '?';
      const slug = path.basename(doc.path, '.md').padEnd(28);
      const pct = doc.checklist?.total > 0 ? `${Math.round(doc.checklist.completed / doc.checklist.total * 100)}%` : '-';
      const ageColor = age > 30 ? red(age + 'd') : age > 14 ? yellow(age + 'd') : dim(age + 'd');
      process.stdout.write(`  ${slug} ${ageColor}  checklist: ${pct}\n`);
    }
    process.stdout.write('\n');
  }

  // Paused
  if (pausedPlans.length > 0) {
    process.stdout.write(bold('Paused:') + '\n');
    for (const doc of pausedPlans) {
      const slug = path.basename(doc.path, '.md').padEnd(28);
      const age = doc.updated ? Math.floor((now - new Date(doc.updated).getTime()) / 86400000) + 'd paused' : '';
      process.stdout.write(`  ${slug} ${dim(age)}\n`);
    }
    process.stdout.write('\n');
  }

  // Velocity
  process.stdout.write(bold('Velocity (last 30d):') + '\n');
  process.stdout.write(`  Archived: ${green(String(recentlyArchived.length))} plans\n`);
  if (recentlyArchived.length > 0) {
    for (const doc of recentlyArchived.slice(0, 8)) {
      process.stdout.write(`    ${dim(path.basename(doc.path, '.md'))}\n`);
    }
    if (recentlyArchived.length > 8) {
      process.stdout.write(`    ${dim(`...and ${recentlyArchived.length - 8} more`)}\n`);
    }
  }
  process.stdout.write('\n');

  // Blocked summary
  if (blockedPlans.length > 0) {
    process.stdout.write(`${bold('Blocked:')} ${blockedPlans.length} plans\n\n`);
  }

  // Ready to promote
  if (readyPlans.length > 0) {
    process.stdout.write(`${bold('Ready to promote:')} ${readyPlans.length} plans\n\n`);
  }
}
