import { afterEach, describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSourceEditor, sourceRevision } from '../src/source-editor.mjs';
import { canonicalPlanIdentity, preparePlanClaim, readPlanOwnership } from '../src/pickup.mjs';
import { mutateFileSet } from '../src/atomic-mutation.mjs';

const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../src/source-editor.mjs')).href;
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const human = { kind: 'human', id: 'human:fixture-owner' };
const agent = { kind: 'agent', id: 'agent:fixture', session_id: 'fixture-session' };
const base = '---\ntype: plan\nstatus: active\ncustom: untouched\n---\n# Fixture\n\nOriginal paragraph 🧭.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<!-- unknown comment -->\n```mjs\nconst sample = 1;\n```\n\n## Version History\n\n- Existing lifecycle entry.\n';
const changed = raw => raw.replace('Original paragraph 🧭.', 'Edited paragraph 先 🧭.');
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(raw = base, git = false) {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'runlist-editor-')); dirs.push(repoRoot);
  mkdirSync(path.join(repoRoot, 'docs'));
  const file = path.join(repoRoot, 'docs', 'fixture.md'); writeFileSync(file, raw);
  if (git) {
    strictEqual(spawnSync('git', ['init', '-q'], { cwd: repoRoot }).status, 0);
    writeFileSync(path.join(repoRoot, '.gitignore'), '.runlist/\n');
  }
  const config = { repoRoot, docsRoot: path.join(repoRoot, 'docs') };
  const make = extra => createSourceEditor({ config, authenticate: () => human, authorize: () => ({ allowed: true }), ...extra });
  const request = (n, source = changed(raw), expectedRevision = sourceRevision(raw)) => ({ path: file, operationId: id(n), expectedRevision, source });
  return { repoRoot, file, config, make, request, editor: make(), raw };
}
const code = expected => error => error.code === expected;

