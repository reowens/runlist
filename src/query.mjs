import { readFileSync } from 'node:fs';
import path from 'node:path';
import { capitalize, toSlug, truncate, warn } from './util.mjs';
import { renderProgressBar } from './render.mjs';
import { computeDaysSinceUpdate, computeIsStale } from './validate.mjs';
import { getGitLastModifiedBatch } from './git.mjs';
import { extractFrontmatter } from './frontmatter.mjs';
import { summarizeDocBody } from './ai.mjs';
import { bold, dim, yellow, red, green, blue, magenta, cyan, brightYellow } from './color.mjs';

const STATUS_COLORS = {
  'in-session': (s) => bold(red(s)),
  'active': green,
  'planned': blue,
  'blocked': yellow,
  'partial': (s) => dim(green(s)),
  'paused': magenta,
  'awaiting': brightYellow,
  'queued-after': (s) => dim(cyan(s)),
  'archived': dim,
  'pending': bold,
  'claimed': dim,
};

function colorTag(status) {
  const tag = `[${(status ?? 'unknown').toUpperCase()}]`;
  const fn = STATUS_COLORS[status] ?? dim;
  return fn(tag);
}

// Strip ANSI for length math
function visibleLen(s) { return s.replace(/\x1b\[[0-9;]*m/g, '').length; }

export function runFocus(index, argv, config) {
  // Find first positional arg, skipping flag-value pairs like --root <name>
  const FLAGS_WITH_VALUES = new Set(['--root']);
  let statusFilter = 'active';
  for (let i = 0; i < argv.length; i++) {
    if (FLAGS_WITH_VALUES.has(argv[i])) { i++; continue; }
    if (argv[i].startsWith('-')) continue;
    statusFilter = argv[i];
    break;
  }

  const docs = index.docs.filter(doc => doc.status === statusFilter);

  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ status: statusFilter, count: docs.length, docs }, null, 2) + '\n');
    return;
  }

  if (docs.length === 0) {
    process.stdout.write(`No docs found for status: ${statusFilter}\n`);
    return;
  }

  process.stdout.write(`${statusFilter.toUpperCase()} Focus\n\n`);

  for (const doc of docs) {
    process.stdout.write(`- ${doc.title}\n`);
    process.stdout.write(`  path: ${doc.path}\n`);
    if (doc.currentState) process.stdout.write(`  state: ${doc.currentState}\n`);
    if (doc.nextStep) {
      process.stdout.write(`  next: ${doc.nextStep}\n`);
    }
    if (doc.blockers?.length) {
      process.stdout.write(`  blockers: ${doc.blockers.join('; ')}\n`);
    }
    if (doc.checklist?.total) {
      process.stdout.write(`  checklist: ${doc.checklist.completed}/${doc.checklist.total} complete\n`);
    }
    process.stdout.write('\n');
  }
}

export function runQuery(index, argv, config, opts = {}) {
  const filters = parseQueryArgs(argv);
  const docs = filterDocs(index.docs, filters, config);

  if (filters.json) {
    if (filters.summarize) {
      for (let i = 0; i < docs.length && i < filters.summarizeLimit; i++) {
        docs[i].aiSummary = getDocSummary(docs[i], config);
      }
    }
    process.stdout.write(`${JSON.stringify({ filters, count: docs.length, docs }, null, 2)}\n`);
    return;
  }

  if (opts.preset === 'plans' || opts.preset === 'prompts') {
    renderPlansOutput(docs, filters, config, { noun: opts.preset });
    return;
  }

  renderQueryResults(docs, filters, config);
}

