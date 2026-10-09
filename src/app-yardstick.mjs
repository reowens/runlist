// Human-scoped yardstick reviews share CLI assessment and archive semantics.
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, lstatSync, mkdirSync, readdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { authorizeRepoGeneratedPath, authorizeManagedDestination } from './managed-path.mjs';
import { currentProcessOwner, processStartIdentity, processOwnerLiveness, inspectTransactions, withPathLocks, snapshotFile, replaceSnapshot, createFileExclusive } from './atomic-mutation.mjs';
import { readPlanOwnership, canonicalPlanIdentity } from './pickup.mjs';
import { stateDir } from './naming.mjs';
import { SourceEditError, sourceRevision, assertPrivateEditorStorage } from './source-editor.mjs';
import { compareYardstick, readYardstick } from './yardstick.mjs';
import { isArchivedPath } from './util.mjs';
import { isBundledRunlistRuntime } from './desktop-runtime.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ACTIONS = new Set(['serves', 'clear', 'fold', 'close']);
const fail = (code, message) => { throw new SourceEditError(code, message); };
const json = value => JSON.stringify(value, null, 2) + '\n';
const activeJobs = new Set();
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');

function runWorker(request, onStart) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/SESSION|^CODEX_|^OPENCODE_/.test(key)) delete env[key];
    const child = fork(new URL('./app-lifecycle-worker.mjs', import.meta.url), [], {
      env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: isBundledRunlistRuntime(process.execPath) ? ['--max-old-space-size=256', '--max-semi-space-size=4'] : [],
    });
    let report = '', result, truncated = false;
    const timer = setTimeout(() => { child.kill(); reject(new SourceEditError('yardstick-uncertain', 'The yardstick runner timed out. Inspect its retained operation before retrying.')); }, 60_000);
    const append = data => { const text = String(data); if (report.length + text.length > 128000) truncated = true; report += text.slice(0, Math.max(0, 128000 - report.length)); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('message', value => { result = value; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', () => {
      clearTimeout(timer);
      if (!result) return reject(new SourceEditError('yardstick-uncertain', 'The yardstick runner stopped. Inspect its retained operation before retrying.'));
      if (!result.ok) return reject(new SourceEditError(result.code === 'lifecycle-conflict' ? 'revision-conflict' : result.code, result.message, { report }));
      resolve({ result: result.result, guards: result.guards, report: report.replace(/\x1b\[[0-9;]*m/g, '') + (truncated ? '\n[Report shortened.]\n' : '') });
    });
    try {
      onStart?.({ ...currentProcessOwner(), pid: child.pid, processStartIdentity: processStartIdentity(child.pid), processStartedAt: new Date().toISOString() });
      child.send({ ...request, kind: 'yardstick' });
    } catch (error) { child.kill(); clearTimeout(timer); reject(error); }
  });
}

