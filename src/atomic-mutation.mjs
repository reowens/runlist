import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { captureGitIndexGeneration, reclaimPreparedGitIndex, restoreGitIndexCas, sameGitIndexGeneration, stageMovePathsCas } from './git.mjs';
import { authorizeManagedDestination, authorizeManagedSource, authorizeRepoGeneratedPath } from './managed-path.mjs';
import { commitRename } from './durable-rename.mjs';

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
let tempSequence = 0;

// How long a peer waits to acquire a path lock before MutationLockError. Any
// retry budget spent while the lock is held has to fit well inside this.
export const MUTATION_LOCK_TIMEOUT_MS = 2000;

export function processStartIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterName = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return `linux:${afterName[19]}`;
  } catch { /* non-Linux or proc unavailable */ }
  if (process.platform === 'win32') return null;
  try {
    const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 }).trim();
    return started ? `ps:${started}` : null;
  } catch { return null; }
}

export const PROCESS_STARTED_AT = new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString();
export const PROCESS_START_IDENTITY = processStartIdentity(process.pid);

export function currentProcessOwner() {
  return {
    pid: process.pid,
    hostname: os.hostname(),
    processStartedAt: PROCESS_STARTED_AT,
    processStartIdentity: PROCESS_START_IDENTITY,
  };
}

export function processOwnerLiveness(owner) {
  if (!owner || owner.hostname !== os.hostname() || !Number.isInteger(owner.pid)) return 'unverifiable';
  try {
    process.kill(owner.pid, 0);
    const currentStart = processStartIdentity(owner.pid);
    // If the host cannot expose process start times, an existing PID is still
    // conservatively live. This may delay stale-lock recovery after PID reuse,
    // but can never steal a live process's lock.
    if (!owner.processStartIdentity || !currentStart) return 'live';
    return owner.processStartIdentity === currentStart ? 'live' : 'dead';
  } catch (err) {
    if (err?.code === 'ESRCH') return 'dead';
    if (err?.code === 'EPERM') return 'live';
    return 'unverifiable';
  }
}

export class MutationConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MutationConflictError';
    this.code = 'DOTMD_MUTATION_CONFLICT';
  }
}

export class MutationLockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MutationLockError';
    this.code = 'DOTMD_MUTATION_LOCK_TIMEOUT';
  }
}

function contentHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

const TRANSACTION_SCHEMA = 2;
const TRANSACTION_OPERATIONS = new Set(['move', 'rename', 'lifecycle-move']);
const TRANSACTION_PHASES = new Set(['staging', 'manifest', 'reservation', 'source-move', 'target-publication', 'referrer-publication', 'ownership-publication', 'creation-publication', 'deletion-publication', 'canonical-commit', 'backup-deletion', 'manifest-completion', 'cleanup', 'recovery', 'recovered', 'completed', 'failed-manual']);
const TRANSACTION_RESULTS = new Set([null, 'committed', 'rolled-back', 'rolled-forward', 'failed-manual']);
const TRANSACTION_STATUSES = new Set(['active', 'complete', 'failed-manual']);

