import { readFileSync } from 'node:fs';
import path from 'node:path';
import { capitalize, toSlug, truncate, warn } from './util.mjs';
import { extractFrontmatter } from './frontmatter.mjs';
import { summarizeDocBody } from './ai.mjs';
import { bold, red, yellow, green, dim } from './color.mjs';

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

  // Render docs with statuses not in statusOrder
  const knownStatuses = new Set(config.statusOrder);
  const otherStatuses = [...new Set(index.docs.filter(d => d.status && !knownStatuses.has(d.status)).map(d => d.status))].sort();
  for (const status of otherStatuses) {
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

  // Render docs with statuses not in statusOrder
  const knownStatuses = new Set(config.statusOrder);
  const otherStatuses = [...new Set(index.docs.filter(d => d.status && !knownStatuses.has(d.status)).map(d => d.status))].sort();
  for (const status of otherStatuses) {
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

export function renderContext(index, config, opts = {}) {
  const defaultRenderer = (idx) => _renderContext(idx, config, opts);
  if (config.hooks.renderContext) {
    try { return config.hooks.renderContext(index, defaultRenderer); }
    catch (err) { warn(`Hook 'renderContext' threw: ${err.message}`); }
  }
  return defaultRenderer(index);
}

function _renderContextSection(docs, ctx, opts, config, lines) {
  const byStatus = {};
  for (const doc of docs) {
    const s = doc.status ?? 'unknown';
    if (!byStatus[s]) byStatus[s] = [];
    byStatus[s].push(doc);
  }

  for (const status of (ctx.expanded || [])) {
    const sdocs = byStatus[status];
    if (!sdocs?.length) continue;
    lines.push(bold(`${capitalize(status)} (${sdocs.length}):`));
    const maxSlug = Math.min(24, Math.max(...sdocs.map(d => toSlug(d).length)));
    for (const doc of sdocs) {
      const slug = toSlug(doc).padEnd(maxSlug);
      const age = doc.created ? Math.floor((Date.now() - new Date(doc.created).getTime()) / 86400000) : null;
      const ageTag = age !== null ? dim(` (${age}d)`) : '';
      const next = doc.nextStep
        ? truncate(doc.nextStep, ctx.truncateNextStep || 80)
        : '(no next step)';
      lines.push(`  ${slug}${ageTag}  next: ${next}`);
      if (opts.summarize) {
        try {
          const absPath = path.resolve(config.repoRoot, doc.path);
          const raw = readFileSync(absPath, 'utf8');
          const { body } = extractFrontmatter(raw);
          const meta = { title: doc.title, status: doc.status, path: doc.path };
          const summary = config.hooks.summarizeDoc
            ? config.hooks.summarizeDoc(body, meta)
            : summarizeDocBody(body, meta, { model: opts.model });
          if (summary) {
            lines.push(`  ${''.padEnd(maxSlug)}  ${dim('ai: ' + truncate(summary, 120))}`);
          }
        } catch (err) { warn(`AI summary failed for ${doc.path}: ${err.message}`); }
      }
    }
    lines.push('');
  }

  for (const status of (ctx.listed || [])) {
    const sdocs = byStatus[status];
    if (!sdocs?.length) continue;
    lines.push(`${capitalize(status)} (${sdocs.length}): ${sdocs.map(toSlug).join(', ')}`);
  }

  const counts = (ctx.counted || [])
    .filter(s => byStatus[s]?.length)
    .map(s => `${capitalize(s)} (${byStatus[s].length})`);
  if (counts.length) {
    lines.push(counts.join('  |  '));
  }
}

function _renderContext(index, config, opts = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [`BRIEFING (${today})`, ''];

  // Group docs by type
  const typeOrder = ['plan', 'doc', 'research'];
  const byType = {};
  const untyped = [];
  for (const doc of index.docs) {
    if (doc.type) {
      if (!byType[doc.type]) byType[doc.type] = [];
      byType[doc.type].push(doc);
    } else {
      untyped.push(doc);
    }
  }

  const hasTypedDocs = Object.keys(byType).length > 0;
  const typeLabels = { plan: 'PLANS', doc: 'DOCS', research: 'RESEARCH' };

  if (hasTypedDocs) {
    for (const typeName of typeOrder) {
      const docs = byType[typeName];
      if (!docs?.length) continue;
      const typeCtx = config.typeContextConfig?.get(typeName) ?? config.context;
      lines.push(bold(typeLabels[typeName] ?? typeName.toUpperCase()));
      _renderContextSection(docs, typeCtx, opts, config, lines);
      lines.push('');
    }
    // Any types not in typeOrder
    for (const typeName of Object.keys(byType)) {
      if (typeOrder.includes(typeName)) continue;
      const docs = byType[typeName];
      if (!docs?.length) continue;
      const typeCtx = config.typeContextConfig?.get(typeName) ?? config.context;
      lines.push(bold(typeName.toUpperCase()));
      _renderContextSection(docs, typeCtx, opts, config, lines);
      lines.push('');
    }
  }

  // Render untyped docs (backward compat) or all docs if no types present
  if (untyped.length > 0) {
    if (hasTypedDocs) lines.push(bold('OTHER'));
    _renderContextSection(untyped, config.context, opts, config, lines);
    lines.push('');
  } else if (!hasTypedDocs) {
    // No types at all — fall back to original flat rendering
    _renderContextSection(index.docs, config.context, opts, config, lines);
    lines.push('');
  }

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

  const ctx = config.context;
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

export function renderBriefing(index, config) {
  const lines = [];
  const plans = index.docs.filter(d => d.type === 'plan');
  const docs = index.docs.filter(d => d.type === 'doc');
  const research = index.docs.filter(d => d.type === 'research');
  const untyped = index.docs.filter(d => !d.type);

  if (plans.length) {
    const bySt = {};
    for (const p of plans) { bySt[p.status] = (bySt[p.status] ?? 0) + 1; }
    const counts = Object.entries(bySt).map(([s, n]) => `${n} ${s}`).join(', ');
    lines.push(`${plans.length} plans: ${counts}`);
    const show = plans.filter(p => p.status === 'in-session' || p.status === 'active');
    for (const p of show) {
      const next = p.nextStep ? `next: ${p.nextStep}` : '(no next step)';
      lines.push(`  > ${path.basename(p.path, '.md')} (${p.status}) ${next}`);
    }
  }

  const parts = [];
  if (docs.length) {
    const active = docs.filter(d => !config.lifecycle.terminalStatuses.has(d.status)).length;
    const rest = docs.length - active;
    parts.push(`${active} docs active` + (rest ? `, ${rest} other` : ''));
  }
  if (research.length) {
    const active = research.filter(d => d.status === 'active').length;
    parts.push(`${active} research active`);
  }
  if (untyped.length) parts.push(`${untyped.length} untyped`);
  if (parts.length) lines.push(parts.join(' | '));

  const stale = index.docs.filter(d => d.isStale && !config.lifecycle.skipStaleFor.has(d.status)).length;
  lines.push(`Stale: ${stale} | Errors: ${index.errors.length} | Warnings: ${index.warnings.length}`);

  return lines.join('\n') + '\n';
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
  const scope = [...new Set(index.docs.map(d => d.status).filter(s => s && !config.lifecycle.terminalStatuses.has(s) && !config.lifecycle.skipWarningsFor.has(s)))];
  const scoped = index.docs.filter(doc => doc.status && !config.lifecycle.terminalStatuses.has(doc.status) && !config.lifecycle.skipWarningsFor.has(doc.status));
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
