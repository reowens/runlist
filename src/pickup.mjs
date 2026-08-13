import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { authorizeManagedSource, authorizeRepoGeneratedPath } from './managed-path.mjs';
import os from 'node:os';
import { currentProcessOwner, mutateFileSet, processOwnerLiveness, processStartIdentity, replaceSnapshot, snapshotFile, withPathLocks } from './atomic-mutation.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, relTime } from './util.mjs';

export const OWNERSHIP_SCHEMA = 2;
export const HOOK_DELIVERY_LEASE_MS = 30_000;

export function authoritativeSessionId(env = process.env) {
  const candidates = [
    ['DOTMD_SESSION_ID', 'dotmd'],
    ['CLAUDE_CODE_SESSION_ID', 'claude'],
    ['CLAUDE_SESSION_ID', 'claude'],
    ['OPENCODE_SESSION_ID', 'opencode'],
    ['OPENCODE_SESSION', 'opencode'],
    ['TERM_SESSION_ID', 'term'],
  ];
  for (const [name, host] of candidates) {
    const value = env[name]?.trim();
    if (value) return host === 'term' ? `term:${value}` : value;
  }
  throw new Error('No authoritative session identity. Set DOTMD_SESSION_ID for this shell or host session.');
}

export function availableSessionId(env = process.env) {
  try { return authoritativeSessionId(env); } catch { return null; }
}

// The process that OWNS the session, not the one taking the claim. `dotmd` exits
// within the second, so its own pid is always dead a moment later and can say
// nothing about whether the session still exists; the agent harness that spawned
// it is what outlives the command. Recording that process is what lets a claim
// answer "is its owner still there?" with the liveness check dotmd already has,
// instead of an age threshold that cannot tell a three-day-dead session from a
// long-running one. Absent (a plain terminal, an unknown harness) is not an
// error — it yields null, which reads as 'unverifiable' and never auto-reclaims.
export function sessionProcessOwner(env = process.env) {
  const raw = (env.DOTMD_SESSION_PID ?? env.CLAUDE_PID)?.trim();
  const pid = Number(raw);
  if (!raw || !Number.isInteger(pid) || pid <= 0) return null;
  return {
    pid,
    hostname: os.hostname(),
    processStartIdentity: processStartIdentity(pid),
  };
}

// Only a claim that names a process we can probe, on this host, can be judged.
// Everything else — a record written before sessionOwner existed, a claim from a
// plain terminal, another machine's claim on a shared filesystem — is
// 'unverifiable' and is treated as live, so a takeover stays an explicit --force.
export function ownershipLiveness(ownership) {
  if (!ownership || ownership.corrupt || !ownership.sessionOwner) return 'unverifiable';
  return processOwnerLiveness(ownership.sessionOwner);
}

function sameIdentity(left, right, fs = { statSync }) {
  try {
    const a = fs.statSync(left, { bigint: true });
    const b = fs.statSync(right, { bigint: true });
    return a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}

// realpath may preserve caller-provided case on case-insensitive filesystems.
// Recover the directory entry spelling at every level. The resulting identity
// survives atomic replacement because it is path-based, not keyed by inode.
export function canonicalizePathEntrySpelling(input, fs = { readdirSync, statSync }) {
  const absolute = path.resolve(input);
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    const requested = path.join(current, segment);
    let entries;
    try { entries = fs.readdirSync(current); } catch { return absolute; }
    const exact = entries.find(entry => entry === segment);
    const actual = exact ?? entries.find(entry => sameIdentity(path.join(current, entry), requested, fs));
    if (!actual) return absolute;
    current = path.join(current, actual);
  }
  return current;
}

