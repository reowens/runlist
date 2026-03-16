import { capitalize, toSlug, warn } from './util.mjs';
import { bold, dim } from './color.mjs';

function pct(n, total) {
  if (!total) return 0;
  return Math.round((n / total) * 100);
}

export function buildStats(index, config) {
  const docs = index.docs;
  const scope = ['active', 'ready', 'planned', 'blocked'];
  const scoped = docs.filter(d => scope.includes(d.status));
  const nonArchived = docs.filter(d => !config.lifecycle.skipWarningsFor.has(d.status));

  // Health
  const staleCount = nonArchived.filter(d => d.isStale).length;
  const brokenRefCount = index.errors.filter(e => e.message.includes('does not resolve to an existing file')).length;
  const brokenLinkCount = index.warnings.filter(w => w.message.startsWith('body link')).length;

  // Freshness
  const withDays = nonArchived.filter(d => d.daysSinceUpdate != null);
  const sorted = [...withDays].sort((a, b) => (b.daysSinceUpdate ?? 0) - (a.daysSinceUpdate ?? 0));
  const oldest = sorted[0] ?? null;

  // Checklists
  const withChecklists = docs.filter(d => d.checklist?.total > 0);
  const avgCompletion = withChecklists.length > 0
    ? Math.round(withChecklists.reduce((sum, d) => sum + (d.checklistCompletionRate ?? 0), 0) / withChecklists.length * 100)
    : 0;
  const fullyComplete = withChecklists.filter(d => d.checklistCompletionRate === 1).length;
  const withOpenItems = withChecklists.filter(d => d.checklist.open > 0).length;

  // Audit
  const auditCounts = { pass1: 0, pass2: 0, deep: 0 };
  for (const d of scoped) {
    if (auditCounts[d.auditLevel] !== undefined) auditCounts[d.auditLevel]++;
  }
  const auditedCount = auditCounts.pass1 + auditCounts.pass2 + auditCounts.deep;

  return {
    generatedAt: new Date().toISOString(),
    totalDocs: docs.length,
    countsByStatus: index.countsByStatus,
    health: {
      staleCount,
      stalePct: pct(staleCount, nonArchived.length),
      nonArchivedCount: nonArchived.length,
      errorCount: index.errors.length,
      warningCount: index.warnings.length,
      brokenRefCount,
      brokenLinkCount,
    },
    freshness: {
      today: docs.filter(d => d.daysSinceUpdate === 0).length,
      thisWeek: docs.filter(d => d.daysSinceUpdate != null && d.daysSinceUpdate <= 7).length,
      thisMonth: docs.filter(d => d.daysSinceUpdate != null && d.daysSinceUpdate <= 30).length,
      oldest: oldest ? { path: oldest.path, slug: toSlug(oldest), daysSinceUpdate: oldest.daysSinceUpdate } : null,
    },
    completeness: {
      scoped: scoped.length,
      hasOwner: scoped.filter(d => d.owner).length,
      hasSurface: scoped.filter(d => d.surface).length,
      hasModule: scoped.filter(d => d.module).length,
      hasNextStep: scoped.filter(d => d.hasNextStep).length,
    },
    checklists: {
      docsWithChecklists: withChecklists.length,
      avgCompletion,
      fullyComplete,
      withOpenItems,
    },
    audit: {
      audited: auditedCount,
      ...auditCounts,
    },
  };
}

// ── Text renderer ──────────────────────────────────────────────────────

export function renderStats(stats, config) {
  const defaultRenderer = (s) => _renderStats(s, config);
  if (config.hooks.renderStats) {
    try { return config.hooks.renderStats(stats, defaultRenderer); }
    catch (err) { warn(`Hook 'renderStats' threw: ${err.message}`); }
  }
  return defaultRenderer(stats);
}

function _renderStats(stats, config) {
  const lines = [];
  lines.push(bold(`Stats`) + dim(` — ${stats.totalDocs} docs`));
  lines.push('');

  // Status
  lines.push(bold('Status'));
  const statusParts = config.statusOrder
    .filter(s => stats.countsByStatus[s])
    .map(s => `${s}: ${stats.countsByStatus[s]}`);
  lines.push('  ' + statusParts.join('  '));
  lines.push('');

  // Health
  const h = stats.health;
  lines.push(bold('Health'));
  lines.push(`  stale: ${h.staleCount}/${h.nonArchivedCount} (${h.stalePct}%)`);
  lines.push(`  errors: ${h.errorCount}`);
  lines.push(`  warnings: ${h.warningCount}`);
  if (h.brokenRefCount) lines.push(`  broken refs: ${h.brokenRefCount}`);
  if (h.brokenLinkCount) lines.push(`  broken links: ${h.brokenLinkCount}`);
  lines.push('');

  // Freshness
  const f = stats.freshness;
  lines.push(bold('Freshness'));
  lines.push(`  updated today: ${f.today}    this week: ${f.thisWeek}    this month: ${f.thisMonth}`);
  if (f.oldest) {
    lines.push(`  oldest: ${f.oldest.slug} (${f.oldest.daysSinceUpdate}d)`);
  }
  lines.push('');

  // Completeness
  const c = stats.completeness;
  if (c.scoped > 0) {
    lines.push(bold('Completeness') + dim(' (active/ready/planned/blocked)'));
    lines.push(`  has owner: ${c.hasOwner}/${c.scoped} (${pct(c.hasOwner, c.scoped)}%)`);
    lines.push(`  has surface: ${c.hasSurface}/${c.scoped} (${pct(c.hasSurface, c.scoped)}%)`);
    lines.push(`  has module: ${c.hasModule}/${c.scoped} (${pct(c.hasModule, c.scoped)}%)`);
    lines.push(`  has next_step: ${c.hasNextStep}/${c.scoped} (${pct(c.hasNextStep, c.scoped)}%)`);
    lines.push('');
  }

  // Checklists
  const cl = stats.checklists;
  if (cl.docsWithChecklists > 0) {
    lines.push(bold('Checklists'));
    lines.push(`  docs with checklists: ${cl.docsWithChecklists}`);
    lines.push(`  avg completion: ${cl.avgCompletion}%`);
    lines.push(`  fully complete: ${cl.fullyComplete}    open items: ${cl.withOpenItems}`);
    lines.push('');
  }

  // Audit
  const a = stats.audit;
  if (c.scoped > 0) {
    lines.push(bold('Audit'));
    lines.push(`  audited: ${a.audited}/${c.scoped} (${pct(a.audited, c.scoped)}%)`);
    if (a.audited > 0) {
      lines.push(`  pass1: ${a.pass1}  pass2: ${a.pass2}  deep: ${a.deep}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

// ── JSON renderer ──────────────────────────────────────────────────────

export function renderStatsJson(stats) {
  return JSON.stringify(stats, null, 2) + '\n';
}