export function parseQueryArgs(argv) {
  const filters = {
    types: null, statuses: null, keyword: null, owner: null, surface: null,
    module: null, domain: null, audience: null, executionMode: null,
    updatedSince: null, limit: 20, all: false, sort: 'updated',
    group: null,
    stale: false, hasNextStep: false, hasBlockers: false,
    checklistOpen: false, json: false, git: false,
    summarize: false, summarizeLimit: 5, model: undefined,
    positionalTerms: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--type' && next) { filters.types = next.split(',').map(v => v.trim()).filter(Boolean); i += 1; continue; }
    if (arg === '--status' && next) { filters.statuses = next.split(',').map(v => v.trim()).filter(Boolean); i += 1; continue; }
    if (arg === '--keyword' && next) { filters.keyword = next; i += 1; continue; }
    if (arg === '--owner' && next) { filters.owner = next; i += 1; continue; }
    if (arg === '--surface' && next) { filters.surface = next; i += 1; continue; }
    if (arg === '--module' && next) { filters.module = next; i += 1; continue; }
    if (arg === '--domain' && next) { filters.domain = next; i += 1; continue; }
    if (arg === '--audience' && next) { filters.audience = next; i += 1; continue; }
    if (arg === '--execution-mode' && next) { filters.executionMode = next; i += 1; continue; }
    if (arg === '--updated-since' && next) { filters.updatedSince = next; i += 1; continue; }
    if (arg === '--limit' && next) { filters.limit = Number.parseInt(next, 10) || 20; i += 1; continue; }
    if (arg === '--sort' && next) { filters.sort = next; i += 1; continue; }
    if (arg === '--group' && next) { filters.group = next; i += 1; continue; }
    if (arg === '--all') { filters.all = true; continue; }
    if (arg === '--include-archived') { filters.includeArchived = true; continue; }
    if (arg === '--exclude-archived') { filters.excludeArchived = true; continue; }
    if (arg === '--stale') { filters.stale = true; continue; }
    if (arg === '--has-next-step') { filters.hasNextStep = true; continue; }
    if (arg === '--has-blockers') { filters.hasBlockers = true; continue; }
    if (arg === '--checklist-open') { filters.checklistOpen = true; continue; }
    if (arg === '--json') { filters.json = true; continue; }
    if (arg === '--git') { filters.git = true; continue; }
    if (arg === '--summarize') { filters.summarize = true; continue; }
    if (arg === '--summarize-limit' && next) { filters.summarizeLimit = Number.parseInt(next, 10) || 5; i += 1; continue; }
    if (arg === '--model' && next) { filters.model = next; i += 1; continue; }

    // Positional terms: anything else that's not a flag becomes a substring
    // filter token (AND-matched against slug + title). Lets users do:
    //   dotmd plans rls          → matches rls-platform-rows, rls-location-anchored
    //   dotmd plans pii redesign → AND match: pii-data-model-redesign
    if (typeof arg === 'string' && !arg.startsWith('-')) {
      filters.positionalTerms.push(arg.toLowerCase());
    }
  }

  return filters;
}

export function filterDocs(docs, filters, config) {
  let result = [...docs];

  if (filters.types?.length) result = result.filter(d => filters.types.includes(d.type));
  if (filters.statuses?.length) result = result.filter(d => filters.statuses.includes(d.status));
  // --exclude-archived strips terminal/archive statuses unless the caller
  // explicitly opted back in with --include-archived.
  if (filters.excludeArchived && !filters.includeArchived) {
    const archived = new Set([
      ...(config.lifecycle?.archiveStatuses ?? []),
      ...(config.lifecycle?.terminalStatuses ?? []),
    ]);
    result = result.filter(d => !archived.has(d.status));
  }

  if (filters.keyword) {
    const needle = filters.keyword.toLowerCase();
    result = result.filter(d => [d.title, d.summary, d.currentState, d.nextStep, d.path, ...(d.blockers ?? [])].filter(Boolean).join(' ').toLowerCase().includes(needle));
  }

  // Positional substring filter: AND match against slug + title.
  if (filters.positionalTerms?.length) {
    result = result.filter(d => {
      const haystack = [d.path, d.title].filter(Boolean).join(' ').toLowerCase();
      return filters.positionalTerms.every(term => haystack.includes(term));
    });
  }

  if (filters.owner) { const n = filters.owner.toLowerCase(); result = result.filter(d => (d.owner ?? '').toLowerCase().includes(n)); }
  if (filters.surface) { const n = filters.surface.toLowerCase(); result = result.filter(d => (d.surfaces ?? []).some(s => s.toLowerCase() === n)); }
  if (filters.module) { const n = filters.module.toLowerCase(); result = result.filter(d => (d.modules ?? []).some(m => m.toLowerCase() === n)); }
  if (filters.domain) { const n = filters.domain.toLowerCase(); result = result.filter(d => (d.domain ?? '').toLowerCase() === n); }
  if (filters.audience) { const n = filters.audience.toLowerCase(); result = result.filter(d => (d.audience ?? '').toLowerCase() === n); }
  if (filters.executionMode) { const n = filters.executionMode.toLowerCase(); result = result.filter(d => (d.executionMode ?? '').toLowerCase() === n); }
  if (filters.updatedSince) result = result.filter(d => d.updated && d.updated >= filters.updatedSince);

  if (filters.git) {
    const gitDates = getGitLastModifiedBatch(config.repoRoot);
    for (const doc of result) {
      const gitDate = gitDates.get(doc.path) ?? null;
      if (gitDate) {
        doc.daysSinceUpdate = computeDaysSinceUpdate(gitDate);
        doc.isStale = computeIsStale(doc.status, gitDate, config);
      }
    }
  }

  if (filters.stale) result = result.filter(d => d.isStale);
  if (filters.hasNextStep) result = result.filter(d => d.hasNextStep);
  if (filters.hasBlockers) result = result.filter(d => d.hasBlockers);
  if (filters.checklistOpen) result = result.filter(d => (d.checklist?.open ?? 0) > 0);

  result.sort(buildSorter(filters.sort, config));
  // Stash pre-limit count and per-status breakdown on filters so renderers
  // can show "N more" footers and accurate pipeline summaries even when the
  // returned slice is limited.
  filters._totalBeforeLimit = result.length;
  filters._statusCounts = {};
  for (const d of result) {
    const s = d.status ?? 'unknown';
    filters._statusCounts[s] = (filters._statusCounts[s] ?? 0) + 1;
  }
  return filters.all ? result : result.slice(0, filters.limit);
}

