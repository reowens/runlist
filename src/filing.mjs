import { readFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter } from './frontmatter.mjs';
import { extractBodyLinks } from './extractors.mjs';
import { isHubDoc, splitRowCells, findMarkedSpan, readPositionalToken } from './hub.mjs';
import { resolveBodyLinkTarget } from './body-link.mjs';
import { isArchivedPath, resolveRefPath, toRepoPath } from './util.mjs';

export function filingOptions(value) {
  if (value === true) return { categoryDepth: 3 };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return null;
  if (value.enabled === false) return null;
  const depth = value.categoryDepth ?? 3;
  return Number.isInteger(depth) && depth >= 2 && depth <= 6 ? { categoryDepth: depth } : null;
}

export function validateFilingConfig(value) {
  if (value === undefined || value === null || typeof value === 'boolean') return [];
  if (typeof value !== 'object' || Array.isArray(value)) return ['Config: filing must be a boolean or an object.'];
  const warnings = [];
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') warnings.push('Config: filing.enabled must be a boolean.');
  if (value.categoryDepth !== undefined && (!Number.isInteger(value.categoryDepth) || value.categoryDepth < 2 || value.categoryDepth > 6)) {
    warnings.push('Config: filing.categoryDepth must be an integer from 2 to 6.');
  }
  return warnings;
}

// Preserve line numbers while ignoring examples and comments. Keep status
// markers: those short comments delimit an authored, managed status word.
function visibleBody(body) {
  const comments = body.replace(/<!--[\s\S]*?-->/g, comment =>
    /^<!--\s*\/?s\s*-->$/.test(comment) ? comment : comment.replace(/[^\n]/g, ' '));
  let fence = null;
  return comments.split('\n').map(line => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = null;
      return '';
    }
    if (match) { fence = match[1]; return ''; }
    return /^ {4}|^\t/.test(line) ? '' : line;
  }).join('\n');
}