export function classifyPlanPickup(facts) {
  const {
    type, status, validStatuses, startableStatuses, terminalStatuses,
    archiveStatuses, physicallyArchived, ownership, sessionId, malformed,
    // Defaulted rather than required: a caller with no view of the owning
    // process (and every existing test) gets the conservative answer, which is
    // that the owner might still be there.
    ownerLiveness = 'unverifiable',
  } = facts;
  if (malformed) return { kind: 'malformed', pickupable: false };
  if (type !== 'plan') return { kind: 'wrong-type', pickupable: false };
  if (!status || !validStatuses?.has(status)) return { kind: 'unconfigured-status', pickupable: false };
  if (physicallyArchived) return { kind: 'physical-archive', pickupable: false };
  if (archiveStatuses?.has(status) || terminalStatuses?.has(status)) return { kind: 'terminal', pickupable: false };
  if (ownership?.corrupt) return { kind: 'ownership-corrupt', pickupable: false };
  if (ownership?.state === 'owned' && ownership.sessionId !== sessionId && ownerLiveness !== 'dead') {
    return { kind: 'busy', pickupable: false, owner: ownership.sessionId };
  }
  if (status === 'in-session') {
    // `resume` means picking my own claim back up. A record left by a session
    // whose process is gone reached here because it is no longer busy, and
    // taking that over is an adopt — the same disposition as a plan sitting
    // `in-session` with no record at all.
    if (ownership?.state === 'owned' && ownership.sessionId === sessionId) return { kind: 'resume', pickupable: true };
    return { kind: 'adopt', pickupable: true };
  }
  if (startableStatuses?.has(status)) return { kind: 'start', pickupable: true };
  return { kind: 'parked', pickupable: false };
}

function ownershipRoot(config) {
  return path.join(config.repoRoot, '.dotmd', 'ownership');
}

export function canonicalPlanIdentity(filePath, config) {
  const authorized = authorizeManagedSource(filePath, config, { kind: 'Ownership plan source' });
  const resolved = process.platform === 'win32'
    ? path.join(realpathSync(path.dirname(authorized.path)), path.basename(authorized.path))
    : canonicalizePathEntrySpelling(realpathSync(authorized.path));
  const canonicalPath = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  let repoPath = path.relative(config.repoRoot, authorized.path);
  if (process.platform === 'win32') repoPath = repoPath.toLowerCase();
  else {
    const displayRoot = canonicalizePathEntrySpelling(authorized.root.lexicalPath);
    const managedDisplayPath = canonicalizePathEntrySpelling(authorized.path);
    repoPath = path.relative(config.repoRoot, path.join(authorized.root.lexicalPath, path.relative(displayRoot, managedDisplayPath)));
  }
  return {
    canonicalPath,
    key: createHash('sha256').update(canonicalPath).digest('hex'),
    repoPath: repoPath.split(path.sep).join('/'),
    managedPath: authorized.path,
  };
}

export function plannedPlanIdentity(filePath, config) {
  const absolute = path.resolve(filePath);
  let parent = path.dirname(absolute);
  const suffix = [path.basename(absolute)];
  while (!existsSync(parent)) {
    suffix.unshift(path.basename(parent));
    parent = path.dirname(parent);
  }
  const resolved = canonicalizePathEntrySpelling(path.join(realpathSync(parent), ...suffix));
  const canonicalPath = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return {
    canonicalPath,
    key: createHash('sha256').update(canonicalPath).digest('hex'),
    repoPath: (process.platform === 'win32'
      ? path.relative(config.repoRoot, absolute).toLowerCase()
      : path.relative(config.repoRoot, absolute))
      .split(path.sep).join('/'),
    managedPath: absolute,
  };
}

function recordPathForIdentity(identity, config) {
  return authorizeRepoGeneratedPath(path.join(ownershipRoot(config), `${identity.key}.json`), config, {
    kind: 'Plan ownership record',
  }).path;
}

export function ownershipPathFor(repoPath, config) {
  return recordPathForIdentity(canonicalPlanIdentity(path.resolve(config.repoRoot, repoPath), config), config);
}