function contained(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function safeGeneratedPath(filePath, repoRoot, options, kind) {
  return authorizeRepoGeneratedPath(filePath, options.config ?? { repoRoot }, { kind }).path;
}

function transactionRoot(repoRoot, options = {}) {
  return safeGeneratedPath(path.join(path.resolve(repoRoot), '.dotmd', 'transactions'), repoRoot, options, 'Transaction root');
}

function durableJson(filePath, value, options = {}) {
  const content = JSON.stringify(value, null, 2) + '\n';
  const temp = writeCompleteTemp(filePath, content, 0o600);
  commitRename(temp.path, filePath, options.testHooks);
  fsyncDirectory(path.dirname(filePath), options, 'transaction-manifest');
}

function writeTransactionArtifact(directory, name, content, mode, options) {
  const artifact = path.join(directory, name);
  const temp = writeCompleteTemp(artifact, content, mode);
  renameSync(temp.path, artifact);
  fsyncDirectory(directory, options, 'transaction-artifact');
  return artifact;
}

function participantState(participant) {
  if (!existsSync(participant.path)) {
    if (!participant.old.exists) return 'old';
    if (!participant.new.exists) return 'new';
    return 'unknown';
  }
  let hash;
  try { hash = contentHash(readFileSync(participant.path)); }
  catch { return 'unknown'; }
  if (participant.old.exists && hash === participant.old.hash) return 'old';
  if (participant.new.exists && hash === participant.new.hash) return 'new';
  if (participant.transientHashes?.includes(hash)) return 'transient';
  return 'unknown';
}

function publishParticipantGeneration(participant, generation, repoRoot) {
  const current = participantState(participant);
  if (current === 'unknown') throw new MutationConflictError(`Transaction recovery found an unrecognized generation at ${participant.path}.`);
  const alreadyDesired = generation.exists
    ? existsSync(participant.path) && contentHash(readFileSync(participant.path)) === generation.hash
    : !existsSync(participant.path);
  if (alreadyDesired) return;
  if (!generation.exists) {
    if (existsSync(participant.path)) unlinkSync(participant.path);
  } else {
    const content = readFileSync(generation.artifact, 'utf8');
    if (contentHash(content) !== generation.hash) throw new MutationConflictError(`Transaction recovery artifact hash mismatch: ${generation.artifact}.`);
    if (existsSync(participant.path)) {
      const snapshot = snapshotFile(participant.path);
      replaceSnapshot(snapshot, content, { repoRoot, locked: true });
    } else {
      createFileExclusive(participant.path, content, { repoRoot, mode: generation.mode, locked: true });
    }
  }
  fsyncDirectory(path.dirname(participant.path), {}, 'transaction-recovery');
}

function cleanupTransactionDirectory(directory, manifest, options) {
  const artifacts = new Set([
    ...manifest.participants.flatMap(item => [item.old.artifact, item.new.artifact]),
    ...manifest.recoveryArtifacts,
  ].filter(Boolean));
  for (const artifact of artifacts) {
    if (!existsSync(artifact)) continue;
    validateTransactionArtifact(artifact, directory, 'cleanup artifact');
    unlinkSync(artifact);
    fsyncDirectory(directory, options, 'transaction-cleanup-artifact-delete');
  }
  const manifestPath = path.join(directory, 'manifest.json');
  if (existsSync(manifestPath)) {
    unlinkSync(manifestPath);
    fsyncDirectory(directory, options, 'transaction-cleanup-manifest-delete');
  }
  const leftovers = readdirSync(directory);
  if (leftovers.length) throw new Error(`Unexpected transaction evidence remains: ${leftovers.join(', ')}`);
  rmdirSync(directory);
  fsyncDirectory(path.dirname(directory), options, 'transaction-cleanup-directory-delete');
}

function transactionRepairMessage(manifestPath, manifest, reason) {
  const artifacts = [
    ...manifest.participants.flatMap(item => [item.old.artifact, item.new.artifact]),
    manifest.gitIndex?.prepared?.path,
    manifest.gitIndex?.prepared?.tempPath,
    ...(manifest.gitIndex?.retainedPaths ?? []),
  ].filter(Boolean);
  return `${reason}\nTransaction recovery refused to guess. Manifest: ${manifestPath}\nInspect the canonical files and recovery artifacts, then restore one complete generation and remove the manifest:\n${artifacts.map(item => `  ${item}`).join('\n') || '  (no content artifacts)'}`;
}

function assertString(value, label, { nullable = false } = {}) {
  if ((nullable && value === null) || typeof value === 'string') return;
  throw new MutationConflictError(`Invalid transaction manifest ${label}.`);
}

function validateGitSnapshot(snapshot, label) {
  if (snapshot === null) return;
  if (!snapshot || typeof snapshot.exists !== 'boolean' || !Number.isInteger(snapshot.size) || typeof snapshot.indexPath !== 'string' || !path.isAbsolute(snapshot.indexPath)) {
    throw new MutationConflictError(`Invalid transaction manifest ${label}.`);
  }
  if (!snapshot.exists) {
    if (snapshot.hash !== null || snapshot.content !== null || snapshot.size !== 0 || snapshot.mode !== null) throw new MutationConflictError(`Invalid absent Git index generation ${label}.`);
    return;
  }
  if (typeof snapshot.hash !== 'string' || !/^[a-f\d]{64}$/.test(snapshot.hash) || typeof snapshot.content !== 'string'
    || !Number.isInteger(snapshot.mode) || snapshot.mode < 0 || snapshot.mode > 0o7777) throw new MutationConflictError(`Invalid Git index generation ${label}.`);
  const bytes = Buffer.from(snapshot.content, 'base64');
  if (bytes.length !== snapshot.size || contentHash(bytes) !== snapshot.hash) throw new MutationConflictError(`Git index generation ${label} hash mismatch.`);
}

function validatePreparedGitIndex(prepared, label, directory) {
  if (prepared === null) return;
  if (!prepared || typeof prepared.path !== 'string' || !path.isAbsolute(prepared.path)
    || !Number.isInteger(prepared.dev) || !Number.isInteger(prepared.ino) || !Number.isInteger(prepared.mode) || prepared.mode < 0 || prepared.mode > 0o7777
    || !Number.isInteger(prepared.size) || typeof prepared.hash !== 'string' || !/^[a-f\d]{64}$/.test(prepared.hash)
    || !['preparing', 'prepared'].includes(prepared.state) || typeof prepared.tempPath !== 'string' || !path.isAbsolute(prepared.tempPath)) {
    throw new MutationConflictError(`Invalid transaction manifest ${label}.`);
  }
  validateGitSnapshot(prepared.generation, `${label}.generation`);
  validateTransactionArtifact(prepared.path, directory, label);
  if (path.dirname(prepared.tempPath) !== path.dirname(prepared.generation.indexPath) || !path.basename(prepared.tempPath).startsWith('.dotmd-index-')) {
    throw new MutationConflictError(`Unsafe prepared Git index path in ${label}.`);
  }
  if ((prepared.generation.exists && (prepared.hash !== prepared.generation.hash || prepared.size !== prepared.generation.size))
    || (!prepared.generation.exists && prepared.size !== 0)) throw new MutationConflictError(`Prepared Git artifact does not match ${label}.generation.`);
  if (prepared.work !== null) {
    if (!prepared.work || prepared.work.path !== prepared.tempPath || !Number.isInteger(prepared.work.dev) || !Number.isInteger(prepared.work.ino)
      || !Number.isInteger(prepared.work.mode) || !Number.isInteger(prepared.work.size) || typeof prepared.work.hash !== 'string') {
      throw new MutationConflictError(`Invalid prepared Git working inode in ${label}.`);
    }
  }
}

function validateGeneration(generation, directory, label) {
  if (!generation || typeof generation.exists !== 'boolean') throw new MutationConflictError(`Invalid transaction manifest ${label}.`);
  if (!generation.exists) {
    if (generation.artifact !== null) throw new MutationConflictError(`Invalid absent generation artifact for ${label}.`);
    return;
  }
  if (typeof generation.hash !== 'string' || !/^[a-f\d]{64}$/.test(generation.hash)
    || !Number.isInteger(generation.mode) || typeof generation.artifact !== 'string') {
    throw new MutationConflictError(`Invalid transaction generation for ${label}.`);
  }
  validateTransactionArtifact(generation.artifact, directory, label);
}

function validateTransactionArtifact(candidate, directory, label) {
  const absolute = path.resolve(candidate);
  if (!contained(directory, absolute) || absolute === directory) throw new MutationConflictError(`Transaction ${label} escapes its transaction directory: ${candidate}`);
  let canonicalDirectory;
  try {
    canonicalDirectory = realpathSync(directory);
    if (existsSync(absolute)) {
      if (lstatSync(absolute).isSymbolicLink()) throw new Error('symlink artifact');
      if (!contained(canonicalDirectory, realpathSync(absolute))) throw new Error('artifact resolves outside transaction directory');
      return;
    }
    let ancestor = path.dirname(absolute);
    while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
    if (!contained(canonicalDirectory, realpathSync(ancestor))) throw new Error('artifact parent resolves outside transaction directory');
  } catch (err) {
    throw new MutationConflictError(`Transaction ${label} is missing or unsafe: ${candidate} (${err.message})`);
  }
}

function validateParticipantPath(participant, repoRoot, options, label) {
  if (!participant || typeof participant.path !== 'string' || !path.isAbsolute(participant.path)
    || !['managed', 'generated'].includes(participant.policy)
    || !['source', 'target', 'referrer', 'ownership', 'creation', 'deletion'].includes(participant.label)) {
    throw new MutationConflictError(`Invalid transaction participant ${label}.`);
  }
  const txRoot = transactionRoot(repoRoot, options);
  const lockRoot = safeGeneratedPath(path.join(repoRoot, '.dotmd', 'locks'), repoRoot, options, 'Lock root');
  if (contained(txRoot, participant.path) || contained(lockRoot, participant.path)) {
    throw new MutationConflictError(`Transaction participant targets transaction/lock state: ${participant.path}`);
  }
  if (participant.policy === 'managed' && options.config) {
    if (existsSync(participant.path)) authorizeManagedSource(participant.path, options.config, { kind: 'Transaction participant' });
    else authorizeManagedDestination(participant.path, options.config, { kind: 'Transaction participant' });
  } else {
    const authorized = safeGeneratedPath(participant.path, repoRoot, options, 'Transaction generated participant');
    if (options.config) {
      const ownershipRoot = path.join(path.resolve(repoRoot), '.dotmd', 'ownership');
      if (!contained(ownershipRoot, authorized)) throw new MutationConflictError(`Generated transaction participant is outside session ownership state: ${participant.path}`);
      if (participant.label !== 'ownership') throw new MutationConflictError(`Session-generated participant must be classified as ownership: ${participant.path}`);
    }
  }
}

function validateManifest(manifest, manifestPath, directory, repoRoot, options) {
  if (!manifest || manifest.schema !== TRANSACTION_SCHEMA || typeof manifest.id !== 'string'
    || !TRANSACTION_OPERATIONS.has(manifest.operation) || !TRANSACTION_PHASES.has(manifest.phase)
    || !TRANSACTION_RESULTS.has(manifest.result) || !TRANSACTION_STATUSES.has(manifest.status) || !Array.isArray(manifest.participants)
    || !Array.isArray(manifest.recoveryArtifacts) || !Array.isArray(manifest.createdDirectories) || typeof manifest.createdAt !== 'string'
    || typeof manifest.directoryToken !== 'string') {
    throw new MutationConflictError(`Invalid transaction manifest schema at ${manifestPath}. Preserve it for manual repair.`);
  }
  assertString(manifest.sessionId, 'sessionId', { nullable: true });
  if (!manifest.owner || !Number.isInteger(manifest.owner.pid) || typeof manifest.owner.hostname !== 'string'
    || typeof manifest.owner.processStartedAt !== 'string' || (manifest.owner.processStartIdentity !== null && typeof manifest.owner.processStartIdentity !== 'string')) {
    throw new MutationConflictError(`Invalid transaction manifest owner at ${manifestPath}.`);
  }
  if (manifest.directory !== directory) throw new MutationConflictError(`Transaction manifest directory binding mismatch at ${manifestPath}.`);
  for (let index = 0; index < manifest.participants.length; index++) {
    const participant = manifest.participants[index];
    validateParticipantPath(participant, repoRoot, options, `participants[${index}]`);
    validateGeneration(participant.old, directory, `participants[${index}].old`);
    validateGeneration(participant.new, directory, `participants[${index}].new`);
    const shape = `${participant.old.exists ? 1 : 0}${participant.new.exists ? 1 : 0}`;
    const expectedShapes = {
      source: ['10'], target: ['01'], referrer: ['11'], creation: ['01'], deletion: ['10'], ownership: ['01', '10'],
    }[participant.label];
    if (!expectedShapes.includes(shape)) throw new MutationConflictError(`Invalid generation shape for transaction ${participant.label} participant.`);
    if (!Array.isArray(participant.transientHashes) || !participant.transientHashes.every(hash => typeof hash === 'string' && /^[a-f\d]{64}$/.test(hash))) {
      throw new MutationConflictError(`Invalid transaction transient generations at ${manifestPath}.`);
    }
  }
  if (manifest.participants.filter(item => item.label === 'source').length !== 1
    || manifest.participants.filter(item => item.label === 'target').length !== 1) {
    throw new MutationConflictError(`Transaction manifest must contain exactly one source and target at ${manifestPath}.`);
  }
  for (const artifact of manifest.recoveryArtifacts) validateTransactionArtifact(artifact, directory, 'recovery artifact');
  for (const createdDirectory of manifest.createdDirectories) {
    if (!createdDirectory || typeof createdDirectory.path !== 'string' || typeof createdDirectory.marker !== 'string'
      || typeof createdDirectory.participantPath !== 'string' || typeof createdDirectory.token !== 'string'
      || !path.isAbsolute(createdDirectory.path) || !path.isAbsolute(createdDirectory.marker) || !path.isAbsolute(createdDirectory.participantPath)) {
      throw new MutationConflictError(`Invalid created directory in ${manifestPath}.`);
    }
    const participant = manifest.participants.find(item => item.path === createdDirectory.participantPath && !item.old.exists && item.new.exists);
    if (!participant || !contained(createdDirectory.path, participant.path) || createdDirectory.path === participant.path) {
      throw new MutationConflictError(`Transaction-created directory is not bound to a destination participant: ${createdDirectory.path}`);
    }
    const expectedMarker = path.join(createdDirectory.path, `.dotmd-transaction-${manifest.id}`);
    if (createdDirectory.marker !== expectedMarker || createdDirectory.token !== manifest.directoryToken) {
      throw new MutationConflictError(`Transaction-created directory marker binding mismatch: ${createdDirectory.path}`);
    }
    if (!['intended', 'created', 'removing', 'removed'].includes(createdDirectory.markerState)) throw new MutationConflictError(`Invalid transaction directory marker state: ${createdDirectory.path}`);
    if (createdDirectory.identity !== null && (!createdDirectory.identity || !Number.isInteger(createdDirectory.identity.dev) || !Number.isInteger(createdDirectory.identity.ino))) {
      throw new MutationConflictError(`Invalid transaction-created directory identity: ${createdDirectory.path}`);
    }
    if (createdDirectory.markerState !== 'intended' && createdDirectory.identity === null) throw new MutationConflictError(`Transaction-created directory state lacks an identity: ${createdDirectory.path}`);
    if (participant.policy === 'managed' && options.config) authorizeManagedDestination(path.join(createdDirectory.path, '.dotmd-directory-check.md'), options.config, { kind: 'Transaction-created directory' });
    else safeGeneratedPath(createdDirectory.path, repoRoot, options, 'Transaction-created directory');
  }
  const createdPaths = new Set(manifest.createdDirectories.map(item => item.path));
  if (createdPaths.size !== manifest.createdDirectories.length) throw new MutationConflictError(`Duplicate transaction-created directory in ${manifestPath}.`);
  for (const participantPath of new Set(manifest.createdDirectories.map(item => item.participantPath))) {
    const chain = manifest.createdDirectories
      .filter(item => item.participantPath === participantPath)
      .sort((left, right) => left.path.split(path.sep).length - right.path.split(path.sep).length);
    if (chain.at(-1)?.path !== path.dirname(participantPath)) throw new MutationConflictError(`Transaction-created directory chain does not end at destination parent: ${participantPath}`);
    for (let index = 1; index < chain.length; index++) {
      if (path.dirname(chain[index].path) !== chain[index - 1].path) throw new MutationConflictError(`Transaction-created directory chain is not contiguous: ${participantPath}`);
    }
  }
  if (manifest.gitMove !== null) {
    if (!manifest.gitMove || typeof manifest.gitMove.source !== 'string' || typeof manifest.gitMove.target !== 'string') throw new MutationConflictError(`Invalid transaction Git move at ${manifestPath}.`);
    for (const gitPath of [manifest.gitMove.source, manifest.gitMove.target]) {
      if (path.isAbsolute(gitPath) || gitPath.split(/[\\/]/).includes('..')) throw new MutationConflictError(`Unsafe Git move path in transaction manifest: ${gitPath}`);
    }
  }
  if (!manifest.gitIndex || !Object.hasOwn(manifest.gitIndex, 'before') || !Object.hasOwn(manifest.gitIndex, 'prepared') || !Object.hasOwn(manifest.gitIndex, 'ownedAfter')) throw new MutationConflictError(`Invalid transaction Git index state at ${manifestPath}.`);
  if (!Array.isArray(manifest.gitIndex.retainedPaths) || !manifest.gitIndex.retainedPaths.every(item => typeof item === 'string' && path.isAbsolute(item))) throw new MutationConflictError(`Invalid retained Git index paths at ${manifestPath}.`);
  validateGitSnapshot(manifest.gitIndex.before, 'gitIndex.before');
  validatePreparedGitIndex(manifest.gitIndex.prepared, 'gitIndex.prepared', directory);
  validateGitSnapshot(manifest.gitIndex.ownedAfter, 'gitIndex.ownedAfter');
  if (manifest.gitIndex.before && manifest.gitIndex.ownedAfter && manifest.gitIndex.before.indexPath !== manifest.gitIndex.ownedAfter.indexPath) throw new MutationConflictError(`Transaction Git index generations target different selected indexes.`);
  return manifest;
}

export function recoverAbandonedTransactions(repoRoot, options = {}) {
  const root = transactionRoot(repoRoot, options);
  if (!existsSync(root)) return [];
  const recovered = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new MutationConflictError(`Unsafe entry in transaction root: ${path.join(root, entry.name)}`);
    const directory = path.join(root, entry.name);
    const manifestPath = path.join(directory, 'manifest.json');
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
    catch (err) {
      if (err?.code === 'ENOENT' && readdirSync(directory).length === 0) {
        rmdirSync(directory);
        fsyncDirectory(root, options, 'transaction-resume-empty-cleanup');
        recovered.push({ id: entry.name, result: 'cleanup-completed' });
        continue;
      }
      throw new MutationConflictError(`Unreadable transaction manifest: ${manifestPath}. Preserve its artifacts and repair it manually.`);
    }
    validateManifest(manifest, manifestPath, directory, repoRoot, options);
    if (manifest.status === 'complete') {
      const retainedDirectories = manifest.createdDirectories.filter(item => existsSync(item.path)).map(item => item.path);
      const retainedGitPaths = manifest.gitIndex.retainedPaths.filter(item => existsSync(item));
      const completedResult = manifest.result === 'committed' ? 'rolled-forward' : manifest.result;
      if (retainedDirectories.length === 0 && retainedGitPaths.length === 0) {
        cleanupTransactionDirectory(directory, manifest, options);
        recovered.push({ id: manifest.id, result: completedResult, retainedDirectories: [], retainedGitPaths: [] });
        continue;
      }
      recovered.push({
        id: manifest.id,
        result: completedResult,
        retainedDirectories,
        retainedGitPaths,
      });
      continue;
    }
    if (manifest.status === 'failed-manual') throw new MutationConflictError(transactionRepairMessage(manifestPath, manifest, 'Transaction is marked failed/manual and will not be retried automatically.'));
    const liveness = processOwnerLiveness(manifest.owner);
    if (liveness === 'live') continue;
    if (liveness !== 'dead') throw new MutationConflictError(`Cannot prove transaction owner is dead for ${manifestPath}; refusing recovery.`);
    if (manifest.gitIndex.before) {
      const selected = captureGitIndexGeneration(repoRoot);
      if (selected.indexPath !== manifest.gitIndex.before.indexPath) throw new MutationConflictError(`Recovery environment selects a different Git index than ${manifestPath}; refusing recovery.`);
      try {
        const reclaimed = reclaimPreparedGitIndex(manifest.gitIndex, repoRoot, options);
        manifest.gitIndex.retainedPaths = [...new Set([...manifest.gitIndex.retainedPaths, ...reclaimed.retainedPaths])];
        if (reclaimed.retainedPaths.length) {
          manifest.phase = 'failed-manual';
          manifest.result = 'failed-manual';
          manifest.status = 'failed-manual';
          durableJson(manifestPath, manifest, options);
          const retainedError = new MutationConflictError(transactionRepairMessage(manifestPath, manifest,
            `Git preparation left unverified work that was preserved and requires manual recovery: ${reclaimed.retainedPaths.join(', ')}`));
          retainedError.retainedGitPaths = reclaimed.retainedPaths;
          throw retainedError;
        }
      }
      catch (err) {
        if (err?.retainedGitPaths) throw err;
        throw new MutationConflictError(transactionRepairMessage(manifestPath, manifest, `Prepared Git index recovery failed: ${err.message}`));
      }
    }
    const states = manifest.participants.map(participantState);
    if (states.includes('unknown')) {
      throw new MutationConflictError(transactionRepairMessage(manifestPath, manifest, 'Canonical generations are ambiguous.'));
    }
    const rollForward = states.every(state => state === 'new');
    try {
      withPathLocks(manifest.participants.map(item => item.path), { repoRoot, ...options }, () => {
        const lockedStates = manifest.participants.map(participantState);
        if (lockedStates.includes('unknown')) {
          throw new MutationConflictError(transactionRepairMessage(manifestPath, manifest, 'Canonical generations changed while recovery acquired locks.'));
        }
        const lockedRollForward = lockedStates.every(state => state === 'new');
        if (lockedRollForward !== rollForward) throw new MutationConflictError(transactionRepairMessage(manifestPath, manifest, 'Canonical generations changed during recovery classification.'));
        if (!lockedRollForward) {
          for (let i = manifest.participants.length - 1; i >= 0; i--) {
            publishParticipantGeneration(manifest.participants[i], manifest.participants[i].old, repoRoot);
          }
          if (manifest.gitIndex.before) {
            if (manifest.gitIndex.ownedAfter) {
              const currentIndex = captureGitIndexGeneration(repoRoot);
              if (!sameGitIndexGeneration(currentIndex, manifest.gitIndex.before)) restoreGitIndexCas(manifest.gitIndex.before, manifest.gitIndex.ownedAfter, repoRoot, {
                artifactPath: path.join(directory, 'git-index-restore'),
                testHooks: {
                  ...options.testHooks,
                  afterGitRestoreArtifact: info => {
                    manifest.gitIndex.prepared = info.prepared;
                    durableJson(manifestPath, manifest, options);
                    options.testHooks?.afterGitRestoreArtifact?.(info);
                  },
                  afterGitRestorePrepared: info => {
                    manifest.gitIndex.prepared = info.prepared;
                    durableJson(manifestPath, manifest, options);
                    options.testHooks?.afterGitRestorePrepared?.(info);
                  },
                },
              });
            }
          }
        } else if (manifest.gitMove) {
          const before = manifest.gitIndex.before;
          const current = before ? captureGitIndexGeneration(repoRoot) : null;
          if (manifest.gitIndex.ownedAfter) {
            if (!sameGitIndexGeneration(current, manifest.gitIndex.ownedAfter)) throw new Error('Git index no longer matches the transaction-owned committed generation; current staging was preserved.');
          } else if (manifest.gitIndex.prepared?.state === 'prepared' && sameGitIndexGeneration(current, manifest.gitIndex.prepared.generation)) {
            manifest.gitIndex.ownedAfter = manifest.gitIndex.prepared.generation;
          } else {
            if (before && !sameGitIndexGeneration(current, before)) throw new Error('Git index changed before recovery could finalize the move; current staging was preserved.');
            manifest.gitIndex.ownedAfter = stageMovePathsCas(manifest.gitMove.source, manifest.gitMove.target, repoRoot, before, {
              artifactPath: path.join(directory, 'git-index-prepared'),
              testHooks: {
                ...options.testHooks,
                afterGitIndexArtifact: info => {
                  manifest.gitIndex.prepared = info.prepared;
                  durableJson(manifestPath, manifest, options);
                  options.testHooks?.afterGitIndexArtifact?.(info);
                },
                afterGitIndexWorkSeed: info => {
                  manifest.gitIndex.prepared = info.prepared;
                  durableJson(manifestPath, manifest, options);
                  options.testHooks?.afterGitIndexWorkSeed?.(info);
                },
                afterGitIndexPrepareStep: info => {
                  manifest.gitIndex.prepared = info.prepared;
                  durableJson(manifestPath, manifest, options);
                  options.testHooks?.afterGitIndexPrepareStep?.(info);
                },
                afterGitIndexSubprocessBeforeCheckpoint: info => {
                  options.testHooks?.afterTransactionPhase?.('git-index-post-subprocess', { manifestPath, manifest, ...info });
                  options.testHooks?.afterGitIndexSubprocessBeforeCheckpoint?.(info);
                },
                afterGitIndexPrepared: info => {
                  manifest.gitIndex.prepared = info.prepared;
                  durableJson(manifestPath, manifest, options);
                  options.testHooks?.afterGitIndexPrepared?.(info);
                },
              },
            });
          }
        }
      });
      manifest.phase = 'recovered';
      manifest.result = rollForward ? 'rolled-forward' : 'rolled-back';
      manifest.status = 'complete';
      durableJson(manifestPath, manifest, options);
      options.testHooks?.afterTransactionPhase?.('recovery', { manifestPath, manifest });
      const retainedDirectories = manifest.createdDirectories.filter(item => existsSync(item.path)).map(item => item.path);
      const retainedGitPaths = manifest.gitIndex.retainedPaths.filter(item => existsSync(item));
      if (retainedDirectories.length === 0 && retainedGitPaths.length === 0) {
        setMoveManifestPhase({ manifest, manifestPath }, 'cleanup', options);
        cleanupTransactionDirectory(directory, manifest, options);
      }
      recovered.push({
        id: manifest.id,
        result: manifest.result,
        retainedDirectories,
        retainedGitPaths,
      });
    } catch (err) {
      try {
        manifest.phase = 'failed-manual';
        manifest.result = 'failed-manual';
        manifest.status = 'failed-manual';
        durableJson(manifestPath, manifest, options);
      } catch { /* retain original manifest and every artifact */ }
      throw new MutationConflictError(transactionRepairMessage(manifestPath, manifest, `Recovery failed and evidence was retained: ${err.message}`));
    }
  }
  return recovered;
}

