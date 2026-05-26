import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { categorizeWarnings } from '../src/check-collapse.mjs';

let tmpDir;

function run(args) {
  const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
  return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
    cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
}

function setup() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-collapse-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('categorizeWarnings (unit)', () => {
  it('collapses singular-module warnings when count >= threshold (3)', () => {
    const warnings = Array.from({ length: 3 }, (_, i) => ({
      path: `docs/p${i}.md`,
      message: '`module:` (singular) is deprecated — use `modules: ["foo"]`. Run `dotmd lint --fix` to migrate.',
    }));
    const { passthrough, collapsed } = categorizeWarnings(warnings);
    strictEqual(passthrough.length, 0, 'all 3 should collapse');
    strictEqual(collapsed.length, 1);
    strictEqual(collapsed[0].count, 3);
    strictEqual(collapsed[0].fix, 'dotmd lint --fix');
  });

  it('passes through when count below threshold (2)', () => {
    const warnings = Array.from({ length: 2 }, (_, i) => ({
      path: `docs/p${i}.md`,
      message: '`module:` (singular) is deprecated — use `modules: ["foo"]`. Run `dotmd lint --fix` to migrate.',
    }));
    const { passthrough, collapsed } = categorizeWarnings(warnings);
    strictEqual(collapsed.length, 0, 'below threshold should not collapse');
    strictEqual(passthrough.length, 2);
  });

  it('keeps structural warnings as orphans regardless of count', () => {
    const warnings = Array.from({ length: 5 }, (_, i) => ({
      path: `docs/p${i}.md`,
      message: 'Missing `title` and no H1 found for fallback.',
    }));
    const { passthrough, collapsed } = categorizeWarnings(warnings);
    strictEqual(collapsed.length, 0, 'no category match → no collapse');
    strictEqual(passthrough.length, 5);
  });

  it('collapses multiple categories independently', () => {
    const warnings = [
      ...Array.from({ length: 4 }, (_, i) => ({
        path: `docs/m${i}.md`,
        message: '`module:` (singular) is deprecated — use `modules: ["foo"]`. Run `dotmd lint --fix` to migrate.',
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        path: `docs/s${i}.md`,
        message: '`surface:` (singular) is deprecated — use `surfaces: ["web"]`. Run `dotmd lint --fix` to migrate.',
      })),
      { path: 'docs/x.md', message: 'Missing `title` and no H1 found for fallback.' },
    ];
    const { passthrough, collapsed } = categorizeWarnings(warnings);
    strictEqual(passthrough.length, 1, 'structural warning passes through');
    strictEqual(collapsed.length, 2);
    // Sorted by count desc: singular-module(4) then singular-surface(3)
    strictEqual(collapsed[0].count, 4);
    strictEqual(collapsed[0].key, 'singular-module');
    strictEqual(collapsed[1].count, 3);
    strictEqual(collapsed[1].key, 'singular-surface');
  });

  it('passthrough is sorted by path (deterministic)', () => {
    const warnings = [
      { path: 'docs/z.md', message: 'Missing `title` and no H1 found for fallback.' },
      { path: 'docs/a.md', message: 'Missing `title` and no H1 found for fallback.' },
      { path: 'docs/m.md', message: 'Missing `title` and no H1 found for fallback.' },
    ];
    const { passthrough } = categorizeWarnings(warnings);
    deepStrictEqual(passthrough.map(w => w.path), ['docs/a.md', 'docs/m.md', 'docs/z.md']);
  });
});

