import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// The plugin's hooks all run through this wrapper. Its contract:
//   - dotmd off PATH + --hint (SessionStart)      → one install-hint line, exit 0
//   - dotmd off PATH, no --hint (SubagentStart…)  → silent, exit 0
//   - dotmd off PATH, guard (PreToolUse)          → silent, exit 0 (never block)
//   - dotmd on PATH                               → execs the real binary
const wrapper = path.resolve(import.meta.dirname, '..', 'plugins', 'dotmd', 'bin', 'dotmd-hook');

// Invoke exactly as Claude Code would: `sh <wrapper> <args...>`. `pathDir` goes
// first on PATH (so a planted fake `dotmd` wins); the trailing system dirs only
// provide `sh` itself — the globally-installed `dotmd` lives in npm's bin, not
// /usr/bin or /bin, so it stays invisible unless `pathDir` supplies it.
function runHook(args, pathDir) {
  return spawnSync('sh', [wrapper, ...args], {
    encoding: 'utf8',
    env: { PATH: `${pathDir}:/usr/bin:/bin` },
  });
}

describe('plugin hook wrapper (missing dotmd binary)', () => {
  it('--hint surfaces a single install hint and exits 0', () => {
    // Empty temp dir on PATH → no `dotmd`. `command -v` / `echo` are shell
    // builtins, so the wrapper still runs.
    const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-nopath-'));
    try {
      const r = runHook(['--hint', 'hud'], emptyDir);
      strictEqual(r.status, 0, `expected exit 0; stderr: ${r.stderr}`);
      match(r.stdout, /npm i -g dotmd-cli/, `expected install hint; got: ${r.stdout}`);
      strictEqual(r.stdout.trim().split('\n').length, 1, 'hint is a single line');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
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

describe('plugin hook wrapper (dotmd present)', () => {
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
      ok(!r.stdout.includes('npm i -g'), 'no install hint when the binary is present');
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
