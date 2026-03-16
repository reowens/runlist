import { capitalize, toSlug, truncate, warn } from './util.mjs';
import { bold, red, yellow, green } from './color.mjs';

export function renderCompactList(index, config) {
  const defaultRenderer = (idx) => _renderCompactList(idx, config);
  if (config.hooks.renderCompactList) {
    try { return config.hooks.renderCompactList(index, defaultRenderer); }
    catch (err) { warn(`Hook 'renderCompactList' threw: ${err.message}`); }
  }
  return defaultRenderer(index);
}

function _renderCompactList(index, config) {
  const lines = ['Index', ''];
  const maxWidth = config.display.lineWidth || process.stdout.columns || 120;

  for (const status of config.statusOrder) {
    const docs = index.docs.filter(d => d.status === status);
    if (!docs.length) continue;

    lines.push(bold(`${capitalize(status)} (${docs.length})`));
    const maxTitle = Math.min(config.display.truncateTitle || 30, Math.max(...docs.map(d => d.title.length)));

    for (const doc of docs) {
      const title = doc.title.length > maxTitle
        ? doc.title.slice(0, maxTitle - 3) + '...'
        : doc.title.padEnd(maxTitle);
      const days = doc.daysSinceUpdate != null ? `${doc.daysSinceUpdate}d` : '';
      const progress = renderProgressBar(doc.checklist);
      const next = doc.nextStep ? `next: ${doc.nextStep}` : '';
      const parts = [`  ${title}  ${days.padStart(4)}`];
      if (progress) parts.push(progress);
      if (next) parts.push(next);
      const line = parts.join('  ');
      lines.push(line.length > maxWidth ? line.slice(0, maxWidth - 3) + '...' : line);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderVerboseList(index, config) {
  const lines = ['Index', ''];

  for (const status of config.statusOrder) {
    const docs = index.docs.filter(doc => doc.status === status);
    if (docs.length === 0) continue;

    lines.push(`${capitalize(status)} (${docs.length})`);
    for (const doc of docs) {
      const parts = [`- ${doc.title}`, `${capitalize(status)}: ${doc.currentState}`, `(${doc.path})`];
      if (doc.nextStep) {
        parts.push(`next: ${doc.nextStep}`);
      }
      lines.push(parts.join(' — '));
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderContext(index, config) {
  const defaultRenderer = (idx) => _renderContext(idx, config);
  if (config.hooks.renderContext) {
    try { return config.hooks.renderContext(index, defaultRenderer); }
    catch (err) { warn(`Hook 'renderContext' threw: ${err.message}`); }
  }
  return defaultRenderer(index);
}

function _renderContext(index, config) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [`BRIEFING (${today})`, ''];
  const ctx = config.context;

  const byStatus = {};
  for (const status of config.statusOrder) {
    byStatus[status] = index.docs.filter(d => d.status === status);
  }

  for (const status of (ctx.expanded || [])) {
    const docs = byStatus[status];
    if (!docs?.length) continue;
    lines.push(bold(`${capitalize(status)} (${docs.length}):`));
    const maxSlug = Math.min(24, Math.max(...docs.map(d => toSlug(d).length)));
    for (const doc of docs) {
      const slug = toSlug(doc).padEnd(maxSlug);
      const next = doc.nextStep
        ? truncate(doc.nextStep, ctx.truncateNextStep || 80)
        : '(no next step)';
      lines.push(`  ${slug}  next: ${next}`);
    }
    lines.push('');
  }

  for (const status of (ctx.listed || [])) {
    const docs = byStatus[status];
    if (!docs?.length) continue;
    lines.push(`${capitalize(status)} (${docs.length}): ${docs.map(toSlug).join(', ')}`);
  }

  const counts = (ctx.counted || [])
    .filter(s => byStatus[s]?.length)
    .map(s => `${capitalize(s)} (${byStatus[s].length})`);
  if (counts.length) {
    lines.push(counts.join('  |  '));
  }
  lines.push('');

  const stale = index.docs.filter(d => d.isStale && !config.lifecycle.skipStaleFor.has(d.status));
  if (stale.length) {
    lines.push(`Stale: ${stale.map(d => `${toSlug(d)} (${d.daysSinceUpdate}d)`).join(', ')}`);
  } else {
    lines.push('Stale: none');
  }

  const withErrors = index.docs.filter(d => d.errors.length > 0 && !config.lifecycle.skipWarningsFor.has(d.status));
  const withWarnings = index.docs.filter(d => d.warnings.length > 0 && !config.lifecycle.skipWarningsFor.has(d.status));
  if (withErrors.length || withWarnings.length) {
    const parts = [];
    if (withErrors.length) parts.push(`${withErrors.length} with errors`);
    if (withWarnings.length) parts.push(`${withWarnings.length} with warnings`);
    lines.push(`Non-compliant: ${parts.join(', ')} (run \`dotmd check\` for details)`);
  }

  const recentStatuses = new Set(ctx.recentStatuses || ['active', 'ready', 'planned']);
  const recentDays = ctx.recentDays ?? 3;
  const recentLimit = ctx.recentLimit ?? 10;
  const recent = index.docs
    .filter(d => d.daysSinceUpdate != null && d.daysSinceUpdate <= recentDays && recentStatuses.has(d.status))
    .sort((a, b) => (a.daysSinceUpdate ?? 99) - (b.daysSinceUpdate ?? 99))
    .slice(0, recentLimit);
  if (recent.length) {
    const items = recent.map(d => {
      const label = d.daysSinceUpdate === 0 ? 'today' : `${d.daysSinceUpdate}d ago`;
      return `${toSlug(d)} (${label})`;
    });
    lines.push(`Recently updated: ${items.join(', ')}`);
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderCheck(index, config, opts = {}) {
  const defaultRenderer = (idx) => _renderCheck(idx, opts);
  if (config.hooks.renderCheck) {
    try { return config.hooks.renderCheck(index, defaultRenderer); }
    catch (err) { warn(`Hook 'renderCheck' threw: ${err.message}`); }
  }
  return defaultRenderer(index);
}

function _renderCheck(index, opts = {}) {
  const { errorsOnly } = opts;
  const lines = ['Check', ''];
  lines.push(`- docs scanned: ${index.docs.length}`);
  lines.push(`- errors: ${index.errors.length}`);
  lines.push(`- warnings: ${index.warnings.length}`);
  lines.push('');

  if (index.errors.length > 0) {
    lines.push(red('Errors'));
    for (const issue of index.errors) {
      lines.push(`- ${issue.path}: ${issue.message}`);
    }
    lines.push('');
  }

  if (!errorsOnly && index.warnings.length > 0) {
    lines.push(yellow('Warnings'));
    for (const issue of index.warnings) {
      lines.push(`- ${issue.path}: ${issue.message}`);
    }
    lines.push('');
  }

  if (index.errors.length === 0 && index.warnings.length === 0) {
    lines.push(green('No issues found.'));
  } else if (index.errors.length === 0) {
    lines.push(green('Check passed with warnings.'));
  } else {
    lines.push(red('Check failed.'));
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderCoverage(index, config) {
  const coverage = buildCoverage(index, config);
  const lines = ['Coverage', ''];
  lines.push(`- scoped docs: ${coverage.totals.scopedDocs}`);
  lines.push(`- missing surface: ${coverage.totals.missingSurface}`);
  lines.push(`- missing module: ${coverage.totals.missingModule}`);
  lines.push(`- module:platform: ${coverage.totals.modulePlatform}`);
  lines.push(`- module:none: ${coverage.totals.moduleNone}`);
  lines.push(`- audit_level:none: ${coverage.totals.auditLevelNone}`);
  lines.push(`- audited (pass1/pass2/deep): ${coverage.totals.audited}`);
  lines.push('');

  for (const [label, list] of [['Missing surface', coverage.missingSurface], ['Missing module', coverage.missingModule], ['module:platform', coverage.modulePlatform], ['module:none', coverage.moduleNone], ['audit_level:none', coverage.auditLevelNone]]) {
    if (list.length) {
      lines.push(label);
      for (const doc of list) lines.push(`- ${doc.path}`);
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function buildCoverage(index, config) {
  const scope = ['active', 'ready', 'planned', 'blocked'];
  const scoped = index.docs.filter(doc => scope.includes(doc.status));
  const missingSurface = scoped.filter(doc => !doc.surface);
  const missingModule = scoped.filter(doc => !doc.module);
  const modulePlatform = scoped.filter(doc => doc.module === 'platform');
  const moduleNone = scoped.filter(doc => doc.module === 'none');
  const auditLevelNone = scoped.filter(doc => doc.auditLevel === 'none');
  const audited = scoped.filter(doc => ['pass1', 'pass2', 'deep'].includes(doc.auditLevel));

  return {
    generatedAt: index.generatedAt, scope,
    totals: { scopedDocs: scoped.length, missingSurface: missingSurface.length, missingModule: missingModule.length, modulePlatform: modulePlatform.length, moduleNone: moduleNone.length, auditLevelNone: auditLevelNone.length, audited: audited.length },
    missingSurface, missingModule, modulePlatform, moduleNone, auditLevelNone, audited,
  };
}

export function renderProgressBar(checklist) {
  if (!checklist?.total) return '';
  const ratio = checklist.completed / checklist.total;
  const filled = Math.round(ratio * 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  return `${bar} ${checklist.completed}/${checklist.total}`;
}

export function formatSnapshot(doc, config) {
  const defaultFormatter = (d) => _formatSnapshot(d);
  if (config.hooks.formatSnapshot) {
    try { return config.hooks.formatSnapshot(doc, defaultFormatter); }
    catch (err) { warn(`Hook 'formatSnapshot' threw: ${err.message}`); }
  }
  return defaultFormatter(doc);
}

function _formatSnapshot(doc) {
  const state = doc.currentState ?? 'No current_state set';
  if (/^active:|^ready:|^planned:|^research:|^blocked:|^archived:/i.test(state)) {
    return state;
  }
  return `${capitalize(doc.status ?? 'unknown')}: ${state}`;
}
