import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolveConfig } from '../src/config.mjs';
import { createAppYardstick } from '../src/app-yardstick.mjs';
import { createSourceEditor, sourceRevision, SourceEditError } from '../src/source-editor.mjs';
import { parseSimpleFrontmatter, extractFrontmatter } from '../src/frontmatter.mjs';
import { preparePlanClaim } from '../src/pickup.mjs';
import { mutateFileSet } from '../src/atomic-mutation.mjs';
import { nativeFixture, nativeSource, recordId } from './native-fixtures.mjs';
import { documentYardstick } from '../assets/app/document-yardstick.mjs';

const roots = [], owner = { kind: 'human', id: 'human:yardstick-test', label: 'Fixture owner' };
const previousGlobals = Object.fromEntries(['document', 'localStorage', 'Option'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const source = '---\ntype: plan\nstatus: active\nupdated: 2026-10-09\ndelivers: Find project documents.\n---\n# Plan\n\nKeep this body.\n';
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, descriptor] of Object.entries(previousGlobals)) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
});
async function fixture(extra = '', options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runlist-app-yardstick-')); roots.push(root);
  mkdirSync(path.join(root, 'docs/plans'), { recursive: true }); mkdirSync(path.join(root, 'docs/prompts'));
  writeFileSync(path.join(root, 'runlist.config.mjs'), "export const root='docs';\nexport const yardstick='docs/goal.md';\n" + extra);
  writeFileSync(path.join(root, 'docs/goal.md'), '# Goal\n\nKeep documents useful.\n');
  const file = path.join(root, 'docs/plans/fixture.md'); writeFileSync(file, source);
  writeFileSync(path.join(root, 'docs/plans/replacement.md'), source.replace('# Plan', '# Replacement'));
  writeFileSync(path.join(root, 'docs/prompts/private.md'), '---\ntype: prompt\nstatus: pending\n---\nPrivate prompt.\n');
  const config = await resolveConfig(root), actor = context => context.actor ?? owner;
  const editor = createSourceEditor({ config, legacyTypes: ['plan', 'doc'], allowUnconfiguredRead: true,
    authenticate: actor, authorize: ({ path: file }) => ({ allowed: !file.split(path.sep).includes('prompts') }) });
  const read = (context, input) => {
    const doc = editor.read(context, { path: input }), metadata = parseSimpleFrontmatter(extractFrontmatter(doc.source).frontmatter);
    return { ...doc, path: path.relative(root, doc.path).split(path.sep).join('/'), type: metadata.type, status: metadata.status, metadata };
  };
  const service = createAppYardstick({ config, read, actor, ...options });
  const preview = (action = 'serves', more = {}) => service.preview({}, { path: 'docs/plans/fixture.md', action,
    expectedRevision: sourceRevision(readFileSync(file, 'utf8')), operationId: randomUUID(), ...more });
  return { root, file, config, read, service, preview };
}
const fm = file => parseSimpleFrontmatter(extractFrontmatter(readFileSync(file, 'utf8')).frontmatter);

