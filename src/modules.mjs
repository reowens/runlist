// Modules dashboard (F16). Two view-only commands:
//   `runlist modules`         — one row per discovered module, dynamic status columns
//   `runlist module <name>`   — plans for one module, grouped by status, stale flagged inline
//
// Aggregation lives in `aggregateModules` (pure data). Both renderers consume
// the same shape, so JSON output and the table share one source of truth.
//
// Constraint cheatsheet (see docs/archived/modules-dashboard.md):
//   M1 dynamic columns      — discover statuses from rendered rows, drop empty cols
//   M2 overflow fallback    — drop-empty first, then stacked render if still too wide
//   M3 double-counting      — `modules: [a, b]` increments both rows (intended)
//   M4 (none) bucket        — surface when ≥1 plan has empty modules
//   M6 archived/skipStale   — terminal statuses excluded; skipStale don't contribute to `stale`
import { toSlug, truncate, die, suggestCandidates } from './util.mjs';
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

function colorStatus(status, text) {
  const fn = STATUS_COLORS[status] ?? ((s) => s);
  return fn(text);
}

// Single pass over docs → Map<moduleName, aggregate>. Terminal-status docs are
// excluded entirely (M6) — they pollute the active-work picture. skipStale
// statuses are counted toward totals but never contribute to `stale` so they
// don't lie about staleness when a custom config (e.g. `backlog`) opts out.
export function aggregateModules(docs, config) {
  const terminal = config.lifecycle.terminalStatuses;
  const skipStale = config.lifecycle.skipStaleFor;
  const liveDocs = docs.filter(d => !terminal.has(d.status));
  const uniqueTotal = liveDocs.length;

  const modules = new Map();
  function bucket(name) {
    if (!modules.has(name)) {
      modules.set(name, {
        name,
        plans: [],
        byStatus: {},
        stale: 0,
        ageSum: 0,
        ageCount: 0,
        oldest: null,
        nextStepCount: 0,
      });
    }
    return modules.get(name);
  }

  for (const doc of liveDocs) {
    const names = doc.modules?.length ? doc.modules : ['(none)'];
    for (const name of names) {
      const m = bucket(name);
      m.plans.push(doc);
      m.byStatus[doc.status] = (m.byStatus[doc.status] ?? 0) + 1;
      if (doc.isStale && !skipStale.has(doc.status)) m.stale += 1;
      if (typeof doc.daysSinceUpdate === 'number') {
        m.ageSum += doc.daysSinceUpdate;
        m.ageCount += 1;
        if (!m.oldest || doc.daysSinceUpdate > m.oldest.ageDays) {
          m.oldest = { slug: toSlug(doc), ageDays: doc.daysSinceUpdate };
        }
      }
      if (doc.hasNextStep) m.nextStepCount += 1;
    }
  }

  const rows = [...modules.values()].map(m => ({
    name: m.name,
    total: m.plans.length,
    byStatus: m.byStatus,
    stale: m.stale,
    avgAgeDays: m.ageCount > 0 ? m.ageSum / m.ageCount : 0,
    oldest: m.oldest,
    nextStepPct: m.plans.length > 0 ? m.nextStepCount / m.plans.length : 0,
    _plans: m.plans,
  }));

  return { rows, totalUnique: uniqueTotal };
}

// Cleanup-rank formula (R3): high stale share + high average age + lower total
// floats modules that have rotted; low total in the denominator keeps a single
// ancient plan from outweighing a 30-plan module with two stale ones. Document
// in `--help`; iterate after running on real corpora.
function cleanupScore(row) {
  return (row.stale * row.avgAgeDays) / Math.max(row.total, 1);
}

function buildSorter(sort) {
  if (sort === 'stale') return (a, b) => b.stale - a.stale || b.total - a.total;
  if (sort === 'age') return (a, b) => b.avgAgeDays - a.avgAgeDays || b.total - a.total;
  if (sort === 'nextstep') return (a, b) => b.nextStepPct - a.nextStepPct || b.total - a.total;
  if (sort === 'cleanup') return (a, b) => cleanupScore(b) - cleanupScore(a) || b.stale - a.stale;
  return (a, b) => b.total - a.total || a.name.localeCompare(b.name);
}

