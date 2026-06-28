import { readFileSync } from 'node:fs';
import path from 'node:path';
import { capitalize, toSlug, truncate, warn, die, suggestCandidates, isArchivedPath } from './util.mjs';
import { renderProgressBar, formatCurrentState } from './render.mjs';
import { computeDaysSinceUpdate, computeIsStale } from './validate.mjs';
import { getGitLastModifiedBatch } from './git.mjs';
import { extractFrontmatter } from './frontmatter.mjs';
import { summarizeDocBody } from './ai.mjs';
import { bold, dim, yellow, red, green, blue, magenta, cyan, brightYellow } from './color.mjs';
import { buildRunlistIndex, buildCoordinationIndex } from './runlist.mjs';

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
    const stateValue = formatCurrentState(doc);
    if (stateValue) process.stdout.write(`  state: ${stateValue}\n`);
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
  if (filters.body && !filters.keyword) {
    die('`--body` extends a keyword search into document bodies — pass `--keyword <term>` (or use `dotmd grep <term>`).');
  }
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
    // Runlist folding only applies to plans (prompts have no runlists).
    const runlist = opts.preset === 'plans' ? buildRunlistIndex(index, config) : null;
    const coordination = opts.preset === 'plans' ? buildCoordinationIndex(index, config) : null;
    renderPlansOutput(docs, filters, config, { noun: opts.preset, runlist, coordination });
    if (docs.length === 0) writeUnknownFilterValueHint(filters, index);
    return;
  }

  renderQueryResults(docs, filters, config);
  if (docs.length === 0) writeUnknownFilterValueHint(filters, index);
}

// `dotmd runlists` — the dedicated coordination-hub dashboard: the `Runlists`
// section from `dotmd plans`, on its own, showing every hub (no leaf list, no
// cap by default — runlists are a small bounded set). `--limit N` caps it,
// `--json` emits structured rows.
export function runRunlists(index, argv, config) {
  const json = argv.includes('--json');
  let limit = Infinity;
  const li = argv.indexOf('--limit');
  if (li >= 0 && argv[li + 1]) { const n = Number.parseInt(argv[li + 1], 10); if (Number.isFinite(n)) limit = n; }

  const coordination = buildCoordinationIndex(index, config);
  const archived = new Set([
    ...(config.lifecycle?.archiveStatuses ?? []),
    ...(config.lifecycle?.terminalStatuses ?? []),
  ]);
  const hubs = index.docs
    .filter(d => coordination.has(d.path) && !archived.has(d.status) && !isArchivedPath(d.path, config))
    .sort((a, b) => (a.daysSinceUpdate ?? Infinity) - (b.daysSinceUpdate ?? Infinity));

  if (json) {
    const runlists = hubs.map(d => ({
      path: d.path,
      status: d.status,
      title: d.title,
      childCount: coordination.get(d.path)?.childCount ?? 0,
      updated: d.updated,
      nextStep: d.nextStep ?? null,
    }));
    process.stdout.write(JSON.stringify({ count: runlists.length, runlists }, null, 2) + '\n');
    return;
  }

  if (hubs.length === 0) {
    process.stdout.write('No runlists found. A runlist is a plan with `execution_mode: coordination` (or a `*-runlist` slug).\n');
    return;
  }

  const maxWidth = process.stdout.columns || 100;
  const shown = hubs.slice(0, limit);
  renderCoordinationSection(shown, coordination, maxWidth, hubs.length);
  const hidden = hubs.length - shown.length;
  if (hidden > 0) process.stdout.write(dim(`  ${hidden} more  ·  dotmd runlists --limit ${hubs.length}\n`));
  process.stdout.write('\n');
}

// When a query returns nothing AND a value-shaped filter (currently --module)
// names a value that doesn't exist anywhere in the index, the empty result is
// almost certainly a typo rather than a combination miss. Surface a hint so
// the agent doesn't have to grep modules to discover the right spelling.
function writeUnknownFilterValueHint(filters, index) {
  if (filters.module) {
    const allModules = new Set();
    for (const d of index.docs) {
      for (const m of (d.modules ?? [])) allModules.add(m);
    }
    const exists = [...allModules].some(m => m.toLowerCase() === filters.module.toLowerCase());
    if (!exists) {
      const suggestions = suggestCandidates(filters.module, [...allModules]);
      const hint = suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : '';
      process.stdout.write(dim(`No module \`${filters.module}\` in index.${hint}`) + '\n');
    }
  }
}