export function createAppYardstick({ config, read, actor, pending = () => {} }) {
  const directory = path.join(stateDir(config.repoRoot), 'editor', 'yardstick');
  // Match the desktop's explicit no-config authority instead of discovering
  // newly added JavaScript while applying a review from an unconfigured folder.
  const configPath = config.configPath ?? path.join(config.repoRoot, '.runlist-desktop-no-config');
  const safe = input => {
    let file;
    try { file = authorizeRepoGeneratedPath(input, config, { kind: 'Yardstick receipt' }).path; }
    catch (error) { fail('unsafe-local-state', error.message); }
    let current = config.repoRoot;
    for (const part of path.relative(config.repoRoot, file).split(path.sep)) {
      current = path.join(current, part);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('unsafe-local-state', 'Yardstick receipts may not traverse symlinks.');
    }
    return file;
  };
  const location = id => { if (!UUID.test(id ?? '')) fail('invalid-id', 'A UUID v4 operation is required.'); return safe(path.join(directory, `${id}.json`)); };
  function storage() {
    assertPrivateEditorStorage(config.repoRoot, directory);
    const make = dir => {
      safe(dir);
      if (existsSync(dir)) { if (!lstatSync(dir).isDirectory()) fail('unsafe-local-state', 'Receipt storage must be a directory.'); return; }
      make(path.dirname(dir)); mkdirSync(dir, { mode: 0o700 });
      let fd;
      try { fd = openSync(path.dirname(dir), 'r'); fsyncSync(fd); }
      catch (error) { if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EACCES', 'EBADF', 'EISDIR'].includes(error.code)) throw error; }
      finally { if (fd !== undefined) closeSync(fd); }
    };
    make(directory);
  }
  function receipt(id) {
    const file = location(id);
    if (!existsSync(file)) return null;
    if (!lstatSync(file).isFile() || lstatSync(file).size > 16 * 1024 * 1024) fail('state-corrupt', 'Inspect the yardstick receipt before continuing.');
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (value.id !== id || value.schema !== 1 || !['reviewed', 'running', 'committed', 'failed', 'settled-unknown'].includes(value.state)
        || !ACTIONS.has(value.action) || typeof value.path !== 'string' || typeof value.newPath !== 'string'
        || value.file !== path.resolve(config.repoRoot, value.path) || !value.actor || !Array.isArray(value.guards)
        || value.guards[0]?.path !== value.file || typeof value.guards[0]?.expectedContent !== 'string'
        || sourceRevision(value.guards[0].expectedContent) !== value.expectedRevision
        || value.reason !== null && typeof value.reason !== 'string' || value.into !== null && typeof value.into !== 'string') throw new Error('invalid');
      return value;
    } catch { fail('state-corrupt', 'Inspect the yardstick receipt before continuing.'); }
  }
  function write(value) {
    const file = location(value.id), content = json(value);
    if (Buffer.byteLength(content) > 16 * 1024 * 1024) fail('review-too-large', 'This review is too large to retain safely. Use the CLI for this assessment.');
    if (existsSync(file)) replaceSnapshot(snapshotFile(file), content, { repoRoot: config.repoRoot, locked: true });
    else createFileExclusive(file, content, { repoRoot: config.repoRoot, locked: true, mode: 0o600 });
  }
  function own(context, value) {
    const current = actor(context);
    if (current.kind !== 'human' || current.kind !== value.actor.kind || current.id !== value.actor.id) fail('forbidden', 'This yardstick review belongs to another actor.');
  }
  // Cross-domain guard: inspect all receipts, regardless of actor ownership.
  // Retained reviews do not lock a source; only uncertain/running writes do.
  function assertIdle(_context, input, exceptId = null) {
    if (existsSync(directory)) {
      safe(directory);
      for (const name of readdirSync(directory).filter(n => n.endsWith('.json'))) {
        const value = receipt(name.slice(0, -5));
        if (value?.id !== exceptId && value?.state === 'running' && [value.path, value.newPath].includes(input)) fail('yardstick-repair-required', 'Inspect the interrupted yardstick operation before starting another change.');
      }
    }
  }
  function eligible(context, input, exceptId = null) {
    const doc = read(context, input);
    if (doc.type !== 'plan') fail('yardstick-unavailable', 'Yardstick assessments apply only to plans.');
    if (!doc.editable) fail('yardstick-unavailable', 'Repair this plan’s source before recording a yardstick assessment.');
    if (doc.metadata?.record_schema) fail('yardstick-unavailable', 'Structured plans can display the yardstick; their assessment and archive actions are not available yet.');
    const claim = readPlanOwnership(doc.path, config);
    if (claim?.corrupt || claim?.state === 'owned' || doc.status === 'in-session') fail('claim-conflict', 'This plan is claimed. Coordinate or release its claim through the CLI first.');
    assertIdle(context, doc.path, exceptId);
    pending(context, doc.path, exceptId);
    return doc;
  }
  const comparison = doc => compareYardstick(doc.metadata, config, readYardstick(config), isArchivedPath(doc.path, config) && config.lifecycle.archiveStatuses.has(doc.status));
  function information(context, input) {
    const doc = read(context, input), compared = comparison(doc);
    try {
      eligible(context, input);
      const actions = compared.goal.state === 'ready' ? [...ACTIONS] : ['clear'];
      return { path: doc.path, comparison: compared, enabled: true, actions };
    } catch (error) { return { path: doc.path, comparison: compared, enabled: false, actions: [], reason: error.message }; }
  }
  function argv(value) {
    return [value.action === 'serves' ? 'mark' : value.action, value.file,
      ...(value.action === 'serves' ? ['serves'] : []), ...(value.reason ? ['--reason', value.reason] : []),
      ...(value.action === 'fold' ? ['--into', value.into] : [])];
  }
  const requestFor = (value, dryRun) => ({ repoRoot: config.repoRoot, configPath,
    argv: argv(value), dryRun, guards: value.guards, ...(dryRun ? {} : { expectedDestination: path.resolve(config.repoRoot, value.newPath) }) });
  const publicReview = value => ({ kind: 'yardstick', operationId: value.id, path: value.path, newPath: value.newPath,
    action: value.action, reason: value.reason, into: value.into ? relative(config.repoRoot, value.into) : null, expectedRevision: value.expectedRevision,
    assessment: value.assessment, comparison: value.comparison ?? null, report: value.report, state: value.state, result: value.result ?? null });
  async function preview(context, request) {
    if (!request || Object.keys(request).some(key => !['path', 'action', 'reason', 'into', 'expectedRevision', 'operationId'].includes(key))) fail('invalid-request', 'Supply a plan, assessment and source revision.');
    const doc = eligible(context, request.path), who = actor(context);
    if (who.kind !== 'human') fail('forbidden', 'The application yardstick runner is human scoped.');
    location(request.operationId);
    if (!ACTIONS.has(request.action)) fail('invalid-request', 'Choose Serves, Clear, Fold or Close.');
    if (doc.revision !== request.expectedRevision) fail('revision-conflict', 'The plan changed. Reload it before reviewing an assessment.');
    if (request.reason !== undefined && (typeof request.reason !== 'string' || !request.reason.trim() || request.reason.length > 4000 || request.reason.includes('\0'))) fail('invalid-request', 'Give a nonempty reason, up to 4,000 characters.');
    if (['fold', 'close'].includes(request.action) && !request.reason?.trim()) fail('invalid-request', 'Closing or folding requires an owner reason.');
    let into = null;
    if (request.action === 'fold') {
      if (typeof request.into !== 'string' || !request.into.trim()) fail('invalid-request', 'Select an existing replacement plan.');
      const target = read(context, request.into);
      if (target.type !== 'plan') fail('invalid-request', 'Select an existing replacement plan.');
      into = path.resolve(config.repoRoot, target.path);
    } else if (request.into !== undefined) fail('invalid-request', 'Only Fold can name a replacement plan.');
    const file = path.resolve(config.repoRoot, doc.path), owner = path.join(stateDir(config.repoRoot), 'ownership', canonicalPlanIdentity(file, config).key + '.json');
    const guards = [{ path: file, expectedContent: doc.source }, existsSync(owner) ? { path: owner, expectedContent: readFileSync(owner, 'utf8') } : { path: owner, absent: true }];
    guards.push(existsSync(configPath) ? { path: configPath, expectedContent: readFileSync(configPath, 'utf8') } : { path: configPath, absent: true });
    const reason = request.reason?.trim() ?? null;
    const requestHash = createHash('sha256').update(JSON.stringify([doc.path, doc.revision, request.action, reason, into, who.id])).digest('hex');
    const prior = receipt(request.operationId);
    if (prior) { own(context, prior); if (prior.requestHash !== requestHash) fail('operation-reused', 'This ID already belongs to another yardstick review.'); return publicReview(prior); }
    const value = { schema: 1, id: request.operationId, state: 'reviewed', actor: who, requestHash,
      path: doc.path, file, action: request.action, reason, into, guards, expectedRevision: doc.revision, at: new Date().toISOString() };
    const prepared = await runWorker(requestFor(value, true));
    // Every replacement link must obey the same scope as the opened plan.
    const known = new Set([...guards.map(guard => guard.path), readYardstick(config).snapshot?.path]);
    for (const guard of prepared.guards) if (!known.has(guard.path)) {
      const replacement = read(context, relative(config.repoRoot, guard.path));
      if (replacement.type !== 'plan') fail('invalid-request', 'The replacement chain contains an unavailable plan.');
    }
    value.guards = prepared.guards;
    value.newPath = prepared.result.path;
    value.assessment = prepared.result.assessment;
    value.comparison = prepared.result.comparison;
    value.report = prepared.report;
    storage();
    return withPathLocks([location(value.id)], { repoRoot: config.repoRoot }, () => {
      const concurrent = receipt(value.id);
      if (concurrent) { own(context, concurrent); if (concurrent.requestHash !== requestHash) fail('operation-reused', 'This ID already belongs to another yardstick review.'); return publicReview(concurrent); }
      write(value); return publicReview(value);
    });
  }
  async function commit(context, { operationId }) {
    storage();
    const current = withPathLocks([location(operationId)], { repoRoot: config.repoRoot }, () => {
      const value = receipt(operationId);
      if (!value) fail('operation-missing', 'Review this yardstick change first.');
      own(context, value);
      if (value.state === 'committed') return value;
      if (value.state === 'running') fail('yardstick-repair-required', 'Inspect the interrupted yardstick operation before applying another change.');
      if (value.state === 'settled-unknown') fail('yardstick-settled', 'This operation was acknowledged without replay. Review a new change against the current source.');
      if (value.state === 'failed') fail(value.failure.code, value.failure.message);
      const doc = eligible(context, value.path, value.id);
      if (doc.revision !== value.expectedRevision) fail('revision-conflict', 'The source changed since this review. Reload and review it again.');
      value.state = 'running'; value.parentOwner = currentProcessOwner(); write(value); return value;
    });
    if (current.state === 'committed') return { ...publicReview(current), replayed: true };
    const activeKey = config.repoRoot + ':' + operationId;
    activeJobs.add(activeKey);
    try {
      const outcome = await runWorker(requestFor(current, false), owner => withPathLocks([location(operationId)], { repoRoot: config.repoRoot }, () => { const value = receipt(operationId); value.workerOwner = owner; write(value); }));
      return withPathLocks([location(operationId)], { repoRoot: config.repoRoot }, () => {
        const value = receipt(operationId);
        if (value.state !== 'running') fail('yardstick-repair-required', 'The retained yardstick outcome changed while the runner was finishing. Inspect it before continuing.');
        value.state = 'committed'; value.result = outcome.result; value.report = outcome.report; value.newPath = outcome.result.path; write(value); return publicReview(value);
      });
    } catch (error) {
      withPathLocks([location(operationId)], { repoRoot: config.repoRoot }, () => {
        const value = receipt(operationId); value.failure = { code: error.code ?? 'yardstick-failed', message: error.message };
        if (error.code !== 'yardstick-uncertain' && existsSync(current.file) && sourceRevision(readFileSync(current.file, 'utf8')) === current.expectedRevision
          && inspectTransactions(config.repoRoot).every(tx => tx.generation === 'old' && tx.resolvable)) value.state = 'failed';
        write(value);
      });
      throw error;
    } finally { activeJobs.delete(activeKey); }
  }
  function currentDocument(context, value) {
    const destination = path.resolve(config.repoRoot, value.newPath);
    return existsSync(destination) ? read(context, value.newPath) : existsSync(value.file) ? read(context, value.path) : null;
  }
  const running = value => activeJobs.has(config.repoRoot + ':' + value.id)
    || (value.workerOwner ? processOwnerLiveness(value.workerOwner) !== 'dead' : value.parentOwner && processOwnerLiveness(value.parentOwner) !== 'dead');
  function inspect(context, { operationId }) {
    const value = receipt(operationId);
    if (!value) return null;
    own(context, value);
    return { ...publicReview(value), canAcknowledge: value.state === 'running' && !running(value), failure: value.failure ?? null,
      settlement: value.settlement ?? null, current: currentDocument(context, value) };
  }
  function settle(context, { operationId, expectedRevision, note }) {
    storage();
    const existing = receipt(operationId);
    if (!existing) fail('operation-missing', 'There is no retained yardstick operation.');
    own(context, existing);
    return withPathLocks([location(operationId), existing.file, path.resolve(config.repoRoot, existing.newPath)], { repoRoot: config.repoRoot }, () => {
      const value = receipt(operationId); own(context, value);
      if (value.state !== 'running') fail('invalid-request', 'Only an uncertain yardstick operation can be acknowledged.');
      if (running(value)) fail('operation-running', 'The yardstick runner is still active or cannot be verified as stopped.');
      if (typeof note !== 'string' || !note.trim() || note.length > 4000) fail('invalid-request', 'Record what you inspected, up to 4,000 characters.');
      if (inspectTransactions(config.repoRoot).length) fail('yardstick-repair-required', 'Inspect and resolve CLI transactions with runlist doctor --transactions first.');
      const current = currentDocument(context, value);
      if (!current || current.revision !== expectedRevision) fail('revision-conflict', 'The source changed. Inspect the operation again before acknowledging it.');
      value.state = 'settled-unknown'; value.settlement = { by: actor(context), at: new Date().toISOString(), reason: note.trim(), outcome: 'unknown',
        current: { path: current.path, revision: current.revision, status: current.status } }; write(value);
      return { ...publicReview(value), current, settlement: value.settlement };
    });
  }
  function list(context) {
    safe(directory);
    if (!existsSync(directory)) return { items: [], unavailable: 0 };
    const items = []; let unavailable = 0;
    for (const name of readdirSync(directory).filter(n => n.endsWith('.json') && UUID.test(n.slice(0, -5)))) try {
      const value = receipt(name.slice(0, -5));
      if (value.actor.id !== actor(context).id || !['reviewed', 'running', 'failed'].includes(value.state)) continue;
      own(context, value); authorizeManagedDestination(path.resolve(config.repoRoot, value.newPath), config);
      const doc = currentDocument(context, value);
      if (!doc) { unavailable++; continue; }
      items.push({ kind: 'yardstick', path: doc.path, operationId: value.id, state: value.state, action: value.action, at: value.at, available: true, newPath: value.newPath });
    } catch { unavailable++; }
    return { items, unavailable };
  }
  return { information, preview, commit, inspect, settle, list, assertIdle };
}
