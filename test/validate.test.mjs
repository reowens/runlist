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

describe('type-scoped status validation (strict)', () => {
  // When a doc declares a known type, its status MUST come from that type's vocab.
  // Falling through to the global union would let `type: prompt, status: active`
  // pass just because `active` is valid for plans — defeating the purpose of
  // type-scoped status vocabularies.

  it('rejects type: prompt with status from another type (e.g. active)', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'prompts'), { recursive: true });
    writeFileSync(path.join(docsDir, 'prompts', 'mis-statused.md'),
      '---\ntype: prompt\nstatus: active\nupdated: 2025-01-01\n---\n# bad\n');

    const result = run(['check']);
    strictEqual(result.status, 1, `should fail. stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    ok(result.stdout.includes('Unknown status `active`'), 'flags the bad status');
    ok(result.stdout.includes('type `prompt`'), 'error message names the type');
    ok(result.stdout.includes('pending'), 'hint lists the type-scoped vocab');
    ok(!result.stdout.includes('in-session'), 'hint does NOT include plan-only statuses');
  });

  it('rejects type: plan with status from prompt vocab (e.g. pending)', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'plans'), { recursive: true });
    writeFileSync(path.join(docsDir, 'plans', 'wrong-vocab.md'),
      '---\ntype: plan\nstatus: pending\nupdated: 2025-01-01\nmodule: foo\n---\n# bad\n');

    const result = run(['check']);
    strictEqual(result.status, 1, `should fail. stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    ok(result.stdout.includes('Unknown status `pending`'), 'flags the bad status');
    ok(result.stdout.includes('type `plan`'), 'error message names the type');
  });

  it('accepts type: plan with a valid plan status (regression)', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'plans'), { recursive: true });
    writeFileSync(path.join(docsDir, 'plans', 'good.md'),
      '---\ntype: plan\nstatus: active\nupdated: 2025-01-01\nmodule: foo\n---\n# good\n');

    const result = run(['check']);
    strictEqual(result.status, 0, `should pass. stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  });

  it('accepts type: prompt with status: pending (regression)', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'prompts'), { recursive: true });
    writeFileSync(path.join(docsDir, 'prompts', 'good.md'),
      '---\ntype: prompt\nstatus: pending\nupdated: 2025-01-01\n---\n# good\n');

    const result = run(['check']);
    strictEqual(result.status, 0, `should pass. stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  });

  it('untyped doc uses global validStatuses (regression)', () => {
    const docsDir = setupProject();
    // No `type:` field. `status: active` should be accepted via the global union.
    writeFileSync(path.join(docsDir, 'untyped.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# untyped\n');

    const result = run(['check']);
    strictEqual(result.status, 0, `should pass. stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  });

  it('unknown type falls through to global validStatuses', () => {
    const docsDir = setupProject();
    // `type: spike` isn't in defaults — no typeSet exists, so we fall through.
    writeFileSync(path.join(docsDir, 'unknown-type.md'),
      '---\ntype: spike\nstatus: active\nupdated: 2025-01-01\n---\n# unknown\n');

    const result = run(['check']);
    // Unknown-type warning fires, but the status itself is accepted via global.
    ok(!result.stdout.includes('Unknown status'), `status should not error: ${result.stdout}`);
  });
});

describe('archive drift (#8)', () => {
  // A doc with status: archived whose path is a direct child of a configured
  // root is misplaced — `dotmd archive` would have moved it under
  // <root>/archived/. Without this check, default `dotmd plans` / `dotmd
  // prompts` views silently drop it from sight.

  it('flags status: archived prompt sitting as direct child of prompts root', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'prompts'), { recursive: true });
    writeFileSync(path.join(docsDir, 'prompts', 'drift.md'),
      '---\ntype: prompt\nstatus: archived\ncreated: 2025-01-01\n---\nbody\n');

    const result = run(['check']);
    strictEqual(result.status, 1, `should fail. stdout: ${result.stdout}`);
    ok(result.stdout.includes('status: `archived`') || result.stdout.includes('`status: archived`'),
       `error names the bad status: ${result.stdout}`);
    ok(result.stdout.includes('dotmd archive'), 'suggests dotmd archive');
    ok(result.stdout.includes('docs/prompts/drift.md'), 'mentions the file path');
  });

  it('flags status: archived plan sitting as direct child of plans root', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'plans'), { recursive: true });
    writeFileSync(path.join(docsDir, 'plans', 'drift-plan.md'),
      '---\ntype: plan\nstatus: archived\nupdated: 2025-01-01\nmodule: foo\n---\n# drift\n');

    const result = run(['check']);
    strictEqual(result.status, 1, `should fail. stdout: ${result.stdout}`);
    ok(result.stdout.includes('docs/plans/drift-plan.md'), 'mentions the file path');
    ok(result.stdout.includes('dotmd archive'), 'suggests dotmd archive');
  });

  it('does NOT flag status: archived in a nested non-archive subdir (e.g., audit/)', () => {
    // Intentional pattern: topic-clustered legacy content lives in a non-archive
    // subdir but is marked archived. Drift check should exempt this.
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'plans', 'audit'), { recursive: true });
    writeFileSync(path.join(docsDir, 'plans', 'audit', 'catalog-audit.md'),
      '---\ntype: plan\nstatus: archived\nupdated: 2025-01-01\nmodule: catalog\n---\n# audit\n');

    const result = run(['check']);
    // Should NOT trip the drift error (other validation may still fail, but not this).
    ok(!result.stdout.includes('not in `docs/plans/archived/`'),
       `nested subdir should be exempt: ${result.stdout}`);
    ok(!result.stdout.includes('direct child'),
       `error message not emitted for nested file: ${result.stdout}`);
  });

  it('does NOT flag properly-archived doc in archived/ subdir', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'prompts', 'archived'), { recursive: true });
    writeFileSync(path.join(docsDir, 'prompts', 'archived', 'done.md'),
      '---\ntype: prompt\nstatus: archived\ncreated: 2025-01-01\n---\nbody\n');

    const result = run(['check']);
    // No drift error for correctly-placed archived files.
    ok(!result.stdout.includes('direct child'),
       `properly archived file should not trip drift: ${result.stdout}`);
  });

  it('does NOT flag a status: pending file directly under prompts root', () => {
    // Regression — only archive-flagged statuses trigger drift.
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'prompts'), { recursive: true });
    writeFileSync(path.join(docsDir, 'prompts', 'live.md'),
      '---\ntype: prompt\nstatus: pending\ncreated: 2025-01-01\nupdated: 2025-01-01\n---\n# live\n\n> blurb\n\nbody\n');

    const result = run(['check']);
    // Only assert the drift error specifically — other validation warnings/errors
    // are out of scope for this test.
    ok(!result.stdout.includes('direct child'),
       `drift error should not fire for live status: ${result.stdout}`);
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
