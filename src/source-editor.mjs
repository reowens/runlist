// Trusted local adapters supply authentication and policy. Never expose these
// callbacks, config, test hooks, or this factory as browser request parameters.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { assertSnapshotCurrent, createFileExclusive, MutationConflictError, replaceSnapshot, snapshotFile, withPathLocks } from './atomic-mutation.mjs';
import { authorizeManagedSource, authorizeManagedDestination, authorizeRepoGeneratedPath } from './managed-path.mjs';
import { canonicalPlanIdentity, readPlanOwnership } from './pickup.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { nativePlanItems, parseNativeRecord } from './native-record.mjs';
import { stateDir } from './naming.mjs';
import {getStageDefinitions, readPlanStage, readShipsFrontmatter} from './stages.mjs';
import {withoutSourceStage} from '../assets/app/stage-source.mjs';

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const revisionPattern = /^sha256:[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

export class SourceEditError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'SourceEditError'; this.code = code; this.details = details; }
}
function fail(code, message, details) { throw new SourceEditError(code, message, details); }

// Shared by narrative editing and lifecycle receipts. Trusted adapters only.
export function assertPrivateEditorStorage(repoRoot, directory) {
  // Draft bodies and before-images must never become shared repository data.
  // In a Git checkout require ignored AND untracked storage; do not alter Git.
  // Git may be missing/broken, and a configured root may sit below a checkout
  // or worktree. Inspect physical ancestors without suppressing stat failures.
  let gitContext = Boolean(process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_COMMON_DIR);
  try {
    for (let directory = realpathSync(repoRoot);;) {
      try { lstatSync(path.join(directory, '.git')); gitContext = true; break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch { fail('unsafe-local-state', 'Cannot inspect Git checkout markers before storing private editor state.'); }
  let git = false;
  try {
    const discovery = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    // A successful false/unexpected response is not a verified non-Git folder
    // (for example, this can be a bare repository or its metadata directory).
    if (discovery !== 'true') gitContext = true;
    else git = true;
  } catch { /* An ordinary non-Git folder remains usable without Git. */ }
  if (!git && gitContext) fail('unsafe-local-state', 'Cannot verify private editor storage in this Git checkout. Make Git available and ensure editor state is ignored and untracked before saving drafts or edits.');
  if (git) {
    const relative = path.relative(repoRoot, directory).split(path.sep).join('/');
    try {
      execFileSync('git', ['-C', repoRoot, 'check-ignore', '-q', '--', `${relative}/`], { stdio: 'ignore' });
      if (execFileSync('git', ['-C', repoRoot, 'ls-files', '--', relative], { encoding: 'utf8' }).trim()) throw new Error('tracked');
    } catch { fail('unsafe-local-state', 'Editor state must be ignored and untracked before storing drafts or before-images.'); }
  }
}
function text(source) {
  // Native UTF-16 validation rejects lone surrogates without allocating a full
  // UTF-8 buffer and decoded copy for every read, revision, draft and save.
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_SOURCE_BYTES
    || source.includes('\0') || !source.isWellFormed()) {
    fail('invalid-source', 'Source must be valid UTF-8 text of at most 8 MiB without NUL bytes.');
  }
  return source;
}
export function sourceRevision(source) { return `sha256:${hash(text(source))}`; }
function requireRevision(value) { if (!revisionPattern.test(value ?? '')) fail('invalid-revision', 'An exact SHA-256 source revision is required.'); }
function requireId(id) { if (!uuid.test(id ?? '')) fail('invalid-id', 'A lowercase UUID v4 operation or draft ID is required.'); }
function synchronous(value) { if (value?.then) fail('adapter-error', 'Editor authentication and authorization callbacks must be synchronous.'); return value; }
function principalKey(actor) { return hash(JSON.stringify([actor.kind, actor.id, actor.session_id ?? null])); }

// Include the raw closing fence/newline in the protected envelope. No parse /
// serialize pass is allowed to normalize unrelated source on a narrative save.
function envelope(source) {
  const match = source.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  return match?.[0] ?? '';
}
function historySections(source) {
  const sections = [];
  const lines = source.slice(envelope(source).length).match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let fence = null, history = null;
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (!fence && /^ {0,3}#{1,2}\s/.test(line)) {
      if (history !== null) { sections.push(history); history = null; }
      if (/^ {0,3}##\s+Version History\s*(?:#+\s*)?$/i.test(line.trimEnd())) history = '';
    }
    if (history !== null) history += line;
  }
  if (history !== null) sections.push(history);
  return sections;
}
function describe(source, legacyTypes = new Set(['plan'])) {
  const { frontmatter } = extractFrontmatter(source);
  const warnings = [];
  const fm = parseSimpleFrontmatter(frontmatter, warnings);
  if (fm.record_schema !== undefined) {
    const native = parseNativeRecord(source);
    return { type: fm.type, editable: native.ok, diagnostics: native.diagnostics };
  }
  const editable = legacyTypes.has(fm.type) && envelope(source) !== '' && warnings.length === 0;
  return { type: fm.type, editable, diagnostics: editable ? [] : [{ code: 'unsupported-source', message: 'Narrative editing requires an unambiguous configured document or valid native v1 record.' }] };
}
function validateEdit(before, after, legacyTypes, stagePolicy, undo = false) {
  text(after);
  if (envelope(before) !== envelope(after)) {
    const beforeMetadata = parseSimpleFrontmatter(extractFrontmatter(before).frontmatter);
    let stageOnly = false;
    try {stageOnly = stagePolicy?.allowed && beforeMetadata.type === 'plan'
      && withoutSourceStage(envelope(before)) === withoutSourceStage(envelope(after));} catch { /* Ambiguous metadata is never editable. */ }
    if (!stageOnly) {
      fail('managed-fields', 'Only the plan stage may change through this editor; other frontmatter is managed by domain operations.');
    }
    const selected = readPlanStage(readShipsFrontmatter(extractFrontmatter(after).frontmatter));
    if (!undo && (selected.invalid || (selected.word && stagePolicy.configured && !stagePolicy.words.has(selected.word)))) {
      fail('invalid-stage', 'Choose a configured stage or leave the stage unset.');
    }
  }
  if (JSON.stringify(historySections(before)) !== JSON.stringify(historySections(after))) fail('managed-fields', 'Lifecycle version history must be retained byte for byte.');
  const beforeItems = nativePlanItems(extractFrontmatter(before).body).map(item => item.id);
  const afterItems = nativePlanItems(extractFrontmatter(after).body).map(item => item.id);
  if (JSON.stringify(beforeItems) !== JSON.stringify(afterItems)) fail('managed-fields', 'Stable item anchors must be retained; allocation/removal belongs to domain operations.');
  for (const source of [before, after]) {
    const info = describe(source,legacyTypes);
    if (!info.editable) fail('invalid-record', 'Invalid or unsupported records are read-only.', { diagnostics: info.diagnostics });
  }
}
function conflict(expected, current) {
  fail('revision-conflict', 'The source changed; review the current source and keep the draft before retrying.', { expectedRevision: expected, currentRevision: sourceRevision(current), currentSource: current });
}

export function createSourceEditor({ config, authenticate, authorize, testHooks = {}, legacyTypes = ['plan'], allowUnconfiguredRead = false, allowStageEdits = false, domainPrepare = null }) {
  if (!config?.repoRoot || typeof authenticate !== 'function' || typeof authorize !== 'function') fail('adapter-error', 'A repository config and explicit authentication and authorization callbacks are required.');
  legacyTypes = new Set(legacyTypes.filter(type=>!['prompt','flag','decision'].includes(type)));
  const stagePolicy = {allowed:allowStageEdits === true, configured:Array.isArray(config.raw?.taxonomy?.milestones ?? config.taxonomy?.milestones), words:new Set(getStageDefinitions(config).map(stage=>stage.word))};
  // Snapshot trusted configuration; a caller cannot widen roots after issuance.
  config = { repoRoot: path.resolve(config.repoRoot), docsRoots: config.docsRoots ? [...config.docsRoots] : undefined, docsRoot: config.docsRoot };
  const options = { repoRoot: config.repoRoot, locked: true };
  const root = path.join(stateDir(config.repoRoot), 'editor');
  const generated = candidate => {
    const authorized = authorizeRepoGeneratedPath(candidate, config, { kind: 'Private editor state' }).path;
    let cursor = config.repoRoot;
    for (const segment of path.relative(config.repoRoot, authorized).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) fail('unsafe-local-state', 'Editor state may not traverse symlinks.');
    }
    return authorized;
  };
  const operations = path.join(root, 'operations');
  // Keep only bounded terminal receipt metadata, never before/after bodies.
  // Every reuse checks the complete on-disk byte hash, not just timestamps.
  const validatedReceipts = new Map();
  const receiptBuffer = Buffer.allocUnsafe(64 * 1024);
  function identity(context) {
    const actor = synchronous(authenticate(context));
    if (!actor || !['human', 'agent'].includes(actor.kind) || typeof actor.id !== 'string' || !actor.id.trim()
      || (actor.kind === 'agent' && (typeof actor.session_id !== 'string' || !actor.session_id.trim()))) {
      fail('unauthenticated', 'The trusted adapter must identify a human or an agent with its actual session.');
    }
    return { kind: actor.kind, id: actor.id, ...(actor.label ? { label: String(actor.label) } : {}), ...(actor.kind === 'agent' ? { session_id: actor.session_id } : {}) };
  }
  function permit(actor, action, filePath) {
    const grant = synchronous(authorize({ actor: structuredClone(actor), action, path: filePath }));
    if (grant?.allowed !== true || (actor.kind === 'agent' && (typeof grant.grant_id !== 'string' || !grant.grant_id.trim()))) {
      fail('forbidden', 'The actor lacks verified, path-scoped authority for this operation.');
    }
    return actor.kind === 'agent' ? grant.grant_id : null;
  }
  function managed(input) {
    if (typeof input !== 'string' || !input) fail('invalid-path', 'A configured Markdown path is required.');
    const filePath = authorizeManagedSource(path.resolve(config.repoRoot, input), config).path;
    const type = describe(text(readFileSync(filePath, 'utf8'))).type;
    if (type === 'prompt' || (!legacyTypes.has(type) && !['flag','decision'].includes(type) && !allowUnconfiguredRead)) fail('unsupported-source', 'This source is outside the adapter’s supported document types.');
    return filePath;
  }
  function sourceSnapshot(filePath) {
    authorizeManagedSource(filePath, config);
    const snapshot = snapshotFile(filePath);
    text(snapshot.content);
    if (!readFileSync(filePath).equals(Buffer.from(snapshot.content))) fail('invalid-source', 'Source is not a stable valid UTF-8 file.');
    return snapshot;
  }
  function durableDirectory(directory) {
    generated(directory);
    if (existsSync(directory)) {
      if (!lstatSync(directory).isDirectory()) fail('unsafe-local-state', 'Editor state directories must be directories.');
      return;
    }
    durableDirectory(path.dirname(directory));
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      generated(directory);
      if (!lstatSync(directory).isDirectory()) throw error;
    }
    let fd;
    try { fd = openSync(path.dirname(directory), 'r'); fsyncSync(fd); }
    catch (error) { if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EACCES', 'EBADF', 'EISDIR'].includes(error.code)) throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  function localState() {
    generated(root);
    assertPrivateEditorStorage(config.repoRoot, root);
    durableDirectory(operations);
  }
  function readState(filePath, onRead = null) {
    generated(filePath);
    if (!existsSync(filePath)) return null;
    try {
      if (!lstatSync(filePath).isFile() || lstatSync(filePath).size > 32 * 1024 * 1024) throw new Error('size');
      const raw = readFileSync(filePath, 'utf8');
      const value = JSON.parse(raw);
      if (value.schema !== 1) throw new Error('schema');
      onRead?.(raw);
      return value;
    } catch { fail('state-corrupt', 'Private editor state requires inspection; it will not be overwritten.', { statePath: filePath }); }
  }
  function writeState(filePath, value) {
    generated(filePath);
    durableDirectory(path.dirname(filePath));
    validatedReceipts.delete(value.id);
    if (existsSync(filePath)) replaceSnapshot(snapshotFile(filePath), json(value), options);
    else createFileExclusive(filePath, json(value), { ...options, mode: 0o600 });
  }
  const operationPath = id => { requireId(id); return generated(path.join(operations, `${id}.json`)); };
  function receipt(id, remember = false) {
    let digest;
    const value = readState(operationPath(id), remember ? raw => { digest = hash(raw); } : null);
    if (value && (value.id !== id || !['prepared', 'committed', 'not-applied', 'settled-unknown'].includes(value.state)
      || !value.actor || typeof value.path !== 'string' || !['save', 'undo', 'native-action'].includes(value.kind)
      || value.beforeRevision !== sourceRevision(value.before) || value.afterRevision !== sourceRevision(value.after))) {
      fail('state-corrupt', 'Operation receipt is inconsistent; no source will be written.', { operationId: id });
    }
    if (remember && value && value.state !== 'prepared') {
      if (validatedReceipts.size >= 256) validatedReceipts.delete(validatedReceipts.keys().next().value);
      validatedReceipts.set(id, { digest, summary: { id, state: value.state, path: Buffer.from(value.path).toString('utf8') } });
    }
    return value;
  }
  function receiptDigest(filePath) {
    generated(filePath);
    let fd;
    const same = (a, b) => ['dev','ino','size','mtimeNs','ctimeNs','mode'].every(key => a[key] === b[key]);
    try {
      const before = lstatSync(filePath, { bigint: true });
      if (!before.isFile() || before.size > 32n * 1024n * 1024n) throw new Error('size');
      fd = openSync(filePath, 'r');
      if (!same(before, fstatSync(fd, { bigint: true }))) throw new Error('changed');
      const digest = createHash('sha256');
      let count, bytes = 0;
      while ((count = readSync(fd, receiptBuffer, 0, receiptBuffer.length, null)) > 0) {
        bytes += count;
        if (bytes > Number(before.size)) throw new Error('changed');
        digest.update(receiptBuffer.subarray(0, count));
      }
      generated(filePath);
      if (bytes !== Number(before.size) || !same(before, fstatSync(fd, { bigint: true }))
        || !same(before, lstatSync(filePath, { bigint: true }))) throw new Error('changed');
      return digest.digest('hex');
    } catch { fail('state-corrupt', 'Private editor state requires inspection; it will not be overwritten.', { statePath: filePath }); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  function scanReceipt(id) {
    const cached = validatedReceipts.get(id);
    if (cached && receiptDigest(operationPath(id)) === cached.digest) return cached.summary;
    validatedReceipts.delete(id);
    // A changed/new receipt is fully parsed and validated. Prepared receipts
    // always retain the existing full-body recovery path, including restart.
    return receipt(id, true);
  }
  function own(value, actor) { if (principalKey(value.actor) !== principalKey(actor)) fail('forbidden', 'This operation or draft belongs to another actor.'); }
  function result(value) {
    return { operationId: value.id, state: value.state, revision: value.state === 'committed' ? value.afterRevision : value.settledRevision ?? value.beforeRevision, actor: value.actor, grantId: value.grantId, affectedFiles: value.state === 'committed' && value.before !== value.after ? [value.path] : [], undoOf: value.undoOf ?? null };
  }
  function reconcile(value, current) {
    if (value.state !== 'prepared') return value;
    if (current === value.after) {
      value = { ...value, state: 'committed', recovered: true };
      writeState(operationPath(value.id), value);
    } else if (current !== value.before) {
      fail('repair-required', 'Publication outcome is unknown after an intervening edit; inspect the retained before/after images.', { operationId: value.id, currentRevision: sourceRevision(current) });
    }
    return value;
  }
  function claimPath(filePath) {
    const key = canonicalPlanIdentity(filePath, config).key;
    return generated(path.join(stateDir(config.repoRoot), 'ownership', `${key}.json`));
  }
  function claimGuard(actor, filePath) {
    const ownership = readPlanOwnership(path.relative(config.repoRoot, filePath), config);
    if (ownership?.corrupt) fail('claim-conflict', 'Repair corrupt ownership through the CLI before saving.');
    // No implicit takeover, even of a dead claim. The human editor is distinct
    // from the launching agent; release/reclaim remains an explicit CLI action.
    if (ownership?.state === 'owned' && (actor.kind !== 'agent' || ownership.sessionId !== actor.session_id)) {
      fail('claim-conflict', 'The plan is owned by another session; coordinate or release it through the CLI.', { sessionId: ownership.sessionId });
    }
  }
  const domainHash = request => hash(JSON.stringify([request.action,request.note,request.optionId??null,request.at]));
  function mutate(context, request, kind) {
    requireId(request.operationId); requireRevision(request.expectedRevision);
    const actor = identity(context);
    const filePath = managed(request.path);
    permit(actor, kind, filePath);
    localState();
    return withPathLocks([filePath, root, claimPath(filePath)], { repoRoot: config.repoRoot }, () => {
      if (principalKey(identity(context)) !== principalKey(actor)) fail('unauthenticated', 'Actor identity changed while waiting for the operation lock.');
      const grantId = permit(actor, kind, filePath);
      claimGuard(actor, filePath);
      const ownershipPath = claimPath(filePath);
      const ownershipSnapshot = existsSync(ownershipPath) ? snapshotFile(ownershipPath) : null;
      const snapshot = sourceSnapshot(filePath);
      let prior = receipt(request.operationId);
      if (prior) {
        own(prior, actor);
        if (prior.path !== filePath || prior.kind !== kind || prior.beforeRevision !== request.expectedRevision
          || (kind !== 'undo' ? prior.after !== request.source : prior.undoOf !== request.undoOf)
          || (kind === 'native-action' && prior.requestHash !== domainHash(request))) fail('operation-reused', 'Operation ID was already bound to a different request.');
        prior = reconcile(prior, snapshot.content);
        if (prior.state === 'committed') return { ...result(prior), replayed: true, currentRevision: sourceRevision(snapshot.content) };
        if (prior.state !== 'prepared') fail('operation-settled', 'This operation was settled without applying; use a new ID after review.');
      }
      // Discover interrupted operations before a newer save obscures their
      // publication evidence. A pending before-image is retried by its owner.
      for (const name of readdirSync(operations)) {
        if (!name.endsWith('.json')) continue;
        const pending = scanReceipt(name.slice(0, -5));
        if (pending.id !== request.operationId && pending.path === filePath && pending.state === 'prepared') {
          const recovered = reconcile(pending, snapshot.content);
          if (recovered.state === 'prepared') fail('operation-pending', 'Retry or settle the interrupted operation before saving.', { operationId: pending.id });
        }
      }
      if (sourceRevision(snapshot.content) !== request.expectedRevision) conflict(request.expectedRevision, snapshot.content);
      let after = request.source;
      if (kind === 'undo') {
        const original = receipt(request.undoOf);
        if (!original) fail('operation-missing', 'Undo requires a retained committed operation.');
        own(original, actor);
        if (original.path !== filePath || original.state !== 'committed' || original.afterRevision !== request.expectedRevision) fail('undo-conflict', 'Undo requires the original operation’s exact resulting revision.');
        // Compensating edit under a new operation ID, with an exact revision
        // precondition. Never replay claims, lifecycle hooks, or Git state.
        after = original.before;
      }
      if(kind==='native-action'){
        if(typeof domainPrepare!=='function')fail('unsupported-operation','This adapter has no native domain writer.');
        if(!prior && Math.abs(Date.now()-Date.parse(request.at))>5*60*1000)fail('review-expired','Reload and review this action with a fresh recording date.');
        after=synchronous(domainPrepare(snapshot.content,request,actor));
        if(after!==request.source)fail('review-conflict','The submitted source differs from the reviewed domain action.');
      }else validateEdit(snapshot.content, after,legacyTypes,stagePolicy,kind==='undo');
      const value = prior ? { ...prior, grantId } : { schema: 1, id: request.operationId, kind, undoOf: kind === 'undo' ? request.undoOf : null, path: filePath, actor, grantId, at: new Date().toISOString(), state: 'prepared', ...(kind==='native-action'?{requestHash:domainHash(request)}:{}), before: snapshot.content, after, beforeRevision: request.expectedRevision, afterRevision: sourceRevision(after) };
      writeState(operationPath(value.id), value);
      testHooks.afterPrepare?.(value);
      try {
        if (permit(actor, kind, filePath) !== grantId) fail('authority-changed', 'Authority changed during preparation; review and retry with current authority.');
        if (ownershipSnapshot) assertSnapshotCurrent(ownershipSnapshot);
        else if (existsSync(ownershipPath)) fail('claim-conflict', 'Ownership appeared while preparing the source save.');
        if (after !== snapshot.content) replaceSnapshot(snapshot, after, { ...options, testHooks: testHooks.atomic });
        testHooks.afterPublish?.(value);
      } catch (error) {
        // Keep WAL evidence when publication or durability is uncertain. No
        // blind rollback can clobber an external editor's later generation.
        if (error instanceof MutationConflictError) conflict(request.expectedRevision, sourceSnapshot(filePath).content);
        throw error;
      }
      const committed = { ...value, state: 'committed' };
      writeState(operationPath(value.id), committed);
      return result(committed);
    });
  }
  function draftPath(actor, id) { requireId(id); return generated(path.join(root, 'drafts', principalKey(actor), `${id}.json`)); }
  function draft(context, request, action) {
    const actor = identity(context), filePath = managed(request.path);
    permit(actor, action, filePath);
    const location = draftPath(actor, request.draftId);
    if (action !== 'read-draft') localState();
    return withPathLocks([location], { repoRoot: config.repoRoot }, () => {
      permit(actor, action, filePath);
      const previous = readState(location);
      if (previous) {
        const { revision, ...fields } = previous;
        if (previous.id !== request.draftId || revision !== `sha256:${hash(json(fields))}`) fail('state-corrupt', 'Draft state is inconsistent; it will not be overwritten.');
        own(previous, actor);
        if (previous.path !== filePath) fail('draft-reused', 'Draft ID is already bound to another document.');
      }
      if (action === 'read-draft') {
        if (!previous || previous.discarded) return null;
        return { ...previous, stale: sourceRevision(sourceSnapshot(filePath).content) !== previous.baseRevision };
      }
      const previousRevision = previous?.discarded ? null : previous?.revision ?? null;
      if (previousRevision !== request.expectedDraftRevision) fail('draft-conflict', 'A newer draft exists; it will not be overwritten.', { currentDraftRevision: previousRevision });
      const discarded = action === 'discard-draft';
      if (!discarded) {
        text(request.source); text(request.baseSource); requireRevision(request.baseRevision);
        if (sourceRevision(request.baseSource) !== request.baseRevision) fail('invalid-revision', 'Draft base source does not match its revision.');
      }
      const value = { schema: 1, id: request.draftId, actor, path: filePath, discarded, baseRevision: discarded ? null : request.baseRevision, baseSource: discarded ? null : request.baseSource, source: discarded ? null : request.source, at: new Date().toISOString() };
      if (!discarded && request.pendingOperation != null) {
        const pending = request.pendingOperation;
        requireId(pending.operationId); requireRevision(pending.expectedRevision);
        if (!['save','undo'].includes(pending.kind) || pending.expectedRevision !== request.baseRevision) fail('invalid-request','The interrupted save must refer to this draft base.');
        if (pending.kind === 'undo') requireId(pending.undoOf);
        value.pendingOperation = { operationId:pending.operationId,kind:pending.kind,expectedRevision:pending.expectedRevision,...(pending.kind === 'undo' ? {undoOf:pending.undoOf} : {}) };
      }
      value.revision = `sha256:${hash(json(value))}`;
      writeState(location, value);
      return value;
    });
  }
  return Object.freeze({
    listRecovery(context, {path:requestedPath=null} = {}) {
      const actor=identity(context),items=[];let unavailable=0;
      const candidates=(directory)=>{
        generated(directory);if(!existsSync(directory))return [];
        if(!lstatSync(directory).isDirectory())fail('unsafe-local-state','Recovery storage must be a directory.');
        return readdirSync(directory).filter(name=>uuid.test(name.slice(0,-5))&&name.endsWith('.json'));
      };
      function scoped(value,action) {
        own(value,actor);
        const file=authorizeManagedDestination(value.path,config).path;
        permit(actor,action,file);
        if(requestedPath && path.resolve(config.repoRoot,requestedPath)!==file)return null;
        return file;
      }
      const directory=generated(path.join(root,'drafts',principalKey(actor)));
      for(const name of candidates(directory)) {
        try {
          const value=readState(generated(path.join(directory,name)));
          if(!value||value.discarded)continue;
          const {revision,...fields}=value;
          if(value.id!==name.slice(0,-5)||revision!==`sha256:${hash(json(fields))}`||sourceRevision(value.baseSource)!==value.baseRevision)fail('state-corrupt','Draft needs inspection.');
          const file=scoped(value,'read-draft');if(!file||value.source===value.baseSource&&!value.pendingOperation)continue;
          let stale=false,available=true;
          try{stale=sourceRevision(sourceSnapshot(managed(file)).content)!==value.baseRevision;}catch{available=false;}
          items.push({kind:'draft',draftId:value.id,path:file,at:value.at,stale,available,pendingOperation:value.pendingOperation??null});
        }catch{unavailable++;}
      }
      for(const name of candidates(operations)) {
        try {
          const raw=readState(operationPath(name.slice(0,-5)));
          if(!raw||!raw.actor||principalKey(raw.actor)!==principalKey(actor)||raw.state!=='prepared')continue;
          const value=receipt(name.slice(0,-5)),file=scoped(value,'inspect-operation');if(!file)continue;
          let available=true;try{managed(file);}catch{available=false;}
          items.push({kind:'operation',operationId:value.id,path:file,at:value.at,state:value.state,available});
        }catch{unavailable++;}
      }
      return {items,unavailable};
    },
    read(context, request) {
      const actor = identity(context), filePath = managed(request.path);
      permit(actor, 'read', filePath);
      const source = sourceSnapshot(filePath).content;
      return { path: filePath, source, revision: sourceRevision(source), ...describe(source,legacyTypes) };
    },
    nativeAction: (context, request) => mutate(context, request, 'native-action'),
    save: (context, request) => mutate(context, request, 'save'),
    undo: (context, request) => mutate(context, request, 'undo'),
    putDraft: (context, request) => draft(context, request, 'write-draft'),
    readDraft: (context, request) => draft(context, request, 'read-draft'),
    discardDraft: (context, request) => draft(context, request, 'discard-draft'),
    inspectOperation(context, request) {
      const actor = identity(context), value = receipt(request.operationId);
      if (!value) return null;
      own(value, actor); permit(actor, 'inspect-operation', managed(value.path));
      return { ...value, currentRevision: sourceRevision(sourceSnapshot(value.path).content) };
    },
    settleOperation(context, request) {
      requireRevision(request.expectedRevision);
      if (request.disposition !== 'leave-current') fail('invalid-repair', 'Settlement requires an explicit leave-current disposition after inspection.');
      const actor = identity(context), value = receipt(request.operationId);
      if (!value) fail('operation-missing', 'No operation receipt exists.');
      own(value, actor); const filePath = managed(value.path);
      permit(actor, 'settle-operation', filePath); localState();
      return withPathLocks([root, filePath], { repoRoot: config.repoRoot }, () => {
        if (principalKey(identity(context)) !== principalKey(actor)) fail('unauthenticated', 'Actor identity changed while waiting for the operation lock.');
        permit(actor, 'settle-operation', filePath);
        const current = sourceSnapshot(filePath).content, latest = receipt(value.id);
        if (sourceRevision(current) !== request.expectedRevision) conflict(request.expectedRevision, current);
        if (latest.state !== 'prepared') return result(latest);
        const state = current === latest.after ? 'committed' : current === latest.before ? 'not-applied' : 'settled-unknown';
        const settled = { ...latest, state, settledAt: new Date().toISOString(), settledRevision: request.expectedRevision };
        writeState(operationPath(value.id), settled);
        return result(settled);
      });
    },
  });
}
