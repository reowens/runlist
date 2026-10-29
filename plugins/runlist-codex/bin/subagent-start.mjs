import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const wrapper = fileURLToPath(new URL('./runlist-hook', import.meta.url));
const result = spawnSync('sh', [wrapper, 'hud', '--subagent'], {
  encoding: 'utf8', timeout: 4_000, maxBuffer: 1024 * 1024,
});
const context = result.error || result.status !== 0
  ? `Runlist child orientation failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`
  : result.stdout.trim();

if (context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: context },
  }) + '\n');
}