test('information compares literal goal/delivery without writes, exposing only human assessment actions', async () => {
  const f = await fixture(), info = f.service.information({}, 'docs/plans/fixture.md');
  assert.equal(info.enabled, true); assert.equal(info.comparison.delivers, 'Find project documents.');
  assert.equal(info.comparison.assessment.disposition, null); assert.match(info.comparison.goal.statement, /Keep documents useful/);
  assert.deepEqual(info.actions, ['serves', 'clear', 'fold', 'close']);
  assert.equal(existsSync(path.join(f.root, '.runlist/editor/yardstick')), false);
});
test('preview is read-only and apply records once with actor-bound retry and Clear leaves status alone', async () => {
  const f = await fixture(), review = await f.preview('serves', { reason: 'Needed for the product.' });
  assert.equal(readFileSync(f.file, 'utf8'), source); assert.equal(review.state, 'reviewed');
  assert.doesNotMatch(JSON.stringify(review), /expectedContent|guards|requestHash/);
  assert.equal(f.service.list({}).items[0].kind, 'yardstick');
  const commit = await f.service.commit({}, review), recorded = readFileSync(f.file, 'utf8');
  assert.equal(commit.state, 'committed'); assert.equal(fm(f.file).yardstick_disposition, 'serves'); assert.equal(fm(f.file).status, 'active');
  assert.equal((await f.service.commit({}, review)).replayed, true); assert.equal(readFileSync(f.file, 'utf8'), recorded);
  assert.throws(() => f.service.inspect({ actor: { kind: 'human', id: 'human:other' } }, review), { code: 'forbidden' });
  assert.deepEqual(f.service.list({}).items, []);
  const cleared = await f.preview('clear'); await f.service.commit({}, cleared);
  assert.equal(fm(f.file).yardstick_disposition, undefined); assert.equal(fm(f.file).status, 'active');
});
test('Close and Fold archive through the CLI transaction and retain destination/history/replacement link', async () => {
  for (const action of ['close', 'fold']) {
    const f = await fixture(), review = await f.preview(action, { reason: 'Owner chose this outcome.', ...(action === 'fold' ? { into: 'docs/plans/replacement.md' } : {}) });
    assert.match(review.report, /Would move/); assert.match(review.newPath, /archived/); assert.equal(existsSync(f.file), true);
    const committed = await f.service.commit({}, review), target = path.join(f.root, committed.newPath);
    assert.equal(existsSync(f.file), false); assert.equal(fm(target).status, 'archived');
    assert.equal(fm(target).yardstick_disposition, action === 'fold' ? 'folded' : 'closed');
    assert.match(readFileSync(target, 'utf8'), /Keep this body|Owner chose this outcome/);
    if (action === 'fold') assert.equal(path.resolve(path.dirname(target), fm(target).yardstick_into), path.join(f.root, 'docs/plans/replacement.md'));
    assert.equal(f.service.inspect({}, review).current.path, committed.newPath);
    assert.equal((await f.service.commit({}, review)).replayed, true);
  }
});
test('review-time source, goal, replacement chain and config changes refuse apply without writes', async () => {
  for (const change of ['source', 'goal', 'replacement', 'config']) {
    const f = await fixture(), review = await f.preview('fold', { reason: 'Combine work.', into: 'docs/plans/replacement.md' });
    const file = change === 'source' ? f.file : path.join(f.root, change === 'goal' ? 'docs/goal.md' : change === 'replacement' ? 'docs/plans/replacement.md' : 'runlist.config.mjs');
    writeFileSync(file, readFileSync(file, 'utf8') + '\nExternal edit.\n');
    const before = readFileSync(f.file, 'utf8');
    await assert.rejects(f.service.commit({}, review), error => /changed|reload/i.test(error.message));
    assert.equal(readFileSync(f.file, 'utf8'), before); assert.equal(existsSync(path.join(f.root, review.newPath)), false);
  }
});
test('reviewed archive destination cannot silently change after a collision', async () => {
  const f = await fixture(), review = await f.preview('close', { reason: 'No longer needed.' });
  mkdirSync(path.dirname(path.join(f.root, review.newPath)), { recursive: true }); writeFileSync(path.join(f.root, review.newPath), 'Other content.');
  await assert.rejects(f.service.commit({}, review), /destination changed/);
  assert.equal(readFileSync(f.file, 'utf8'), source); assert.equal(readFileSync(path.join(f.root, review.newPath), 'utf8'), 'Other content.');
});
test('fold guards every replacement-chain member and refuses private intermediate plans', async () => {
  const f = await fixture(), replacement = path.join(f.root, 'docs/plans/replacement.md'), last = path.join(f.root, 'docs/plans/last.md');
  writeFileSync(last, source);
  writeFileSync(replacement, source.replace('status: active', 'status: active\nyardstick_disposition: folded\nyardstick_into: ./last.md'));
  const review = await f.preview('fold', { reason: 'Combined work.', into: 'docs/plans/replacement.md' });
  writeFileSync(last, source + '\nReplacement changed.\n');
  await assert.rejects(f.service.commit({}, review), /changed/); assert.equal(readFileSync(f.file, 'utf8'), source);
  writeFileSync(path.join(f.root, 'docs/prompts/private-plan.md'), source);
  writeFileSync(replacement, source.replace('status: active', 'status: active\nyardstick_disposition: folded\nyardstick_into: ../prompts/private-plan.md'));
  await assert.rejects(f.preview('fold', { reason: 'Combined work.', into: 'docs/plans/replacement.md' }), /authoriz|scope|source/i);
  assert.equal(readFileSync(f.file, 'utf8'), source);
});
test('new claims and cross-domain pending operations block assessments', async () => {
  const f = await fixture(), review = await f.preview();
  const claim = preparePlanClaim({ filePath: f.file, sourceContent: source, renderedContent: null, ownership: null,
    sessionId: 'fixture-agent', now: '2026-10-09T00:00:00Z', config: f.config });
  mutateFileSet(claim, { repoRoot: f.root });
  await assert.rejects(f.service.commit({}, review), { code: 'claim-conflict' });
  assert.equal(f.service.information({}, 'docs/plans/fixture.md').enabled, false);
  const blocked = await fixture('', { pending() { throw new SourceEditError('pending-draft', 'Save or discard the draft first.'); } });
  assert.equal(blocked.service.information({}, 'docs/plans/fixture.md').enabled, false);
  await assert.rejects(blocked.preview(), { code: 'pending-draft' });
});
test('structured plans retain comparisons only; unavailable goals still permit clearing a plain assessment', async () => {
  const f = await fixture(), record = nativeFixture(); record.type = 'plan'; record.id = recordId('plan', 8); record.status = 'active'; delete record.question;
  record.record_data = Object.fromEntries(['repository_id', 'created_by', 'aliases', 'evidence', 'relations', 'history', 'extensions'].map(key => [key, record.record_data[key]]));
  writeFileSync(f.file, nativeSource(record, '# Structured plan\n\nAuthored text.\n'));
  const info = f.service.information({}, 'docs/plans/fixture.md');
  assert.equal(info.enabled, false); assert.match(info.reason, /Structured plans/); assert.equal(info.comparison.goal.state, 'ready');
  await assert.rejects(f.preview(), { code: 'yardstick-unavailable' });
  writeFileSync(f.file, source); await f.service.commit({}, await f.preview()); rmSync(path.join(f.root, 'docs/goal.md'));
  assert.deepEqual(f.service.information({}, 'docs/plans/fixture.md').actions, ['clear']);
  await f.service.commit({}, await f.preview('clear')); assert.equal(fm(f.file).yardstick_disposition, undefined);
});
test('an explicit unconfigured folder can clear without discovering other JavaScript configuration', async () => {
  const f = await fixture(), absent = path.join(f.root, '.runlist-desktop-no-config');
  const config = await resolveConfig(f.root, absent), service = createAppYardstick({ config, read: f.read, actor: () => owner });
  const review = await service.preview({}, { path: 'docs/plans/fixture.md', action: 'clear', expectedRevision: sourceRevision(source), operationId: randomUUID() });
  writeFileSync(path.join(f.root, 'runlist.config.mjs'), "throw new Error('Do not discover this configuration.');\n");
  assert.equal((await service.commit({}, review)).state, 'committed');
  assert.equal(fm(f.file).status, 'active'); assert.equal(existsSync(absent), false);
});
test('invalid requests, self-fold, private target and missing reviews do not write', async () => {
  const f = await fixture();
  await assert.rejects(f.preview('close'), { code: 'invalid-request' });
  await assert.rejects(f.preview('bogus'), { code: 'invalid-request' });
  await assert.rejects(f.preview('fold', { reason: 'Combine.', into: 'docs/plans/fixture.md' }), /itself|circular/);
  await assert.rejects(f.preview('fold', { reason: 'Combine.', into: 'docs/prompts/private.md' }), { code: 'unsupported-source' });
  await assert.rejects(f.preview('serves', { actor: { kind: 'agent', id: 'spoof' } }), { code: 'invalid-request' });
  await assert.rejects(f.service.commit({}, { operationId: randomUUID() }), { code: 'operation-missing' });
  assert.equal(readFileSync(f.file, 'utf8'), source);
});
test('running receipts block every actor and retain inspect/acknowledge without replay', async () => {
  const f = await fixture(), review = await f.preview();
  const receipt = path.join(f.root, '.runlist/editor/yardstick', review.operationId + '.json'), value = JSON.parse(readFileSync(receipt, 'utf8'));
  value.state = 'running'; writeFileSync(receipt, JSON.stringify(value));
  assert.throws(() => f.service.assertIdle({ actor: { id: 'human:other', kind: 'human' } }, review.path), { code: 'yardstick-repair-required' });
  await assert.rejects(f.preview(), { code: 'yardstick-repair-required' });
  assert.equal(f.service.inspect({}, review).canAcknowledge, true); assert.equal(f.service.list({}).items[0].state, 'running');
  assert.throws(() => f.service.settle({}, { ...review, expectedRevision: 'sha256:' + '0'.repeat(64), note: 'Inspected.' }), { code: 'revision-conflict' });
  const settled = f.service.settle({}, { ...review, expectedRevision: sourceRevision(source), note: 'Inspected unchanged source and no transactions.' });
  assert.equal(settled.state, 'settled-unknown'); assert.equal(settled.settlement.by.id, owner.id);
  await assert.rejects(f.service.commit({}, review), { code: 'yardstick-settled' });
  assert.equal(readFileSync(f.file, 'utf8'), source); assert.equal(f.service.list({}).items.length, 0);
  assert.equal((await f.preview()).state, 'reviewed');
});
test('private receipt storage rejects symlinks and corrupt receipts', async () => {
  const f = await fixture(), review = await f.preview();
  const receipt = path.join(f.root, '.runlist/editor/yardstick', review.operationId + '.json'); writeFileSync(receipt, 'broken');
  await assert.rejects(f.service.commit({}, review), { code: 'state-corrupt' });
  const outside = mkdtempSync(path.join(os.tmpdir(), 'yardstick-outside-')); roots.push(outside);
  rmSync(path.dirname(receipt), { recursive: true }); symlinkSync(outside, path.dirname(receipt));
  await assert.rejects(f.preview(), { code: 'unsafe-local-state' }); assert.equal(readdirSync(outside).length, 0);
});