function parseOwnership(raw, recordPath) {
  try {
    const value = JSON.parse(raw);
    if (value?.schema !== OWNERSHIP_SCHEMA
      || !['owned', 'released'].includes(value.state)
      || typeof value.plan !== 'string'
      || typeof value.canonicalPath !== 'string'
      || typeof value.identityKey !== 'string'
      || typeof value.sessionId !== 'string') throw new Error('invalid shape');
    return { ...value, recordPath, raw, corrupt: false };
  } catch {
    return { corrupt: true, recordPath, raw, reason: 'invalid ownership JSON or schema' };
  }
}

// The bar for reclaiming another session's plan without being asked to, and it is
// deliberately the same bar `assertHookDeliveryReclaimable` already sets for a
// forced hook-delivery takeover: *demonstrably* dead. `processOwnerLiveness`
// answers 'dead' only for a probe that came back ESRCH on this host, or a pid
// whose process start-identity no longer matches the one recorded — so a reused
// pid reads live, another machine's claim reads unverifiable, and a record
// written before `sessionOwner` existed reads unverifiable. Every one of those
// keeps the refusal and leaves the takeover to an explicit --force. Only a
// process we watched go away is treated as gone.
function abandonedByDeadSession(ownership) {
  return ownershipLiveness(ownership) === 'dead';
}

const BUSY_TAKEOVER_RECOVERY = 're-run this command with --force to take the plan over.';

// A busy refusal almost always fires on the command that would have *cleared*
// the wedge — `baton`, `set`, `archive` — so the message has to carry the two
// things that decide what to do next: how long the owner has held the claim, and
// the verb that takes it back. Nothing expires a session claim, so an owner
// three days gone looks exactly like one mid-edit; a survey of real sessions
// found 16 of these against 7 plans, every owner long dead, and not one of them
// recovered. What agents did instead was re-run the same command with the plan
// addressed differently (path, then slug) — reading a bare "busy in another
// session (<uuid>)" as "you named the plan wrong". The age is the judgement
// input and the recovery line is the way out; neither was there to read.
function planBusyError(repoPath, ownership, recovery = BUSY_TAKEOVER_RECOVERY) {
  const since = ownership.updatedAt ?? ownership.claimedAt ?? null;
  const age = since ? relTime(since) : null;
  const held = age && age !== '?' ? ` since ${since} (${age})` : '';
  return new Error(`Plan is busy in another session: ${repoPath}\n`
    + `  held by session ${ownership.sessionId}${held}\n`
    + `  If that session is gone, ${recovery}`);
}

function validateBinding(record, identity, config) {
  if (record.corrupt) return record;
  const expectedPath = recordPathForIdentity(identity, config);
  if (record.recordPath !== expectedPath
    || record.identityKey !== identity.key
    || record.canonicalPath !== identity.canonicalPath
    || record.plan !== identity.repoPath) {
    return { ...record, corrupt: true, reason: 'ownership record identity/path binding mismatch' };
  }
  return record;
}

export function readPlanOwnership(repoPath, config) {
  let identity;
  try { identity = canonicalPlanIdentity(path.resolve(config.repoRoot, repoPath), config); }
  catch { return null; }
  const recordPath = recordPathForIdentity(identity, config);
  if (!existsSync(recordPath)) return null;
  try { return validateBinding(parseOwnership(readFileSync(recordPath, 'utf8'), recordPath), identity, config); }
  catch { return { corrupt: true, recordPath, raw: null, reason: 'unreadable ownership record' }; }
}

