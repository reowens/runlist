// Retrying rename for publishing a prepared temp over a live path.
//
// Lives in its own leaf module rather than in atomic-mutation.mjs because
// atomic-mutation.mjs already imports git.mjs, and git.mjs needs this helper for
// its .git/index publish — exporting it from atomic-mutation.mjs would close an
// import cycle.
import { renameSync } from 'node:fs';

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

const RENAME_RETRY_CODES = ['EPERM', 'EBUSY', 'EACCES'];
const RENAME_RETRY_ATTEMPTS = 10;
const RENAME_RETRY_BACKOFF_MS = 10;

// Total the backoff can sleep across a fully exhausted retry — the sum of
// RENAME_RETRY_BACKOFF_MS × (1 … attempts-1). Exported so the budget can be
// checked against MUTATION_LOCK_TIMEOUT_MS deterministically, rather than by
// timing a run on a shared CI runner.
export const RENAME_RETRY_SLEEP_BUDGET_MS =
  (RENAME_RETRY_BACKOFF_MS * (RENAME_RETRY_ATTEMPTS - 1) * RENAME_RETRY_ATTEMPTS) / 2;

// Windows refuses to rename onto — or away from — a path another process holds
// open, surfacing EPERM/EBUSY/EACCES. That holder is by construction a
// non-cooperating one (editor, AV, Search Indexer, `git`): dotmd's path lock is
// advisory and only excludes other dotmd processes, so a retry here is never
// waiting on a peer we would have serialized against anyway. POSIX never fails a
// rename this way, so retrying there would mask a genuinely different fault.
//
// The budget is bounded by withPathLocks' timeoutMs (2000ms default): these
// renames run while the lock is held, so a longer budget would trade a rare
// transient EPERM for common peer MutationLockErrors. 10 attempts with a 10ms
// linear backoff is ~450ms of sleep — comfortable headroom under 2s. Do not
// raise it past ~1s without also raising timeoutMs.
export function commitRename(from, to, testHooks) {
  // Single seam for the platform check so the retry is reachable in tests on the
  // POSIX machines that actually run them.
  const windowsRenameSemantics = testHooks?.forceWindowsRenameSemantics ?? process.platform === 'win32';
  for (let attempt = 0; ; attempt++) {
    try {
      const injected = testHooks?.forceRenameError?.(attempt);
      if (injected) {
        const error = new Error(`injected rename ${injected}`);
        error.code = injected;
        throw error;
      }
      renameSync(from, to);
      return;
    } catch (err) {
      if (!windowsRenameSemantics) throw err;
      if (!RENAME_RETRY_CODES.includes(err?.code)) throw err;
      if (attempt >= RENAME_RETRY_ATTEMPTS - 1) throw err;
      Atomics.wait(sleepBuffer, 0, 0, RENAME_RETRY_BACKOFF_MS * (attempt + 1));
    }
  }
}
