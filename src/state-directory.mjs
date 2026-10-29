import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { STATE_DIR } from './naming.mjs';

function syncDirectory(directory) {
  let fd;
  try { fd = openSync(directory, 'r'); fsyncSync(fd); }
  catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EBADF', 'EISDIR'].includes(error.code)) throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

// Directory creation is the shared boundary for local-state writers. Keep
// readers (including hooks) stat-only, and never take a lock here: the lock
// root itself lives inside this directory. A prepared, flushed file plus an
// exclusive hard link publishes complete bytes without replacing user rules.
export function mkdirStateSync(directory, options) {
  let state = path.resolve(directory);
  while (path.basename(state) !== STATE_DIR) {
    const parent = path.dirname(state);
    if (parent === state) return mkdirSync(directory, options);
    state = parent;
  }
  // Establish the ignore before creating a lock directory, so a failed
  // publication cannot leave an ownerless lock behind.
  let present = false;
  try { present = lstatSync(state).isDirectory(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (present) ensureStateIgnored(state);
  const result = mkdirSync(directory, options);
  if (!present && lstatSync(state).isDirectory()) ensureStateIgnored(state);
  return result;
}

function ensureStateIgnored(state) {
  const ignore = path.join(state, '.gitignore');
  // lstat also preserves an existing dangling symlink.
  try { lstatSync(ignore); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(state, `.gitignore-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, '*\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { linkSync(temporary, ignore); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally {
    unlinkSync(temporary);
    syncDirectory(state);
    syncDirectory(path.dirname(state));
  }
}
