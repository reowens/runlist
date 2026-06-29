import { describe, it, beforeEach, afterEach } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// End-to-end coverage for the CRLF (Windows) frontmatter fix. Before the fix a
// CRLF-authored doc read as having no frontmatter and dropped out of the managed
// set entirely — invisible to `dotmd plans`, and `dotmd set` died on it. These
// drive the real CLI to prove the doc is now indexed and mutable, and that the
// first rewrite settles its line endings to LF (content-preserving).

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

let tmpDir;
let configPath;

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-crlf-'));
  spawnSync('git', ['init', '-q'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
  mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'docs', 'archived'), { recursive: true });
  configPath = path.join(tmpDir, 'dotmd.config.mjs');
  writeFileSync(configPath, `export const root = 'docs';\n`);
}

function writeCrlfPlan(name, status = 'active') {
  const file = path.join(tmpDir, 'docs', 'plans', `${name}.md`);
  const lines = ['---', 'type: plan', `status: ${status}`, `title: ${name}`, 'updated: 2025-01-01', '---', `# ${name}`, '', '## Problem', 'Windows wrote this.', ''];
  writeFileSync(file, lines.join('\r\n'));
  spawnSync('git', ['add', file], { cwd: tmpDir });
  spawnSync('git', ['commit', '-qm', `add ${name}`], { cwd: tmpDir });
  return file;
}

function run(args) {
  return spawnSync('node', [bin, ...args, '--config', configPath], {
    cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
}

beforeEach(setupProject);
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('CRLF docs are managed', () => {
  it('a CRLF plan shows up in `dotmd plans` (not dropped as untyped)', () => {
    writeCrlfPlan('windows-plan');
    const res = run(['plans']);
    strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    ok(res.stdout.includes('windows-plan'), `CRLF plan should be listed; got: ${res.stdout}`);
  });

  it('`dotmd check` does not flag a CRLF plan as having no frontmatter', () => {
    writeCrlfPlan('windows-plan');
    const res = run(['check']);
    ok(!/no frontmatter/i.test(res.stdout + res.stderr),
      `CRLF doc wrongly flagged frontmatter-less; got: ${res.stdout}${res.stderr}`);
  });

  it('`dotmd set` mutates a CRLF plan and settles it to LF', () => {
    const file = writeCrlfPlan('windows-plan', 'active');
    // Read-only listing must not have rewritten the file yet.
    ok(readFileSync(file, 'utf8').includes('\r\n'), 'file is still CRLF before any mutation');

    const res = run(['set', 'in-session', 'docs/plans/windows-plan.md']);
    strictEqual(res.status, 0, `stderr: ${res.stderr}`);

    const after = readFileSync(file, 'utf8');
    ok(after.includes('status: in-session'), `status updated; got:\n${after}`);
    ok(!after.includes('\r\n'), 'first rewrite normalized the doc to LF');
    ok(after.includes('Windows wrote this.'), 'body content preserved through normalization');
  });
});