function getDocSummary(doc, config) {
  try {
    const absPath = path.resolve(config.repoRoot, doc.path);
    const raw = readFileSync(absPath, 'utf8');
    const { body } = extractFrontmatter(raw);
    if (!body?.trim()) return null;
    const meta = { title: doc.title, status: doc.status, path: doc.path };
    return config.hooks.summarizeDoc
      ? config.hooks.summarizeDoc(body, meta)
      : summarizeDocBody(body, meta);
  } catch (err) { warn(`Could not summarize ${doc.path}: ${err.message}`); return null; }
}

function renderQueryResults(docs, filters, config) {
  process.stdout.write('Query\n\n');
  process.stdout.write(`- results: ${docs.length}\n`);
  if (filters.types?.length) process.stdout.write(`- type: ${filters.types.join(', ')}\n`);
  if (filters.statuses?.length) process.stdout.write(`- status: ${filters.statuses.join(', ')}\n`);
  if (filters.keyword) process.stdout.write(`- keyword: ${filters.keyword}\n`);
  if (filters.owner) process.stdout.write(`- owner: ${filters.owner}\n`);
  if (filters.surface) process.stdout.write(`- surface: ${filters.surface}\n`);
  if (filters.module) process.stdout.write(`- module: ${filters.module}\n`);
  if (filters.domain) process.stdout.write(`- domain: ${filters.domain}\n`);
  if (filters.audience) process.stdout.write(`- audience: ${filters.audience}\n`);
  if (filters.executionMode) process.stdout.write(`- execution-mode: ${filters.executionMode}\n`);
  if (filters.updatedSince) process.stdout.write(`- updated-since: ${filters.updatedSince}\n`);
  process.stdout.write(`- sort: ${filters.sort}\n`);
  if (filters.stale) process.stdout.write('- stale-only: true\n');
  if (filters.git) process.stdout.write('- using: git dates\n');
  if (filters.hasNextStep) process.stdout.write('- has-next-step: true\n');
  if (filters.hasBlockers) process.stdout.write('- has-blockers: true\n');
  if (filters.checklistOpen) process.stdout.write('- checklist-open: true\n');
  process.stdout.write('\n');

  if (docs.length === 0) { process.stdout.write('No matching docs.\n'); return; }

  for (let idx = 0; idx < docs.length; idx++) {
    const doc = docs[idx];
    process.stdout.write(`- ${doc.title}\n`);
    if (doc.type) process.stdout.write(`  type: ${doc.type}\n`);
    process.stdout.write(`  status: ${doc.status}\n`);
    process.stdout.write(`  updated: ${doc.updated ?? 'n/a'}\n`);
    if (doc.daysSinceUpdate != null) process.stdout.write(`  days-since-update: ${doc.daysSinceUpdate}\n`);
    process.stdout.write(`  stale: ${doc.isStale ? 'yes' : 'no'}\n`);
    process.stdout.write(`  path: ${doc.path}\n`);
    if (doc.currentState) process.stdout.write(`  state: ${doc.currentState}\n`);
    if (doc.nextStep) process.stdout.write(`  next: ${doc.nextStep}\n`);
    if (doc.owner) process.stdout.write(`  owner: ${doc.owner}\n`);
    if (doc.surfaces?.length) process.stdout.write(`  surfaces: ${doc.surfaces.join(', ')}\n`);
    if (doc.modules?.length) process.stdout.write(`  modules: ${doc.modules.join(', ')}\n`);
    if (doc.domain) process.stdout.write(`  domain: ${doc.domain}\n`);
    if (doc.audience) process.stdout.write(`  audience: ${doc.audience}\n`);
    if (doc.executionMode) process.stdout.write(`  execution-mode: ${doc.executionMode}\n`);
    if (doc.blockers?.length) process.stdout.write(`  blockers: ${doc.blockers.join('; ')}\n`);
    if (doc.checklist?.total) process.stdout.write(`  checklist: ${doc.checklist.completed}/${doc.checklist.total} complete\n`);
    if (filters.summarize && idx < filters.summarizeLimit) {
      const summary = getDocSummary(doc, config);
      if (summary) process.stdout.write(`  ${dim('ai-summary:')} ${summary}\n`);
    }
    process.stdout.write('\n');
  }
}

