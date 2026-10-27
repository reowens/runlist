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

// Node's test runner hands its children FORCE_COLOR=1 when it runs in a colour
// terminal, and color.mjs honours that first, so every output comparison saw
// escape codes under a TTY and passed only where stdout was piped. Each test
// process loads this file before any source, so output is plain everywhere; a
// colour test sets FORCE_COLOR itself.
if (process.env.NODE_TEST_CONTEXT) delete process.env.FORCE_COLOR;
// After that delete: util.mjs loads color.mjs, which reads FORCE_COLOR once on load.
const { agentSessionSource } = await import('../src/util.mjs');

if (!process.env[OWNER_FLAG]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runlist-test-logs-'));
  process.env[OWNER_FLAG] = String(process.pid);
  process.env.RUNLIST_ERROR_LOG_DIR = dir;
  // The legacy name too, so a test that clears the current one still lands here.
  process.env.DOTMD_ERROR_LOG_DIR = dir;
  // Nor reach a real model server or the operator's model settings.
  process.env.RUNLIST_MODEL_SETTINGS = path.join(dir, 'model.json');
  process.env.RUNLIST_MODEL_ENDPOINT = 'http://127.0.0.1:9';
  // And read the same memory on every machine.
  process.env.RUNLIST_MODEL_CAP_GB = '12';
  process.env.RUNLIST_MODEL_AVAILABLE_GB = '64';
  process.env.RUNLIST_MODEL_PRESSURE = 'normal';
  // Run as an agent session wherever `npm test` starts, the way it runs inside
  // Claude Code: runlist consumes prompts only in one. A test of the plain
  // terminal case clears every session variable itself.
  if (!agentSessionSource(process.env)) process.env.CLAUDE_CODE_SESSION_ID = 'runlist-test-session';
  process.on('exit', () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
}
