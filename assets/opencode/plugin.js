// runlist's OpenCode integration. Installed by `runlist install opencode`, which
// copies this file (with a version banner prepended) to the OpenCode plugin
// directory, where OpenCode auto-discovers it — it globs
// `{plugin,plugins}/*.{ts,js}` under `.opencode/` and the global config dir, so
// no `opencode.json` edit is needed.
//
// TWO CONSTRAINTS, both load-bearing:
//
//  1. EXACTLY ONE EXPORT. OpenCode treats every export of a plugin module as a
//     plugin factory and throws `Plugin export is not a function` on anything
//     that isn't one — so an exported helper wouldn't just be untidy, it would
//     be *called* as a second plugin. Helpers stay module-local.
//
//  2. Only a deliberate guard denial may throw. OpenCode awaits hooks inside
//     the chat request, so every other failure degrades to a no-op.
//
// Runs under Bun inside the OpenCode process. Node builtins only, no deps.

import { execFile } from 'node:child_process';

// The primer is a nicety; identity is a correctness invariant. They are split
// across two hooks deliberately: `shell.env` is stable API, while
// `experimental.chat.system.transform` may be renamed by OpenCode. If it is,
// priming stops and ownership keeps working — the failure lands on the half
// that can afford it.
const PRIMER_TTL_MS = 60_000;
const PRIMER_TIMEOUT_MS = 5_000;

function cliExecutables() {
  return process.platform === 'win32' ? ['runlist.cmd', 'dotmd.cmd'] : ['runlist', 'dotmd'];
}

// Runs the CLI and resolves its trimmed stdout, or '' on any failure. `input`,
// when given, is written to the child's stdin.
function runCli(directory, args, input = null) {
  return new Promise(resolve => {
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    const candidates = cliExecutables();
    const attempt = index => {
      if (index >= candidates.length) { done(''); return; }
      try {
        const child = execFile(candidates[index], args, {
          cwd: directory,
          timeout: PRIMER_TIMEOUT_MS,
          windowsHide: true,
          // Node refuses to execFile a `.cmd` without a shell (EINVAL since the
          // 2024 batch-file fix), and npm installs the CLI on Windows as one.
          // The arguments are fixed strings, never user input.
          shell: process.platform === 'win32',
          env: { ...process.env, NO_COLOR: '1' },
        }, (error, stdout) => {
          if (error?.code === 'ENOENT') attempt(index + 1);
          else done(error ? '' : (stdout ?? '').trim());
        });
        child.stdin?.on('error', () => {});
        if (input !== null) child.stdin?.end(input);
        else child.stdin?.end();
      } catch { attempt(index + 1); }
    };
    attempt(0);
  });
}

// OpenCode runs no Claude Code hooks. Evaluate recognized prompt reads before
// the tool so opt-in strict mode can block them. Its V1 before hook cannot
// return model context, so ordinary warnings are appended to the result.
const PROMPT_FILE = /(^|[\\/])prompts[\\/]\S*\.md\b/;

function guardPayload(tool, args) {
  if (tool === 'read' && typeof args?.filePath === 'string' && PROMPT_FILE.test(args.filePath)) {
    return { tool_name: 'Read', tool_input: { file_path: args.filePath } };
  }
  if (tool === 'bash' && typeof args?.command === 'string' && PROMPT_FILE.test(args.command)) {
    return { tool_name: 'Bash', tool_input: { command: args.command } };
  }
  return null;
}

export default async function dotmdOpencodePlugin({ directory }) {
  // Keyed by session so a subagent session primes independently, the way
  // SubagentStart does under Claude Code.
  const primers = new Map();
  const guardDecisions = new Map();

  async function guardFor(tool, args) {
    const payload = guardPayload(tool, args);
    if (!payload) return null;
    const raw = await runCli(directory, ['guard'], JSON.stringify(payload));
    return raw ? JSON.parse(raw)?.hookSpecificOutput ?? null : null;
  }

  async function primerFor(sessionId) {
    const key = sessionId ?? '';
    const cached = primers.get(key);
    // Refreshed on a TTL rather than cached for the session's life: OpenCode
    // rebuilds the system prompt every turn, so a once-only push would reach
    // only the first request — and a never-refreshed one would keep announcing
    // a pending prompt this session already consumed.
    if (cached && Date.now() - cached.at < PRIMER_TTL_MS) return cached.text;
    const text = await runCli(directory, ['hud']);
    primers.set(key, { text, at: Date.now() });
    return text;
  }

  return {
    'tool.execute.before': async (input, output) => {
      let refusal = null;
      try {
        const decision = await guardFor(input?.tool, output?.args);
        if (input?.callID && decision) guardDecisions.set(input.callID, decision);
        if (decision?.permissionDecision === 'deny') {
          if (input?.callID) guardDecisions.delete(input.callID);
          refusal = decision.permissionDecisionReason;
        }
      } catch { /* a missing/broken guard must not fail the chat turn */ }
      if (refusal) throw new Error(`[runlist] ${refusal}`);
    },
    // Ownership identity. OpenCode sets no session-id variable of its own, and
    // `OPENCODE_PID` — what runlist falls back to without this plugin — names the
    // OpenCode *process*, so every session in one TUI shares it and can release
    // the others' plans. This is the only place the real session id is
    // available to a tool shell.
    'shell.env': async (input, output) => {
      try {
        if (input?.sessionID) {
          output.env.RUNLIST_SESSION_ID = `opencode:${input.sessionID}`;
          // Legacy name, kept for an older CLI (before 0.77.0) still on PATH.
          output.env.DOTMD_SESSION_ID = `opencode:${input.sessionID}`;
        }
        // The OpenCode server process hosts the session and outlives every tool
        // shell, so it is the process whose liveness answers "is this claim's
        // owner still there?" — `runlist doctor --claims` probes exactly this.
        output.env.RUNLIST_SESSION_PID = String(process.pid);
        output.env.DOTMD_SESSION_PID = String(process.pid);
      } catch { /* never break a shell over this */ }
    },

    // The guard's warnings, appended after the call ran. A `deny` from the
    // guard is ignored here: the call has already happened, so there is
    // nothing left to refuse.
    'tool.execute.after': async (input, output) => {
      try {
        if (typeof output?.output !== 'string') return;
        const decision = input?.callID ? guardDecisions.get(input.callID) : null;
        if (input?.callID) guardDecisions.delete(input.callID);
        const note = (decision ?? await guardFor(input?.tool, input?.args))?.additionalContext;
        if (typeof note === 'string' && note) output.output += `\n\n${note}`;
      } catch { /* a guard failure never touches the tool result */ }
    },

    // Session priming — the equivalent of the SessionStart hook that runs
    // `runlist hud` under Claude Code. Silent outside a runlist repo (hud prints
    // nothing and exits 0), so this is inert in unrelated projects.
    'experimental.chat.system.transform': async (input, output) => {
      try {
        const text = await primerFor(input?.sessionID);
        if (text) output.system.push(text);
      } catch { /* priming is best-effort */ }
    },
  };
}
