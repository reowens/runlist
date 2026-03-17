import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { computeChecklistCompletionRate } from '../src/validate.mjs';

describe('computeChecklistCompletionRate', () => {
  it('returns ratio for non-empty checklist', () => {
    strictEqual(computeChecklistCompletionRate({ completed: 3, open: 1, total: 4 }), 0.75);
  });

  it('returns null for empty checklist', () => {
    strictEqual(computeChecklistCompletionRate({ completed: 0, open: 0, total: 0 }), null);
  });

  it('returns 1 for fully complete', () => {
    strictEqual(computeChecklistCompletionRate({ completed: 5, open: 0, total: 5 }), 1);
  });

  it('returns 0 for nothing complete', () => {
    strictEqual(computeChecklistCompletionRate({ completed: 0, open: 3, total: 3 }), 0);
  });
});

let tmpDir;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-validate-'));
  mkdirSync(path.join(tmpDir, '.git'));
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
  return docsDir;
}

function run(args) {
  const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
  return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
    cwd: tmpDir,
    encoding: 'utf8',
  });
}

describe('body link validation', () => {
  it('warns about broken body links', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n\nSee [broken](nonexistent.md) for details.\n');

    const result = run(['check']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('body link'), 'shows body link warning');
    ok(result.stdout.includes('nonexistent.md'), 'shows broken link path');
  });

  it('does not warn about valid body links', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n\nSee [B](b.md) for details.\n');
    writeFileSync(path.join(docsDir, 'b.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# B\n');

    const result = run(['check']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!result.stdout.includes('body link'), 'no body link warning for valid link');
  });

  it('skips links inside fenced code blocks', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n\n```\n[fake](nonexistent.md)\n```\n');

    const result = run(['check']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!result.stdout.includes('body link'), 'no warning for link inside code block');
  });

  it('unknown status is warning not error', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: implemented\nupdated: 2025-01-01\n---\n# A\n');

    const result = run(['check']);
    strictEqual(result.status, 0, `should not fail for unknown status. stderr: ${result.stderr}`);
    ok(result.stdout.includes('Unknown status'), 'shows warning about unknown status');
  });

  it('body link issues are warnings not errors', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n\n[broken](gone.md)\n');

    const result = run(['check', '--errors-only']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    // With --errors-only, body link warnings should be suppressed
    ok(!result.stdout.includes('body link'), 'body link warning suppressed with --errors-only');
  });
});
