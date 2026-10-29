import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { isHandoffAsk, isPickupAsk } from '../src/hud.mjs';
import { saveRequests, pickupRequests, mixedRequests, longRequest } from './fixtures/handoff-phrases.mjs';

// The plugin's hooks all run through this wrapper. Its contract:
//   - dotmd off PATH + --hint (SessionStart)      → one install-hint line, exit 0
//   - dotmd off PATH, no --hint (SubagentStart…)  → silent, exit 0
//   - dotmd off PATH, guard (PreToolUse)          → silent, exit 0 (never block)
//   - dotmd on PATH                               → execs the real binary
const wrapper = path.resolve(import.meta.dirname, '..', 'plugins', 'runlist', 'bin', 'runlist-hook');

// Invoke exactly as Claude Code would: `sh <wrapper> <args...>`. `pathDir` goes
// first on PATH (so a planted fake `dotmd` wins); the trailing system dirs only
// provide `sh` itself — the globally-installed `dotmd` lives in npm's bin, not
// /usr/bin or /bin, so it stays invisible unless `pathDir` supplies it.
function runHook(args, pathDir, input, script = wrapper) {
  return spawnSync('sh', [script, ...args], {
    encoding: 'utf8',
    input,
    env: { PATH: `${pathDir}:/usr/bin:/bin` },
  });
}

