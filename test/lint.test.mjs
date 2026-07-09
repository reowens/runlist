import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

function run(args, opts = {}) {
  return spawnSync('node', [BIN, ...args], {
    cwd: tmpDir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    ...opts,
  });
}

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-lint-'));
  mkdirSync(path.join(tmpDir, '.git'));
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
  return docsDir;
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('dotmd lint', () => {
  it('reports fixable issues without --fix', () => {
    const docsDir = setupProject();
    // Missing updated, has status
    writeFileSync(path.join(docsDir, 'no-updated.md'), '---\nstatus: active\n---\n# Test\n');
    // Wrong status casing
    writeFileSync(path.join(docsDir, 'bad-case.md'), '---\nstatus: Active\nupdated: 2025-01-01\n---\n# Test\n');

    const result = run(['lint']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('fixable issues'), 'reports fixable issues');
    ok(result.stdout.includes('dotmd lint --fix'), 'suggests --fix');
  });

  it('reports camelCase key renames', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'camel.md'), '---\nstatus: active\nupdated: 2025-01-01\nnextStep: do something\n---\n# Test\n');

    const result = run(['lint']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('nextStep'), 'reports camelCase key');
    ok(result.stdout.includes('next_step'), 'shows snake_case replacement');
  });

  it('reports missing EOF newline', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'no-eof.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# Test');

    const result = run(['lint']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('missing newline'), 'reports missing EOF newline');
  });

  it('--fix --dry-run previews without writing', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'fixme.md'), '---\nstatus: Active\nupdated: 2025-01-01\n---\n# Test\n');

    const result = run(['lint', '--fix', '--dry-run']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('[dry-run]'), 'shows dry-run prefix');
    ok(result.stdout.includes('Fixed'), 'shows Fixed');

    // Verify file unchanged
    const content = readFileSync(path.join(docsDir, 'fixme.md'), 'utf8');
    ok(content.includes('status: Active'), 'file unchanged');
  });

  it('--fix applies status casing fix', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'fixme.md'), '---\nstatus: Active\nupdated: 2025-01-01\n---\n# Test\n');

    const result = run(['lint', '--fix']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Fixed'), 'shows Fixed');

    const content = readFileSync(path.join(docsDir, 'fixme.md'), 'utf8');
    ok(content.includes('status: active'), 'status lowercased');
  });

  it('--fix applies key renames', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'camel.md'), '---\nstatus: active\nupdated: 2025-01-01\nnextStep: do something\n---\n# Test\n');

    const result = run(['lint', '--fix']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const content = readFileSync(path.join(docsDir, 'camel.md'), 'utf8');
    ok(content.includes('next_step:'), 'key renamed to snake_case');
    ok(!content.includes('nextStep:'), 'camelCase key removed');
  });

  it('--fix adds missing updated date', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'no-updated.md'), '---\nstatus: active\n---\n# Test\n');

    const result = run(['lint', '--fix']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const content = readFileSync(path.join(docsDir, 'no-updated.md'), 'utf8');
    const today = new Date().toISOString().slice(0, 10);
    ok(content.includes(`updated: ${today}`), 'updated date added');
  });

  it('--fix adds missing EOF newline', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'no-eof.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# Test');

    const result = run(['lint', '--fix']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const content = readFileSync(path.join(docsDir, 'no-eof.md'), 'utf8');
    ok(content.endsWith('\n'), 'EOF newline added');
  });

  it('reports no issues for clean docs', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'clean.md'), '---\ntype: doc\nstatus: active\nupdated: 2025-01-01\ntitle: Clean\nsummary: A clean doc\ncurrent_state: all good\nnext_step: nothing\n---\n\n# Clean\n\n> A clean doc\n');

    const result = run(['lint']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    // Should not report fixable issues for this file
    ok(!result.stdout.includes('clean.md') || result.stdout.includes('No issues found'), 'no fixable issues for clean doc');
  });

  it('does not skip archived docs for missing updated when configured', () => {
    const docsDir = setupProject();
    // Archived docs have skipWarningsFor by default, so missing updated is OK
    writeFileSync(path.join(docsDir, 'old.md'), '---\nstatus: archived\n---\n# Old\n');

    const result = run(['lint']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    // Should NOT report old.md as fixable since archived is in skipWarningsFor
    ok(!result.stdout.includes('old.md') || !result.stdout.includes('add updated'), 'archived doc not flagged for missing updated');
  });

  it('detects missing status as fixable', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'no-status.md'), '---\nupdated: 2025-01-01\n---\n# No Status\n');

    const result = run(['lint']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('missing status') || result.stdout.includes('no-status.md'), 'reports missing status as fixable');
  });

  it('detects and fixes comma-separated surface values', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'multi.md'), '---\nstatus: active\nupdated: 2025-01-01\nsurface: api, web, ios\n---\n# Multi\n');

    // Report mode
    const report = run(['lint']);
    strictEqual(report.status, 0, `stderr: ${report.stderr}`);
    ok(report.stdout.includes('surfaces'), 'reports comma-separated surface');

    // Fix mode
    const fix = run(['lint', '--fix']);
    strictEqual(fix.status, 0, `stderr: ${fix.stderr}`);

    const content = readFileSync(path.join(docsDir, 'multi.md'), 'utf8');
    ok(!content.includes('surface: api, web, ios'), 'old comma-separated surface removed');
    ok(content.includes('- api'), 'has api in array');
    ok(content.includes('- web'), 'has web in array');
    ok(content.includes('- ios'), 'has ios in array');
  });

  it('--fix migrates singular module: to plural modules: array (F18, no existing plural)', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'm.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nmodule: catalog\n---\n# M\n');

    const result = run(['lint', '--fix']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const content = readFileSync(path.join(docsDir, 'm.md'), 'utf8');
    ok(!/^module:/m.test(content), 'singular module: removed');
    ok(/^modules:\n  - catalog$/m.test(content), `expected plural block: ${content}`);
  });

  it('--fix merges singular module: into existing modules: array (F18)', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'm.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nmodule: catalog\nmodules:\n  - bar\n---\n# M\n');

    const result = run(['lint', '--fix']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const content = readFileSync(path.join(docsDir, 'm.md'), 'utf8');
    ok(!/^module:/m.test(content), 'singular module: removed');
    ok(/-\s+catalog/.test(content), `catalog added to plural: ${content}`);
    ok(/-\s+bar/.test(content), `existing bar preserved: ${content}`);
  });

  it('--fix dedupes when singular module: equals an entry already in modules: (F18)', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'm.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nmodule: catalog\nmodules:\n  - catalog\n---\n# M\n');

    const result = run(['lint', '--fix']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const content = readFileSync(path.join(docsDir, 'm.md'), 'utf8');
    ok(!/^module:/m.test(content), 'singular module: removed');
    const catalogLines = content.split('\n').filter(l => /^\s*-\s+catalog\s*$/.test(l));
    strictEqual(catalogLines.length, 1, `expected single catalog entry, got: ${content}`);
  });

  // issue #17 item 1: an EMPTY deprecated singular key sitting above a populated
  // plural. The parser yields `[]`, `validate` warns, but `lint --fix` used to
  // no-op it (asString([]) is falsy). It must now drop the dead line — and
  // preserve the plural's values.
  it('--fix drops an empty singular surface:/module: and keeps the plural values (F18, issue #17)', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'e.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nsurface:\nsurfaces:\n  - db\nmodule:\nmodules:\n  - core\n---\n# E\n');

    const result = run(['lint', '--fix']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const content = readFileSync(path.join(docsDir, 'e.md'), 'utf8');
    ok(!/^surface:/m.test(content), `empty singular surface: removed: ${content}`);
    ok(!/^module:/m.test(content), `empty singular module: removed: ${content}`);
    ok(/^surfaces:\n\s+- db$/m.test(content), `surfaces value preserved: ${content}`);
    ok(/^modules:\n\s+- core$/m.test(content), `modules value preserved: ${content}`);
  });

  it('--fix drops an empty singular even with no plural counterpart present (F18)', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'e2.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nsurface:\n---\n# E2\n');

    const result = run(['lint', '--fix']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const content = readFileSync(path.join(docsDir, 'e2.md'), 'utf8');
    ok(!/^surface:/m.test(content), `empty singular surface: removed: ${content}`);
  });

  // issue #17 item 8: the singular-deprecation warnings must not appear in the
  // "non-fixable" list once `lint --fix` can resolve them.
  it('lint does not list a fixable singular deprecation as non-fixable (issue #17)', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'e3.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nsurface:\nsurfaces:\n  - db\n---\n# E3\n');

    const report = run(['lint']);
    strictEqual(report.status, 0, `stderr: ${report.stderr}`);
    ok(report.stdout.includes('remove deprecated `surface:`'), `previewed as fixable: ${report.stdout}`);
    const nonFixableIdx = report.stdout.indexOf('non-fixable');
    if (nonFixableIdx !== -1) {
      const tail = report.stdout.slice(nonFixableIdx);
      ok(!/`surface:` \(singular\) is deprecated/.test(tail),
        `singular deprecation must not be under non-fixable: ${report.stdout}`);
    }
  });
});