export function prepareOwnershipMigration(oldRepoPath, newPath, config, { sessionId = authoritativeSessionId(), now = new Date().toISOString() } = {}) {
  const ownership = readPlanOwnership(oldRepoPath, config);
  if (!ownership) return null;
  if (ownership.corrupt) throw new Error(`Ownership record is corrupt for ${oldRepoPath}: ${ownership.reason}; repair or release it before rename.`);
  if (ownership.state === 'owned' && ownership.sessionId !== sessionId && !abandonedByDeadSession(ownership)) {
    // `rename` has no --force of its own: a rename carries the claim across to
    // the new path rather than ending it, so the takeover has to happen first.
    throw planBusyError(oldRepoPath, ownership,
      `release it first with \`dotmd set <status> ${oldRepoPath} --force\`, then rename.`);
  }
  const identity = plannedPlanIdentity(newPath, config);
  const recordPath = recordPathForIdentity(identity, config);
  const content = recordContent({
    identity,
    sessionId: ownership.sessionId,
    // A rename moves the claim, it does not re-take it: the same session still
    // owns the plan, so its owning process carries across untouched.
    sessionOwner: ownership.sessionOwner,
    state: ownership.state,
    now,
    claimedAt: ownership.claimedAt,
    operation: ownership.operation,
  });
  return {
    oldRecordPath: ownership.recordPath,
    oldContent: ownership.raw,
    newRecordPath: recordPath,
    newContent: content,
  };
}

export function listOwnedPlans(config, sessionId = authoritativeSessionId()) {
  const root = ownershipRoot(config);
  const found = [];
  const diagnostics = [];
  if (!existsSync(root)) return Object.assign(found, { diagnostics });
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const recordPath = path.join(root, entry.name);
    let record;
    try { record = parseOwnership(readFileSync(recordPath, 'utf8'), recordPath); }
    catch { record = { corrupt: true, recordPath, reason: 'unreadable ownership record' }; }
    if (record.corrupt) { diagnostics.push(`${entry.name}: ${record.reason}`); continue; }
    if (record.state !== 'owned' || record.sessionId !== sessionId) continue;
    let identity;
    try { identity = canonicalPlanIdentity(path.resolve(config.repoRoot, record.plan), config); }
    catch { diagnostics.push(`${record.plan}: owned record points to a missing or unmanaged plan`); continue; }
    record = validateBinding(record, identity, config);
    if (record.corrupt) { diagnostics.push(`${record.plan}: ${record.reason}`); continue; }
    let planFm;
    try { planFm = parseSimpleFrontmatter(extractFrontmatter(readFileSync(identity.managedPath, 'utf8')).frontmatter); }
    catch { diagnostics.push(`${record.plan}: owned plan cannot be read`); continue; }
    if (asString(planFm.type) !== 'plan' || asString(planFm.status) !== 'in-session') {
      diagnostics.push(`${record.plan}: owned record is stale because the plan is not in-session`);
      continue;
    }
    found.push(record);
  }
  found.sort((a, b) => a.plan.localeCompare(b.plan));
  return Object.assign(found, { diagnostics });
}

// `sessionOwner` is deliberately additive rather than a schema bump: parseOwnership
// accepts exactly OWNERSHIP_SCHEMA, so raising it would turn every record already
// on disk corrupt — which is a worse wedge than the one this fixes. An old record
// simply has no sessionOwner and stays 'unverifiable' for its whole life; an older
// dotmd reading a new record ignores a field it does not validate.
function recordContent({ identity, sessionId, state, now, claimedAt, operation, sessionOwner }) {
  return JSON.stringify({
    schema: OWNERSHIP_SCHEMA,
    state,
    plan: identity.repoPath,
    canonicalPath: identity.canonicalPath,
    identityKey: identity.key,
    sessionId,
    sessionOwner: sessionOwner ?? null,
    claimedAt: claimedAt ?? now,
    updatedAt: now,
    operation: operation ?? null,
  }, null, 2) + '\n';
}