describe('plugin hook wrapper (missing dotmd binary)', { skip: process.platform === 'win32' && 'POSIX sh plugin wrapper' }, () => {
  it('--hint surfaces a single install hint and exits 0', () => {
    // Empty temp dir on PATH → no `dotmd`. `command -v` / `echo` are shell
    // builtins, so the wrapper still runs.
    const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-nopath-'));
    try {
      const r = runHook(['--hint', 'hud'], emptyDir);
      strictEqual(r.status, 0, `expected exit 0; stderr: ${r.stderr}`);
      match(r.stdout, /not on this app's PATH/, `expected PATH-aware hint; got: ${r.stdout}`);
      ok(r.stdout.includes(`PATH searched: ${emptyDir}`), 'shows the PATH it searched');
      match(r.stdout, /Not installed yet: run `npm install -g runlist`/);
      match(r.stdout, /Already installed: restart the app from a terminal.*login profile/);
      ok(!/npm i -g/.test(r.stdout), 'one spelling of the install command');
      strictEqual(r.stdout.trim().split('\n').length, 2, 'hint is two lines: what is wrong, then the fix');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('truncates a long PATH in the hint', () => {
    const longDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-nopath-'));
    try {
      const r = runHook(['--hint', 'hud'], `${longDir}:${'/nonexistent/segment:'.repeat(30)}`);
      strictEqual(r.status, 0);
      const line = r.stdout.split('\n')[0];
      match(line, /PATH searched: .*\.\.\.$/);
      ok(line.length < 400, `hint line stays short; got ${line.length} chars`);
    } finally {
      rmSync(longDir, { recursive: true, force: true });
    }
  });

  it('without --hint stays silent (SubagentStart/CwdChanged)', () => {
    const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-nopath-'));
    try {
      const r = runHook(['hud', '--subagent'], emptyDir);
      strictEqual(r.status, 0, `expected exit 0; stderr: ${r.stderr}`);
      strictEqual(r.stdout, '', `expected no output; got: ${r.stdout}`);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('guard is a clean no-op when the binary is missing (never blocks)', () => {
    const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-nopath-'));
    try {
      const r = runHook(['guard'], emptyDir);
      strictEqual(r.status, 0, `guard must exit 0 when dotmd is absent; stderr: ${r.stderr}`);
      strictEqual(r.stdout, '', `guard must emit nothing when dotmd is absent; got: ${r.stdout}`);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('plugin hook wrapper (dotmd present)', { skip: process.platform === 'win32' && 'POSIX sh plugin wrapper' }, () => {
  it('execs the real binary, forwarding all args', () => {
    const binDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-fakebin-'));
    try {
      // Fake `dotmd` that echoes its args so we can prove the wrapper exec'd it
      // with the subcommand intact (and dropped the consumed --hint flag).
      const fake = path.join(binDir, 'dotmd');
      writeFileSync(fake, '#!/bin/sh\necho "FAKE-DOTMD: $@"\n');
      chmodSync(fake, 0o755);

      const r = runHook(['--hint', 'hud'], binDir);
      strictEqual(r.status, 0, `expected exit 0; stderr: ${r.stderr}`);
      match(r.stdout, /FAKE-DOTMD: hud/, `expected real binary to run with hud; got: ${r.stdout}`);
      ok(!r.stdout.includes('--hint'), '--hint is consumed by the wrapper, not forwarded');
      ok(!r.stdout.includes('npm install -g'), 'no install hint when the binary is present');
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('routes broad Git and Windows prompt guard payloads through Node', () => {
    const binDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-fakebin-'));
    try {
      const fake = path.join(binDir, 'dotmd');
      writeFileSync(fake, '#!/bin/sh\necho "FAKE-DOTMD: $@"\n');
      chmodSync(fake, 0o755);
      const broad = runHook(['guard'], binDir, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git add .' } }));
      match(broad.stdout, /FAKE-DOTMD: guard/);
      const gitOptions = runHook(['guard'], binDir, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git -C . add .' } }));
      match(gitOptions.stdout, /FAKE-DOTMD: guard/);
      const sudo = runHook(['guard'], binDir, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'sudo git add .' } }));
      match(sudo.stdout, /FAKE-DOTMD: guard/);
      const windows = runHook(['guard'], binDir, JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'docs\\prompts\\x.md' } }));
      match(windows.stdout, /FAKE-DOTMD: guard/);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  // UserPromptSubmit fires on every message; only a handoff request should pay
  // for a Node start, and a failing CLI (an older one without the flag) must
  // never turn a message into a hook error.
  it('keeps both prompt globs weaker than Node and skips realistic quiet payloads', t => {
    const binDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-fakebin-'));
    try {
      const fake = path.join(binDir, 'runlist');
      writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho "FAKE-RUNLIST: $@"\nexit 1\n');
      chmodSync(fake, 0o755);
      const hook = ['hud', '--prompt-submit'];
      const scripts = [wrapper, path.resolve(import.meta.dirname, '..', 'plugins', 'runlist-codex', 'bin', 'runlist-hook')];
      strictEqual(readFileSync(scripts[0], 'utf8'), readFileSync(scripts[1], 'utf8'), 'both wrappers are byte-identical');
      const requests = ['Baton this', 'can you HAND OFF', 'save a resume prompt', 'pick it up next time', ...saveRequests, ...pickupRequests, ...mixedRequests, longRequest];
      let positives = 0;
      const payload = prompt => JSON.stringify({
        session_id: 'synthetic-id', transcript_path: '/tmp/somewhere/holiday-planner/synthetic-log.jsonl', cwd: '/tmp/somewhere/holiday-planner',
        hook_event_name: 'UserPromptSubmit', permission_mode: 'default', prompt,
      });
      for (const script of scripts) {
        for (const prompt of requests.flatMap(text => [text, text.toUpperCase(), text.replaceAll("'", '’'), text.replaceAll(' ', '\t'), text.replaceAll(' ', '\u00a0')])) {
          // Normalize apostrophes exactly as the matcher does before checking coverage.
          const normalized = prompt.replaceAll('’', "'");
          if (!isHandoffAsk(normalized) && !isPickupAsk(normalized)) continue;
          positives++;
          const r = runHook(hook, binDir, payload(prompt), script);
          strictEqual(r.status, 0, r.stderr);
          match(r.stdout, /FAKE-RUNLIST: hud --prompt-submit/, `${script}: ${prompt}`);
        }
        for (const prompt of [
          'fix the flaky test', 'save the file', 'continue with the next step',
          'add a WHERE clause', 'update the Monday report', 'check collateral', 'fix the next timeout',
        ]) {
          const quiet = runHook(hook, binDir, payload(prompt), script);
          strictEqual(quiet.status, 0);
          strictEqual(quiet.stdout, '');
        }
      }
      t.diagnostic(`${positives} Node-positive variants across both wrappers; none skipped`);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
