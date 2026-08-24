import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { processOwnerLiveness } from './atomic-mutation.mjs';
import { LEGACY_STATE_DIR, STATE_DIR } from './naming.mjs';

export { stateDir } from './naming.mjs';

const MIGRATION_MARKER = 'migrated-from-dotmd.json';
const DROP_ENTRIES = new Set(['handoffs']);
const TERMINAL_TRANSACTION_STATUSES = new Set(['committed', 'rolled-back', 'failed-manual']);

function heldLocks(lockRoot) {
  if (!existsSync(lockRoot)) return [];
  let entries;
  try { entries = readdirSync(lockRoot); }
  catch { return [{ lock: path.basename(lockRoot), status: 'unreadable-directory' }]; }
  const held = [];
  for (const entry of entries) {
    const ownerPath = path.join(lockRoot, entry, 'owner.json');
    if (!existsSync(ownerPath)) {
      held.push({ lock: entry, status: 'owner-missing' });
      continue;
    }
    let owner;
    try { owner = JSON.parse(readFileSync(ownerPath, 'utf8')); }
    catch {
      held.push({ lock: entry, status: 'owner-unreadable' });
      continue;
    }
    if (processOwnerLiveness(owner) !== 'dead') {
      held.push({ lock: entry, status: 'held-or-unverifiable', pid: owner.pid, hostname: owner.hostname });
    }
  }
  return held;
}

function unresolvedTransactions(transactionRoot) {
  if (!existsSync(transactionRoot)) return [];
  let entries;
  try { entries = readdirSync(transactionRoot); }
  catch { return [{ id: path.basename(transactionRoot), status: 'unreadable-directory' }]; }
  const open = [];
  for (const entry of entries) {
    const manifestPath = path.join(transactionRoot, entry, 'manifest.json');
    if (!existsSync(manifestPath)) {
      open.push({ id: entry, status: 'manifest-missing' });
      continue;
    }
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
    catch { open.push({ id: entry, status: 'unreadable' }); continue; }
    if (!TERMINAL_TRANSACTION_STATUSES.has(manifest.status)) {
      open.push({ id: entry, status: manifest.status ?? 'unknown' });
    }
  }
  return open;
}

function moveEntry(from, to) {
  if (existsSync(to)) {
    if (statSync(to).isDirectory() && statSync(from).isDirectory()) {
      for (const child of readdirSync(from)) moveEntry(path.join(from, child), path.join(to, child));
      rmSync(from, { recursive: true, force: true });
      return;
    }
    // Current state wins an exact-name collision. The legacy copy is stale by
    // definition and retaining both would make the next migration ambiguous.
    rmSync(from, { recursive: true, force: true });
    return;
  }
  renameSync(from, to);
}

export function migrateStateDirectory(repoRoot, options = {}) {
  const root = path.resolve(repoRoot);
  const from = path.join(root, LEGACY_STATE_DIR);
  const to = path.join(root, STATE_DIR);
  if (!existsSync(from)) return { status: 'noop', reason: 'nothing-to-migrate', from, to };

  const held = heldLocks(path.join(from, 'locks'));
  if (held.length) {
    return {
      status: 'refused', reason: 'locks-held', detail: held, from, to,
      message: `Legacy state has ${held.length} lock${held.length === 1 ? '' : 's'} that ${held.length === 1 ? 'is' : 'are'} not provably abandoned. State migration refused; retry after active work finishes or inspect with \`runlist doctor --transactions\`.`,
    };
  }

  const open = unresolvedTransactions(path.join(from, 'transactions'));
  if (open.length) {
    return {
      status: 'refused', reason: 'transactions-unresolved', detail: open, from, to,
      message: `${open.length} transaction${open.length === 1 ? ' is' : 's are'} not terminal (${open.map(item => `${item.id}: ${item.status}`).join(', ')}). State migration refused. Resolve with \`runlist doctor --transactions --apply\`, then retry.`,
    };
  }

  if (options.dryRun) return { status: 'noop', reason: 'dry-run', from, to };

  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (DROP_ENTRIES.has(entry)) {
      rmSync(path.join(from, entry), { recursive: true, force: true });
      continue;
    }
    moveEntry(path.join(from, entry), path.join(to, entry));
  }
  try { if (readdirSync(from).length === 0) rmdirSync(from); } catch {}

  writeFileSync(
    path.join(to, MIGRATION_MARKER),
    JSON.stringify({ from: LEGACY_STATE_DIR, to: STATE_DIR, migratedAt: new Date().toISOString() }, null, 2) + '\n',
  );
  return { status: 'migrated', from, to };
}