function buildSorter(sort, config) {
  if (sort === 'title') return (a, b) => a.title.localeCompare(b.title);
  if (sort === 'status') {
    return (a, b) => {
      const ai = config.statusOrder.indexOf(a.status); const bi = config.statusOrder.indexOf(b.status);
      const aIdx = ai === -1 ? Number.MAX_SAFE_INTEGER : ai; const bIdx = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
      if (aIdx !== bIdx) return aIdx - bIdx;
      return compareUpdatedDesc(a, b) || a.title.localeCompare(b.title);
    };
  }
  return (a, b) => compareUpdatedDesc(a, b) || a.title.localeCompare(b.title);
}

function compareUpdatedDesc(a, b) {
  const au = a.updated ?? ''; const bu = b.updated ?? '';
  return au !== bu ? bu.localeCompare(au) : 0;
}

function renderPlansOutput(docs, filters, config, opts = {}) {
  const noun = opts.noun ?? 'plans';
  if (docs.length === 0) {
    process.stdout.write(`No ${noun} found.\n`);
    return;
  }

  // Summary line: middle-dot separator, ALWAYS based on the full pre-limit
  // pipeline so the top-of-page numbers stay honest when --limit is applied.
  const totalShown = docs.length;
  const totalAll = filters._totalBeforeLimit ?? totalShown;
  const bySt = filters._statusCounts ?? (() => {
    const counts = {};
    for (const d of docs) { counts[d.status] = (counts[d.status] ?? 0) + 1; }
    return counts;
  })();
  // Sort statuses by count desc for a stable visual.
  const counts = Object.entries(bySt).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${n} ${s}`).join(' · ');
  const header = `${totalAll} ${noun}${counts ? ' · ' + counts : ''}`;
  process.stdout.write(dim(header) + '\n');

  // Active filter note
  const activeFilters = [];
  if (filters.statuses?.length) activeFilters.push(`status: ${filters.statuses.join(', ')}`);
  if (filters.module) activeFilters.push(`module: ${filters.module}`);
  if (filters.surface) activeFilters.push(`surface: ${filters.surface}`);
  if (filters.owner) activeFilters.push(`owner: ${filters.owner}`);
  if (filters.keyword) activeFilters.push(`keyword: ${filters.keyword}`);
  if (filters.stale) activeFilters.push('stale only');
  if (filters.hasNextStep) activeFilters.push('has next step');
  if (filters.hasBlockers) activeFilters.push('has blockers');
  if (activeFilters.length) process.stdout.write(dim(`  filtered: ${activeFilters.join(' | ')}`) + '\n');

  const maxWidth = process.stdout.columns || 100;
  const grouped = filters.sort === 'status' || filters.group;

  if (filters.group === 'module') {
    process.stdout.write('\n');
    renderPlansByGroup(docs, d => d.modules?.length ? d.modules : ['(none)'], filters, maxWidth);
  } else if (filters.group === 'surface') {
    process.stdout.write('\n');
    renderPlansByGroup(docs, d => d.surfaces?.length ? d.surfaces : ['(none)'], filters, maxWidth);
  } else if (filters.group === 'owner') {
    process.stdout.write('\n');
    renderPlansByGroup(docs, d => [d.owner ?? '(none)'], filters, maxWidth);
  } else if (grouped) {
    // Pipeline view: group by status, ordered by config.statusOrder. Tag is implicit.
    const statusGroups = new Map();
    for (const d of docs) {
      const s = d.status ?? 'unknown';
      if (!statusGroups.has(s)) statusGroups.set(s, []);
      statusGroups.get(s).push(d);
    }
    const orderedStatuses = [...config.statusOrder.filter(s => statusGroups.has(s)), ...([...statusGroups.keys()].filter(s => !config.statusOrder.includes(s)))];
    for (const status of orderedStatuses) {
      const group = statusGroups.get(status);
      process.stdout.write(`\n${bold(`${capitalize(status)} (${group.length})`)}\n`);
      renderPlanRows(group, filters, maxWidth, { showTag: false });
    }
  } else {
    // Triage view: flat, sorted by recency, tag on right.
    process.stdout.write('\n');
    renderPlanRows(docs, filters, maxWidth, { showTag: true });
    // Footer when the result was capped.
    const hidden = totalAll - totalShown;
    if (hidden > 0) {
      process.stdout.write('\n');
      process.stdout.write(dim(`  ${hidden} more ${noun}  ·  dotmd ${noun} --all  ·  dotmd ${noun} status\n`));
    }
  }

  process.stdout.write('\n');
}

function renderPlansByGroup(docs, keyFn, filters, maxWidth) {
  const groups = new Map();
  for (const d of docs) {
    for (const key of keyFn(d)) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }
  }

  const ordered = [...groups.keys()].sort((a, b) => a === '(none)' ? 1 : b === '(none)' ? -1 : a.localeCompare(b));
  for (const key of ordered) {
    const group = groups.get(key);
    process.stdout.write(`\n${bold(`${key} (${group.length})`)}\n`);
    renderPlanRows(group, filters, maxWidth);
  }
}

// Widest tag we render (status name in CAPS + brackets). Used to budget the
// next-step column when right-aligning tags.
const MAX_TAG_WIDTH = '[QUEUED-AFTER]'.length;

function renderPlanRows(group, filters, maxWidth, opts = {}) {
  const { showTag = false } = opts;
  const maxSlug = Math.min(30, Math.max(...group.map(d => toSlug(d).length)));

  for (const doc of group) {
    const slug = toSlug(doc).padEnd(maxSlug);
    const age = doc.daysSinceUpdate != null ? `${doc.daysSinceUpdate}d` : '—';
    const ageStr = doc.daysSinceUpdate != null && doc.isStale ? red(age.padStart(4)) : dim(age.padStart(4));

    // Compact percentage cell (always 5 chars: "100% " / " 99% " / "  5% " / "     ")
    let pctCell = '     ';
    if (doc.checklist?.total) {
      const pct = Math.round((doc.checklist.completed / doc.checklist.total) * 100);
      pctCell = `${pct.toString().padStart(3)}% `;
    }

    const leftBlock = `  ${slug}  ${ageStr}  ${dim(pctCell)}`;
    const leftLen = visibleLen(leftBlock);

    // Next-step / blocker text. Budget = maxWidth - leftLen - separator - (tag column if shown).
    let nextText = '';
    if (doc.blockers?.length && doc.status === 'blocked') {
      nextText = `blocked by ${doc.blockers.join('; ')}`;
    } else if (doc.nextStep) {
      nextText = doc.nextStep;
    }

    const tagBudget = showTag ? MAX_TAG_WIDTH + 2 : 0; // 2 = gap before tag
    const nextBudget = Math.max(10, maxWidth - leftLen - 2 - tagBudget); // -2 for `  ` separator
    let nextRendered = nextText;
    if (nextText.length > nextBudget) nextRendered = nextText.slice(0, nextBudget - 3) + '...';

    // Coloring for "blocked by" stays yellow.
    if (doc.blockers?.length && doc.status === 'blocked') nextRendered = yellow(nextRendered);

    let line = `${leftBlock}  ${nextRendered}`;
    if (showTag) {
      // Pad next column to push tag to the right column boundary.
      const consumed = visibleLen(line);
      const targetCol = maxWidth - MAX_TAG_WIDTH;
      const padCount = Math.max(2, targetCol - consumed);
      line = `${line}${' '.repeat(padCount)}${colorTag(doc.status)}`;
    }
    process.stdout.write(line + '\n');
  }
}