export function preparePlanClaim({ filePath, sourceContent, renderedContent, ownership, sessionId, now, config, operationId = randomUUID() }) {
  const identity = canonicalPlanIdentity(filePath, config);
  const recordPath = recordPathForIdentity(identity, config);
  const operation = {
    id: operationId,
    kind: 'claim',
    oldStatus: (() => {
      const match = sourceContent.match(/^status:\s*(.+)$/m);
      return match?.[1]?.trim() ?? null;
    })(),
    index: config.indexPath ? 'pending' : 'skipped',
    hook: 'pending',
  };
  const content = recordContent({ identity, sessionId, state: 'owned', now,
    sessionOwner: sessionProcessOwner(), operation,
    claimedAt: ownership && !ownership.corrupt ? ownership.claimedAt : null });
  const updates = [];
  const guards = [];
  if (renderedContent !== null && renderedContent !== sourceContent) {
    updates.push({ path: filePath, expectedContent: sourceContent, content: renderedContent });
  } else {
    // An `adopt` claim writes only the ownership record — the plan is already
    // `in-session`, so there is nothing to render. The DECISION still rests on
    // the plan's status, which was read before this mutation was prepared, so
    // the plan file joins as a read-only guard. Without it, a concurrent
    // `set active` could win the status write while this claim takes ownership,
    // leaving a record that owns a plan the file calls `active`.
    guards.push({ path: filePath, expectedContent: sourceContent });
  }
  const creations = [];
  if (ownership) updates.push({ path: recordPath, expectedContent: ownership.raw, content });
  else creations.push({ path: recordPath, content });
  return { identity, recordPath, updates, creations, guards, operationId };
}

export function commitPlanClaim(args) {
  const prepared = preparePlanClaim(args);
  mkdirSync(path.dirname(prepared.recordPath), { recursive: true });
  mutateFileSet({ updates: prepared.updates, creations: prepared.creations, guards: prepared.guards }, {
    repoRoot: args.config.repoRoot,
    testHooks: args.testHooks,
  });
  return prepared;
}

export function prepareOwnershipRelease(repoPath, config, { sessionId = authoritativeSessionId(), force = false, now = new Date().toISOString() } = {}) {
  const identity = canonicalPlanIdentity(path.resolve(config.repoRoot, repoPath), config);
  const ownership = readPlanOwnership(repoPath, config);
  if (!ownership) return null;
  if (ownership.corrupt && !force) throw new Error(`Ownership record is corrupt for ${repoPath}: ${ownership.reason}; use an explicit path with --force to recover.`);
  if (!ownership.corrupt && ownership.state === 'owned' && ownership.sessionId !== sessionId
    && !force && !abandonedByDeadSession(ownership)) {
    throw planBusyError(repoPath, ownership);
  }
  if (!ownership.corrupt && ownership.state === 'released') return null;
  return {
    path: ownership.recordPath,
    expectedContent: ownership.raw,
    content: recordContent({ identity, sessionId, state: 'released', now,
      claimedAt: ownership.corrupt ? null : ownership.claimedAt, operation: null }),
  };
}

export function assertPlanMutationAuthorized(repoPath, config, { sessionId = authoritativeSessionId(), force = false } = {}) {
  const ownership = readPlanOwnership(repoPath, config);
  if (ownership?.corrupt && !force) {
    throw new Error(`Ownership record is corrupt for ${repoPath}: ${ownership.reason}; use an explicit path with --force to recover.`);
  }
  if (ownership?.state === 'owned' && ownership.sessionId !== sessionId
    && !force && !abandonedByDeadSession(ownership)) {
    throw planBusyError(repoPath, ownership);
  }
  return ownership;
}

// Every owned claim in the repo, whoever holds it — the survey `listOwnedPlans`
// deliberately cannot do, since that one answers "what does THIS session own?".
// Unlike that function this keeps records whose plan has drifted or vanished:
// a claim pinning a plan nobody can read is exactly the kind that wedges a repo
// and so is exactly the kind worth showing.
export function surveyOwnershipClaims(config, now = Date.now()) {
  const root = ownershipRoot(config);
  if (!existsSync(root)) return [];
  const claims = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const recordPath = path.join(root, entry.name);
    let record;
    try { record = parseOwnership(readFileSync(recordPath, 'utf8'), recordPath); }
    catch { record = { corrupt: true, recordPath, reason: 'unreadable ownership record' }; }
    if (record.corrupt) {
      claims.push({ recordPath, plan: null, corrupt: true, reason: record.reason, liveness: 'unverifiable', ageMs: null });
      continue;
    }
    if (record.state !== 'owned') continue;
    const since = record.updatedAt ?? record.claimedAt ?? null;
    const parsed = since ? Date.parse(since) : NaN;
    claims.push({
      recordPath,
      plan: record.plan,
      sessionId: record.sessionId,
      corrupt: false,
      since,
      ageMs: Number.isFinite(parsed) ? Math.max(0, now - parsed) : null,
      liveness: ownershipLiveness(record),
    });
  }
  claims.sort((a, b) => (b.ageMs ?? 0) - (a.ageMs ?? 0));
  return claims;
}