function ensureDirectoryDurable(directory, options, phase) {
  if (existsSync(directory)) return false;
  const parent = path.dirname(directory);
  if (!existsSync(parent)) ensureDirectoryDurable(parent, options, phase);
  try { mkdirSync(directory); }
  catch (err) { if (err?.code === 'EEXIST') return false; throw err; }
  fsyncDirectory(parent, options, phase);
  return true;
}

function beginMoveManifest({ repoRoot, transactionId, operation, sessionId, source, targetPath, targetContent, updates, creations, deletions, gitIndex, tracked }, options) {
  const root = transactionRoot(repoRoot, options);
  ensureDirectoryDurable(root, options, 'transaction-root-create');
  const directory = path.join(root, transactionId);
  mkdirSync(directory);
  try { fsyncDirectory(root, options, 'transaction-directory-create'); }
  catch (err) {
    try { rmdirSync(directory); fsyncDirectory(root, options, 'transaction-directory-create-rollback'); } catch { /* preserve durability error */ }
    throw err;
  }
  const participants = [];
  const add = (filePath, oldGeneration, newGeneration, label) => {
    const index = participants.length;
    const old = oldGeneration.exists ? {
      exists: true, hash: oldGeneration.hash, mode: oldGeneration.mode,
      artifact: path.join(directory, `${index}-old`),
    } : { exists: false, artifact: null };
    const next = newGeneration.exists ? {
      exists: true, hash: contentHash(newGeneration.content), mode: newGeneration.mode,
      artifact: path.join(directory, `${index}-new`),
    } : { exists: false, artifact: null };
    const policy = String(filePath).endsWith('.md') ? 'managed' : 'generated';
    participants.push({ path: path.resolve(filePath), policy, label, old, new: next, transientHashes: [], _oldContent: oldGeneration.content, _newContent: newGeneration.content });
  };
  add(source.path, { exists: true, content: source.content, hash: source.hash, mode: source.identity.mode }, { exists: false }, 'source');
  add(targetPath, { exists: false }, { exists: true, content: targetContent, mode: source.identity.mode }, 'target');
  for (const item of updates) add(item.path,
    { exists: true, content: item.snapshot.content, hash: item.snapshot.hash, mode: item.snapshot.identity.mode },
    { exists: true, content: item.content, mode: item.snapshot.identity.mode }, item.label === 'ownership' || !String(item.path).endsWith('.md') ? 'ownership' : 'referrer');
  for (const item of creations) add(item.path, { exists: false }, { exists: true, content: item.content, mode: item.mode ?? (0o666 & ~process.umask()) }, item.label === 'ownership' || !String(item.path).endsWith('.md') ? 'ownership' : 'creation');
  for (const item of deletions) add(item.path,
    { exists: true, content: item.snapshot.content, hash: item.snapshot.hash, mode: item.snapshot.identity.mode }, { exists: false }, item.label === 'ownership' || !String(item.path).endsWith('.md') ? 'ownership' : 'deletion');
  const backup = path.join(directory, 'source-backup');
  const stagedPath = path.join(directory, 'target-staged');
  const gitPreparedArtifact = path.join(directory, 'git-index-prepared');
  const gitRestoreArtifact = path.join(directory, 'git-index-restore');
  const manifest = {
    schema: TRANSACTION_SCHEMA,
    id: transactionId,
    operation: operation ?? 'move',
    sessionId: sessionId ?? null,
    owner: currentProcessOwner(),
    createdAt: new Date().toISOString(),
    phase: 'manifest',
    status: 'active',
    result: null,
    directory,
    directoryToken: randomUUID(),
    participants: participants.map(({ _oldContent, _newContent, ...participant }) => participant),
    gitIndex: { before: gitIndex ?? null, prepared: null, ownedAfter: null, retainedPaths: [] },
    gitMove: tracked ? { source: path.relative(repoRoot, source.path).split(path.sep).join('/'), target: path.relative(repoRoot, targetPath).split(path.sep).join('/') } : null,
    recoveryArtifacts: [backup, stagedPath, ...(tracked ? [gitPreparedArtifact, gitRestoreArtifact] : [])],
    createdDirectories: [],
  };
  const manifestPath = path.join(directory, 'manifest.json');
  try { durableJson(manifestPath, manifest, options); }
  catch (err) {
    try { cleanupTransactionDirectory(directory, manifest, options); }
    catch (cleanupError) { err.message += `\nCould not clean failed manifest publication: ${cleanupError.message}`; }
    throw err;
  }
  return { directory, manifestPath, manifest, participants, backup, stagedPath, gitPreparedArtifact, gitRestoreArtifact, createdDirectories: [], createdDirectoryOwnership: new Set() };
}

