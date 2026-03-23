import path from 'node:path';
import { buildIndex } from './index.mjs';
import { bold, dim, green, yellow, red } from './color.mjs';

export function runHealth(argv, config) {
  const json = argv.includes('--json');
  const index = buildIndex(config);

  // Only plans (type: plan or untyped docs in plans root)
  const plans = index.docs.filter(d => d.type === 'plan' || (!d.type && d.root?.includes('plan')));
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
    }, null, 2) + '\n');
    return;
  }

  process.stdout.write(bold('Plan Health') + '\n\n');

  // Pipeline
  process.stdout.write(bold('Pipeline:') + '\n');
  const pipeline = ['active', 'paused', 'ready', 'planned', 'blocked', 'research', 'archived'];
  for (const s of pipeline) {
    const count = byStatus[s] || 0;
    if (count > 0) {
      const bar = '█'.repeat(Math.min(count, 40));
      process.stdout.write(`  ${s.padEnd(10)} ${String(count).padStart(4)}  ${dim(bar)}\n`);
    }
  }
  process.stdout.write('\n');

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
