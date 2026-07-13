import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { checkUvAvailable, summarizeDocBody, summarizeDiffText } from '../src/ai.mjs';

let tmpDir;

function run(args) {
  const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
  return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
    cwd: tmpDir, encoding: 'utf8',
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('ai.mjs', () => {
  it('checkUvAvailable returns boolean', () => {
    const result = checkUvAvailable();
    strictEqual(typeof result, 'boolean');
  });

  it('summarizeDocBody returns null for empty body', () => {
    const result = summarizeDocBody('', { title: 'T', status: 's', path: 'p' });
    strictEqual(result, null);
  });

  it('summarizeDocBody returns null for null body', () => {
    const result = summarizeDocBody(null, { title: 'T', status: 's', path: 'p' });
    strictEqual(result, null);
  });
});

describe('summary command', () => {
  it('exits with error for missing file arg', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-summary-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);

    const result = run(['summary']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('Usage'), 'shows usage');
  });

  it('exits with error for nonexistent file', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-summary-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);

    const result = run(['summary', 'nonexistent.md']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('not found'), 'shows not found');
  });

  it('reads file and produces output', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-summary-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\ntitle: Test Doc\n---\n# Test\n\nSome content.\n');

    const result = run(['summary', 'docs/a.md']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Test Doc'), 'shows title');
    ok(result.stdout.includes('active'), 'shows status');
  });

  it('--json produces JSON output', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-summary-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\ntitle: Test\n---\n# Test\n');

    const result = run(['summary', 'docs/a.md', '--json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    strictEqual(json.title, 'Test');
    strictEqual(json.status, 'active');
    ok('summary' in json, 'has summary field');
  });

  it('--help shows summary help', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-summary-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);

    const result = run(['summary', '--help']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('AI summary'), 'shows help');
  });

  it('respects summarizeDoc hook', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-summary-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const root = 'docs';
      export function summarizeDoc(body, meta) {
        return 'Hook summary for ' + meta.title;
      }
    `);
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\ntitle: Hooked\n---\n# Hooked\nContent.\n');

    const result = run(['summary', 'docs/a.md']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Hook summary for Hooked'), 'uses hook');
  });

  it('context --json --summarize --dry-run does not invoke summary hooks', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-summary-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    const sentinel = path.join(tmpDir, 'summary-sentinel');
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      import { writeFileSync } from 'node:fs';
      export const root = 'docs';
      export function summarizeDoc() { writeFileSync(${JSON.stringify(sentinel)}, 'called'); return 'summary'; }
    `);
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\ntitle: Test\n---\n# Test\nBody.\n');

    const result = run(['context', '--json', '--summarize', '--dry-run']);
    strictEqual(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    strictEqual(output.summaryPreview?.status, 'skipped-preview');
    ok(!existsSync(sentinel), 'summary hook was not invoked');

    const textResult = run(['context', '--summarize', '--dry-run']);
    strictEqual(textResult.status, 0, textResult.stderr);
    ok(textResult.stdout.includes('AI summaries skipped'), textResult.stdout);

    const queryResult = run(['query', '--summarize', '--json', '--dry-run']);
    strictEqual(queryResult.status, 0, queryResult.stderr);
    strictEqual(JSON.parse(queryResult.stdout).summaryPreview?.status, 'skipped-preview');
    ok(!existsSync(sentinel), 'summary hook was not invoked by context/query previews');
  });

  it('summary --dry-run reports a skipped preview instead of a model failure', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-summary-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    const sentinel = path.join(tmpDir, 'summary-sentinel');
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      import { writeFileSync } from 'node:fs';
      export const root = 'docs';
      export function summarizeDoc() { writeFileSync(${JSON.stringify(sentinel)}, 'called'); return 'summary'; }
    `);
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\ntitle: Test\n---\n# Test\nBody.\n');

    const result = run(['summary', 'docs/a.md', '--dry-run']);
    strictEqual(result.status, 0, result.stderr);
    ok(result.stdout.includes('Summary generation skipped'), result.stdout);
    ok(!result.stdout.includes('model call failed'), result.stdout);
    ok(!existsSync(sentinel), 'summary hook was not invoked');

    const jsonResult = run(['summary', 'docs/a.md', '--json', '--dry-run']);
    strictEqual(jsonResult.status, 0, jsonResult.stderr);
    const output = JSON.parse(jsonResult.stdout);
    strictEqual(output.summary, null);
    strictEqual(output.summaryStatus, 'skipped-preview');
  });
});

describe('diff --summarize regression', () => {
  it('--help still works after ai.mjs refactor', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-diff-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);

    const result = run(['diff', '--help']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('summarize'), 'diff help still mentions summarize');
  });
});
