import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

let tmpDir;
const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-hud-'));
  spawnSync('git', ['init'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(path.join(docsDir, 'archived'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\n`);
  // Pre-stamp the primer marker so the default test setup represents a
  // session that's already seen the teach-once primer. Tests that want to
  // exercise the first-session primer should delete this marker explicitly.
  mkdirSync(path.join(tmpDir, '.dotmd'), { recursive: true });
  writeFileSync(path.join(tmpDir, '.dotmd', 'primer-shown'), '');
  return docsDir;
}

function writeDoc(docsDir, filename, frontmatter, body = '') {
  const filePath = path.join(docsDir, filename);
  writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`);
  spawnSync('git', ['add', filePath], { cwd: tmpDir });
  spawnSync('git', ['commit', '-m', `add ${filename}`], { cwd: tmpDir });
  return filePath;
}

function runCli(args, { session = 'sess-A', input } = {}) {
  return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
    cwd: tmpDir,
    encoding: 'utf8',
    input,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: session, PATH: process.env.PATH },
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// HUD contract (post-scrub):
//   - stdout always emits a single command primer line (the verb cheat-sheet)
//   - HUD never surfaces plan/prompt/lease/error state in stdout — those signals
//     belong in their own commands (`plans`, `prompts`, `set --help`)
//   - `--json` still returns the structured shape (owned/prompts/stale/errors)
//     for any programmatic caller that wants it, and skips the human primer
//   - slash-command staleness is self-healed and emits a dim refresh line
describe('dotmd hud', () => {
  it('always emits the command primer (one line)', () => {
    setupProject();
    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(/dotmd:/.test(r.stdout), `expected primer line; got: ${r.stdout}`);
    ok(/set <status>/.test(r.stdout), `primer should name the set verb; got: ${r.stdout}`);
    ok(/new <type>/.test(r.stdout), `primer should name the new verb; got: ${r.stdout}`);
    ok(/\buse\b/.test(r.stdout), `primer should name the use verb; got: ${r.stdout}`);
  });

  it('does NOT show owned/prompts/stale/errors in stdout', () => {
    // Even with a held lease + pending prompts + a validation error, the
    // human-facing hud output stays the primer only. Plan/prompt state has
    // dedicated commands (`plans`, `prompts`) — hud is verbs-only.
    const docsDir = setupProject();
    writeDoc(docsDir, 'p.md', 'type: plan\nstatus: active\nupdated: 2025-01-01\nmodules: [core]', '# P\n');
    runCli(['pickup', 'p.md']); // grab a lease via the still-dispatched verb
    mkdirSync(path.join(docsDir, 'prompts'), { recursive: true });
    writeDoc(docsDir, 'prompts/x.md', 'type: prompt\nstatus: pending\ncreated: 2025-01-01', 'body\n');
    writeDoc(docsDir, 'broken.md', 'type: plan\nstatus: archived\nupdated: 2025-01-01', '# Broken\n');

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    // The plan-state lines were arrow-prefixed (`▶`, `⚠`, `✗`); none should remain.
    ok(!/[▶⚠✗]/.test(r.stdout), `stdout should not carry plan-state arrows; got: ${r.stdout}`);
    ok(!/You hold/.test(r.stdout), `stdout should not mention held leases; got: ${r.stdout}`);
    ok(!/\d+ pending prompt/.test(r.stdout), `stdout should not list a pending-prompt count; got: ${r.stdout}`);
    ok(!/validation error/.test(r.stdout), `stdout should not surface error counts; got: ${r.stdout}`);
    ok(!/stuck lease/.test(r.stdout), `stdout should not surface stuck leases; got: ${r.stdout}`);
  });

  it('--json still exposes structured state for programmatic callers', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'p.md', 'type: plan\nstatus: active\nupdated: 2025-01-01\nmodules: [core]', '# P\n');
    runCli(['pickup', 'p.md']);

    const r = runCli(['hud', '--json']);
    strictEqual(r.status, 0, `hud --json failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    ok(Array.isArray(parsed.owned), '.owned is an array');
    ok(Array.isArray(parsed.prompts), '.prompts is an array');
    ok(Array.isArray(parsed.stale), '.stale is an array');
    strictEqual(typeof parsed.errors, 'number', '.errors is a number');
  });

  it('--json skips the human primer (structured output stays stable)', () => {
    setupProject();
    const r = runCli(['hud', '--json']);
    strictEqual(r.status, 0, `hud --json failed: ${r.stderr}`);
    ok(!r.stdout.includes('dotmd:'), 'no primer text in JSON output');
    JSON.parse(r.stdout); // should parse clean
  });

  it('self-heals stale slash-command files and surfaces a dim refresh line', () => {
    setupProject();
    const cmdDir = path.join(tmpDir, '.claude', 'commands');
    mkdirSync(cmdDir, { recursive: true });
    const batonPath = path.join(cmdDir, 'baton.md');
    writeFileSync(batonPath, '<!-- dotmd-generated: 0.0.1 -->\nstale body\n');

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(/slash commands refreshed/.test(r.stdout), `expected refresh line; got: ${r.stdout}`);
    ok(/0\.0\.1\s*→/.test(r.stdout), `refresh line should show version transition; got: ${r.stdout}`);
    ok(/baton\.md/.test(r.stdout), `refresh line should name the file; got: ${r.stdout}`);
    ok(/dotmd:/.test(r.stdout), `primer line should still emit alongside refresh; got: ${r.stdout}`);

    const content = readFileSync(batonPath, 'utf8');
    ok(!content.includes('dotmd-generated: 0.0.1'), 'stale banner should be gone after refresh');
    ok(!content.includes('stale body'), 'stale body should be replaced');
  });

  it('does not emit a refresh line when slash-command banners are current', () => {
    setupProject();
    const cmdDir = path.join(tmpDir, '.claude', 'commands');
    mkdirSync(cmdDir, { recursive: true });
    const pkgVersion = JSON.parse(readFileSync(
      path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8',
    )).version;
    writeFileSync(path.join(cmdDir, 'baton.md'), `<!-- dotmd-generated: ${pkgVersion} -->\ncurrent body\n`);

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(!/slash commands refreshed/.test(r.stdout), `should not refresh when current; got: ${r.stdout}`);
    ok(/dotmd:/.test(r.stdout), `primer should still emit; got: ${r.stdout}`);
  });

  it('does not touch user-managed slash-command files (no banner)', () => {
    setupProject();
    const cmdDir = path.join(tmpDir, '.claude', 'commands');
    mkdirSync(cmdDir, { recursive: true });
    const customPath = path.join(cmdDir, 'baton.md');
    const original = '# my hand-rolled baton, no dotmd marker\n';
    writeFileSync(customPath, original);

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(!/slash commands refreshed/.test(r.stdout), `should not announce refresh for user files; got: ${r.stdout}`);
    strictEqual(readFileSync(customPath, 'utf8'), original, 'user file untouched');
  });

  it('survives missing .claude/ directory without erroring', () => {
    setupProject();
    ok(!existsSync(path.join(tmpDir, '.claude')), 'precondition: no .claude/');
    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(/dotmd:/.test(r.stdout), `primer should still emit; got: ${r.stdout}`);
  });

  it('--json error count remains parity with `dotmd check --json`', () => {
    // Even though stdout no longer prints the error count, the --json shape
    // still surfaces .errors for programmatic callers. Contract: it equals
    // what `dotmd check --json` reports.
    function errorCount(json) { return JSON.parse(json).errors ?? 0; }
    function checkErrorCount(json) { return (JSON.parse(json).errors ?? []).length; }

    const docsDir = setupProject();
    writeDoc(docsDir, 'plan-a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01\nmodules: [core]', '# A\n');
    let hudJson = runCli(['hud', '--json']);
    let checkJson = runCli(['check', '--json']);
    strictEqual(errorCount(hudJson.stdout), checkErrorCount(checkJson.stdout), 'clean-repo parity');
    strictEqual(errorCount(hudJson.stdout), 0, 'clean repo: 0 errors');

    writeDoc(docsDir, 'broken.md', 'type: plan\nstatus: archived\nupdated: 2025-01-01', '# Broken\n');
    hudJson = runCli(['hud', '--json']);
    checkJson = runCli(['check', '--json']);
    strictEqual(errorCount(hudJson.stdout), checkErrorCount(checkJson.stdout), 'archive-drift parity');
    ok(errorCount(hudJson.stdout) >= 1, 'archive drift counted');
  });

  it('stdout stays under ~500 bytes regardless of repo state', () => {
    const docsDir = setupProject();
    for (let i = 0; i < 5; i++) {
      writeDoc(docsDir, `held-${i}.md`, 'type: plan\nstatus: active\nupdated: 2025-01-01', '# held\n');
      runCli(['pickup', `held-${i}.md`]);
    }
    mkdirSync(path.join(docsDir, 'prompts'), { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeDoc(docsDir, `prompts/p-${i}.md`, 'type: prompt\nstatus: pending\ncreated: 2025-01-01', 'body\n');
    }
    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(r.stdout.length < 500, `hud output too large: ${r.stdout.length} bytes\n${r.stdout}`);
  });

});