const delimiter = cells => cells.length > 0 && cells.every(cell => /^\s*:?-+:?\s*$/.test(cell.raw));
const headerWord = cell => cell.raw.replace(/[*_`]/g, '').trim().toLowerCase();

// A home is a status-bearing table row ABOUT the plan: its first cell must
// link to that plan. Links in commentary, prose, metadata or order lists are
// references. The caller resolves the subject before reading its vocabulary.
export function scanFilingRows(body, categoryDepth = 3) {
  const lines = visibleBody(body).split('\n');
  const rows = [];
  let category = null;
  let table = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      if (heading[1].length <= categoryDepth) category = heading[1].length === categoryDepth ? heading[2].trim() : null;
    }
    if (!line.trim().startsWith('|')) { table = null; continue; }
    const cells = splitRowCells(line);
    if (!table) {
      const next = lines[i + 1] ?? '';
      if (next.trim().startsWith('|') && delimiter(splitRowCells(next))) {
        table = { statusColumn: cells.findIndex(cell => ['status', 'state'].includes(headerWord(cell))) };
      }
      continue;
    }
    if (delimiter(cells)) continue;
    const subject = extractBodyLinks(cells[0]?.raw ?? '').find(link => link.targetKind === 'document');
    if (!subject) continue;
    const statusCell = table.statusColumn >= 0 ? cells[table.statusColumn] : null;
    // A marker belongs in a later cell, never inside the subject or its prose.
    const marked = statusCell ? findMarkedSpan(statusCell.raw) :
      cells.slice(1).map(cell => findMarkedSpan(cell.raw)).find(Boolean);
    if (!statusCell && !marked) continue;
    rows.push({ lineIndex: i, href: subject.href, category, statusCell, marked });
  }
  return rows;
}

function closed(doc, config) {
  return isArchivedPath(doc.path, config) || (config.lifecycle?.isTerminal?.(doc.status, doc.type)
    ?? config.lifecycle?.terminalStatuses?.has(doc.status) ?? false);
}

function totals(plans) {
  return {
    plans: plans.length,
    filedDirect: plans.filter(plan => plan.filing === 'direct').length,
    filedThroughParent: plans.filter(plan => plan.filing === 'parent').length,
    unfiled: plans.filter(plan => plan.filing === 'unfiled').length,
    multiplyFiled: plans.filter(plan => plan.rows.length > 1 || new Set(plan.rows.flatMap(row => row.categories)).size > 1).length,
    noCategory: plans.filter(plan => plan.rows.some(row => !row.categories.length)).length,
  };
}

export function scopeFilingCoverage(report, docs) {
  if (!report) return null;
  const selected = new Set(docs.map(doc => doc.path));
  const plans = report.plans.filter(plan => selected.has(plan.path));
  return { ...report, totals: totals(plans), plans };
}

export function buildFilingCoverage(docs, config) {
  const options = filingOptions(config.filing);
  if (!options) return null;
  const byPath = new Map(docs.map(doc => [doc.path, doc]));
  const folded = new Map();
  for (const doc of docs) {
    const key = doc.path.toLowerCase();
    folded.set(key, folded.has(key) ? null : doc);
  }
  const lookup = absolute => {
    const relative = toRepoPath(absolute, config.repoRoot);
    return byPath.get(relative) ?? folded.get(relative.toLowerCase()) ?? null;
  };
  const homes = new Map();
  const failures = [];
  for (const hub of docs) {
    if (!isHubDoc(hub) || closed(hub, config)) continue;
    let raw;
    try { raw = readFileSync(path.join(config.repoRoot, hub.path), 'utf8'); }
    catch (error) { failures.push({ path: hub.path, message: error.message }); continue; }
    const { body, bodyLineOffset } = extractFrontmatter(raw);
    const dir = path.dirname(path.join(config.repoRoot, hub.path));
    for (const row of scanFilingRows(body, options.categoryDepth)) {
      const resolved = resolveBodyLinkTarget(row.href, dir, config.repoRoot);
      if (!resolved.ok) continue;
      const subject = lookup(resolved.path);
      if (!subject || subject.type !== 'plan' || subject.path === hub.path || closed(subject, config)) continue;
      const vocabulary = config.typeStatuses?.get(subject.type) ?? config.validStatuses ?? new Set();
      const span = row.marked ?? readPositionalToken(row.statusCell, word => vocabulary.has(word.toLowerCase()));
      if (!span || !vocabulary.has(span.text.toLowerCase())) continue;
      if (!homes.has(subject.path)) homes.set(subject.path, []);
      homes.get(subject.path).push({ hub: hub.path, line: bodyLineOffset + row.lineIndex + 1,
        subject: subject.path, category: row.category, categories: [], printedStatus: span.text });
    }
  }

  // A hub filed beneath a category passes that category to its own rows. Only
  // explicit headings/subject rows supply categories; hub titles are not guessed.
  const hubCategories = new Map();
  const liveHubs = docs.filter(doc => isHubDoc(doc) && !closed(doc, config));
  for (const hub of liveHubs) hubCategories.set(hub.path, new Set());
  const dependents = new Map();
  const queue = [];
  const addCategory = (hub, category) => {
    const categories = hubCategories.get(hub);
    if (categories && !categories.has(category)) { categories.add(category); queue.push([hub, category]); }
  };
  for (const hub of liveHubs) for (const row of homes.get(hub.path) ?? []) {
    if (row.category) addCategory(hub.path, row.category);
    else {
      if (!dependents.has(row.hub)) dependents.set(row.hub, new Set());
      dependents.get(row.hub).add(hub.path);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const [hub, category] = queue[i];
    for (const dependent of dependents.get(hub) ?? []) addCategory(dependent, category);
  }
  for (const rows of homes.values()) for (const row of rows) {
    row.categories = row.category ? [row.category] : [...(hubCategories.get(row.hub) ?? [])].sort();
  }

  // Parent inheritance is explicit and cycle-safe. A child's own home takes
  // precedence. Cache each resolved ancestor so deep plan trees stay linear.
  const memo = new Map();
  const resolveHome = doc => {
    const chain = [];
    const seen = new Set();
    let current = doc;
    let result = null;
    while (current) {
      if (memo.has(current.path)) { result = memo.get(current.path); break; }
      if (seen.has(current.path) || closed(current, config)) break;
      seen.add(current.path);
      if (homes.has(current.path)) { result = { filedThrough: current.path, rows: homes.get(current.path) }; break; }
      chain.push(current.path);
      const parents = current.refFields?.parent_plan ?? [];
      if (parents.length !== 1) break;
      const absolute = resolveRefPath(parents[0], path.dirname(path.join(config.repoRoot, current.path)), config.repoRoot);
      current = absolute ? lookup(absolute) : null;
      if (current?.type !== 'plan') break;
    }
    for (const item of chain) memo.set(item, result);
    return result;
  };
  const plans = docs.filter(doc => doc.type === 'plan' && !isHubDoc(doc) && !closed(doc, config)).map(doc => {
    const home = resolveHome(doc);
    return { path: doc.path, status: doc.status,
      filing: !home ? 'unfiled' : home.filedThrough === doc.path ? 'direct' : 'parent',
      filedThrough: home?.filedThrough ?? null, rows: home?.rows ?? [] };
  });
  return { enabled: true, complete: failures.length === 0, categoryDepth: options.categoryDepth,
    totals: totals(plans), plans, failures };
}

export function filingFindings(report) {
  if (!report) return [];
  const findings = report.failures.map(failure => ({ path: failure.path, level: 'warning',
    message: `Could not read hub for filing coverage: ${failure.message}`, meta: { kind: 'filing-read-failure' } }));
  // Missing hubs make absence claims unreliable. Preserve evidence but do not
  // declare missing or unique homes from an incomplete sweep.
  if (!report.complete) return findings;
  for (const plan of report.plans) {
    const meta = { rows: plan.rows, filedThrough: plan.filedThrough, filing: plan.filing };
    const via = plan.filing === 'parent' ? ` through parent \`${plan.filedThrough}\`` : '';
    const locations = plan.rows.map(row => `${row.hub}:${row.line} [${row.categories.join(', ') || 'no category'}]`).join('; ');
    const add = (kind, message) => findings.push({ path: plan.path, level: 'warning', message, meta: { ...meta, kind } });
    if (!plan.rows.length) add('filing-unfiled', 'has no home in a status-bearing hub table row; links in prose or commentary are references.');
    if (plan.rows.length > 1 || new Set(plan.rows.flatMap(row => row.categories)).size > 1) {
      add('filing-multiple', `has multiple filing homes${via}: ${locations}`);
    }
    if (plan.rows.some(row => !row.categories.length)) add('filing-no-category', `is filed${via} under no category: ${locations}`);
  }
  return findings;
}