function parseFlags(argv) {
  const flags = { sort: 'total', json: false, limit: 20, all: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sort' && argv[i + 1]) { flags.sort = argv[++i]; continue; }
    if (arg === '--json') { flags.json = true; continue; }
    if (arg === '--limit' && argv[i + 1]) { flags.limit = parseInt(argv[++i], 10); continue; }
    if (arg === '--all') { flags.all = true; continue; }
  }
  const validSorts = new Set(['total', 'stale', 'age', 'nextstep', 'cleanup']);
  if (!validSorts.has(flags.sort)) {
    die(`Invalid --sort value: ${flags.sort}. Valid: ${[...validSorts].join(', ')}.`);
  }
  return flags;
}

// Discover which status columns to render. Only statuses with ≥1 non-zero cell
// across the rendered rows make the cut (M1). Ordered by config.statusOrder
// first, then alphabetically for any custom statuses the index encountered
// that aren't in statusOrder (so a custom `research` column appears).
function discoverStatusColumns(rows, config) {
  const seen = new Set();
  for (const row of rows) {
    for (const [status, count] of Object.entries(row.byStatus)) {
      if (count > 0) seen.add(status);
    }
  }
  const ordered = config.statusOrder.filter(s => seen.has(s));
  const extras = [...seen].filter(s => !config.statusOrder.includes(s)).sort();
  return [...ordered, ...extras];
}

function fmtAge(days) {
  if (!Number.isFinite(days)) return '-';
  if (days < 1) return '<1d';
  if (days < 10) return `${days.toFixed(1)}d`;
  return `${Math.round(days)}d`;
}

function fmtPct(frac) {
  if (!Number.isFinite(frac)) return '-';
  return `${Math.round(frac * 100)}%`;
}

function fmtOldest(oldest) {
  if (!oldest) return '-';
  const slug = truncate(oldest.slug, 14);
  return `${slug} (${fmtAge(oldest.ageDays)})`;
}

// Heuristic column-width budget. Returns true if the dynamic-columns table
// will fit within the terminal; caller switches to the stacked render if not.
function tableFits(rows, statuses, termWidth) {
  const nameCol = Math.max(8, ...rows.map(r => r.name.length));
  const statusCols = statuses.length * 7; // each status header padded
  const tailCols = 6 /*stale*/ + 8 /*age*/ + 22 /*oldest*/ + 6 /*next%*/ + 8 /*gutters*/;
  return nameCol + statusCols + tailCols <= termWidth;
}

