// dotmd's OpenCode integration. Installed by `dotmd install opencode`, which
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
//  2. NO HOOK MAY THROW. OpenCode awaits hook callbacks inside the request it
//     is serving; a rejected promise fails the user's chat turn. Every hook
//     body is wrapped, and a failure degrades to "dotmd does nothing here"
//     rather than to a broken session.
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

function dotmdExecutable() {
  return process.platform === 'win32' ? 'dotmd.cmd' : 'dotmd';
}

function runHud(directory) {
  return new Promise(resolve => {
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    try {
      execFile(dotmdExecutable(), ['hud'], {
        cwd: directory,
        timeout: PRIMER_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1' },
      }, (error, stdout) => done(error ? '' : (stdout ?? '').trim()));
    } catch {
      // `dotmd` not on PATH, spawn refused — no primer, no noise.
      done('');
    }
  });
}

export default async function dotmdOpencodePlugin({ directory }) {
  // Keyed by session so a subagent session primes independently, the way
  // SubagentStart does under Claude Code.
  const primers = new Map();

  async function primerFor(sessionId) {
    const key = sessionId ?? '';
    const cached = primers.get(key);
    // Refreshed on a TTL rather than cached for the session's life: OpenCode
    // rebuilds the system prompt every turn, so a once-only push would reach
    // only the first request — and a never-refreshed one would keep announcing
    // a pending prompt this session already consumed.
    if (cached && Date.now() - cached.at < PRIMER_TTL_MS) return cached.text;
    const text = await runHud(directory);
    primers.set(key, { text, at: Date.now() });
    return text;
  }

  return {
    // Ownership identity. OpenCode sets no session-id variable of its own, and
    // `OPENCODE_PID` — what dotmd falls back to without this plugin — names the
    // OpenCode *process*, so every session in one TUI shares it and can release
    // the others' plans. This is the only place the real session id is
    // available to a tool shell.
    'shell.env': async (input, output) => {
      try {
        if (input?.sessionID) output.env.DOTMD_SESSION_ID = `opencode:${input.sessionID}`;
        // The OpenCode server process hosts the session and outlives every tool
        // shell, so it is the process whose liveness answers "is this claim's
        // owner still there?" — `dotmd doctor --claims` probes exactly this.
        output.env.DOTMD_SESSION_PID = String(process.pid);
      } catch { /* never break a shell over this */ }
    },

    // Session priming — the equivalent of the SessionStart hook that runs
    // `dotmd hud` under Claude Code. Silent outside a dotmd repo (hud prints
    // nothing and exits 0), so this is inert in unrelated projects.
    'experimental.chat.system.transform': async (input, output) => {
      try {
        const text = await primerFor(input?.sessionID);
        if (text) output.system.push(text);
      } catch { /* priming is best-effort */ }
    },
  };
}