export function parseQueryArgs(argv) {
  const filters = {
    types: null, statuses: null, keyword: null, body: false, owner: null, surface: null,
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
    if (arg === '--body') { filters.body = true; continue; }
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
  // --exclude-archived strips terminal/archive statuses AND any file physically
  // located under `archiveDir/` (issue #13: status can drift out of sync with
  // the file's directory; the path is the source of truth for "is archived").
  if (filters.excludeArchived && !filters.includeArchived) {
    const archived = new Set([
      ...(config.lifecycle?.archiveStatuses ?? []),
      ...(config.lifecycle?.terminalStatuses ?? []),
    ]);
    result = result.filter(d => !archived.has(d.status) && !isArchivedPath(d.path, config));
  }

  const keywordNeedle = filters.keyword ? filters.keyword.toLowerCase() : null;
  const matchesFrontmatter = d => [d.title, d.summary, d.currentState, d.nextStep, d.path, ...(d.blockers ?? [])].filter(Boolean).join(' ').toLowerCase().includes(keywordNeedle);
  // With --body the keyword filter is deferred to after the cheap frontmatter
  // filters (below) so body files are only read for surviving candidates.
  if (keywordNeedle && !filters.body) {
    result = result.filter(matchesFrontmatter);
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

  // Lazy body scan: docs already matching on frontmatter fields keep their spot
  // without a file read; only the rest get their bodies scanned. Hits carry
  // 1-2 matching-line excerpts so the caller can rank without opening files.
  if (keywordNeedle && filters.body) {
    result = result.filter(d => {
      if (matchesFrontmatter(d)) return true;
      const matches = scanBodyForKeyword(d, keywordNeedle, config);
      if (!matches.length) return false;
      d.bodyMatches = matches;
      return true;
    });
  }

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
  // Keep a reference to the full pre-limit set so the plans header can
  // reclassify runlist hubs out of the status breakdown (it needs per-doc
  // identity, not just aggregate counts).
  filters._matched = result;
  return filters.all ? result : result.slice(0, filters.limit);
}

// Read one doc's body and return up to MAX_BODY_MATCHES matching-line
// excerpts: { line: <1-based file line>, text: <trimmed, windowed around the
// match> }. Line numbers are file-absolute (frontmatter included) so they can
// feed straight into a Read offset.
const MAX_BODY_MATCHES = 2;
const EXCERPT_WIDTH = 120;

function scanBodyForKeyword(doc, needle, config) {
  let raw;
  try {
    raw = readFileSync(path.resolve(config.repoRoot, doc.path), 'utf8');
  } catch (err) {
    warn(`Could not read ${doc.path}: ${err.message}`);
    return [];
  }
  const { body } = extractFrontmatter(raw);
  if (!body || !body.toLowerCase().includes(needle)) return [];

  // body is a suffix of raw — the slice before it is the frontmatter block.
  const bodyStartLine = raw.slice(0, raw.length - body.length).split('\n').length;
  const lines = body.split('\n');
  const matches = [];
  for (let i = 0; i < lines.length && matches.length < MAX_BODY_MATCHES; i++) {
    const text = lines[i].trim();
    const at = text.toLowerCase().indexOf(needle);
    if (at === -1) continue;
    matches.push({ line: bodyStartLine + i, text: excerptAround(text, at, needle.length) });
  }
  return matches;
}

// Window a long line around the match so the needle is always visible.
function excerptAround(text, at, needleLen) {
  if (text.length <= EXCERPT_WIDTH) return text;
  const start = Math.max(0, Math.min(at - Math.floor((EXCERPT_WIDTH - needleLen) / 2), text.length - EXCERPT_WIDTH));
  const slice = text.slice(start, start + EXCERPT_WIDTH);
  return `${start > 0 ? '…' : ''}${slice}${start + EXCERPT_WIDTH < text.length ? '…' : ''}`;
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
  const total = filters._totalBeforeLimit ?? docs.length;
  const truncated = !filters.all && total > docs.length;
  if (truncated) {
    process.stdout.write(`- results: ${docs.length} of ${total} ${dim('(use --all to see all)')}\n`);
  } else {
    process.stdout.write(`- results: ${docs.length}\n`);
  }
  if (filters.types?.length) process.stdout.write(`- type: ${filters.types.join(', ')}\n`);
  if (filters.statuses?.length) process.stdout.write(`- status: ${filters.statuses.join(', ')}\n`);
  if (filters.keyword) process.stdout.write(`- keyword: ${filters.keyword}${filters.body ? ' (bodies scanned)' : ''}\n`);
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
    const stateValue = formatCurrentState(doc);
    if (stateValue) process.stdout.write(`  state: ${stateValue}\n`);
    if (doc.nextStep) process.stdout.write(`  next: ${doc.nextStep}\n`);
    if (doc.owner) process.stdout.write(`  owner: ${doc.owner}\n`);
    if (doc.surfaces?.length) process.stdout.write(`  surfaces: ${doc.surfaces.join(', ')}\n`);
    if (doc.modules?.length) process.stdout.write(`  modules: ${doc.modules.join(', ')}\n`);
    if (doc.domain) process.stdout.write(`  domain: ${doc.domain}\n`);
    if (doc.audience) process.stdout.write(`  audience: ${doc.audience}\n`);
    if (doc.executionMode) process.stdout.write(`  execution-mode: ${doc.executionMode}\n`);
    if (doc.blockers?.length) process.stdout.write(`  blockers: ${doc.blockers.join('; ')}\n`);
    if (doc.checklist?.total) process.stdout.write(`  checklist: ${doc.checklist.completed}/${doc.checklist.total} complete\n`);
    for (const m of doc.bodyMatches ?? []) {
      process.stdout.write(`  match: ${dim(`L${m.line}:`)} ${m.text}\n`);
    }
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

  const maxWidth = process.stdout.columns || 100;
  const grouped = filters.sort === 'status' || filters.group;
  // Runlist treatment (sprint-hub folding + the coordination-hub section) is
  // scoped to the flat triage view; grouped views keep their existing shape.
  const runlist = !grouped ? opts.runlist : null;
  const coordination = !grouped ? opts.coordination : null;
  // A doc is a "runlist" for header/section purposes if it's either a
  // frontmatter-`runlist:` sprint hub or an `execution_mode: coordination` hub.
  const isHub = (p) => Boolean(runlist?.hubs.has(p) || coordination?.has(p));

  // Summary line: middle-dot separator, ALWAYS based on the full pre-limit
  // pipeline so the top-of-page numbers stay honest when --limit is applied.
  const totalShown = docs.length;
  const totalAll = filters._totalBeforeLimit ?? totalShown;
  const bySt = filters._statusCounts ?? (() => {
    const counts = {};
    for (const d of docs) { counts[d.status] = (counts[d.status] ?? 0) + 1; }
    return counts;
  })();
  // With runlists present, pull hubs out of the per-status breakdown into a
  // dedicated `N runlist` bucket so a hub reads as an active *runlist*, not one
  // more active plan. Needs per-doc identity, so recompute from the pre-limit
  // matched set rather than the aggregate counts.
  let hubCount = 0;
  let counts;
  if ((runlist?.hubs.size || coordination?.size) && filters._matched) {
    const reclassed = {};
    for (const d of filters._matched) {
      if (isHub(d.path)) { hubCount += 1; continue; }
      const s = d.status ?? 'unknown';
      reclassed[s] = (reclassed[s] ?? 0) + 1;
    }
    counts = Object.entries(reclassed).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${n} ${s}`);
  } else {
    counts = Object.entries(bySt).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${n} ${s}`);
  }
  const headerParts = [];
  if (hubCount) headerParts.push(`${hubCount} runlist${hubCount === 1 ? '' : 's'}`);
  headerParts.push(...counts);
  const header = `${totalAll} ${noun}${headerParts.length ? ' · ' + headerParts.join(' · ') : ''}`;
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
    // Flat triage view, "capped like leaves": work from the full pre-limit
    // matched set and cap each kind independently. Leaf plans (+ frontmatter
    // `runlist:` sprint hubs, which still fold inline) fill the main list;
    // coordination hubs are lifted into their own `Runlists` section. Each
    // section caps at `--limit` with its own "N more" footer; `--all` lifts
    // both caps. The Runlists section is pinned — it shows whenever hubs exist,
    // independent of how the leaf list fills up.
    const matched = filters._matched ?? docs;
    const coordAll = [];
    const mainAll = [];
    for (const d of matched) {
      if (coordination?.has(d.path)) coordAll.push(d);
      else mainAll.push(d);
    }
    const mainShown = filters.all ? mainAll : mainAll.slice(0, filters.limit);
    const coordShown = filters.all ? coordAll : coordAll.slice(0, filters.limit);

    process.stdout.write('\n');
    if (mainShown.length) {
      if (runlist?.hubs.size) renderTriageWithRunlists(mainShown, runlist, maxWidth);
      else renderPlanRows(mainShown, filters, maxWidth, { showTag: true });
    }
    const mainHidden = mainAll.length - mainShown.length;
    if (mainHidden > 0) {
      process.stdout.write('\n');
      process.stdout.write(dim(`  ${mainHidden} more ${noun}  ·  dotmd ${noun} --all  ·  dotmd ${noun} status\n`));
    }

    if (coordShown.length) {
      renderCoordinationSection(coordShown, coordination, maxWidth, coordAll.length);
      const coordHidden = coordAll.length - coordShown.length;
      if (coordHidden > 0) {
        process.stdout.write(dim(`  ${coordHidden} more runlists  ·  dotmd ${noun} --all\n`));
      }
    }

    process.stdout.write('\n');
    return;
  }

  // Footer (grouped views) — emit when the result was capped.
  const hidden = totalAll - totalShown;
  if (hidden > 0) {
    process.stdout.write('\n');
    process.stdout.write(dim(`  ${hidden} more ${noun}  ·  dotmd ${noun} --all  ·  dotmd ${noun} status\n`));
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

// Format a single triage row: `<indent><slug>  <age>  <pct>  <next-step>` with
// an optional right-aligned tag. `indent` carries the left gutter (and, for
// runlist children, the `→` next-pickup marker), so its visible length must be
// stable across sibling rows for the slug column to align. `tag` overrides the
// status tag (used for the `[RUNLIST]` hub tag).
function formatPlanRow(doc, maxWidth, { slug, indent = '  ', maxSlug, showTag = false, tag } = {}) {
  const slugCell = slug.padEnd(maxSlug ?? slug.length);
  const age = doc.daysSinceUpdate != null ? `${doc.daysSinceUpdate}d` : '—';
  const ageStr = doc.daysSinceUpdate != null && doc.isStale ? red(age.padStart(4)) : dim(age.padStart(4));

  // Compact percentage cell (always 5 chars: "100% " / " 99% " / "  5% " / "     ")
  let pctCell = '     ';
  if (doc.checklist?.total) {
    const pct = Math.round((doc.checklist.completed / doc.checklist.total) * 100);
    pctCell = `${pct.toString().padStart(3)}% `;
  }

  const leftBlock = `${indent}${slugCell}  ${ageStr}  ${dim(pctCell)}`;
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
    line = `${line}${' '.repeat(padCount)}${tag ?? colorTag(doc.status)}`;
  }
  return line;
}

function renderPlanRows(group, _filters, maxWidth, opts = {}) {
  const { showTag = false } = opts;
  const maxSlug = Math.min(30, Math.max(...group.map(d => toSlug(d).length)));
  for (const doc of group) {
    process.stdout.write(formatPlanRow(doc, maxWidth, { slug: toSlug(doc), maxSlug, showTag }) + '\n');
  }
}

const RUNLIST_TAG = bold(cyan('[RUNLIST]'));

// Drop a hub's slug prefix off a child slug so a sprint's children read as
// `01-extract` rather than `auth-revamp-01-extract`. Falls back to the full
// slug when there's no shared prefix.
function stripHubPrefix(childSlug, hubSlug) {
  return childSlug.startsWith(`${hubSlug}-`) ? childSlug.slice(hubSlug.length + 1) : childSlug;
}

// Flat triage view, runlist-aware. Standalone plans render as before; each hub
// becomes a `[RUNLIST]` header with its (filtered) children folded underneath
// in runlist order, the next pickup marked `→`. A child whose hub is absent
// from this filtered set (e.g. `--status active` hid the hub) renders
// standalone so it still surfaces. Render units sort by their most-recent
// member so an actively-worked sprint stays near the top.
function renderTriageWithRunlists(docs, runlist, maxWidth) {
  const { hubs, childToHub } = runlist;
  const docPathSet = new Set(docs.map(d => d.path));

  const folded = new Set();
  for (const d of docs) {
    const hubPath = childToHub.get(d.path);
    if (hubPath && docPathSet.has(hubPath)) folded.add(d.path);
  }

  const units = [];
  for (const d of docs) {
    if (folded.has(d.path)) continue; // emitted under its hub
    const info = hubs.get(d.path);
    if (info) {
      const children = docs.filter(c => childToHub.get(c.path) === d.path);
      const ages = [d.daysSinceUpdate, ...children.map(c => c.daysSinceUpdate)].filter(n => n != null);
      units.push({ anchor: ages.length ? Math.min(...ages) : Infinity, kind: 'hub', hub: d, info, children });
    } else {
      units.push({ anchor: d.daysSinceUpdate ?? Infinity, kind: 'plan', doc: d });
    }
  }
  // Stable sort by most-recent member ascending (docs arrive already sorted by
  // `updated`, so equal anchors keep their incoming order).
  units.sort((a, b) => a.anchor - b.anchor);

  // Shared slug width for the left-most rows (standalone plans + hub headers).
  const topSlugs = units.map(u => u.kind === 'hub' ? toSlug(u.hub) : toSlug(u.doc));
  const topMaxSlug = Math.min(30, Math.max(...topSlugs.map(s => s.length)));

  for (const u of units) {
    if (u.kind === 'plan') {
      process.stdout.write(formatPlanRow(u.doc, maxWidth, { slug: toSlug(u.doc), maxSlug: topMaxSlug, showTag: true }) + '\n');
    } else {
      renderHubBlock(u.hub, u.info, u.children, maxWidth, topMaxSlug);
    }
  }
}

function renderHubBlock(hub, info, children, maxWidth, topMaxSlug) {
  const hubSlug = toSlug(hub);
  const nextDoc = info.nextChildPath ? info.children.find(c => c.path === info.nextChildPath)?.doc : null;
  const nextLabel = nextDoc ? stripHubPrefix(toSlug(nextDoc), hubSlug) : null;
  const descr = nextLabel
    ? `runlist · ${info.doneCount}/${info.total} · next → ${nextLabel}`
    : `runlist · ${info.doneCount}/${info.total} · all archived`;

  // Header row: hub slug + descriptor, with `[RUNLIST]` right-aligned like a tag.
  const slugCell = hubSlug.padEnd(topMaxSlug);
  let header = `  ${slugCell}  ${dim(descr)}`;
  const targetCol = maxWidth - MAX_TAG_WIDTH;
  const pad = Math.max(2, targetCol - visibleLen(header));
  header = `${header}${' '.repeat(pad)}${RUNLIST_TAG}`;
  process.stdout.write(header + '\n');

  if (children.length === 0) return;
  const childMaxSlug = Math.min(28, Math.max(...children.map(c => stripHubPrefix(toSlug(c), hubSlug).length)));
  for (const c of children) {
    const isNext = c.path === info.nextChildPath;
    const indent = isNext ? `    ${green('→')} ` : '      ';
    process.stdout.write(formatPlanRow(c, maxWidth, {
      slug: stripHubPrefix(toSlug(c), hubSlug), indent, maxSlug: childMaxSlug, showTag: true,
    }) + '\n');
  }
}

// Conventional container dirs whose name adds no disambiguation to a hub label.
const HUB_CONTAINER_DIRS = new Set(['plans', 'prompts', 'archive', 'archived']);

// Display label for a hub. A bare basename loses context for hubs that live in
// a subdirectory (e.g. `docs/plans/pos/runlist.md` would read as just
// `runlist`), so prefix the immediate parent dir unless it's a conventional
// container. → `pos/runlist`, but `billing-runlist` stays as-is.
function hubLabel(doc) {
  const slug = toSlug(doc);
  const parent = path.basename(path.dirname(doc.path));
  return HUB_CONTAINER_DIRS.has(parent) ? slug : `${parent}/${slug}`;
}

// Coordination hubs (prose-first runlists) render in their own compact section:
// label · age · rough related-cluster size · one-line descriptor. No fold, no
// per-row tag — the section header is the signal. The count is the resolved
// `related_plans:` cluster, which includes peer/parent runlists, so it's
// labelled `related` (not `plans`) to stay honest. Status shows only when it's
// not the expected `active` (e.g. a `partial` hub).
function renderCoordinationSection(coordDocs, coordination, maxWidth, total) {
  process.stdout.write(`\n${bold(`Runlists (${total ?? coordDocs.length})`)}\n`);
  const maxSlug = Math.min(34, Math.max(...coordDocs.map(d => hubLabel(d).length)));
  for (const doc of coordDocs) {
    const info = coordination.get(doc.path);
    const slug = hubLabel(doc).padEnd(maxSlug);
    const age = doc.daysSinceUpdate != null ? `${doc.daysSinceUpdate}d` : '—';
    const ageStr = doc.daysSinceUpdate != null && doc.isStale ? red(age.padStart(4)) : dim(age.padStart(4));
    const count = info?.childCount ? `${String(info.childCount).padStart(2)} related` : '          ';
    const statusTag = doc.status && doc.status !== 'active' ? ` ${colorTag(doc.status)}` : '';
    const desc = (doc.nextStep || doc.currentState || doc.title || '').replace(/\s+/g, ' ').trim();

    const left = `  ${slug}  ${ageStr}  ${dim(count)}  `;
    const budget = Math.max(10, maxWidth - visibleLen(left) - visibleLen(statusTag) - 2);
    const descR = desc.length > budget ? desc.slice(0, budget - 3) + '...' : desc;
    process.stdout.write(`${left}${dim(descR)}${statusTag}\n`);
  }
}
