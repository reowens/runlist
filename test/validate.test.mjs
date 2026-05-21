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

  it('unknown status does not also trigger missing-updated error', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: implemented\n---\n# A\n');

    const result = run(['check']);
    // Unknown status itself is now an error, so exit 1 — but the missing-updated
    // check is gated on knownStatus, so we should NOT see that error compound on top.
    strictEqual(result.status, 1, `should fail on unknown status. stderr: ${result.stderr}`);
    ok(!result.stdout.includes('Missing frontmatter `updated`'), 'no updated error for unknown status');
  });

  it('known status without updated is still an error', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: active\n---\n# A\n');

    const result = run(['check']);
    strictEqual(result.status, 1, 'should fail for known status missing updated');
    ok(result.stdout.includes('Missing frontmatter `updated`'), 'shows updated error');
  });

  it('unknown status is an error', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: implemented\nupdated: 2025-01-01\n---\n# A\n');

    const result = run(['check']);
    strictEqual(result.status, 1, `should fail for unknown status. stderr: ${result.stderr}`);
    ok(result.stdout.includes('Unknown status'), 'shows error about unknown status');
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

describe('reference path resolution', () => {
  function setupRefProject() {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-refresolve-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
    mkdirSync(path.join(tmpDir, 'docs', 'modules', 'catalog'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const root = 'docs';
      export const referenceFields = { bidirectional: ['related_plans'], unidirectional: [] };
    `);
    return tmpDir;
  }

  it('accepts repo-root-relative paths in related_plans frontmatter', () => {
    const root = setupRefProject();
    // a.md is nested two deep; the repo-root form (docs/plans/b.md) should resolve.
    writeFileSync(path.join(root, 'docs', 'plans', 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - docs/plans/b.md\n---\n# A\n');
    writeFileSync(path.join(root, 'docs', 'plans', 'b.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - docs/plans/a.md\n---\n# B\n');
    const result = run(['check']);
    ok(!result.stdout.includes('does not resolve'),
      `repo-root-relative path should resolve. stdout: ${result.stdout}`);
  });

  it('accepts repo-root-relative paths in body links', () => {
    const root = setupRefProject();
    writeFileSync(path.join(root, 'docs', 'plans', 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n\nSee [catalog](docs/modules/catalog/catalog.md).\n');
    writeFileSync(path.join(root, 'docs', 'modules', 'catalog', 'catalog.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# Catalog\n');
    const result = run(['check']);
    ok(!result.stdout.includes('body link'),
      `repo-root-relative body link should resolve. stdout: ${result.stdout}`);
  });

  it('still flags genuinely missing reference targets', () => {
    const root = setupRefProject();
    writeFileSync(path.join(root, 'docs', 'plans', 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - docs/plans/missing.md\n---\n# A\n');
    const result = run(['check']);
    ok(result.stdout.includes('does not resolve'),
      `missing target should still be flagged. stdout: ${result.stdout}`);
  });

  it('treats both styles as the same target for bidirectional check', () => {
    const root = setupRefProject();
    // a.md uses repo-root style; b.md uses doc-relative style. Both should resolve
    // to the same canonical key, so the bidirectional pair is satisfied.
    writeFileSync(path.join(root, 'docs', 'plans', 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - docs/plans/b.md\n---\n# A\n');
    writeFileSync(path.join(root, 'docs', 'plans', 'b.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - ./a.md\n---\n# B\n');
    const result = run(['check']);
    ok(!result.stdout.includes('does not reference back'),
      `bidirectional pair should be satisfied across both path styles. stdout: ${result.stdout}`);
  });
});

describe('rootStatuses validation', () => {
  function setupMultiRootProject() {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-rootstatus-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'plans'), { recursive: true });
    mkdirSync(path.join(tmpDir, 'modules'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const root = ['plans', 'modules'];
      export const statuses = {
        rootStatuses: {
          'modules': ['implemented', 'partial'],
        },
      };
    `);
    return { plans: path.join(tmpDir, 'plans'), modules: path.join(tmpDir, 'modules') };
  }

  function run(args) {
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
    });
  }

  it('accepts root-specific status without warning', () => {
    const dirs = setupMultiRootProject();
    writeFileSync(path.join(dirs.modules, 'a.md'),
      '---\nstatus: implemented\nupdated: 2025-01-01\n---\n# A\n');
    const result = run(['check']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!result.stdout.includes('Unknown status'), 'no unknown status warning for root-allowed status');
  });

  it('warns when root-specific status used in wrong root', () => {
    const dirs = setupMultiRootProject();
    writeFileSync(path.join(dirs.plans, 'a.md'),
      '---\nstatus: implemented\nupdated: 2025-01-01\n---\n# A\n');
    const result = run(['check']);
    ok(result.stdout.includes('Unknown status'), 'warns about implemented in plans root');
  });

  it('global statuses valid in all roots', () => {
    const dirs = setupMultiRootProject();
    writeFileSync(path.join(dirs.modules, 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n');
    writeFileSync(path.join(dirs.plans, 'b.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# B\n');
    const result = run(['check']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!result.stdout.includes('Unknown status'), 'global status valid everywhere');
  });

  it('treats root-specific status as known for lifecycle field enforcement', () => {
    const dirs = setupMultiRootProject();
    // implemented without updated — should get error because it's now a known status
    writeFileSync(path.join(dirs.modules, 'a.md'),
      '---\nstatus: implemented\n---\n# A\n');
    const result = run(['check']);
    ok(result.stdout.includes('Missing frontmatter `updated`'), 'enforces updated for known root status');
  });
});
