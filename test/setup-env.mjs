// Preloaded by `npm test` (node --import). Tests must never write the real
// cross-repo logs under ~/.claude/logs: a guard or failing-command test that
// forgets to point RUNLIST_ERROR_LOG_DIR somewhere else would otherwise append
// to the operator's live misuse and error logs. Setting it once here covers
// every test process — the runner's children inherit the environment — and a
// test that needs its own directory still overrides it explicitly.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OWNER_FLAG = 'RUNLIST_TEST_LOG_DIR_OWNER';

if (!process.env[OWNER_FLAG]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runlist-test-logs-'));
  process.env[OWNER_FLAG] = String(process.pid);
  process.env.RUNLIST_ERROR_LOG_DIR = dir;
  // The legacy name too, so a test that clears the current one still lands here.
  process.env.DOTMD_ERROR_LOG_DIR = dir;
  process.on('exit', () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
}
