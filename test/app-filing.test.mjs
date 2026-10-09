import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, lstatSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAppFiling } from '../src/app-filing.mjs';
import { createDocumentLibrary } from '../src/app-library.mjs';
import { createSourceEditor } from '../src/source-editor.mjs';
import { resolveConfig } from '../src/config.mjs';
import { buildIndex } from '../src/index.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const table = rows => `| Plan | Status |\n|---|---|\n${rows}\n`;
const home = name => `| [Plan](${name}) | active |`;
const stamp = file => { const s = lstatSync(file); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; };
async function fixture(filing = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runlist-app-filing-')); roots.push(root);
  mkdirSync(path.join(root, 'docs/prompts'), { recursive: true }); mkdirSync(path.join(root, 'docs/excluded'));
  writeFileSync(path.join(root, 'runlist.config.mjs'), `export const root='docs';\nexport const filing=${JSON.stringify(filing)};\nexport const excludeDirs=['excluded'];\n`);
  const config = await resolveConfig(root), library = createDocumentLibrary(config);
  const actor = { kind: 'human', id: 'human:filing-test' };
  const editor = createSourceEditor({ config, authenticate: () => actor, authorize: ({ path: file }) => ({ allowed: !file.split(path.sep).some(part => ['prompts', 'excluded'].includes(part)) }), allowUnconfiguredRead: true });
  let reads = 0, fail = new Set();
  const readSource = documentPath => {
    reads++;
    if (fail.has(documentPath)) throw new Error('unavailable');
    return { ...editor.read(null, { path: documentPath }), stamp: stamp(path.join(root, documentPath)) };
  };
  const service = createAppFiling({ config, library, readSource });
  const write = (name, body = '', extra = '') => { const file = path.join(root, 'docs', name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `---\ntype: plan\nstatus: active\n${extra}---\n# ${name}\n\n${body}`); library.invalidate('docs/' + name); return 'docs/' + name; };
  const hub = (name, body) => write(name, body, 'execution_mode: coordination\n');
  const call = (op, params = {}) => service.request(new URLSearchParams({ op, ...params }));
  const scan = async () => { let result = await call('start', { refresh: '1' }); while (result.state === 'scanning') result = await call('advance', { scanId: result.scanId }); return result; };
  return { root, config, library, service, write, hub, call, scan, readSource, reads: () => reads, fail };
}

test('filing service is lazy and disabled filing never discovers or reads documents', async () => {
  let inventoryCalls = 0;
  const service = createAppFiling({ config: { filing: false }, library: { filingInventory() { inventoryCalls++; throw Error('must not run'); } }, readSource() { throw Error('must not read'); } });
  assert.equal(inventoryCalls, 0);
  assert.equal((await service.request(new URLSearchParams('op=start'))).state, 'disabled');
  assert.equal(inventoryCalls, 0);
  const f = await fixture(); f.hub('area.md', '');
  assert.equal(f.reads(), 0); assert.equal((await f.call('status')).state, 'idle'); assert.equal(f.reads(), 0);
});

test('GUI report shares CLI direct, inherited, category and duplicate-home evidence exactly', async () => {
  const f = await fixture(); f.write('parent.md'); f.write('child.md', '', 'parent_plan: "> parent.md"\n'); f.write('unfiled.md'); f.write('uncategorized.md');
  f.hub('root.md', '### Delivery\n| Hub | Notes |\n|---|---|\n| [Area](area.md) | Group |\n');
  f.hub('area.md', table(home('parent.md'))); f.hub('second.md', `### Other\n${table(home('parent.md'))}`); f.hub('uncategorized-hub.md', table(home('uncategorized.md')));
  const cli = buildIndex(f.config, { invokeHooks: false, gitStaleness: false }).filingCoverage;
  const result = await f.scan(); assert.equal(result.state, 'complete'); assert.deepEqual(result.totals, cli.totals);
  const page = await f.call('page', { scanId: result.scanId }); assert.equal(page.total, cli.plans.length);
  for (const plan of cli.plans) {
    const detail = await f.call('detail', { scanId: result.scanId, path: plan.path });
    assert.equal(detail.filing, plan.filing); assert.equal(detail.filedThrough, plan.filedThrough);
    assert.deepEqual(detail.homes.map(({ revision, current, categoriesShortened, ...row }) => row), plan.rows);
    assert.ok(detail.homes.every(home => home.current === 'unchanged'));
  }
  assert.equal((await f.call('page', { scanId: result.scanId, group: 'multiple', q: 'child' })).plans[0].path, 'docs/child.md');
  assert.equal((await f.call('page', { scanId: result.scanId, group: 'no-category' })).total, 1);
});

test('scans advance bounded metadata batches and pages/filtering do not reread hub sources', async () => {
  const f = await fixture(); for (let i = 0; i < 115; i++) f.write(`plans/${String(i).padStart(3, '0')}.md`);
  for (let i = 0; i < 19; i++) f.hub(`hub-${i}.md`, '');
  let result = await f.call('start', { refresh: '1' }); assert.equal(f.reads(), 0);
  while (result.state === 'scanning') {
    const before = f.reads(), progress = result.progress.done;
    result = await f.call('advance', { scanId: result.scanId });
    assert.ok(f.reads() - before <= 8); assert.ok(result.progress.done - progress <= 8);
  }
  assert.equal(f.reads(), 19); const before = f.reads();
  const first = await f.call('page', { scanId: result.scanId, limit: '999999' }); assert.equal(first.plans.length, 50); assert.equal(first.total, 115); assert.equal(first.hasMore, true);
  const second = await f.call('page', { scanId: result.scanId, offset: '50' }); assert.equal(second.plans.length, 50);
  const filtered = await f.call('page', { scanId: result.scanId, q: 'plans/11' }); assert.equal(filtered.total, 5); assert.equal(f.reads(), before);
  assert.ok(!JSON.stringify(first).includes('printedStatus'));
});

