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

describe('modules-required gate (opt-in via taxonomy.modules)', () => {
  it('skips the modules-required error when taxonomy.modules is unset', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-mod-off-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    // Plan with `partial` (a moduleRequiredFor status) and no modules — must
    // NOT trip the validator when the project doesn't enumerate modules.
    writeFileSync(path.join(tmpDir, 'docs', 'plans', 'p.md'),
      '---\ntype: plan\nstatus: partial\nupdated: 2026-05-28\n---\n# P\n');
    const r = run(['check', '--verbose']);
    ok(!r.stdout.includes('is required'),
      `no modules-required error expected in no-taxonomy mode. stdout: ${r.stdout}`);
  });

  it('fires the modules-required error when taxonomy.modules IS set', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-mod-on-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'),
      `export const root = 'docs';\nexport const taxonomy = { modules: ['kiosk', 'catalog'] };`);
    writeFileSync(path.join(tmpDir, 'docs', 'plans', 'p.md'),
      '---\ntype: plan\nstatus: partial\nupdated: 2026-05-28\n---\n# P\n');
    const r = run(['check', '--verbose']);
    ok(r.stdout.includes('`modules` is required'),
      `modules-required error expected when taxonomy.modules is set. stdout: ${r.stdout}`);
  });
});

describe('body link validation', () => {
  it('warns about broken body links', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n\nSee [broken](nonexistent.md) for details.\n');

    const result = run(['check', '--verbose']);
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

    const result = run(['check', '--verbose']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!result.stdout.includes('body link'), 'no body link warning for valid link');
  });

  it('skips links inside fenced code blocks', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n\n```\n[fake](nonexistent.md)\n```\n');

    const result = run(['check', '--verbose']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!result.stdout.includes('body link'), 'no warning for link inside code block');
  });

  it('unknown status does not also trigger missing-updated error', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: implemented\n---\n# A\n');

    const result = run(['check', '--verbose']);
    // Unknown status itself is now an error, so exit 1 — but the missing-updated
    // check is gated on knownStatus, so we should NOT see that error compound on top.
    strictEqual(result.status, 1, `should fail on unknown status. stderr: ${result.stderr}`);
    ok(!result.stdout.includes('Missing frontmatter `updated`'), 'no updated error for unknown status');
  });

  it('known status without updated is still an error', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: active\n---\n# A\n');

    const result = run(['check', '--verbose']);
    strictEqual(result.status, 1, 'should fail for known status missing updated');
    ok(result.stdout.includes('Missing frontmatter `updated`'), 'shows updated error');
  });

  it('unknown status is an error', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: implemented\nupdated: 2025-01-01\n---\n# A\n');

    const result = run(['check', '--verbose']);
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

    const result = run(['check', '--verbose']);
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

    const result = run(['check', '--verbose']);
    strictEqual(result.status, 1, `should fail. stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    ok(result.stdout.includes('Unknown status `pending`'), 'flags the bad status');
    ok(result.stdout.includes('type `plan`'), 'error message names the type');
  });

  it('accepts type: plan with a valid plan status (regression)', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'plans'), { recursive: true });
    writeFileSync(path.join(docsDir, 'plans', 'good.md'),
      '---\ntype: plan\nstatus: active\nupdated: 2025-01-01\nmodule: foo\n---\n# good\n');

    const result = run(['check', '--verbose']);
    strictEqual(result.status, 0, `should pass. stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  });

  it('accepts type: prompt with status: pending (regression)', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'prompts'), { recursive: true });
    writeFileSync(path.join(docsDir, 'prompts', 'good.md'),
      '---\ntype: prompt\nstatus: pending\nupdated: 2025-01-01\n---\n# good\n');

    const result = run(['check', '--verbose']);
    strictEqual(result.status, 0, `should pass. stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  });

  it('untyped doc uses global validStatuses (regression)', () => {
    const docsDir = setupProject();
    // No `type:` field. `status: active` should be accepted via the global union.
    writeFileSync(path.join(docsDir, 'untyped.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# untyped\n');

    const result = run(['check', '--verbose']);
    strictEqual(result.status, 0, `should pass. stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  });

  it('unknown type falls through to global validStatuses', () => {
    const docsDir = setupProject();
    // `type: spike` isn't in defaults — no typeSet exists, so we fall through.
    writeFileSync(path.join(docsDir, 'unknown-type.md'),
      '---\ntype: spike\nstatus: active\nupdated: 2025-01-01\n---\n# unknown\n');

    const result = run(['check', '--verbose']);
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

    const result = run(['check', '--verbose']);
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

    const result = run(['check', '--verbose']);
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

    const result = run(['check', '--verbose']);
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

    const result = run(['check', '--verbose']);
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

    const result = run(['check', '--verbose']);
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
    const result = run(['check', '--verbose']);
    ok(!result.stdout.includes('does not resolve'),
      `repo-root-relative path should resolve. stdout: ${result.stdout}`);
  });

  it('accepts repo-root-relative paths in body links', () => {
    const root = setupRefProject();
    writeFileSync(path.join(root, 'docs', 'plans', 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n\nSee [catalog](docs/modules/catalog/catalog.md).\n');
    writeFileSync(path.join(root, 'docs', 'modules', 'catalog', 'catalog.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# Catalog\n');
    const result = run(['check', '--verbose']);
    ok(!result.stdout.includes('body link'),
      `repo-root-relative body link should resolve. stdout: ${result.stdout}`);
  });

  it('still flags genuinely missing reference targets', () => {
    const root = setupRefProject();
    writeFileSync(path.join(root, 'docs', 'plans', 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - docs/plans/missing.md\n---\n# A\n');
    const result = run(['check', '--verbose']);
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
    const result = run(['check', '--verbose']);
    ok(!result.stdout.includes('does not reference back'),
      `bidirectional pair should be satisfied across both path styles. stdout: ${result.stdout}`);
  });

  it('appends `Did you mean` suggestions when a ref typo is close to a real basename', () => {
    const root = setupRefProject();
    writeFileSync(path.join(root, 'docs', 'plans', 'authn-revamp.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# Authn\n');
    writeFileSync(path.join(root, 'docs', 'plans', 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - docs/plans/authn-revam.md\n---\n# A\n');
    const result = run(['check', '--verbose']);
    ok(result.stdout.includes('does not resolve'));
    ok(result.stdout.includes('Did you mean'),
      `expected suggestion line, got: ${result.stdout}`);
    ok(result.stdout.includes('authn-revamp.md'),
      `expected real basename in suggestion, got: ${result.stdout}`);
  });

  it('omits the `Did you mean` line when nothing in the index is close', () => {
    const root = setupRefProject();
    writeFileSync(path.join(root, 'docs', 'plans', 'authn-revamp.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# Authn\n');
    writeFileSync(path.join(root, 'docs', 'plans', 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - docs/plans/zzzz-nothing-like-it.md\n---\n# A\n');
    const result = run(['check', '--verbose']);
    ok(result.stdout.includes('does not resolve'));
    ok(!result.stdout.includes('Did you mean'),
      `should not suggest when nothing close. got: ${result.stdout}`);
  });

  it('does not warn about missing back-ref when the outbound entry uses `>` prefix (A4)', () => {
    const root = setupRefProject();
    // a.md → b.md is one-way via the `>` prefix; b.md doesn't reference a back.
    // The reciprocity check should skip the warning entirely.
    writeFileSync(path.join(root, 'docs', 'plans', 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - "> docs/plans/b.md"\n---\n# A\n');
    writeFileSync(path.join(root, 'docs', 'plans', 'b.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# B\n');
    const result = run(['check', '--verbose']);
    ok(!result.stdout.includes('does not reference back'),
      `one-way ref should suppress reciprocity warning. stdout: ${result.stdout}`);
  });

  it('still warns when an unprefixed sibling in a mixed list lacks a back-ref (A4)', () => {
    const root = setupRefProject();
    // a.md → b.md is one-way (silent); a.md → c.md is two-way (must reciprocate, but c.md doesn't).
    writeFileSync(path.join(root, 'docs', 'plans', 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - "> docs/plans/b.md"\n  - docs/plans/c.md\n---\n# A\n');
    writeFileSync(path.join(root, 'docs', 'plans', 'b.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# B\n');
    writeFileSync(path.join(root, 'docs', 'plans', 'c.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# C\n');
    const result = run(['check', '--verbose']);
    const backRefLines = result.stdout.split('\n').filter(l => l.includes('does not reference back'));
    strictEqual(backRefLines.length, 1,
      `expected exactly one reciprocity warning, got: ${backRefLines.join(' | ')}`);
    ok(backRefLines[0].includes('docs/plans/c.md'),
      `reciprocity warning should target the unprefixed entry. got: ${backRefLines[0]}`);
    ok(!backRefLines[0].includes('docs/plans/b.md'),
      `reciprocity warning should not target the prefixed entry. got: ${backRefLines[0]}`);
  });

  it('filters suggestions by ref-field type (related_plans → plans only)', () => {
    // Set up a doc-typed file with a similar basename and a plan-typed file. A
    // `related_plans` typo should suggest the plan, not the doc.
    const root = setupRefProject();
    writeFileSync(path.join(root, 'docs', 'plans', 'payments.md'),
      '---\ntype: plan\nstatus: active\nupdated: 2025-01-01\n---\n# Payments plan\n');
    writeFileSync(path.join(root, 'docs', 'payment.md'),
      '---\ntype: doc\nstatus: active\nupdated: 2025-01-01\n---\n# Payment doc\n');
    writeFileSync(path.join(root, 'docs', 'plans', 'a.md'),
      '---\ntype: plan\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - docs/plans/paymentz.md\n---\n# A\n');
    const result = run(['check', '--verbose']);
    ok(result.stdout.includes('Did you mean'),
      `expected suggestion line, got: ${result.stdout}`);
    ok(result.stdout.includes('payments.md'),
      `should suggest the plan-typed file. got: ${result.stdout}`);
  });
});

// Regression for audit-example-project F2: three validators (Unknown surface,
// body link does not resolve, ref-field error) were ignoring
// `skipWarningsFor` and `terminalStatuses` — firing for archived plans whose
// quiet: true should have suppressed them. Example project hit 46 archived-noise
// warnings out of 279 total.
describe('archived/terminal status suppresses noise validators', () => {
  function setupArchivedProject() {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-archnoise-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs', 'archived'), { recursive: true });
    // Use a config that mirrors custom shape: archived status has quiet:true
    // (sugar for skipStale + skipWarnings), and a surfaces taxonomy is set.
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const root = 'docs';
      export const taxonomy = { surfaces: ['frontend', 'backend'] };
      export const referenceFields = { bidirectional: ['related_plans'], unidirectional: [] };
    `);
    return tmpDir;
  }

  it('does NOT warn about Unknown surface for archived docs', () => {
    const root = setupArchivedProject();
    // Archived plan with a surface that's NOT in the taxonomy.
    writeFileSync(path.join(root, 'docs', 'archived', 'old.md'),
      '---\ntype: plan\nstatus: archived\nupdated: 2025-01-01\nsurface: legacy-thing\n---\n# Old\n');
    const result = run(['check', '--verbose']);
    ok(!result.stdout.includes('Unknown surface'),
      `archived plan with unknown surface should not warn. stdout: ${result.stdout}`);
  });

  it('still warns about Unknown surface for live docs', () => {
    const root = setupArchivedProject();
    writeFileSync(path.join(root, 'docs', 'live.md'),
      '---\ntype: plan\nstatus: active\nupdated: 2025-01-01\nmodule: foo\nsurface: legacy-thing\ncurrent_state: x\nnext_step: y\n---\n# Live\n');
    const result = run(['check', '--verbose']);
    ok(result.stdout.includes('Unknown surface'),
      `live plan with unknown surface should warn. stdout: ${result.stdout}`);
    ok(result.stdout.includes('dotmd surfaces'),
      `unknown-surface warning should hint at the lookup command. stdout: ${result.stdout}`);
  });

  it('unknown-surface warning suggests close matches via did-you-mean', () => {
    const root = setupArchivedProject();
    writeFileSync(path.join(root, 'docs', 'live.md'),
      '---\ntype: plan\nstatus: active\nupdated: 2025-01-01\nmodule: foo\nsurface: frontent\ncurrent_state: x\nnext_step: y\n---\n# Live\n');
    const result = run(['check', '--verbose']);
    ok(result.stdout.includes('Did you mean'),
      `unknown-surface warning should include did-you-mean. stdout: ${result.stdout}`);
    ok(result.stdout.includes('frontend'),
      `did-you-mean should propose 'frontend' for typo 'frontent'. stdout: ${result.stdout}`);
  });

  it('does NOT flag broken body links in archived docs', () => {
    const root = setupArchivedProject();
    writeFileSync(path.join(root, 'docs', 'archived', 'old.md'),
      '---\ntype: plan\nstatus: archived\nupdated: 2025-01-01\n---\n# Old\n\nSee [gone](./deleted.md).\n');
    const result = run(['check', '--verbose']);
    ok(!result.stdout.includes('body link'),
      `archived doc body link to deleted target should not warn. stdout: ${result.stdout}`);
  });

  it('does NOT error on unresolved ref-field entries in archived docs', () => {
    const root = setupArchivedProject();
    writeFileSync(path.join(root, 'docs', 'archived', 'old.md'),
      '---\ntype: plan\nstatus: archived\nupdated: 2025-01-01\nrelated_plans:\n  - ./gone-forever.md\n---\n# Old\n');
    const result = run(['check', '--verbose']);
    ok(!result.stdout.includes('does not resolve'),
      `archived doc ref-field to deleted target should not error. stdout: ${result.stdout}`);
    // And exit code should reflect zero errors.
    strictEqual(result.status, 0, `check should pass for archived-only noise: ${result.stderr}`);
  });

  it('still errors on unresolved ref-field entries in live docs', () => {
    const root = setupArchivedProject();
    writeFileSync(path.join(root, 'docs', 'live.md'),
      '---\ntype: plan\nstatus: active\nupdated: 2025-01-01\nmodule: foo\ncurrent_state: x\nnext_step: y\nrelated_plans:\n  - ./missing.md\n---\n# Live\n');
    const result = run(['check', '--verbose']);
    ok(result.stdout.includes('does not resolve'),
      `live doc with missing ref-field target should error. stdout: ${result.stdout}`);
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
    const result = run(['check', '--verbose']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!result.stdout.includes('Unknown status'), 'no unknown status warning for root-allowed status');
  });

  it('warns when root-specific status used in wrong root', () => {
    const dirs = setupMultiRootProject();
    writeFileSync(path.join(dirs.plans, 'a.md'),
      '---\nstatus: implemented\nupdated: 2025-01-01\n---\n# A\n');
    const result = run(['check', '--verbose']);
    ok(result.stdout.includes('Unknown status'), 'warns about implemented in plans root');
  });

  it('global statuses valid in all roots', () => {
    const dirs = setupMultiRootProject();
    writeFileSync(path.join(dirs.modules, 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n');
    writeFileSync(path.join(dirs.plans, 'b.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# B\n');
    const result = run(['check', '--verbose']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!result.stdout.includes('Unknown status'), 'global status valid everywhere');
  });

  it('treats root-specific status as known for lifecycle field enforcement', () => {
    const dirs = setupMultiRootProject();
    // implemented without updated — should get error because it's now a known status
    writeFileSync(path.join(dirs.modules, 'a.md'),
      '---\nstatus: implemented\n---\n# A\n');
    const result = run(['check', '--verbose']);
    ok(result.stdout.includes('Missing frontmatter `updated`'), 'enforces updated for known root status');
  });
});

describe('F18: singular module/surface deprecation warning', () => {
  it('warns when only singular `module:` is set, names the migration target', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nmodule: catalog\n---\n# A\n');
    const result = run(['check', '--verbose']);
    const matches = result.stdout.split('\n').filter(l => l.includes('`module:` (singular) is deprecated'));
    strictEqual(matches.length, 1, `expected exactly one deprecation warning, got: ${result.stdout}`);
    ok(matches[0].includes('modules: ["catalog"]'), `expected migration target in message: ${matches[0]}`);
  });

  it('warns when singular + plural agree (target shows single value, no dup)', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nmodule: catalog\nmodules:\n  - catalog\n---\n# A\n');
    const result = run(['check', '--verbose']);
    const matches = result.stdout.split('\n').filter(l => l.includes('`module:` (singular) is deprecated'));
    strictEqual(matches.length, 1, `expected exactly one deprecation warning, got: ${result.stdout}`);
    ok(matches[0].includes('modules: ["catalog"]'), `target should be deduped to one value: ${matches[0]}`);
  });

  it('warns when singular + plural diverge (target shows merged list)', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nmodule: catalog\nmodules:\n  - other\n---\n# A\n');
    const result = run(['check', '--verbose']);
    const matches = result.stdout.split('\n').filter(l => l.includes('`module:` (singular) is deprecated'));
    strictEqual(matches.length, 1, `expected exactly one deprecation warning, got: ${result.stdout}`);
    ok(matches[0].includes('modules: ["catalog", "other"]'), `target should merge: ${matches[0]}`);
  });

  it('no longer emits the old "both module/modules set with different values" message', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nmodule: catalog\nmodules:\n  - other\n---\n# A\n');
    const result = run(['check', '--verbose']);
    ok(!result.stdout.includes('set with different values'),
      `F3 divergence message should be subsumed: ${result.stdout}`);
  });

  it('warns for singular surface: too', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nsurface: web\n---\n# A\n');
    const result = run(['check', '--verbose']);
    const matches = result.stdout.split('\n').filter(l => l.includes('`surface:` (singular) is deprecated'));
    strictEqual(matches.length, 1, `expected exactly one deprecation warning, got: ${result.stdout}`);
    ok(matches[0].includes('surfaces: ["web"]'), `expected migration target in message: ${matches[0]}`);
  });

  it('gives manual guidance for a non-string singular value', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nsurface: false\n---\n# A\n');
    const result = run(['check', '--verbose']);
    const matches = result.stdout.split('\n').filter(l => l.includes('`surface:` (singular) is deprecated'));
    strictEqual(matches.length, 1, `expected exactly one deprecation warning, got: ${result.stdout}`);
    ok(matches[0].includes('manually') && !matches[0].includes('lint --fix'), matches[0]);
  });
});

describe('scan floor (minDocs)', () => {
  function seed(docsDir, n) {
    for (let i = 0; i < n; i++) {
      writeFileSync(path.join(docsDir, `d${i}.md`),
        `---\nstatus: active\nupdated: 2025-01-01\n---\n# D${i}\n`);
    }
  }

  it('is off by default — a tiny corpus is not an error', () => {
    const docsDir = setupProject();
    seed(docsDir, 2);
    const r = run(['check']);
    strictEqual(r.status, 0, `stdout: ${r.stdout}`);
    ok(!r.stdout.includes('scan surface'), r.stdout);
  });

  it('fails when the corpus is under the configured floor', () => {
    const docsDir = setupProject();
    seed(docsDir, 2);
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'),
      `export const root = 'docs';\nexport const minDocs = 50;\n`);
    const r = run(['check']);
    strictEqual(r.status, 1, `stdout: ${r.stdout}`);
    ok(r.stdout.includes('only 2 docs in the scan surface (expected at least 50)'), r.stdout);
  });

  it('passes when the floor is met', () => {
    const docsDir = setupProject();
    seed(docsDir, 4);
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'),
      `export const root = 'docs';\nexport const minDocs = 4;\n`);
    const r = run(['check']);
    strictEqual(r.status, 0, `stdout: ${r.stdout}`);
  });

  it('--min-docs overrides config for one run', () => {
    const docsDir = setupProject();
    seed(docsDir, 2);
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'),
      `export const root = 'docs';\nexport const minDocs = 50;\n`);
    strictEqual(run(['check', '--min-docs', '1']).status, 0);
    ok(run(['check', '--min-docs', '99']).stdout.includes('expected at least 99'));
  });

  // A single-file check is a deliberate subset, not a claim about corpus size.
  it('never fires on a path-scoped check', () => {
    const docsDir = setupProject();
    seed(docsDir, 2);
    const r = run(['check', '--min-docs', '999', path.join(docsDir, 'd0.md')]);
    strictEqual(r.status, 0, `stdout: ${r.stdout}`);
    ok(!r.stdout.includes('scan surface'), r.stdout);
  });

  // The `--min-docs` VALUE is not a path, but a real path must survive in either
  // order — an earlier cut dropped the first positional whenever the flag was
  // absent, silently widening every scoped check to the whole repo.
  it('keeps the path target whichever side of the flag it sits on', () => {
    const docsDir = setupProject();
    seed(docsDir, 3);
    for (const args of [
      ['check', path.join(docsDir, 'd0.md'), '--min-docs', '999'],
      ['check', '--min-docs', '999', path.join(docsDir, 'd0.md')],
      ['check', path.join(docsDir, 'd0.md')],
    ]) {
      const r = run(args);
      ok(r.stdout.includes('docs scanned: 1'), `${args.join(' ')} → ${r.stdout}`);
    }
  });

  it('reports the floor breach in --json with a machine-readable kind', () => {
    const docsDir = setupProject();
    seed(docsDir, 2);
    const r = run(['check', '--min-docs', '50', '--json']);
    strictEqual(r.status, 1);
    const out = JSON.parse(r.stdout);
    const floor = out.errors.find(e => e.meta?.kind === 'scan-floor');
    ok(floor, `expected a scan-floor error: ${r.stdout}`);
    strictEqual(floor.meta.found, 2);
    strictEqual(floor.meta.floor, 50);
    strictEqual(out.passed, false);
  });

  it('rejects a non-numeric --min-docs instead of silently ignoring it', () => {
    setupProject();
    const r = run(['check', '--min-docs', 'lots']);
    strictEqual(r.status, 1);
    ok(r.stderr.includes('--min-docs'), r.stderr);
  });

  it('warns and stays off for an invalid configured value', () => {
    const docsDir = setupProject();
    seed(docsDir, 2);
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'),
      `export const root = 'docs';\nexport const minDocs = -3;\n`);
    const r = run(['check', '--verbose']);
    strictEqual(r.status, 0, `stdout: ${r.stdout}`);
    const all = r.stdout + r.stderr;
    ok(all.includes('minDocs must be a positive integer'), all);
    ok(!all.includes("unknown key 'minDocs'"), 'minDocs must be a recognized config key');
  });
});