// The controller builds elements directly; only DOM primitives are doubled.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.className = ''; this.attributes = {}; this._text = ''; this.value = ''; this.disabled = false; this.open = false; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { for (const child of nodes) { child.parent = this; this.children.push(child); } }
  replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = value; }
  add(option) { this.append(option); }
  addEventListener(name, handler) { (this.events ??= {})[name] = handler; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  querySelectorAll(selector) {
    const matches = item => selector.startsWith('.') ? item.className.split(' ').includes(selector.slice(1))
      : selector.startsWith('[data-') ? Object.hasOwn(item.dataset, selector.slice(6, -1).replace(/-([a-z])/g, (_, char) => char.toUpperCase())) : item.tag === selector;
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
async function presentation(f) {
  const body = new Element('body'), panel = new Element('section'); panel.id = 'yardstick-panel'; body.append(panel);
  globalThis.document = { body, createElement: tag => new Element(tag) };
  globalThis.Option = class extends Element { constructor(text, value) { super('option'); this.textContent = text; this.value = value; } };
  const values = new Map(); globalThis.localStorage = { get length() { return values.size; }, key: i => [...values.keys()][i], getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const state = { doc: { ...f.read({}, 'docs/plans/fixture.md'), kind: 'plan', title: 'Fixture' }, busy: false, dirty: false, pending: null }, calls = [], notices = [], relocations = [];
  let controller, loaded = 0;
  const api = async (route, request) => {
    calls.push({ route, request });
    if (route.startsWith('yardstick?')) return f.service.information({}, new URLSearchParams(route.split('?')[1]).get('path'));
    if (route.startsWith('yardstick/')) return f.service[route.split('/')[1]]({}, request);
    if (route.startsWith('library?')) return { documents: [{ path: 'docs/plans/replacement.md', title: 'Replacement', type: 'plan' }], hasMore: false };
    throw new Error('Unexpected route: ' + route);
  };
  const open = async file => { state.doc = { ...f.read({}, file), kind: 'plan', title: 'Fixture' }; await controller.opened(); };
  controller = documentYardstick({ state, $: () => panel, api, checkout: () => f.root, open,
    library: { relocated: (...args) => relocations.push(args), async load() { loaded++; } }, notice: (...args) => notices.push(args) });
  await controller.opened();
  return { controller, panel, body, state, calls, notices, relocations, loaded: () => loaded };
}
test('yardstick presentation disables draft mutations and preserves literal goal and delivery', async () => {
  const f = await fixture(), ui = await presentation(f);
  assert.match(ui.panel.textContent, /Keep documents useful|Find project documents/);
  assert.equal(ui.panel.hidden, false); assert.equal(ui.calls.every(call => call.request === undefined), true);
  ui.state.dirty = true; ui.controller.update();
  const buttons = ui.panel.querySelectorAll('[data-yardstick-action]'); assert.equal(buttons.every(button => button.disabled), true);
  await buttons[0].onclick(); assert.equal(ui.body.querySelector('dialog'), null);
  ui.state.dirty = false; ui.state.recovery = { source: 'Unsaved draft', baseSource: source }; ui.controller.update();
  assert.equal(buttons.every(button => button.disabled), true); assert.match(ui.panel.textContent, /Save or discard/);
  ui.state.recovery = null; ui.controller.update(); assert.equal(buttons[0].disabled, false);
});
test('the goal panel bounds a long literal statement and links its full source', async () => {
  const f = await fixture(), statement = 'Long literal product goal. '.repeat(1000);
  writeFileSync(path.join(f.root, 'docs/goal.md'), statement);
  const ui = await presentation(f), excerpt = ui.panel.querySelector('.yardstick-goal').textContent;
  assert.ok(excerpt.length < 2100); assert.match(excerpt, /shortened; open the goal document/);
  assert.match(ui.panel.textContent, /Open goal · docs\/goal.md/);
  assert.equal(f.service.information({}, 'docs/plans/fixture.md').comparison.goal.statement, statement.trim());
});
test('a changed goal after panel opening is shown from the guarded prepared comparison', async () => {
  const f = await fixture(), ui = await presentation(f), goalFile = path.join(f.root, 'docs/goal.md');
  const newGoal = 'New literal product goal. '.repeat(150);
  writeFileSync(goalFile, newGoal);
  await ui.panel.querySelectorAll('[data-yardstick-action]')[0].onclick();
  const dialog = ui.body.querySelector('dialog');
  await dialog.querySelector('form').onsubmit({ preventDefault() {} });
  const goal = dialog.querySelector('.yardstick-reviewed-goal').textContent;
  assert.match(goal, /New literal product goal/); assert.doesNotMatch(goal, /Keep documents useful/);
  assert.ok(goal.length < 2100); assert.match(goal, /shortened/);
  assert.equal(dialog.querySelector('.yardstick-reviewed-delivers').textContent, 'Find project documents.');
  assert.equal(dialog.querySelector('.yardstick-reviewed-assessment').textContent, 'Serves the goal');
  const before = readFileSync(f.file, 'utf8'); writeFileSync(goalFile, 'Another goal after review.\n');
  await dialog.querySelector('[data-yardstick-apply]').onclick();
  assert.equal(readFileSync(f.file, 'utf8'), before); assert.match(ui.notices.at(-1)[0], /changed|Inspect/);
});
test('plan-typed hubs display the yardstick while doc-typed hubs do not', async () => {
  const f = await fixture(), ui = await presentation(f);
  ui.state.doc.kind = 'hub'; await ui.controller.opened(); assert.equal(ui.panel.hidden, false);
  assert.match(ui.panel.textContent, /Keep documents useful/);
  ui.state.doc.type = 'doc'; await ui.controller.opened(); assert.equal(ui.panel.hidden, true);
});
test('yardstick presentation reviews before apply, guards leave, and refreshes saved assessment', async () => {
  const f = await fixture(), ui = await presentation(f);
  await ui.panel.querySelectorAll('[data-yardstick-action]')[0].onclick();
  const dialog = ui.body.querySelector('dialog'); assert.equal(dialog.open, true); assert.throws(ui.controller.beforeLeave, /Close the current yardstick review/);
  dialog.querySelector('textarea').value = 'This serves the goal.';
  await dialog.querySelector('form').onsubmit({ preventDefault() {} });
  assert.equal(readFileSync(f.file, 'utf8'), source); assert.match(dialog.querySelector('pre').textContent, /Would record/);
  const apply = dialog.querySelector('[data-yardstick-apply]'); assert.equal(apply.disabled, false);
  await apply.onclick(); assert.equal(fm(f.file).yardstick_disposition, 'serves'); assert.equal(dialog.open, false);
  assert.equal(ui.loaded(), 1); assert.equal(ui.relocations.length, 1); assert.match(ui.panel.textContent, /Serves the goal/);
  assert.equal(localStorage.length, 0); assert.doesNotThrow(ui.controller.beforeLeave);
});
test('Fold presentation uses bounded plan search and archives only after reviewed confirmation', async () => {
  const f = await fixture(), ui = await presentation(f);
  await ui.panel.querySelectorAll('[data-yardstick-action]')[2].onclick();
  const dialog = ui.body.querySelector('dialog'), form = dialog.querySelector('form');
  await form.querySelectorAll('button')[0].onclick(); const search = ui.calls.find(call => call.route.startsWith('library?'));
  assert.equal(new URLSearchParams(search.route.split('?')[1]).get('limit'), '50');
  form.querySelector('select').value = 'docs/plans/replacement.md'; form.querySelector('textarea').value = 'Combined work.';
  await form.onsubmit({ preventDefault() {} }); assert.equal(existsSync(f.file), true);
  assert.match(dialog.querySelector('pre').textContent, /Would move/);
  await dialog.querySelector('[data-yardstick-apply]').onclick(); assert.equal(existsSync(f.file), false);
  assert.equal(fm(path.join(f.root, ui.state.doc.path)).yardstick_disposition, 'folded');
});
test('a lost apply response is inspected after restart and never automatically replayed', async () => {
  const f = await fixture(), review = await f.preview(); await f.service.commit({}, review);
  const ui = await presentation(f), prefix = `runlist:yardstick:${f.root}:${encodeURIComponent(review.path)}`;
  localStorage.setItem(prefix, JSON.stringify(review));
  const before = readFileSync(f.file, 'utf8'), writes = ui.calls.filter(call => call.route === 'yardstick/commit').length;
  const resolved = await ui.controller.resolveInitial(review.path);
  assert.equal(resolved, review.path); assert.equal(localStorage.length, 0); assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.equal(ui.calls.filter(call => call.route === 'yardstick/commit').length, writes);
});