export function updateOwnershipOperation(repoPath, config, expected, mutate) {
  const ownership = readPlanOwnership(repoPath, config);
  if (!ownership || ownership.corrupt || ownership.state !== 'owned' || !ownership.operation) {
    throw new Error(`Claim completion is stale for ${repoPath}; ownership is no longer active.`);
  }
  if (ownership.sessionId !== expected.sessionId
    || ownership.operation.id !== expected.operationId
    || ownership.identityKey !== expected.identityKey) {
    throw new Error(`Claim completion is stale for ${repoPath}; ownership or operation changed.`);
  }
  const next = structuredClone(ownership);
  delete next.recordPath; delete next.raw; delete next.corrupt; delete next.reason;
  mutate(next.operation);
  next.updatedAt = new Date().toISOString();
  mutateFileSet({ updates: [{ path: ownership.recordPath, expectedContent: ownership.raw, content: JSON.stringify(next, null, 2) + '\n' }] }, { repoRoot: config.repoRoot });
  return next;
}

export function validatedClaimOperation(repoPath, config, expected = null) {
  const ownership = readPlanOwnership(repoPath, config);
  if (!ownership || ownership.corrupt || ownership.state !== 'owned' || !ownership.operation) return null;
  const binding = {
    sessionId: ownership.sessionId,
    operationId: ownership.operation.id,
    identityKey: ownership.identityKey,
  };
  if (expected && (binding.sessionId !== expected.sessionId
    || binding.operationId !== expected.operationId
    || binding.identityKey !== expected.identityKey)) return null;
  return { ownership, binding, operation: ownership.operation };
}

function lockedOperation(repoPath, config, expected, callback) {
  const identity = canonicalPlanIdentity(path.resolve(config.repoRoot, repoPath), config);
  const recordPath = recordPathForIdentity(identity, config);
  return withPathLocks([recordPath], { repoRoot: config.repoRoot }, () => {
    const snapshot = snapshotFile(recordPath);
    const ownership = validateBinding(parseOwnership(snapshot.content, recordPath), identity, config);
    if (ownership.corrupt || ownership.state !== 'owned' || !ownership.operation
      || ownership.sessionId !== expected.sessionId
      || ownership.operation.id !== expected.operationId
      || ownership.identityKey !== expected.identityKey) {
      throw new Error(`Claim completion is stale for ${repoPath}; ownership or operation changed.`);
    }
    return callback({ ownership, snapshot });
  });
}

function writeLockedOperation(ownership, snapshot, config, mutate) {
    const next = structuredClone(ownership);
    delete next.recordPath; delete next.raw; delete next.corrupt; delete next.reason;
    mutate(next.operation);
    next.updatedAt = new Date().toISOString();
    replaceSnapshot(snapshot, JSON.stringify(next, null, 2) + '\n', { repoRoot: config.repoRoot, locked: true });
    return next;
}