function stageMoveManifest(transaction, targetContent, sourceMode, options) {
  for (let index = 0; index < transaction.participants.length; index++) {
    const participant = transaction.participants[index];
    if (participant.old.exists) writeTransactionArtifact(transaction.directory, `${index}-old`, participant._oldContent, participant.old.mode, options);
    if (participant.new.exists) writeTransactionArtifact(transaction.directory, `${index}-new`, participant._newContent, participant.new.mode, options);
  }
  writeTransactionArtifact(transaction.directory, 'target-staged', targetContent, sourceMode, options);
  setMoveManifestPhase(transaction, 'staging', options);
}

function ensureTransactionDirectory(directory, transaction, options, participantPath) {
  if (existsSync(directory)) return;
  const missing = [];
  let cursor = directory;
  while (!existsSync(cursor)) { missing.unshift(cursor); cursor = path.dirname(cursor); }
  for (const item of missing) {
    const intent = {
      path: item,
      participantPath: path.resolve(participantPath),
      marker: path.join(item, `.dotmd-transaction-${transaction.manifest.id}`),
      token: transaction.manifest.directoryToken,
      markerState: 'intended',
      identity: null,
    };
    transaction.manifest.createdDirectories.push(intent);
    transaction.createdDirectories.push(intent);
    durableJson(transaction.manifestPath, transaction.manifest, options);
    options.testHooks?.afterTransactionPhase?.('directory-intent', { directory: item, intent, manifestPath: transaction.manifestPath });
    mkdirSync(item);
    transaction.createdDirectoryOwnership.add(item);
    fsyncDirectory(path.dirname(item), options, 'canonical-directory-create');
    options.testHooks?.afterTransactionPhase?.('directory-create', { directory: item, intent, manifestPath: transaction.manifestPath });
    const createdIdentity = lstatSync(item);
    intent.identity = { dev: createdIdentity.dev, ino: createdIdentity.ino };
    durableJson(transaction.manifestPath, transaction.manifest, options);
    const fd = openSync(intent.marker, 'wx', 0o600);
    try { writeFileSync(fd, `${intent.token}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    fsyncDirectory(item, options, 'canonical-directory-marker');
    intent.markerState = 'created';
    durableJson(transaction.manifestPath, transaction.manifest, options);
    options.testHooks?.afterTransactionPhase?.('directory-marker', { directory: item, intent, manifestPath: transaction.manifestPath });
  }
}

function cleanupCreatedDirectories(transaction, options) {
  let complete = true;
  const manifest = transaction.manifest ?? transaction;
  for (const intent of [...transaction.createdDirectories].reverse()) {
    try {
      const directory = intent.path;
      if (!(transaction.createdDirectoryOwnership instanceof Set) || !transaction.createdDirectoryOwnership.has(directory)) continue;
      if (!existsSync(directory)) continue;
      const currentIdentity = lstatSync(directory);
      if (!currentIdentity.isDirectory() || !intent.identity || currentIdentity.dev !== intent.identity.dev || currentIdentity.ino !== intent.identity.ino) {
        complete = false;
        continue;
      }
      if (!existsSync(intent.marker)) {
        if (['removing', 'removed'].includes(intent.markerState)) {
          if (readdirSync(directory).length === 0) {
            rmdirSync(directory);
            fsyncDirectory(path.dirname(directory), options, 'canonical-directory-rollback');
          }
          continue;
        }
        complete = false;
        continue;
      }
      if (lstatSync(intent.marker).isSymbolicLink() || readFileSync(intent.marker, 'utf8') !== `${intent.token}\n`) {
        complete = false;
        continue;
      }
      const entries = readdirSync(directory).filter(entry => path.join(directory, entry) !== intent.marker);
      intent.markerState = 'removing';
      if (transaction.manifestPath) durableJson(transaction.manifestPath, manifest, options);
      unlinkSync(intent.marker);
      fsyncDirectory(directory, options, 'canonical-directory-marker-delete');
      if (entries.length === 0) {
        rmdirSync(directory);
        fsyncDirectory(path.dirname(directory), options, 'canonical-directory-rollback');
      } else {
        intent.markerState = 'removed';
        if (transaction.manifestPath) durableJson(transaction.manifestPath, manifest, options);
      }
    } catch { complete = false; }
  }
  return complete;
}

function setMoveManifestPhase(transaction, phase, options, detail = null) {
  transaction.manifest.phase = phase;
  if (detail !== null) transaction.manifest.detail = detail;
  durableJson(transaction.manifestPath, transaction.manifest, options);
  options.testHooks?.afterTransactionPhase?.(phase, { manifestPath: transaction.manifestPath, manifest: transaction.manifest });
}

function companionPhase(item, fallback) {
  return item.label === 'ownership' || item.path.includes(`${path.sep}.dotmd${path.sep}ownership${path.sep}`)
    ? 'ownership-publication'
    : fallback;
}

function statIdentity(stat) {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    mode: Number(stat.mode & 0o7777n),
  };
}

function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function sameGenerationIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size;
}

export function snapshotFile(filePath) {
  const resolved = path.resolve(filePath);
  const before = statSync(resolved, { bigint: true });
  if (!before.isFile()) throw new Error(`Mutation source is not a file: ${resolved}`);
  const content = readFileSync(resolved, 'utf8');
  const after = statSync(resolved, { bigint: true });
  const identity = statIdentity(after);
  if (!sameIdentity(statIdentity(before), identity) || BigInt(Buffer.byteLength(content)) !== after.size) {
    throw new MutationConflictError(`File changed while it was being read: ${resolved}`);
  }
  return { path: resolved, content, hash: contentHash(content), identity };
}

export function assertSnapshotCurrent(snapshot) {
  let current;
  try { current = snapshotFile(snapshot.path); }
  catch (err) {
    if (err?.code === 'ENOENT') throw new MutationConflictError(`File disappeared after it was read: ${snapshot.path}`);
    throw err;
  }
  const identityMatches = snapshot.identityKind === 'inode-content'
    ? sameGenerationIdentity(snapshot.identity, current.identity)
    : sameIdentity(snapshot.identity, current.identity);
  if (!identityMatches || snapshot.hash !== current.hash) {
    throw new MutationConflictError(`File changed after it was read; refusing to overwrite newer content: ${snapshot.path}`);
  }
}

function canonicalPath(filePath) {
  const resolved = path.resolve(filePath);
  if (existsSync(resolved)) return realpathSync(resolved);
  const suffix = [];
  let cursor = resolved;
  while (!existsSync(cursor)) {
    suffix.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return path.join(realpathSync(cursor), ...suffix);
}

function lockPathFor(canonical, repoRoot) {
  const key = createHash('sha256').update(canonical).digest('hex');
  return path.join(path.resolve(repoRoot), '.dotmd', 'locks', `${key}.lock`);
}

function ownerDescription(lockPath) {
  try {
    const owner = JSON.parse(readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
    const age = Math.max(0, Date.now() - Date.parse(owner.createdAt));
    return `pid ${owner.pid} on ${owner.hostname} (process started ${owner.processStartedAt ?? 'unknown'}, lock age ${age}ms)`;
  } catch {
    return 'another process';
  }
}

function lockOwner(lockPath) {
  try { return JSON.parse(readFileSync(path.join(lockPath, 'owner.json'), 'utf8')); }
  catch { return null; }
}

function ownerIsDemonstrablyDead(owner) {
  return processOwnerLiveness(owner) === 'dead';
}

function removeLockDirectory(lockPath, lockRoot) {
  if (!contained(lockRoot, lockPath) || lstatSync(lockPath).isSymbolicLink()) return false;
  for (const entry of readdirSync(lockPath)) {
    if (!/^owner\.json$|^reclaiming$|^\.owner-[\w-]+\.tmp$/.test(entry)) return false;
    unlinkSync(path.join(lockPath, entry));
  }
  rmdirSync(lockPath);
  return true;
}

function reclaimLock(lockPath, lockRoot) {
  try { statSync(lockPath); } catch { return true; }
  const owner = lockOwner(lockPath);
  if (!ownerIsDemonstrablyDead(owner)) return false;

  // A marker inside the old directory serializes reclaimers. A live owner is
  // never reclaimed. An ownerless directory is deliberately left for bounded
  // timeout/manual recovery: reclaiming it could steal from a live process
  // paused between mkdir and atomic owner publication.
  let marker;
  try {
    marker = openSync(path.join(lockPath, 'reclaiming'), 'wx');
    closeSync(marker);
  } catch { return false; }
  const tombstone = `${lockPath}.reclaimed-${process.pid}-${Date.now()}-${tempSequence++}`;
  try {
    renameSync(lockPath, tombstone);
    return removeLockDirectory(tombstone, path.dirname(tombstone));
  } catch {
    return false;
  }
}

export function withPathLocks(filePaths, options, callback) {
  const { repoRoot, timeoutMs = MUTATION_LOCK_TIMEOUT_MS, retryMs = 20 } = options;
  if (!repoRoot) throw new Error('withPathLocks requires repoRoot.');
  const canonicals = [...new Set(filePaths.map(canonicalPath))].sort();
  const lockRoot = safeGeneratedPath(path.join(path.resolve(repoRoot), '.dotmd', 'locks'), repoRoot, options, 'Lock root');
  ensureDirectoryDurable(lockRoot, options, 'lock-root-create');
  const acquired = [];
  const deadline = Date.now() + timeoutMs;
  try {
    for (const canonical of canonicals) {
      const lockPath = lockPathFor(canonical, repoRoot);
      while (true) {
        const token = randomUUID();
        let madeLock = false;
        try {
          mkdirSync(lockPath);
          fsyncDirectory(lockRoot, options, 'lock-directory-create');
          madeLock = true;
          const ownerTemp = path.join(lockPath, `.owner-${token}.tmp`);
          writeFileSync(ownerTemp, JSON.stringify({
            token,
            ...currentProcessOwner(),
            createdAt: new Date().toISOString(),
            path: canonical,
          }) + '\n', { flag: 'wx' });
          renameSync(ownerTemp, path.join(lockPath, 'owner.json'));
          fsyncDirectory(lockPath, options, 'lock-owner-publish');
          if (lockOwner(lockPath)?.token !== token) {
            throw new MutationConflictError(`Mutation lock ownership changed while claiming ${canonical}.`);
          }
          acquired.push({ lockPath, token });
          break;
        } catch (err) {
          if (madeLock) {
            try {
              const owner = lockOwner(lockPath);
              if (!owner || owner.token === token) removeLockDirectory(lockPath, lockRoot);
            } catch { /* best effort */ }
          }
          if (err?.code !== 'EEXIST') throw err;
          if (reclaimLock(lockPath, lockRoot)) continue;
          if (Date.now() >= deadline) {
            throw new MutationLockError(`Timed out after ${timeoutMs}ms waiting for mutation lock on ${canonical} (held by ${ownerDescription(lockPath)}).`);
          }
          Atomics.wait(sleepBuffer, 0, 0, Math.min(retryMs, Math.max(1, deadline - Date.now())));
        }
      }
    }
    return callback();
  } finally {
    for (const { lockPath, token } of acquired.reverse()) {
      try {
        if (lockOwner(lockPath)?.token === token) {
          removeLockDirectory(lockPath, lockRoot);
          fsyncDirectory(lockRoot, options, 'lock-directory-delete');
        }
      } catch { /* preserve original error */ }
    }
  }
}

function tempPathFor(filePath) {
  const base = path.basename(filePath);
  return path.join(path.dirname(filePath), `.${base}.dotmd-tmp-${process.pid}-${Date.now()}-${tempSequence++}`);
}

function fsyncDirectory(dirPath, options = {}, phase = 'directory') {
  let fd;
  try {
    fd = openSync(dirPath, 'r');
    options.testHooks?.beforeDirectoryFsync?.(phase, dirPath);
    fsyncSync(fd);
  } catch (err) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF', 'EISDIR', 'EPERM'].includes(err?.code)) throw err;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function writeCompleteTemp(filePath, content, mode) {
  const tempPath = tempPathFor(filePath);
  let fd;
  try {
    fd = openSync(tempPath, 'wx', mode);
    writeFileSync(fd, content, 'utf8');
    fchmodSync(fd, mode);
    fsyncSync(fd);
    const finalStat = fstatSync(fd, { bigint: true });
    closeSync(fd);
    fd = undefined;
    return {
      path: tempPath,
      content,
      hash: contentHash(content),
      identity: statIdentity(finalStat),
    };
  } catch (err) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
    try { unlinkSync(tempPath); } catch { /* best effort */ }
    throw err;
  }
}

function committedGeneration(prepared, finalPath) {
  return {
    path: path.resolve(finalPath),
    content: prepared.content,
    hash: prepared.hash,
    identity: prepared.identity,
    identityKind: 'inode-content',
  };
}

function recoveryArtifact(filePath, content, mode, label) {
  const artifact = path.join(path.dirname(filePath), `.${path.basename(filePath)}.dotmd-recovery-${label}-${randomUUID()}`);
  const temp = writeCompleteTemp(artifact, content, mode);
  renameSync(temp.path, artifact);
  fsyncDirectory(path.dirname(artifact));
  return artifact;
}

function rollbackConflict(error, message) {
  error.message += `\nRollback conflict: ${message}`;
}

function removeCommitted(snapshot, error, label) {
  try {
    assertSnapshotCurrent(snapshot);
    unlinkSync(snapshot.path);
    try { fsyncDirectory(path.dirname(snapshot.path)); }
    catch (durabilityError) {
      rollbackConflict(error, `${label} was removed, but its directory could not be durably synced: ${durabilityError.message}`);
    }
    return true;
  } catch (conflict) {
    rollbackConflict(error, `${label} was replaced; left current file untouched at ${snapshot.path}.`);
    return false;
  }
}

function restoreUpdate(committed, original, error) {
  try {
    assertSnapshotCurrent(committed);
    replaceSnapshot(committed, original.content, { repoRoot: path.dirname(original.path), locked: true });
    return true;
  } catch (conflict) {
    let artifact = 'could not write recovery artifact';
    try { artifact = recoveryArtifact(original.path, original.content, original.identity.mode, 'original'); } catch { /* report fallback text */ }
    rollbackConflict(error, `${original.path} changed after commit; left it untouched. Original content: ${artifact}.`);
    return false;
  }
}

function reserveExclusive(filePath, mode, content, testHooks = {}) {
  let fd;
  let openedIdentity;
  let reservation;
  try {
    fd = openSync(filePath, 'wx', mode);
    const opened = fstatSync(fd, { bigint: true });
    openedIdentity = { dev: opened.dev, ino: opened.ino };
    const reservationContent = content ?? JSON.stringify({ dotmdReservation: true, pid: process.pid, createdAt: new Date().toISOString() }) + '\n';
    writeFileSync(fd, reservationContent, 'utf8');
    testHooks.afterReserveWrite?.(filePath);
    testHooks.beforeReserveFsync?.(filePath);
    fsyncSync(fd);
    const finalStat = fstatSync(fd, { bigint: true });
    reservation = {
      path: path.resolve(filePath),
      content: reservationContent,
      hash: contentHash(reservationContent),
      identity: statIdentity(finalStat),
    };
    closeSync(fd);
    fd = undefined;
    return reservation;
  } catch (err) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
    if (openedIdentity) {
      try {
        const current = lstatSync(filePath, { bigint: true });
        if (current.dev === openedIdentity.dev && current.ino === openedIdentity.ino) unlinkSync(filePath);
      } catch { /* missing or replaced by another actor */ }
    }
    throw err;
  }
}

export function replaceSnapshot(snapshot, newContent, options = {}) {
  const { repoRoot, locked = false } = options;
  const commit = () => {
    const prepared = writeCompleteTemp(snapshot.path, newContent, snapshot.identity.mode);
    let committed;
    try {
      options.testHooks?.beforeReplacePublish?.({ snapshot, tempPath: prepared.path });
      assertSnapshotCurrent(snapshot);
      commitRename(prepared.path, snapshot.path, options.testHooks);
      committed = committedGeneration(prepared, snapshot.path);
      options.testHooks?.afterPublicationBeforePathOpen?.('replace', snapshot.path);
      try { fsyncDirectory(path.dirname(snapshot.path), options, 'replace-publish'); }
      catch (err) { err.committedSnapshot = committed; throw err; }
      return committed;
    } catch (err) {
      try { unlinkSync(prepared.path); } catch { /* already renamed or best effort */ }
      if (committed && !err.committedSnapshot) err.committedSnapshot = committed;
      throw err;
    }
  };
  return locked ? commit() : withPathLocks([snapshot.path], { repoRoot, ...options }, commit);
}

export function mutateFile(filePath, options, render) {
  return withPathLocks([filePath], options, () => {
    options.testHooks?.beforeMutationSnapshot?.(filePath);
    const snapshot = snapshotFile(filePath);
    const rendered = render(snapshot.content, snapshot);
    if (rendered === snapshot.content) return { changed: false, snapshot };
    try {
      const committed = replaceSnapshot(snapshot, rendered, { ...options, locked: true });
      return { changed: true, snapshot, committed };
    } catch (err) {
      if (err.committedSnapshot) restoreUpdate(err.committedSnapshot, snapshot, err);
      throw err;
    }
  });
}

export function createFileExclusive(filePath, content, options) {
  const { repoRoot, mode = 0o666 & ~process.umask(), locked = false } = options;
  const create = () => {
    if (existsSync(filePath)) throw new MutationConflictError(`Destination already exists: ${path.resolve(filePath)}`);
    const prepared = writeCompleteTemp(filePath, content, mode);
    let tempPublished = false;
    let committed;
    try {
      try {
        if (options.testHooks?.forceLinkUnsupported) {
          const error = new Error('injected unsupported hard link');
          error.code = 'ENOTSUP';
          throw error;
        }
        linkSync(prepared.path, filePath);
        committed = committedGeneration(prepared, filePath);
        options.testHooks?.afterPublicationBeforePathOpen?.('create-hardlink', filePath);
      } catch (err) {
        if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'EMLINK'].includes(err?.code)) throw err;
        // Portable fallback: reserve with O_EXCL, then replace only our own
        // reservation. This may expose the reservation briefly, but can never
        // overwrite a competing creator's file.
        let fallbackReserved = false;
        let reservation;
        try {
          reservation = reserveExclusive(filePath, mode, undefined, options.testHooks);
          fallbackReserved = true;
          options.testHooks?.afterReservationAcquired?.(filePath);
          options.testHooks?.afterCreateReservation?.(filePath);
          assertSnapshotCurrent(reservation);
          commitRename(prepared.path, filePath, options.testHooks);
          tempPublished = true;
          committed = committedGeneration(prepared, filePath);
          options.testHooks?.afterPublicationBeforePathOpen?.('create-rename', filePath);
        } catch (fallbackError) {
          if (fallbackReserved) {
            try { assertSnapshotCurrent(reservation); unlinkSync(filePath); } catch { /* replaced by another actor */ }
          }
          throw fallbackError;
        }
      }
      if (!tempPublished) unlinkSync(prepared.path);
      try { fsyncDirectory(path.dirname(filePath), options, 'creation-publish'); }
      catch (err) { err.committedSnapshot = committed; throw err; }
      return committed;
    } catch (err) {
      try { unlinkSync(prepared.path); } catch { /* best effort */ }
      if (committed) removeCommitted(committed, err, 'created file after durability failure');
      if (err?.code === 'EEXIST') throw new MutationConflictError(`Destination already exists: ${path.resolve(filePath)}`);
      throw err;
    }
  };
  return locked ? create() : withPathLocks([filePath], options, create);
}

export function moveFileAtomic(sourcePath, targetPath, render, options) {
  const { repoRoot, finalize, rollbackFinalize, testHooks, updates = [], creations = [], deletions = [] } = options;
  recoverAbandonedTransactions(repoRoot, options);
  return withPathLocks([sourcePath, targetPath, ...updates.map(item => item.path), ...creations.map(item => item.path), ...deletions.map(item => item.path)], options, () => {
    testHooks?.afterTransactionPhase?.('lock', { sourcePath, targetPath });
    testHooks?.beforeMoveSnapshot?.({ sourcePath, targetPath });
    const source = snapshotFile(sourcePath);
    if (options.expectedSourceContent !== undefined && source.content !== options.expectedSourceContent) {
      throw new MutationConflictError(`Source changed while the move transaction was being planned: ${source.path}`);
    }
    const targetDir = path.dirname(targetPath);
    const newContent = typeof render === 'function' ? render(source.content, source) : render;
    const preparedUpdates = updates.map(item => {
      const snapshot = snapshotFile(item.path);
      if (item.expectedContent !== undefined && snapshot.content !== item.expectedContent) {
        throw new MutationConflictError(`File changed while the move mutation set was being prepared: ${snapshot.path}`);
      }
      return { ...item, snapshot, content: item.render ? item.render(snapshot.content, snapshot) : item.content };
    }).filter(item => item.content !== item.snapshot.content);
    const preparedDeletions = deletions.map(item => {
      const snapshot = snapshotFile(item.path);
      if (item.expectedContent !== undefined && snapshot.content !== item.expectedContent) {
        throw new MutationConflictError(`File changed while the move deletion set was being prepared: ${snapshot.path}`);
      }
      return { ...item, snapshot };
    });
    for (const item of creations) {
      if (existsSync(item.path)) throw new MutationConflictError(`Destination already exists: ${path.resolve(item.path)}`);
    }
    const transactionId = `${process.pid}-${Date.now()}-${tempSequence++}`;
    const transaction = beginMoveManifest({
      repoRoot,
      transactionId,
      operation: options.operation,
      sessionId: options.sessionId,
      source,
      targetPath,
      targetContent: newContent,
      updates: preparedUpdates,
      creations,
      deletions: preparedDeletions,
      gitIndex: options.gitIndex,
      tracked: Boolean(options.gitMove || finalize),
    }, options);
    const { backup, stagedPath } = transaction;
    let reserved = false;
    let reservation;
    let moved = false;
    let published = false;
    let publishedSnapshot;
    let backupSnapshot;
    const committedUpdates = [];
    const committedCreations = [];
    const committedDeletions = [];
    let finalizeAttempted = false;
    let pastRecoveryBoundary = false;
    try {
      testHooks?.afterTransactionPhase?.('manifest', { manifestPath: transaction.manifestPath, manifest: transaction.manifest });
      stageMoveManifest(transaction, newContent, source.identity.mode, options);
      const prepared = snapshotFile(stagedPath);
      ensureTransactionDirectory(targetDir, transaction, options, targetPath);
      for (const item of creations) ensureTransactionDirectory(path.dirname(item.path), transaction, options, item.path);
      try {
        reservation = reserveExclusive(targetPath, source.identity.mode, JSON.stringify({
          dotmdReservation: true,
          transactionId,
          sourcePath,
          backup,
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }) + '\n', testHooks);
      } catch (err) {
        if (err?.code === 'EEXIST') throw new MutationConflictError(`Destination already exists: ${path.resolve(targetPath)}`);
        throw err;
      }
      reserved = true;
      transaction.manifest.participants[1].transientHashes.push(reservation.hash);
      setMoveManifestPhase(transaction, 'reservation', options);
      testHooks?.afterReservationAcquired?.(targetPath);
      fsyncDirectory(targetDir);

      testHooks?.afterMoveReservation?.({ source, sourcePath, targetPath });
      assertSnapshotCurrent(source);
      testHooks?.afterMoveValidation?.({ source, sourcePath, targetPath });
      // Revalidate immediately before the move, after every hook/preparation
      // step that can permit an injected or external source edit.
      assertSnapshotCurrent(source);
      for (const item of preparedUpdates) assertSnapshotCurrent(item.snapshot);
      commitRename(sourcePath, backup, testHooks);
      moved = true;
      backupSnapshot = { ...source, path: backup, identityKind: 'inode-content' };
      fsyncDirectory(path.dirname(sourcePath));
      setMoveManifestPhase(transaction, 'source-move', options);

      testHooks?.afterSourceMove?.({ backup, sourcePath, targetPath });
      assertSnapshotCurrent(reservation);
      commitRename(stagedPath, targetPath, testHooks);
      published = true;
      reserved = false;
      publishedSnapshot = committedGeneration(prepared, targetPath);
      testHooks?.afterPublicationBeforePathOpen?.('move-target', targetPath);
      fsyncDirectory(targetDir, options, 'move-target-publish');
      setMoveManifestPhase(transaction, 'target-publication', options);
      for (const item of preparedUpdates) {
        try {
          const committed = replaceSnapshot(item.snapshot, item.content, { ...options, locked: true });
          committedUpdates.push({ ...item, committed });
        } catch (err) {
          if (err.committedSnapshot) committedUpdates.push({ ...item, committed: err.committedSnapshot });
          throw err;
        }
        setMoveManifestPhase(transaction, companionPhase(item, 'referrer-publication'), options, item.path);
      }
      for (const item of creations) {
        const committed = createFileExclusive(item.path, item.content, { ...options, mode: item.mode, locked: true });
        committedCreations.push({ ...item, committed });
        setMoveManifestPhase(transaction, companionPhase(item, 'creation-publication'), options, item.path);
      }
      for (const item of preparedDeletions) {
        assertSnapshotCurrent(item.snapshot);
        unlinkSync(item.path);
        fsyncDirectory(path.dirname(item.path), options, 'move-companion-delete');
        committedDeletions.push(item);
        setMoveManifestPhase(transaction, companionPhase(item, 'deletion-publication'), options, item.path);
        testHooks?.afterMoveDeletion?.(committedDeletions.length, item.path);
      }
      testHooks?.afterMovePublish?.({ backup, sourcePath, targetPath });

      if (options.gitMove && transaction.manifest.gitIndex.before) {
        finalizeAttempted = true;
        const gitHooks = {
          ...options.testHooks,
          afterGitIndexArtifact: info => {
            transaction.manifest.gitIndex.prepared = info.prepared;
            durableJson(transaction.manifestPath, transaction.manifest, options);
            options.testHooks?.afterTransactionPhase?.('git-index-artifact', { manifestPath: transaction.manifestPath, manifest: transaction.manifest });
            options.testHooks?.afterGitIndexArtifact?.(info);
          },
          afterGitIndexWorkSeed: info => {
            transaction.manifest.gitIndex.prepared = info.prepared;
            durableJson(transaction.manifestPath, transaction.manifest, options);
            options.testHooks?.afterGitIndexWorkSeed?.(info);
          },
          afterGitIndexPrepareStep: info => {
            transaction.manifest.gitIndex.prepared = info.prepared;
            durableJson(transaction.manifestPath, transaction.manifest, options);
            options.testHooks?.afterTransactionPhase?.('git-index-prepare-step', { manifestPath: transaction.manifestPath, manifest: transaction.manifest });
            options.testHooks?.afterGitIndexPrepareStep?.(info);
          },
          afterGitIndexSubprocessBeforeCheckpoint: info => {
            options.testHooks?.afterTransactionPhase?.('git-index-post-subprocess', { manifestPath: transaction.manifestPath, manifest: transaction.manifest, ...info });
            options.testHooks?.afterGitIndexSubprocessBeforeCheckpoint?.(info);
          },
          afterGitIndexPrepared: info => {
            transaction.manifest.gitIndex.prepared = info.prepared;
            durableJson(transaction.manifestPath, transaction.manifest, options);
            options.testHooks?.afterTransactionPhase?.('git-index-prepared', { manifestPath: transaction.manifestPath, manifest: transaction.manifest });
            options.testHooks?.afterGitIndexPrepared?.(info);
          },
          afterGitIndexLock: info => {
            options.testHooks?.afterTransactionPhase?.('git-index-lock', { manifestPath: transaction.manifestPath, manifest: transaction.manifest });
            options.testHooks?.afterGitIndexLock?.(info);
          },
          afterGitIndexCompare: info => {
            options.testHooks?.afterTransactionPhase?.('git-index-compare', { manifestPath: transaction.manifestPath, manifest: transaction.manifest });
            options.testHooks?.afterGitIndexCompare?.(info);
          },
          afterGitIndexPublication: info => {
            options.testHooks?.afterTransactionPhase?.('git-index-publication', { manifestPath: transaction.manifestPath, manifest: transaction.manifest });
            options.testHooks?.afterGitIndexPublication?.(info);
          },
        };
        transaction.manifest.gitIndex.ownedAfter = stageMovePathsCas(
          transaction.manifest.gitMove.source,
          transaction.manifest.gitMove.target,
          repoRoot,
          transaction.manifest.gitIndex.before,
          { testHooks: gitHooks, artifactPath: transaction.gitPreparedArtifact },
        );
        durableJson(transaction.manifestPath, transaction.manifest, options);
      } else if (finalize) {
        finalizeAttempted = true;
        finalize({ sourcePath, targetPath, backup });
      }
      setMoveManifestPhase(transaction, 'canonical-commit', options);
      testHooks?.afterMoveFinalize?.({ backup, sourcePath, targetPath });
      unlinkSync(backup);
      moved = false;
      pastRecoveryBoundary = true;
      fsyncDirectory(transaction.directory, options, 'move-backup-delete');
      setMoveManifestPhase(transaction, 'backup-deletion', options);
      if (!cleanupCreatedDirectories(transaction, options)) throw new Error('Could not remove transaction-owned directory markers after commit.');
      transaction.manifest.phase = 'completed';
      transaction.manifest.status = 'complete';
      transaction.manifest.result = 'committed';
      durableJson(transaction.manifestPath, transaction.manifest, options);
      testHooks?.afterTransactionPhase?.('manifest-completion', { manifestPath: transaction.manifestPath, manifest: transaction.manifest });
      testHooks?.afterTransactionPhase?.('final-commit', { manifestPath: transaction.manifestPath, manifest: transaction.manifest });
      setMoveManifestPhase(transaction, 'cleanup', options);
      cleanupTransactionDirectory(transaction.directory, transaction.manifest, options);
      return { source, target: publishedSnapshot, updatedPaths: preparedUpdates.map(item => item.path) };
    } catch (err) {
      if (pastRecoveryBoundary) {
        try {
          transaction.manifest.phase = 'failed-manual';
          transaction.manifest.status = 'failed-manual';
          transaction.manifest.result = 'failed-manual';
          durableJson(transaction.manifestPath, transaction.manifest, options);
        } catch { /* retain existing durable evidence */ }
        err.message += `\n${transactionRepairMessage(transaction.manifestPath, transaction.manifest, 'Move content and Git index are committed, but post-commit durability/cleanup failed; no rollback was attempted.')}`;
        throw err;
      }
      let rollbackFailed = false;
      for (const item of committedDeletions.reverse()) {
        try { createFileExclusive(item.path, item.snapshot.content, { ...options, mode: item.snapshot.identity.mode, locked: true }); }
        catch (rollbackError) { rollbackFailed = true; rollbackConflict(err, `could not restore deleted companion ${item.path}: ${rollbackError.message}`); }
      }
      for (const item of committedCreations.reverse()) if (!removeCommitted(item.committed, err, 'created move companion')) rollbackFailed = true;
      for (const item of committedUpdates.reverse()) if (!restoreUpdate(item.committed, item.snapshot, err)) rollbackFailed = true;
      if (published) {
        if (!removeCommitted(publishedSnapshot, err, 'published move target')) rollbackFailed = true;
        published = false;
      } else if (reserved) {
        try { assertSnapshotCurrent(reservation); unlinkSync(targetPath); }
        catch { rollbackFailed = true; }
        reserved = false;
      }
      if (moved) {
        try {
          assertSnapshotCurrent(backupSnapshot);
          if (existsSync(sourcePath)) {
            rollbackFailed = true;
            rollbackConflict(err, `source was recreated at ${sourcePath}; left recoverable original at ${backup}.`);
          } else {
            renameSync(backup, sourcePath);
            moved = false;
            try { fsyncDirectory(path.dirname(sourcePath), options, 'rollback-source-restore'); }
            catch (durabilityError) {
              rollbackFailed = true;
              rollbackConflict(err, `source was restored but its parent directory could not be durably synced: ${durabilityError.message}`);
            }
          }
        } catch (rollbackError) {
          rollbackFailed = true;
          rollbackConflict(err, `could not restore source; recoverable original remains at ${backup}: ${rollbackError.message}`);
        }
      }
      try { if (finalizeAttempted) {
        if (transaction.manifest.gitIndex.before) {
          if (transaction.manifest.gitIndex.ownedAfter) {
            restoreGitIndexCas(transaction.manifest.gitIndex.before, transaction.manifest.gitIndex.ownedAfter, repoRoot, {
              artifactPath: transaction.gitRestoreArtifact,
              testHooks: {
                ...options.testHooks,
                afterGitRestoreArtifact: info => {
                  transaction.manifest.gitIndex.prepared = info.prepared;
                  durableJson(transaction.manifestPath, transaction.manifest, options);
                  options.testHooks?.afterGitRestoreArtifact?.(info);
                },
                afterGitRestorePrepared: info => {
                  transaction.manifest.gitIndex.prepared = info.prepared;
                  durableJson(transaction.manifestPath, transaction.manifest, options);
                  options.testHooks?.afterGitRestorePrepared?.(info);
                },
              },
            });
          } else if (!sameGitIndexGeneration(captureGitIndexGeneration(repoRoot), transaction.manifest.gitIndex.before)) {
            throw new Error('Git finalize did not publish its prepared generation, but the real index changed; current staging was preserved.');
          }
        } else if (rollbackFinalize) rollbackFinalize({ sourcePath, targetPath, backup });
      } } catch (rollbackError) {
        rollbackFailed = true;
        rollbackConflict(err, `could not restore Git index: ${rollbackError.message}`);
      }
      try {
        if (transaction.manifest.gitIndex.prepared) {
          const reclaimed = reclaimPreparedGitIndex(transaction.manifest.gitIndex, repoRoot, options);
          if (reclaimed.retainedPaths.length) {
            transaction.manifest.gitIndex.retainedPaths = [...new Set([
              ...transaction.manifest.gitIndex.retainedPaths,
              ...reclaimed.retainedPaths,
            ])];
            rollbackFailed = true;
            rollbackConflict(err, `unverified Git preparation work was preserved for manual recovery: ${reclaimed.retainedPaths.join(', ')}`);
          }
        }
      } catch (cleanupError) {
        rollbackFailed = true;
        rollbackConflict(err, `could not safely clean prepared Git index state: ${cleanupError.message}`);
      }
      try { fsyncDirectory(targetDir); } catch { rollbackFailed = true; }
      try {
        const states = transaction.manifest.participants.map(participantState);
        if (!rollbackFailed && states.every(state => state === 'old') && cleanupCreatedDirectories(transaction, options)) {
          transaction.manifest.phase = 'completed';
          transaction.manifest.status = 'complete';
          transaction.manifest.result = 'rolled-back';
          durableJson(transaction.manifestPath, transaction.manifest, options);
          cleanupTransactionDirectory(transaction.directory, transaction.manifest, options);
        } else {
          transaction.manifest.phase = 'failed-manual';
          transaction.manifest.status = 'failed-manual';
          transaction.manifest.result = 'failed-manual';
          durableJson(transaction.manifestPath, transaction.manifest, options);
          err.message += `\n${transactionRepairMessage(transaction.manifestPath, transaction.manifest, 'Rollback was incomplete; durable evidence was retained.')}`;
        }
      } catch (manifestError) {
        err.message += `\nCould not finalize transaction recovery record: ${manifestError.message}`;
      }
      throw err;
    }
  });
}

export function mutateFileSet({ updates = [], creations = [] }, options) {
  const paths = [...updates.map(item => item.path), ...creations.map(item => item.path)];
  return withPathLocks(paths, options, () => {
    const createdDirectories = [];
    for (const item of creations) {
      const directory = path.dirname(item.path);
      if (!existsSync(directory)) {
        const missing = [];
        let cursor = directory;
        while (!existsSync(cursor)) { missing.unshift(cursor); cursor = path.dirname(cursor); }
        for (const candidate of missing) {
          mkdirSync(candidate);
          fsyncDirectory(path.dirname(candidate), options, 'set-directory-create');
          createdDirectories.push(candidate);
        }
      }
    }
    const preparedUpdates = updates.map(item => {
      const snapshot = snapshotFile(item.path);
      if (item.expectedContent !== undefined && snapshot.content !== item.expectedContent) {
        throw new MutationConflictError(`File changed while the mutation set was being prepared: ${snapshot.path}`);
      }
      return { ...item, snapshot, content: item.render ? item.render(snapshot.content, snapshot) : item.content };
    });
    for (const item of creations) {
      if (existsSync(item.path)) throw new MutationConflictError(`Destination already exists: ${path.resolve(item.path)}`);
    }
    options.testHooks?.afterSetPreflight?.({ updates: preparedUpdates, creations });

    const committedUpdates = [];
    const committedCreations = [];
    try {
      for (const item of preparedUpdates) {
        try {
          const committed = replaceSnapshot(item.snapshot, item.content, { ...options, locked: true });
          committedUpdates.push({ ...item, committed });
        } catch (err) {
          if (err.committedSnapshot) committedUpdates.push({ ...item, committed: err.committedSnapshot });
          throw err;
        }
        options.testHooks?.afterSetCommit?.(committedUpdates.length + committedCreations.length, item.path);
      }
      for (const item of creations) {
        const committed = createFileExclusive(item.path, item.content, { ...options, mode: item.mode, locked: true });
        committedCreations.push({ ...item, committed });
        options.testHooks?.afterSetCommit?.(committedUpdates.length + committedCreations.length, item.path);
      }
      return { updates: preparedUpdates, creations };
    } catch (err) {
      for (const item of committedCreations.reverse()) {
        removeCommitted(item.committed, err, 'created file');
      }
      for (const item of committedUpdates.reverse()) {
        restoreUpdate(item.committed, item.snapshot, err);
      }
      for (const directory of createdDirectories.reverse()) {
        try {
          if (readdirSync(directory).length === 0) {
            rmdirSync(directory);
            fsyncDirectory(path.dirname(directory), options, 'set-directory-rollback');
          }
        } catch (rollbackError) { rollbackConflict(err, `could not remove newly created directory ${directory}: ${rollbackError.message}`); }
      }
      throw err;
    }
  });
}
