import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
}

let request;
try { request = JSON.parse(readFileSync(0, 'utf8')); }
catch { process.exit(0); }

if (request.hook_event_name !== 'UserPromptSubmit' || typeof request.prompt !== 'string') process.exit(0);
// T3 adds this role header to its delegated task's user message.
const prompt = request.prompt.replace(/^Act as the (?:implementation|research|review|design|test|general) sub-agent for this task\.\r?\n\r?\n/, '');
const match = /^\s*consume[ \t]+([A-Za-z0-9_.\/\\][A-Za-z0-9_.\/\\:-]*)[ \t]*$/i.exec(prompt);
if (!match) process.exit(0);

if (typeof request.session_id !== 'string' || !request.session_id.trim()
  || typeof request.cwd !== 'string' || !path.isAbsolute(request.cwd)) {
  block('Runlist needs the native session_id and absolute cwd to consume the requested handoff.');
  process.exit(0);
}

const wrapper = fileURLToPath(new URL('./runlist-hook', import.meta.url));
const result = spawnSync('sh', [wrapper, 'prompts', 'use', match[1]], {
  cwd: request.cwd,
  env: { ...process.env, RUNLIST_SESSION_ID: request.session_id },
  encoding: 'utf8', timeout: 12_000, maxBuffer: 4 * 1024 * 1024,
});

if (result.error || result.status !== 0 || !result.stdout?.trim()) {
  const detail = result.error?.message || result.stderr?.trim() || 'No consumed handoff was returned; check that runlist is on PATH.';
  block(`Runlist could not consume ${match[1]}: ${detail.slice(0, 2000)}`);
  process.exit(0);
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: 'Runlist has already consumed the saved prompt requested by the user for this native session. Continue from the handoff below without consuming it again.\n\n'
      + result.stdout + (result.stderr ? '\nRunlist receipt:\n' + result.stderr : ''),
  },
}) + '\n');
