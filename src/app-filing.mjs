import { randomUUID } from 'node:crypto';
import { setImmediate as yieldThread } from 'node:timers/promises';
import { assembleFilingCoverage, filingLiveHub, filingOptions, filingParentTarget, prepareFilingHub } from './filing.mjs';
import { SourceEditError } from './source-editor.mjs';

const detached = value => JSON.parse(JSON.stringify(value));
const number = (params, key, fallback, max) => {
  const value = Number(params.get(key) ?? fallback);
  return Number.isInteger(value) && value >= 0 ? Math.min(value, max) : fallback;
};
const multiple = plan => plan.rows.length > 1 || new Set(plan.rows.flatMap(row => row.categories)).size > 1;
const noCategory = plan => plan.rows.some(row => !row.categories.length);

/** One private, read-only report per checkout. No scan happens during creation. */
export function createAppFiling({ config, library, readSource }) {
  let scan = null, epoch = 0, advancing = null;
  function invalidate() { epoch++; scan = null; }
  function summary(current = scan) {
    if (!filingOptions(config.filing)) return { enabled: false, state: 'disabled', complete: false, reason: 'Filing reports are not enabled in this repository configuration.' };
    if (!current) return { enabled: true, state: 'idle', complete: false };
    return { enabled: true, scanId: current.id, generation: current.generation, state: current.report ? current.report.complete ? 'complete' : 'incomplete' : 'scanning',
      complete: current.report?.complete ?? false, progress: { done: current.index, total: current.documents.length },
      totals: current.report?.complete ? current.report.totals : null,
      failures: current.failures.slice(0, 50), failureCount: current.failures.length };
  }
  async function inventory(force = false) { return library.filingInventory({ refresh: force }); }
  function requireScan(params) {
    if (!scan || params.get('scanId') !== scan.id) throw new SourceEditError('filing-scan-stale', 'The filing report changed. Refresh it before continuing.');
    return scan;
  }
  function finish(current) {
    current.report = assembleFilingCoverage(current.documents, config, current.rows, current.parents,
      { complete: current.inventoryComplete, failures: current.failures });
    current.rows = null;
    current.parents = null;
  }
  async function start(params) {
    const ticket = epoch;
    const observed = await inventory(params.get('refresh') === '1');
    if (ticket !== epoch) throw new SourceEditError('filing-scan-stale', 'Saved files changed. Refresh the filing report.');
    if (scan?.generation === observed.generation && params.get('refresh') !== '1') return summary();
    const documents = observed.documents.map(doc => detached({ ...doc, path: doc.repoPath ?? doc.path }));
    scan = { id: randomUUID(), epoch, generation: observed.generation, documents, byPath: new Map(documents.map(doc => [doc.path, doc])), index: 0, rows: [], parents: new Map(), revisions: new Map(),
      inventoryComplete: observed.complete, failures: detached(observed.failures ?? []), report: null };
    if (!documents.length) finish(scan);
    return summary();
  }
  async function currentScan(params) {
    const current = requireScan(params), observed = await inventory();
    if (current !== scan || observed.generation !== current.generation || current.epoch !== epoch) {
      if (current === scan) invalidate();
      throw new SourceEditError('filing-scan-stale', 'Saved files changed. Refresh the filing report.');
    }
    return current;
  }
  async function advance(params, context) {
    if (advancing) { await advancing; return summary(await currentScan(params)); }
    const current = await currentScan(params);
    if (current.report) return summary(current);
    advancing = (async () => {
      const end = Math.min(current.documents.length, current.index + 8);
      while (current.index < end) {
        const doc = current.documents[current.index++];
        current.parents.set(doc.path, filingParentTarget(doc, config));
        if (filingLiveHub(doc, config)) {
          try {
            const opened = await readSource(doc.path, context);
            if (doc.stamp && opened.stamp !== doc.stamp) throw new Error('changed since inventory');
            if (Buffer.byteLength(opened.source) > 8 * 1024 * 1024) throw new Error('oversized');
            const rows = prepareFilingHub(doc, opened.source, config);
            if (current.rows.length + rows.length > 100_000) throw new Error('too many rows');
            current.rows.push(...detached(rows));
            current.revisions.set(doc.path, opened.revision);
          } catch {
            current.failures.push({ path: doc.path, message: 'Hub source is unavailable, changed, unsafe or exceeds report limits.' });
          }
        }
        await yieldThread();
        if (current !== scan || current.epoch !== epoch) throw new SourceEditError('filing-scan-stale', 'Saved files changed. Refresh the filing report.');
      }
      await currentScan(params);
      if (current.index === current.documents.length) finish(current);
      return summary(current);
    })();
    try { return await advancing; } finally { advancing = null; }
  }
  function planSummary(plan, current) {
    const doc = current.byPath.get(plan.path);
    return { path: plan.path, title: String(doc?.title ?? plan.path).slice(0, 300), status: plan.status,
      filing: current.report.complete ? plan.filing : plan.rows.length ? 'observed' : 'unknown',
      filedThrough: plan.filedThrough, homeCount: plan.rows.length,
      multiplyFiled: current.report.complete ? multiple(plan) : null, noCategory: current.report.complete ? noCategory(plan) : null };
  }
  async function page(params) {
    const current = await currentScan(params);
    if (!current.report) return { ...summary(current), plans: [], total: 0, offset: 0, limit: 50, hasMore: false };
    const group = params.get('group') ?? 'all';
    if (!['all', 'unfiled', 'multiple', 'no-category', 'parent', 'direct'].includes(group)) throw new SourceEditError('invalid-request', 'Choose a supported filing filter.');
    const words = (params.get('q') ?? '').slice(0, 500).toLowerCase().trim().split(/\s+/).filter(Boolean);
    const documents = new Map(current.documents.map(doc => [doc.path, doc]));
    const matches = current.report.plans.filter(plan =>
      (group === 'all' || current.report.complete && (group === 'unfiled' ? plan.filing === 'unfiled' : group === 'multiple' ? multiple(plan) : group === 'no-category' ? noCategory(plan) : plan.filing === group)) &&
      words.every(word => `${plan.path} ${documents.get(plan.path)?.title ?? ''} ${plan.status}`.toLowerCase().includes(word))).sort((a, b) => a.path.localeCompare(b.path));
    const limit = Math.max(1, number(params, 'limit', 50, 50));
    const offset = Math.min(number(params, 'offset', 0, 10_000_000), Math.max(0, Math.floor((matches.length - 1) / limit) * limit));
    return { ...summary(current), plans: matches.slice(offset, offset + limit).map(plan => planSummary(plan, current)), total: matches.length, offset, limit, hasMore: offset + limit < matches.length,
      reason: !current.report.complete && group !== 'all' ? 'Filing findings are unavailable until a complete scan can be made. Select All plans to inspect observed evidence.' : null };
  }
  async function detail(params, context) {
    const current = await currentScan(params);
    const plan = current.report?.plans.find(plan => plan.path === params.get('path'));
    if (!plan) throw new SourceEditError('filing-plan-unavailable', 'This plan is unavailable in the filing report. Refresh the report.');
    const limit = Math.max(1, number(params, 'homeLimit', 20, 20));
    const offset = Math.min(number(params, 'homeOffset', 0, 100_000), Math.max(0, Math.floor((plan.rows.length - 1) / limit) * limit));
    const sources = new Map(), homes = [];
    for (const row of plan.rows.slice(offset, offset + limit)) {
      if (!sources.has(row.hub)) {
        try { sources.set(row.hub, (await readSource(row.hub, context)).revision === current.revisions.get(row.hub) ? 'unchanged' : 'changed'); }
        catch { sources.set(row.hub, 'unavailable'); }
      }
      homes.push({ ...row, categories: row.categories.slice(0, 100).map(category => category.slice(0, 300)),
        categoriesShortened: row.categories.length > 100 || row.categories.some(category => category.length > 300),
        category: row.category?.slice(0, 300) ?? null, revision: current.revisions.get(row.hub), current: sources.get(row.hub) });
    }
    await currentScan(params);
    return { ...summary(current), ...planSummary(plan, current), homes, totalHomes: plan.rows.length, homeOffset: offset, homeLimit: limit, hasMoreHomes: offset + limit < plan.rows.length };
  }
  async function request(params = new URLSearchParams(), context) {
    if (!filingOptions(config.filing)) return summary();
    const op = params.get('op') ?? 'status';
    if (op === 'start') return start(params);
    if (op === 'advance') return advance(params, context);
    if (op === 'status') return params.has('scanId') ? summary(await currentScan(params)) : summary();
    if (op === 'page') return page(params);
    if (op === 'detail') return detail(params, context);
    throw new SourceEditError('invalid-request', 'Choose a supported filing report operation.');
  }
  return { request, invalidate };
}
