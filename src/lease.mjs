import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { warn } from './util.mjs';

const LEASE_DIR = '.dotmd';
const LEASE_FILE = 'in-session.json';
const LOCK_FILE = 'in-session.lock';
const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_WAIT_MS = 2_000;
export const STALE_LEASE_AGE_MS = 4 * 60 * 60 * 1000;
export const STALE_LEASE_AGE_HOURS = STALE_LEASE_AGE_MS / (60 * 60 * 1000);

const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function syncSleep(ms) { Atomics.wait(_sleepBuf, 0, 0, ms); }

export function currentSessionId() {
  if (process.env.CLAUDE_CODE_SESSION_ID) return process.env.CLAUDE_CODE_SESSION_ID;
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  if (process.env.TERM_SESSION_ID) return `term:${process.env.TERM_SESSION_ID}`;
  return `shell:${os.userInfo().username}@${os.hostname()}`;
}

function dirFor(config) { return path.join(config.repoRoot, LEASE_DIR); }
function leaseFilePath(config) { return path.join(dirFor(config), LEASE_FILE); }
function lockFilePath(config) { return path.join(dirFor(config), LOCK_FILE); }

export function readLeases(config) {
  const file = leaseFilePath(config);
  if (!existsSync(file)) return {};
  try {
    const raw = readFileSync(file, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch (err) {
    warn(`Lease file at ${file} is corrupt (${err.message}); treating as empty.`);
    return {};
  }
}

export function writeLeases(config, leases) {
  const dir = dirFor(config);
  mkdirSync(dir, { recursive: true });
  const file = leaseFilePath(config);
  if (Object.keys(leases).length === 0) {
    if (existsSync(file)) {
      try { unlinkSync(file); } catch {}
    }
    return;
  }
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(leases, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

export function withLeaseLock(config, fn) {
  const dir = dirFor(config);
  mkdirSync(dir, { recursive: true });
  const lock = lockFilePath(config);
  const start = Date.now();
  let fd = null;
  while (true) {
    try {
      fd = openSync(lock, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = statSync(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try { unlinkSync(lock); } catch {}
          continue;
        }
      } catch {}
      if (Date.now() - start > LOCK_MAX_WAIT_MS) {
        throw new Error(`Could not acquire lease lock at ${lock} within ${LOCK_MAX_WAIT_MS}ms`);
      }
      syncSleep(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch {}
    try { unlinkSync(lock); } catch {}
  }
}

export function isPidAlive(pid, host) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (host && host !== os.hostname()) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function isLeaseStale(lease) {
  const t = new Date(lease.pickedUpAt).getTime();
  if (Number.isNaN(t)) return true;
  return Date.now() - t > STALE_LEASE_AGE_MS;
  // Note: pid liveness is intentionally NOT used here. dotmd's own CLI pid is
  // dead the moment the process exits, so it's not a useful signal for "is the
  // session that wrote this lease still active." Use age and explicit takeover.
}

export function findStaleLeases(config) {
  const leases = readLeases(config);
  return Object.values(leases).filter(isLeaseStale);
}

export function acquireLease(config, repoPath, oldStatus, opts = {}) {
  return withLeaseLock(config, () => {
    const leases = readLeases(config);
    const existing = leases[repoPath];
    const session = opts.session ?? currentSessionId();

    if (existing && existing.session === session) {
      existing.pickedUpAt = new Date().toISOString();
      existing.pid = process.pid;
      leases[repoPath] = existing;
      writeLeases(config, leases);
      return { outcome: 'reattached', lease: existing, conflict: null };
    }

    if (existing && !opts.takeover) {
      const ageMs = Date.now() - new Date(existing.pickedUpAt).getTime();
      const stale = Number.isNaN(ageMs) || ageMs > STALE_LEASE_AGE_MS;
      return {
        outcome: stale ? 'conflict-stale' : 'conflict-alive',
        conflict: existing,
        lease: null,
      };
    }

    const newLease = {
      path: repoPath,
      oldStatus: oldStatus ?? 'active',
      pid: process.pid,
      host: os.hostname(),
      session,
      pickedUpAt: new Date().toISOString(),
    };
    if (existing && opts.takeover) {
      newLease.takenOverFrom = {
        session: existing.session,
        pid: existing.pid,
        pickedUpAt: existing.pickedUpAt,
      };
    }
    leases[repoPath] = newLease;
    writeLeases(config, leases);
    return { outcome: existing ? 'taken-over' : 'acquired', lease: newLease, conflict: existing ?? null };
  });
}

export function releaseLease(config, repoPath, opts = {}) {
  return withLeaseLock(config, () => {
    const leases = readLeases(config);
    const existing = leases[repoPath];
    if (!existing) return { released: false, lease: null, reason: 'no-lease' };
    const session = opts.session ?? currentSessionId();
    if (existing.session !== session && !opts.force) {
      return { released: false, lease: existing, reason: 'not-yours' };
    }
    delete leases[repoPath];
    writeLeases(config, leases);
    return { released: true, lease: existing, reason: null };
  });
}

export function releaseAllForSession(config, sessionId, opts = {}) {
  return withLeaseLock(config, () => {
    const leases = readLeases(config);
    const released = [];
    for (const [key, lease] of Object.entries(leases)) {
      if (lease.session === sessionId) {
        released.push(lease);
        delete leases[key];
      }
    }
    if (released.length > 0) writeLeases(config, leases);
    return { released };
  });
}

export function releaseStale(config) {
  return withLeaseLock(config, () => {
    const leases = readLeases(config);
    const released = [];
    for (const [key, lease] of Object.entries(leases)) {
      if (isLeaseStale(lease)) {
        released.push(lease);
        delete leases[key];
      }
    }
    if (released.length > 0) writeLeases(config, leases);
    return { released };
  });
}

export function migrateLease(config, oldPath, newPath) {
  return withLeaseLock(config, () => {
    const leases = readLeases(config);
    if (!leases[oldPath]) return false;
    const lease = leases[oldPath];
    lease.path = newPath;
    leases[newPath] = lease;
    delete leases[oldPath];
    writeLeases(config, leases);
    return true;
  });
}

export function leasePathFor(config) {
  return leaseFilePath(config);
}