test('incomplete scans retain observed evidence without definite missing or unique-home claims', async () => {
  const f = await fixture(); f.write('filed.md'); f.write('missing.md'); f.hub('good.md', `### Delivery\n${table(home('filed.md'))}`); f.hub('unreadable.md', ''); f.fail.add('docs/unreadable.md');
  const result = await f.scan(); assert.equal(result.state, 'incomplete'); assert.equal(result.totals, null); assert.equal(result.failureCount, 1);
  const page = await f.call('page', { scanId: result.scanId });
  assert.equal(page.plans.find(plan => plan.path === 'docs/filed.md').filing, 'observed');
  assert.equal(page.plans.find(plan => plan.path === 'docs/missing.md').filing, 'unknown');
  assert.ok(page.plans.every(plan => plan.multiplyFiled === null && plan.noCategory === null));
  const filtered = await f.call('page', { scanId: result.scanId, group: 'unfiled' }); assert.equal(filtered.total, 0); assert.match(filtered.reason, /unavailable/);
  const detail = await f.call('detail', { scanId: result.scanId, path: 'docs/filed.md' }); assert.equal(detail.homes.length, 1);
});

test('metadata discovery failures and unsafe sources prevent complete coverage and leak no prompt body', async () => {
  const f = await fixture(); f.write('work.md'); f.hub('area.md', table(home('work.md')));
  const secret = f.write('prompts/secret.md', 'PRIVATE_FILING_BODY', 'execution_mode: coordination\n');
  symlinkSync(path.join(f.root, secret), path.join(f.root, 'docs/unsafe.md')); f.library.invalidate();
  writeFileSync(path.join(f.root, 'docs/incomplete-header.md'), '---\ntype: plan\n' + 'Long incomplete metadata '.repeat(8_000));
  const result = await f.scan(); assert.equal(result.complete, false); assert.ok(result.failureCount);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_FILING_BODY'));
  const page = await f.call('page', { scanId: result.scanId }); assert.ok(!page.plans.some(plan => plan.path.includes('prompts')));
});

test('generation invalidation rejects old scans and a fresh scan sees saved changes', async () => {
  const f = await fixture(); f.write('work.md'); const hub = f.hub('area.md', ''); const first = await f.scan();
  f.hub('area.md', `### Delivery\n${table(home('work.md'))}`);
  await assert.rejects(f.call('page', { scanId: first.scanId }), { code: 'filing-scan-stale' });
  const second = await f.scan(); assert.equal(second.totals.filedDirect, 1); assert.notEqual(second.scanId, first.scanId);
  f.service.invalidate(); await assert.rejects(f.call('detail', { scanId: second.scanId, path: 'docs/work.md' }), { code: 'filing-scan-stale' });
  assert.ok(readFileSync(path.join(f.root, hub), 'utf8').includes('work.md'));
});

test('a hub changed between metadata and body reads makes the scan incomplete', async () => {
  const f = await fixture(); f.write('work.md'); f.hub('area.md', '');
  const start = await f.call('start', { refresh: '1' });
  // External edit deliberately bypasses library invalidation.
  writeFileSync(path.join(f.root, 'docs/area.md'), '---\ntype: plan\nstatus: active\nexecution_mode: coordination\n---\n' + table(home('work.md')));
  let result = start; while (result.state === 'scanning') result = await f.call('advance', { scanId: result.scanId });
  assert.equal(result.complete, false); assert.equal(result.failureCount, 1); assert.equal(result.totals, null);
});

test('home details are lazy, bounded and mark changed source evidence without claiming a current line', async () => {
  const f = await fixture(); f.write('work.md'); f.hub('area.md', `### Delivery\n${table(Array.from({ length: 45 }, () => home('work.md')).join('\n'))}`);
  const result = await f.scan(), before = f.reads();
  await f.call('page', { scanId: result.scanId }); assert.equal(f.reads(), before);
  const detail = await f.call('detail', { scanId: result.scanId, path: 'docs/work.md', homeLimit: '999' });
  assert.equal(detail.homes.length, 20); assert.equal(detail.totalHomes, 45); assert.equal(detail.hasMoreHomes, true); assert.equal(f.reads(), before + 1);
  const file = path.join(f.root, 'docs/area.md'); writeFileSync(file, readFileSync(file, 'utf8') + '\nExternal edit.');
  const changed = await f.call('detail', { scanId: result.scanId, path: 'docs/work.md', homeOffset: '40' });
  assert.equal(changed.homes.length, 5); assert.ok(changed.homes.every(home => home.current === 'changed'));
});

test('bounded scans and lazy details retain the requesting adapter authentication context', async () => {
  const f = await fixture(); f.write('work.md'); f.hub('area.md', `### Delivery\n${table(home('work.md'))}`);
  const context = { authenticatedRequest: 'fixture authority' };
  let reads = 0;
  const service = createAppFiling({ config: f.config, library: f.library, readSource(documentPath, candidate) { assert.equal(candidate, context); reads++; return f.readSource(documentPath); } });
  let result = await service.request(new URLSearchParams('op=start&refresh=1'), context);
  while (result.state === 'scanning') result = await service.request(new URLSearchParams({ op: 'advance', scanId: result.scanId }), context);
  await service.request(new URLSearchParams({ op: 'detail', scanId: result.scanId, path: 'docs/work.md' }), context);
  assert.equal(reads, 2);
});