export function beginClaimHookDelivery(repoPath, config, expected, options = {}) {
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? HOOK_DELIVERY_LEASE_MS;
  const ownerLiveness = options.ownerLiveness ?? processOwnerLiveness;
  return lockedOperation(repoPath, config, expected, ({ ownership, snapshot }) => {
    const operation = ownership.operation;
    if (['done', 'skipped'].includes(operation.hook)) return null;
    if (operation.hook === 'delivering') {
      const age = now.getTime() - Date.parse(operation.hookDeliveryStartedAt ?? '');
      const liveness = ownerLiveness(operation.hookDeliveryOwner);
      if (!Number.isFinite(age) || age < leaseMs || liveness !== 'dead') {
        return { busy: true, operationId: operation.id, liveness };
      }
    }
    const token = randomUUID();
    const next = writeLockedOperation(ownership, snapshot, config, op => {
      op.hook = 'delivering';
      op.hookDeliveryToken = token;
      op.hookDeliveryStartedAt = now.toISOString();
      op.hookDeliveryOwner = currentProcessOwner();
    });
    return { busy: false, token, operation: next.operation };
  });
}

export function finishClaimHookDelivery(repoPath, config, expected, token) {
  return lockedOperation(repoPath, config, expected, ({ ownership, snapshot }) => {
    if (ownership.operation.hook !== 'delivering' || ownership.operation.hookDeliveryToken !== token) {
      throw new Error(`Claim hook delivery token is stale for ${repoPath}.`);
    }
    return writeLockedOperation(ownership, snapshot, config, op => {
      op.hook = 'done';
      delete op.hookDeliveryToken;
      delete op.hookDeliveryStartedAt;
      delete op.hookDeliveryOwner;
    });
  });
}

export function abandonClaimHookDelivery(repoPath, config, expected, token) {
  try {
    return lockedOperation(repoPath, config, expected, ({ ownership, snapshot }) => {
      if (ownership.operation.hook !== 'delivering' || ownership.operation.hookDeliveryToken !== token) return ownership;
      return writeLockedOperation(ownership, snapshot, config, op => {
        op.hook = 'pending';
        delete op.hookDeliveryToken;
        delete op.hookDeliveryStartedAt;
        delete op.hookDeliveryOwner;
      });
    });
  } catch { return null; }
}

export function skipClaimHookDelivery(repoPath, config, expected, token) {
  return lockedOperation(repoPath, config, expected, ({ ownership, snapshot }) => {
    if (ownership.operation.hook !== 'delivering' || ownership.operation.hookDeliveryToken !== token) {
      throw new Error(`Claim hook delivery token is stale for ${repoPath}.`);
    }
    return writeLockedOperation(ownership, snapshot, config, op => {
      op.hook = 'skipped';
      delete op.hookDeliveryToken;
      delete op.hookDeliveryStartedAt;
      delete op.hookDeliveryOwner;
    });
  });
}

export function assertHookDeliveryTakeoverSafe(ownership, options = {}) {
  if (ownership?.operation?.hook !== 'delivering') return;
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? HOOK_DELIVERY_LEASE_MS;
  const age = now.getTime() - Date.parse(ownership.operation.hookDeliveryStartedAt ?? '');
  const liveness = (options.ownerLiveness ?? processOwnerLiveness)(ownership.operation.hookDeliveryOwner);
  if (!Number.isFinite(age) || age < leaseMs || liveness !== 'dead') {
    throw new Error(`Plan hook delivery is active (${liveness}); force takeover is refused until its owner is demonstrably dead and the delivery lease expires.`);
  }
}

export function pickupFactsForDoc(doc, config, { sessionId = availableSessionId() } = {}) {
  const ownership = doc?.path ? readPlanOwnership(doc.path, config) : null;
  return classifyPlanPickup({
    type: doc?.type ?? null,
    status: doc?.status ?? null,
    validStatuses: config.typeStatuses?.get('plan') ?? config.validStatuses,
    ownerLiveness: ownershipLiveness(ownership),
    startableStatuses: config.lifecycle.startableStatuses,
    terminalStatuses: config.lifecycle.terminalStatuses,
    archiveStatuses: config.lifecycle.archiveStatuses,
    physicallyArchived: Boolean(doc?.path?.split('/').includes(config.archiveDir)),
    ownership,
    sessionId,
    malformed: !doc || doc.parseError === true,
  });
}
