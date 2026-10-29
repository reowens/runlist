import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CONFIG_FILENAMES, STATE_DIR } from './naming.mjs';

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
    // The repository top ends the search: a folder named like the state
    // folder above it belongs to someone else.
    if (parent === state || isRepoTop(state)) return mkdirSync(directory, options);
    state = parent;
  }
  // Only a project's own state folder sits at its top. Any other folder
  // with this name is not ours to hide, and without Git an ignore does nothing.
  if (!isRepoTop(path.dirname(state))) return mkdirSync(directory, options);
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

function isRepoTop(directory) {
  return existsSync(path.join(directory, '.git')) || CONFIG_FILENAMES.some(name => existsSync(path.join(directory, name)));
}

// The ignore is a convenience: failing to write it must never block the
// write that needed the folder. A filesystem without hard links gets an
// exclusive create instead, which still never replaces an existing file.
export function ensureStateIgnored(state) {
  const ignore = path.join(state, '.gitignore');
  // lstat also preserves an existing dangling symlink.
  try { lstatSync(ignore); return; }
  catch (error) { if (error.code !== 'ENOENT') return; }
  try { publishByLink(state, ignore); return; }
  catch (error) { if (error.code === 'EEXIST') return; }
  let fd;
  try { fd = openSync(ignore, 'wx', 0o600); } catch { return; }
  try {
    try { writeFileSync(fd, '*\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    syncDirectory(state);
  } catch {
    // A partial file would hide nothing and never be repaired; this one is ours.
    try { unlinkSync(ignore); } catch {}
  }
}

function publishByLink(state, ignore) {
  const temporary = path.join(state, `.gitignore-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, '*\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    linkSync(temporary, ignore);
  } finally {
    try { unlinkSync(temporary); } catch {}
    try { syncDirectory(state); syncDirectory(path.dirname(state)); } catch {}
  }
}