// Exercise executable discovery in a separate process without changing the
// test runner's PATH or substituting the editor's Git implementation.
function storageProbe(f, environment = {}, checkBlockedLifecycle = true) {
  const script = `
    import {createSourceEditor, sourceRevision} from ${JSON.stringify(moduleUrl)};
    import {createAppLifecycle} from ${JSON.stringify(new URL('../src/app-lifecycle.mjs', import.meta.url).href)};
    const config = JSON.parse(process.argv[1]), file = process.argv[2], source = process.argv[3];
    const editor = createSourceEditor({config, authenticate:()=>({kind:'human',id:'human:fixture-owner'}), authorize:()=>({allowed:true})});
    const attempt = action => { try { action(); return 'accepted'; } catch(error) { return error.code ?? error.message; } };
    const draft = attempt(()=>editor.putDraft({}, {path:file,draftId:${JSON.stringify(id(90))},expectedDraftRevision:null,baseSource:source,baseRevision:sourceRevision(source),source:source.replace('Original','Private draft')}));
    const save = attempt(()=>editor.save({}, {path:file,operationId:${JSON.stringify(id(91))},expectedRevision:sourceRevision(source),source:source.replace('Original','Saved')}));
    // These lifecycle regressions test rejection before filesystem writes;
    // successful lifecycle I/O has its own platform qualification and suite.
    const lifecycle = createAppLifecycle({config, read:()=>{}, actor:()=>({kind:'human',id:'human:fixture-owner'})});
    let lifecycleCommit='not-tested';
    if (${JSON.stringify(checkBlockedLifecycle)}) { try { await lifecycle.commit({}, {operationId:${JSON.stringify(id(92))}}); lifecycleCommit='accepted'; } catch(error) { lifecycleCommit=error.code ?? error.message; } }
    console.log(JSON.stringify({draft,save,lifecycleCommit}));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(f.config), f.file, f.raw], {
    encoding: 'utf8', env: { ...process.env, ...environment }
  });
  strictEqual(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
function absentGit(f) {
  const directory = path.join(f.repoRoot, 'empty-path'); mkdirSync(directory);
  return { PATH: directory };
}
function blockedStorage(f, environment) {
  deepStrictEqual(storageProbe(f, environment), { draft: 'unsafe-local-state', save: 'unsafe-local-state', lifecycleCommit: 'unsafe-local-state' });
  strictEqual(readFileSync(f.file, 'utf8'), f.raw);
  strictEqual(existsSync(path.join(f.repoRoot, '.runlist/editor')), false);
}

describe('safe source editing core', () => {
  it('validates Unicode scalars and exact byte limits without changing source revision bytes', () => {
    const codepoint = '先 🧭';
    strictEqual(sourceRevision(codepoint),sourceRevision(Buffer.from(codepoint).toString('utf8')));
    for (const source of ['\ud800','\udc00','\ud800x','x\udc00','\0','x'.repeat(8*1024*1024+1)]) {
      throws(()=>sourceRevision(source), code('invalid-source'));
    }
    ok(sourceRevision('x'.repeat(8*1024*1024)).startsWith('sha256:'));
  });
  it('preserves all unrelated CRLF bytes and stores a durable actor-attributed result without changing Git or claims', () => {
    const f = fixture(base.replaceAll('\n', '\r\n'), true);
    const beforeIndex = spawnSync('git', ['ls-files', '--stage'], { cwd: f.repoRoot, encoding: 'utf8' }).stdout;
    const opened = f.editor.read({}, { path: f.file });
    strictEqual(opened.source, f.raw); strictEqual(opened.editable, true);
    const saved = f.editor.save({}, f.request(1));
    strictEqual(saved.state, 'committed'); deepStrictEqual(saved.actor, human);
    deepStrictEqual(saved.affectedFiles, [f.file]); strictEqual(readFileSync(f.file, 'utf8'), changed(f.raw));
    strictEqual(f.make().inspectOperation({}, { operationId: id(1) }).before, f.raw);
    strictEqual(readPlanOwnership('docs/fixture.md', f.config), null);
    strictEqual(spawnSync('git', ['ls-files', '--stage'], { cwd: f.repoRoot, encoding: 'utf8' }).stdout, beforeIndex);
    if (process.platform !== 'win32') strictEqual(statSync(path.join(f.repoRoot, '.runlist/editor/operations', `${id(1)}.json`)).mode & 0o777, 0o600);
  });

  it('returns the current source on stale revisions and never accepts missing preconditions or managed-field/history edits', () => {
    const f = fixture(); writeFileSync(f.file, base.replace('Original', 'External'));
    throws(() => f.editor.save({}, f.request(2)), error => error.code === 'revision-conflict' && error.details.currentSource.includes('External'));
    const f2 = fixture();
    throws(() => f2.editor.save({}, { ...f2.request(2), expectedRevision: undefined }), code('invalid-revision'));
    for (const source of [base.replace('status: active', 'status: archived'), base.replace('custom: untouched', 'custom: lost'), base.replace('Existing lifecycle entry.', 'Rewritten history.')]) {
      throws(() => f2.editor.save({}, f2.request(2, source)), code('managed-fields'));
    }
    strictEqual(readFileSync(f2.file, 'utf8'), base);
  });

  it('does not inherit a launching session or accept request-supplied identity and requires verified agent grants', () => {
    const f = fixture();
    throws(() => createSourceEditor({ config: f.config }), code('adapter-error'));
    const unauthenticated = f.make({ authenticate: () => null });
    throws(() => unauthenticated.save({ actor: human }, { ...f.request(3), actor: human }), code('unauthenticated'));
    throws(() => f.make({ authenticate: async () => human }).read({}, { path: f.file }), code('adapter-error'));
    throws(() => f.make({ authenticate: () => ({ ...agent, session_id: undefined }) }).save({}, f.request(3)), code('unauthenticated'));
    throws(() => f.make({ authenticate: () => agent }).save({}, f.request(3)), code('forbidden'));
    throws(() => f.make({ authorize: () => ({ allowed: false }) }).save({}, f.request(3)), code('forbidden'));
    const verified = f.make({ authenticate: () => agent, authorize: ({ actor, action, path: file }) => ({ allowed: actor.id === agent.id && action === 'save' && file === f.file, grant_id: 'verified:fixture-grant' }) });
    const result = verified.save({}, { ...f.request(3), actor: human });
    deepStrictEqual(result.actor, agent); strictEqual(result.grantId, 'verified:fixture-grant');
  });

  it('respects live/unverifiable claims and locks the same ownership participant as CLI mutations', () => {
    const f = fixture(base.replace('status: active', 'status: in-session'));
    const prepared = preparePlanClaim({ filePath: f.file, sourceContent: f.raw, renderedContent: null, ownership: null, sessionId: agent.session_id, now: '2026-10-05T00:00:00Z', config: f.config });
    mutateFileSet(prepared, { repoRoot: f.repoRoot });
    const originalOwnership = readFileSync(prepared.recordPath, 'utf8');
    throws(() => f.editor.save({}, f.request(4)), code('claim-conflict'));
    throws(() => f.make({ authenticate: () => ({ ...agent, session_id: 'other-session' }), authorize: () => ({ allowed: true, grant_id: 'verified:fixture' }) }).save({}, f.request(4)), code('claim-conflict'));
    f.make({ authenticate: () => agent, authorize: () => ({ allowed: true, grant_id: 'verified:fixture' }) }).save({}, f.request(4));
    strictEqual(readFileSync(prepared.recordPath, 'utf8'), originalOwnership);
    strictEqual(canonicalPlanIdentity(f.file, f.config).key, prepared.identity.key);
  });

  it('rechecks revoked authority before publication and retains a not-applied receipt for explicit settlement', () => {
    const f = fixture(); let allowed = true;
    const editor = f.make({ authenticate: () => agent, authorize: () => ({ allowed, grant_id: 'verified:fixture' }), testHooks: { afterPrepare: () => { allowed = false; } } });
    throws(() => editor.save({}, f.request(19)), code('forbidden'));
    strictEqual(readFileSync(f.file, 'utf8'), base);
    const fresh = f.make({ authenticate: () => agent, authorize: () => ({ allowed: true, grant_id: 'verified:fixture' }) });
    strictEqual(fresh.inspectOperation({}, { operationId: id(19) }).state, 'prepared');
    const settled = fresh.settleOperation({}, { operationId: id(19), expectedRevision: sourceRevision(base), disposition: 'leave-current' });
    strictEqual(settled.state, 'not-applied'); deepStrictEqual(settled.affectedFiles, []);
    strictEqual(readFileSync(f.file, 'utf8'), base);
  });

  it('persists private drafts across reload, reports stale bases, and protects against two-tab draft overwrite', () => {
    const f = fixture(base, true);
    const request = { path: f.file, draftId: id(5), expectedDraftRevision: null, baseSource: base, baseRevision: sourceRevision(base), source: changed(base) };
    const stored = f.editor.putDraft({}, request);
    strictEqual(readFileSync(f.file, 'utf8'), base);
    const fresh = f.make(); strictEqual(fresh.readDraft({}, request).source, changed(base));
    throws(() => fresh.putDraft({}, { ...request, source: 'stale tab' }), code('draft-conflict'));
    writeFileSync(f.file, base.replace('Original', 'External'));
    strictEqual(fresh.readDraft({}, request).stale, true);
    strictEqual(f.make({ authenticate: () => ({ ...human, id: 'human:other' }) }).readDraft({}, request), null);
    fresh.discardDraft({}, { ...request, expectedDraftRevision: stored.revision });
    strictEqual(f.make().readDraft({}, request), null);
    f.make().putDraft({}, request); // A discarded ID can be reused after restart.
    const drafts = path.join(f.repoRoot, '.runlist/editor/drafts');
    if (process.platform !== 'win32') strictEqual(statSync(path.join(drafts, readdirSync(drafts)[0], `${id(5)}.json`)).mode & 0o777, 0o600);
  });

  it('refuses shared/tracked local storage, escaping paths and symlinked state without writing source', () => {
    const f = fixture(base, true); writeFileSync(path.join(f.repoRoot, '.gitignore'), '');
    throws(() => f.editor.save({}, f.request(6)), code('unsafe-local-state'));
    strictEqual(readFileSync(f.file, 'utf8'), base);
    throws(() => f.editor.read({}, { path: '../outside.md' }));
    writeFileSync(path.join(f.repoRoot, '.gitignore'), '.runlist/\n');
    mkdirSync(path.join(f.repoRoot, '.runlist/editor'), { recursive: true });
    writeFileSync(path.join(f.repoRoot, '.runlist/editor/tracked.json'), '{}');
    strictEqual(spawnSync('git', ['add', '-f', '.runlist/editor/tracked.json'], { cwd: f.repoRoot }).status, 0);
    throws(() => f.editor.save({}, f.request(6)), code('unsafe-local-state'));
    if (process.platform !== 'win32') {
      const s = fixture(); mkdirSync(path.join(s.repoRoot, 'shared'));
      symlinkSync(path.join(s.repoRoot, 'shared'), path.join(s.repoRoot, '.runlist'));
      throws(() => s.editor.putDraft({}, { path: s.file, draftId: id(6), expectedDraftRevision: null, baseSource: base, baseRevision: sourceRevision(base), source: changed(base) }), code('unsafe-local-state'));
      strictEqual(readdirSync(path.join(s.repoRoot, 'shared')).length, 0);
    }
  });

  it('blocks drafts and before-images in a Git checkout when Git is unavailable, even when storage is ignored', () => {
    for (const ignored of [false, true]) {
      const f = fixture(base, true);
      if (!ignored) writeFileSync(path.join(f.repoRoot, '.gitignore'), '');
      blockedStorage(f, absentGit(f));
    }
  });

  it('blocks drafts and before-images when installed Git fails to discover the checkout', () => {
    const f = fixture(base, true);
    writeFileSync(path.join(f.repoRoot, '.git/config'), '[broken configuration');
    const discovery = spawnSync('git', ['-C', f.repoRoot, 'rev-parse', '--is-inside-work-tree']);
    ok(discovery.status !== 0);
    blockedStorage(f, {});
  });

  it('detects a checkout above the configured root when Git is unavailable', () => {
    const parent = fixture(base, true);
    const repoRoot = path.join(parent.repoRoot, 'nested'); mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    const file = path.join(repoRoot, 'docs/fixture.md'); writeFileSync(file, base);
    const f = { repoRoot, file, raw: base, config: { repoRoot, docsRoot: path.join(repoRoot, 'docs') } };
    blockedStorage(f, absentGit(f));
  });

  it('recognizes real worktree Git files and verifies storage again on every write', () => {
    const parent = fixture(base, true);
    for (const args of [['add', '.gitignore', 'docs/fixture.md'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
      const git = spawnSync('git', args, { cwd: parent.repoRoot, encoding: 'utf8' }); strictEqual(git.status, 0, git.stderr);
    }
    const repoRoot = path.join(parent.repoRoot, 'worktree');
    const git = spawnSync('git', ['worktree', 'add', '--detach', repoRoot], { cwd: parent.repoRoot, encoding: 'utf8' }); strictEqual(git.status, 0, git.stderr);
    ok(statSync(path.join(repoRoot, '.git')).isFile());
    const f = { repoRoot, file: path.join(repoRoot, 'docs/fixture.md'), raw: base, config: { repoRoot, docsRoot: path.join(repoRoot, 'docs') } };
    blockedStorage(f, absentGit(f));
    deepStrictEqual(storageProbe(f, {}, false), { draft: 'accepted', save: 'accepted', lifecycleCommit: 'not-tested' });
    const retained = readFileSync(path.join(repoRoot, '.runlist/editor/operations', `${id(91)}.json`), 'utf8');
    f.raw = readFileSync(f.file, 'utf8');
    deepStrictEqual(storageProbe(f, { PATH: path.join(repoRoot, 'empty-path') }), { draft: 'unsafe-local-state', save: 'unsafe-local-state', lifecycleCommit: 'unsafe-local-state' });
    strictEqual(readFileSync(f.file, 'utf8'), f.raw);
    strictEqual(readFileSync(path.join(repoRoot, '.runlist/editor/operations', `${id(91)}.json`), 'utf8'), retained);
  });

  it('blocks broken worktree markers and explicit Git contexts without Git', () => {
    const worktree = fixture(); writeFileSync(path.join(worktree.repoRoot, '.git'), 'gitdir: missing-worktree-metadata\n');
    blockedStorage(worktree, {});
    const context = fixture(); blockedStorage(context, { ...absentGit(context), GIT_DIR: path.join(context.repoRoot, 'missing-git-dir') });
  });

  it('keeps genuine non-Git folders editable without a Git executable', () => {
    const f = fixture();
    deepStrictEqual(storageProbe(f, absentGit(f), false), { draft: 'accepted', save: 'accepted', lifecycleCommit: 'not-tested' });
    strictEqual(readFileSync(f.file, 'utf8'), base.replace('Original', 'Saved'));
  });

  it('makes retries idempotent across reload and detects operation-ID reuse and foreign ownership', () => {
    const f = fixture(); f.editor.save({}, f.request(7));
    writeFileSync(f.file, changed(base).replace('Edited', 'Later external'));
    const replay = f.make().save({}, f.request(7));
    strictEqual(replay.replayed, true); strictEqual(replay.currentRevision, sourceRevision(readFileSync(f.file, 'utf8')));
    throws(() => f.make().save({}, f.request(7, base)), code('operation-reused'));
    throws(() => f.make({ authenticate: () => ({ ...human, id: 'human:other' }) }).save({}, f.request(7)), code('forbidden'));
    strictEqual(readFileSync(f.file, 'utf8'), changed(base).replace('Edited', 'Later external'));
  });

  it('does not reset corrupted receipts or silently overwrite damaged drafts', () => {
    const f = fixture(); f.editor.save({}, f.request(20));
    const location = path.join(f.repoRoot, '.runlist/editor/operations', `${id(20)}.json`);
    writeFileSync(location, '{broken');
    throws(() => f.make().save({}, f.request(20)), code('state-corrupt'));
    strictEqual(readFileSync(f.file, 'utf8'), changed(base)); strictEqual(readFileSync(location, 'utf8'), '{broken');
    const g = fixture();
    const request = { path: g.file, draftId: id(21), expectedDraftRevision: null, baseSource: base, baseRevision: sourceRevision(base), source: changed(base) };
    const stored = g.editor.putDraft({}, request);
    const drafts = path.join(g.repoRoot, '.runlist/editor/drafts');
    const draftFile = path.join(drafts, readdirSync(drafts)[0], `${id(21)}.json`);
    const damaged = JSON.parse(readFileSync(draftFile, 'utf8')); damaged.source = 'different draft'; writeFileSync(draftFile, JSON.stringify(damaged));
    throws(() => g.make().readDraft({}, request), code('state-corrupt'));
    throws(() => g.make().putDraft({}, { ...request, expectedDraftRevision: stored.revision }), code('state-corrupt'));
    strictEqual(readFileSync(g.file, 'utf8'), base);
  });

  it('rechecks complete receipt bytes after warm saves, including same-size corruption with restored mtime', () => {
    const f = fixture();
    f.editor.save({}, f.request(100));
    f.editor.save({}, f.request(101, base, sourceRevision(changed(base))));
    const location = path.join(f.repoRoot, '.runlist/editor/operations', `${id(100)}.json`);
    const before = statSync(location), raw = readFileSync(location, 'utf8');
    const damaged = raw.replace('Original paragraph', 'Corrupt! paragraph');
    strictEqual(Buffer.byteLength(damaged), Buffer.byteLength(raw));
    writeFileSync(location, damaged); utimesSync(location, before.atime, before.mtime);
    throws(() => f.editor.save({}, f.request(102)), code('state-corrupt'));
    strictEqual(readFileSync(f.file, 'utf8'), base);
    strictEqual(readFileSync(location, 'utf8'), damaged);
  });

  it('fully revalidates a cached terminal receipt changed to prepared and preserves retry recovery', () => {
    const f = fixture();
    f.editor.save({}, f.request(110));
    f.editor.save({}, f.request(111, base, sourceRevision(changed(base))));
    const location = path.join(f.repoRoot, '.runlist/editor/operations', `${id(110)}.json`);
    const prepared = JSON.parse(readFileSync(location, 'utf8')); prepared.state = 'prepared';
    writeFileSync(location, JSON.stringify(prepared));
    throws(() => f.editor.save({}, f.request(112)), error => error.code === 'operation-pending' && error.details.operationId === id(110));
    strictEqual(readFileSync(f.file, 'utf8'), base);
    strictEqual(f.editor.save({}, f.request(110)).state, 'committed');
    strictEqual(f.make().inspectOperation({}, { operationId:id(110) }).before, base);
  });

  it('rejects symlink replacement of a previously validated terminal receipt', () => {
    const f = fixture();
    f.editor.save({}, f.request(120));
    f.editor.save({}, f.request(121, base, sourceRevision(changed(base))));
    const location = path.join(f.repoRoot, '.runlist/editor/operations', `${id(120)}.json`);
    const copy = path.join(f.repoRoot, 'receipt-copy.json'); writeFileSync(copy, readFileSync(location));
    rmSync(location); symlinkSync(copy, location);
    throws(() => f.editor.save({}, f.request(122)), /symlink/);
    strictEqual(readFileSync(f.file, 'utf8'), base);
  });

  it('uses a new compensating operation for undo and refuses to overwrite an intervening edit', () => {
    const f = fixture(); const saved = f.editor.save({}, f.request(8));
    const undo = { path: f.file, operationId: id(9), undoOf: id(8), expectedRevision: saved.revision };
    const reversed = f.make().undo({}, undo);
    strictEqual(reversed.undoOf, id(8)); strictEqual(readFileSync(f.file, 'utf8'), base);
    strictEqual(f.make().undo({}, undo).replayed, true);
    const g = fixture(); const original = g.editor.save({}, g.request(8));
    writeFileSync(g.file, changed(base).replace('Edited', 'Later external'));
    throws(() => g.editor.undo({}, { ...undo, path: g.file, expectedRevision: original.revision }), code('revision-conflict'));
    throws(() => g.editor.undo({}, { ...undo, path: g.file, expectedRevision: sourceRevision(readFileSync(g.file, 'utf8')) }), code('undo-conflict'));
    strictEqual(readFileSync(g.file, 'utf8'), changed(base).replace('Edited', 'Later external'));
  });

  it('retains WAL evidence after an external publication race and settles unknown outcomes without touching source', () => {
    const f = fixture(); const external = base.replace('Original', 'External');
    const racing = f.make({ testHooks: { atomic: { beforeReplacePublish: () => writeFileSync(f.file, external) } } });
    throws(() => racing.save({}, f.request(10)), code('revision-conflict'));
    strictEqual(f.make().inspectOperation({}, { operationId: id(10) }).state, 'prepared');
    throws(() => f.editor.save({}, f.request(11, changed(external), sourceRevision(external))), code('repair-required'));
    throws(() => f.editor.settleOperation({}, { operationId: id(10), expectedRevision: sourceRevision(external) }), code('invalid-repair'));
    throws(() => f.editor.settleOperation({}, { operationId: id(10), expectedRevision: sourceRevision(base), disposition: 'leave-current' }), code('revision-conflict'));
    const settled = f.editor.settleOperation({}, { operationId: id(10), expectedRevision: sourceRevision(external), disposition: 'leave-current' });
    strictEqual(settled.state, 'settled-unknown'); deepStrictEqual(settled.affectedFiles, []);
    strictEqual(readFileSync(f.file, 'utf8'), external);
    throws(() => f.editor.save({}, f.request(10)), code('operation-settled'));
    f.editor.save({}, f.request(11, external.replace('External', 'Reviewed'), sourceRevision(external)));
  });

  it('keeps unsupported/malformed native records readable and draftable, and preserves native item identity', () => {
    const item = `item:${id(12)}`;
    const metadata = { repository_id: `repo:${id(13)}`, created_by: human, aliases: [], evidence: [], relations: [], history: [] };
    const raw = `---\nrecord_schema: runlist.record/v1\nid: plan:${id(14)}\ntype: plan\nstatus: active\ncreated: 2026-10-05T00:00:00Z\nupdated: 2026-10-05T00:00:00Z\nrecord_data: |-\n  ${JSON.stringify(metadata)}\n---\n# Plan\n\nOriginal paragraph 🧭.\n\n<!-- runlist:item ${item} -->\n- [ ] Existing task\n`;
    const f = fixture(raw); strictEqual(f.editor.read({}, { path: f.file }).editable, true);
    throws(() => f.editor.save({}, f.request(12, changed(raw).replace(item, `item:${id(99)}`))), code('managed-fields'));
    f.editor.save({}, f.request(12, changed(raw).replace('[ ]', '[x]')));
    const invalid = fixture(raw.replace('runlist.record/v1', 'runlist.record/v9'));
    const opened = invalid.editor.read({}, { path: invalid.file }); strictEqual(opened.editable, false); strictEqual(opened.source, invalid.raw);
    throws(() => invalid.editor.save({}, invalid.request(13)), code('invalid-record'));
    invalid.editor.putDraft({}, { path: invalid.file, draftId: id(13), expectedDraftRevision: null, baseRevision: sourceRevision(invalid.raw), baseSource: invalid.raw, source: changed(invalid.raw) });
    strictEqual(readFileSync(invalid.file, 'utf8'), invalid.raw);
  });

  it('recovers actual process exits before and after publication without duplicate writes', () => {
    for (const phase of ['afterPrepare', 'afterPublish']) {
      const f = fixture();
      const script = `import {createSourceEditor} from ${JSON.stringify(moduleUrl)}; const editor=createSourceEditor({config:${JSON.stringify(f.config)},authenticate:()=>(${JSON.stringify(human)}),authorize:()=>({allowed:true}),testHooks:{${phase}:()=>process.exit(71)}});editor.save({},${JSON.stringify(f.request(15))});`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      strictEqual(child.status, 71, child.stderr);
      strictEqual(readFileSync(f.file, 'utf8'), phase === 'afterPrepare' ? base : changed(base));
      if (phase === 'afterPrepare') throws(() => f.make().save({}, f.request(16)), code('operation-pending'));
      const recovered = f.make().save({}, f.request(15)); strictEqual(recovered.state, 'committed');
      strictEqual(readFileSync(f.file, 'utf8'), changed(base));
      strictEqual(f.make().save({}, f.request(15)).replayed, true);
    }
  });

  it('allows exactly one of two concurrent processes to save the same base revision', async () => {
    const f = fixture();
    const run = n => new Promise((resolve, reject) => {
      const script = `import {createSourceEditor} from ${JSON.stringify(moduleUrl)};const e=createSourceEditor({config:${JSON.stringify(f.config)},authenticate:()=>(${JSON.stringify(human)}),authorize:()=>({allowed:true})});try{e.save({},${JSON.stringify(f.request(n, base.replace('Original', `Writer ${n}`)))});process.stdout.write('committed');}catch(e){process.stdout.write(e.code||e.message);}`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
      let output = '', errors = ''; child.stdout.on('data', value => output += value); child.stderr.on('data', value => errors += value);
      child.on('error', reject); child.on('close', status => status === 0 ? resolve(output) : reject(new Error(errors)));
    });
    const results = await Promise.all([run(17), run(18)]);
    deepStrictEqual(results.sort(), ['committed', 'revision-conflict']);
    ok(/Writer (17|18)/.test(readFileSync(f.file, 'utf8')));
  });
});