function pad(s, width) {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

function padLeft(s, width) {
  if (s.length >= width) return s;
  return ' '.repeat(width - s.length) + s;
}

function renderTable(rows, statuses, config) {
  const nameCol = Math.max(8, ...rows.map(r => r.name.length));
  const lines = [];
  const headerCells = [
    pad('module', nameCol),
    ...statuses.map(s => padLeft(s.slice(0, 5), 5)),
    padLeft('stale', 5),
    padLeft('avgAge', 7),
    pad('oldest', 22),
    padLeft('next%', 5),
  ];
  lines.push(dim(headerCells.join('  ')));
  for (const row of rows) {
    const cells = [
      pad(row.name, nameCol),
      ...statuses.map(s => {
        const n = row.byStatus[s] ?? 0;
        const text = padLeft(String(n), 5);
        return n > 0 ? colorStatus(s, text) : dim(text);
      }),
      padLeft(String(row.stale), 5),
      padLeft(fmtAge(row.avgAgeDays), 7),
      pad(fmtOldest(row.oldest), 22),
      padLeft(fmtPct(row.nextStepPct), 5),
    ];
    lines.push(cells.join('  '));
  }
  return lines.join('\n') + '\n';
}

// Stacked fallback (M2 step 2): one block per module, status counts indented.
// Preserves every value — never collapses to "Other".
function renderStacked(rows, statuses) {
  const lines = [];
  for (const row of rows) {
    lines.push(bold(row.name) + dim(`  · ${row.total} total · ${row.stale} stale · avg ${fmtAge(row.avgAgeDays)} · next-step ${fmtPct(row.nextStepPct)}`));
    const cells = statuses
      .filter(s => (row.byStatus[s] ?? 0) > 0)
      .map(s => `${colorStatus(s, s)}: ${row.byStatus[s]}`);
    if (cells.length) lines.push('  ' + cells.join('  '));
    if (row.oldest) lines.push(dim(`  oldest: ${row.oldest.slug} (${fmtAge(row.oldest.ageDays)})`));
    lines.push('');
  }
  return lines.join('\n');
}

export function runModulesDashboard(index, argv, config) {
  const flags = parseFlags(argv);
  const { rows, totalUnique } = aggregateModules(index.docs, config);
  rows.sort(buildSorter(flags.sort));
  const totalModules = rows.length;
  const displayRows = flags.all ? rows : rows.slice(0, flags.limit);

  if (flags.json) {
    const out = {
      type: 'plan',
      sort: flags.sort,
      _totalUnique: totalUnique,
      modules: displayRows.map(r => ({
        name: r.name,
        total: r.total,
        byStatus: r.byStatus,
        stale: r.stale,
        avgAgeDays: Math.round(r.avgAgeDays * 10) / 10,
        oldest: r.oldest,
        nextStepPct: Math.round(r.nextStepPct * 100) / 100,
      })),
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  if (rows.length === 0) {
    process.stdout.write('No modules found.\n');
    return;
  }

  const statuses = discoverStatusColumns(displayRows, config);
  const termWidth = process.stdout.columns || 120;

  const header = `${totalModules} modules · ${totalUnique} plans · sort: ${flags.sort}`;
  process.stdout.write(dim(header) + '\n\n');

  if (tableFits(displayRows, statuses, termWidth)) {
    process.stdout.write(renderTable(displayRows, statuses, config));
  } else {
    process.stdout.write(renderStacked(displayRows, statuses));
  }

  if (!flags.all && rows.length > flags.limit) {
    const hidden = rows.length - flags.limit;
    process.stdout.write('\n' + dim(`  ${hidden} more module${hidden === 1 ? '' : 's'}  ·  runlist modules --all\n`));
  }
}

export function runModuleDetail(index, argv, config) {
  const flags = { sort: 'status', json: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sort' && argv[i + 1]) { flags.sort = argv[++i]; continue; }
    if (arg === '--json') { flags.json = true; continue; }
    if (arg.startsWith('-')) continue;
    positional.push(arg);
  }
  const name = positional[0];
  if (!name) die('Usage: runlist module <name>');

  const { rows } = aggregateModules(index.docs, config);
  const row = rows.find(r => r.name === name);
  if (!row) {
    const candidates = rows.map(r => r.name);
    const suggestions = suggestCandidates(name, candidates);
    const hint = suggestions.length
      ? `Did you mean: ${suggestions.join(', ')}?`
      : `Available: ${candidates.slice(0, 5).join(', ')}${candidates.length > 5 ? ', …' : ''} (run \`runlist modules\` for the full list).`;
    die(`Module '${name}' not found. ${hint}`);
  }

  const plans = row._plans.slice();
  if (flags.sort === 'updated' || flags.sort === 'age') {
    plans.sort((a, b) => (b.daysSinceUpdate ?? 0) - (a.daysSinceUpdate ?? 0));
  } else {
    plans.sort((a, b) => {
      const ai = config.statusOrder.indexOf(a.status);
      const bi = config.statusOrder.indexOf(b.status);
      const aIdx = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
      const bIdx = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
      if (aIdx !== bIdx) return aIdx - bIdx;
      return (b.daysSinceUpdate ?? 0) - (a.daysSinceUpdate ?? 0);
    });
  }

  if (flags.json) {
    const out = {
      name: row.name,
      total: row.total,
      plans: plans.map(p => ({
        path: p.path,
        slug: toSlug(p),
        status: p.status,
        daysSinceUpdate: p.daysSinceUpdate,
        isStale: p.isStale,
        hasNextStep: p.hasNextStep,
        summary: p.summary,
      })),
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  process.stdout.write(dim(`${row.total} plans · ${row.stale} stale · module: ${row.name}`) + '\n');

  const skipStale = config.lifecycle.skipStaleFor;
  const groups = new Map();
  for (const p of plans) {
    if (!groups.has(p.status)) groups.set(p.status, []);
    groups.get(p.status).push(p);
  }
  const orderedStatuses = [
    ...config.statusOrder.filter(s => groups.has(s)),
    ...[...groups.keys()].filter(s => !config.statusOrder.includes(s)),
  ];
  for (const status of orderedStatuses) {
    const group = groups.get(status);
    process.stdout.write(`\n${bold(colorStatus(status, status))} (${group.length})\n`);
    for (const p of group) {
      const slug = toSlug(p);
      const age = fmtAge(p.daysSinceUpdate);
      const staleTag = p.isStale && !skipStale.has(p.status) ? dim(' [stale]') : '';
      const next = p.nextStep ? ` — ${truncate(p.nextStep, 60)}` : '';
      process.stdout.write(`  ${slug}  ${dim(age)}${staleTag}${next}\n`);
    }
  }
  process.stdout.write('\n');
}