describe('dotmd check collapse render (CLI)', () => {
  it('collapses 3+ singular-module deprecations into a one-line summary with fix command', () => {
    setup();
    for (let i = 0; i < 3; i++) {
      writeFileSync(path.join(tmpDir, 'docs', `m${i}.md`),
        `---\nstatus: active\nupdated: 2025-01-01\nmodule: foo\n---\n# M${i}\n`);
    }
    const result = run(['check']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('3 docs use deprecated singular `module:`'),
      `expected collapsed summary line; got: ${result.stdout}`);
    ok(result.stdout.includes('run `dotmd lint --fix` to bulk-fix'),
      `expected bulk-fix hint; got: ${result.stdout}`);
    // No per-doc deprecation lines remain
    const perDocDeprecation = result.stdout.split('\n').filter(l =>
      l.includes('m0.md:') && l.includes('(singular) is deprecated'));
    strictEqual(perDocDeprecation.length, 0,
      `per-doc deprecation lines should be hidden; got: ${result.stdout}`);
  });

  it('--no-collapse keeps per-doc warning lines', () => {
    setup();
    for (let i = 0; i < 3; i++) {
      writeFileSync(path.join(tmpDir, 'docs', `m${i}.md`),
        `---\nstatus: active\nupdated: 2025-01-01\nmodule: foo\n---\n# M${i}\n`);
    }
    const result = run(['check', '--no-collapse']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!result.stdout.includes('docs use deprecated'), 'no collapsed summary');
    // Each doc surfaces its own line
    for (let i = 0; i < 3; i++) {
      ok(result.stdout.includes(`m${i}.md`), `m${i}.md should appear per-doc; got: ${result.stdout}`);
    }
  });

  it('--json output is unchanged (collapse is text-render only)', () => {
    setup();
    for (let i = 0; i < 3; i++) {
      writeFileSync(path.join(tmpDir, 'docs', `m${i}.md`),
        `---\nstatus: active\nupdated: 2025-01-01\nmodule: foo\n---\n# M${i}\n`);
    }
    const result = run(['check', '--json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const data = JSON.parse(result.stdout);
    const deprecations = data.warnings.filter(w => w.message.includes('(singular) is deprecated'));
    strictEqual(deprecations.length, 3, 'JSON keeps all 3 per-doc deprecation warnings — no collapse in JSON');
    // And no collapsed-summary entry was synthesized into the JSON.
    const summaryEntries = data.warnings.filter(w => w.message.includes('to bulk-fix'));
    strictEqual(summaryEntries.length, 0, 'JSON contains no synthesized summary entries');
  });

  it('below threshold: 2 singular-module warnings stay per-doc (no collapse)', () => {
    setup();
    for (let i = 0; i < 2; i++) {
      writeFileSync(path.join(tmpDir, 'docs', `m${i}.md`),
        `---\nstatus: active\nupdated: 2025-01-01\nmodule: foo\n---\n# M${i}\n`);
    }
    const result = run(['check']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!result.stdout.includes('docs use deprecated'), 'no collapse below threshold');
    ok(result.stdout.includes('m0.md') && result.stdout.includes('m1.md'),
      'both docs appear per-doc');
  });

  it('mixed warnings: structural stays per-doc, auto-fixable collapses', () => {
    setup();
    // 3 singular-module docs (will collapse)
    for (let i = 0; i < 3; i++) {
      writeFileSync(path.join(tmpDir, 'docs', `m${i}.md`),
        `---\nstatus: active\nupdated: 2025-01-01\nmodule: foo\n---\nbody\n`);
    }
    // 1 doc missing title (structural, passes through)
    writeFileSync(path.join(tmpDir, 'docs', 'x.md'),
      `---\nstatus: active\nupdated: 2025-01-01\n---\nbody\n`);

    const result = run(['check']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('3 docs use deprecated singular `module:`'),
      'singular-module collapsed');
    ok(result.stdout.includes('x.md') && result.stdout.includes('Missing `title`'),
      `structural warning stays per-doc; got: ${result.stdout}`);
  });

  it('--errors-only suppresses warnings entirely (no collapse summary either)', () => {
    setup();
    for (let i = 0; i < 3; i++) {
      writeFileSync(path.join(tmpDir, 'docs', `m${i}.md`),
        `---\nstatus: active\nupdated: 2025-01-01\nmodule: foo\n---\n# M${i}\n`);
    }
    const result = run(['check', '--errors-only']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!result.stdout.includes('docs use deprecated'), 'no collapse summary');
    ok(!result.stdout.includes('(singular) is deprecated'), 'no per-doc warning either');
  });
});
