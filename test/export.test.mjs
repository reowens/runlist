import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

let tmpDir;

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-export-'));
  mkdirSync(path.join(tmpDir, '.git'));
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
    export const root = 'docs';
    export const referenceFields = {
      bidirectional: ['related_plans'],
      unidirectional: [],
    };
  `);
  writeFileSync(path.join(docsDir, 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\nmodule: auth\nrelated_plans:\n  - b.md\n---\n# Plan A\n\nSome **bold** content.\n\n- item 1\n- item 2\n');
  writeFileSync(path.join(docsDir, 'b.md'), '---\nstatus: planned\nupdated: 2025-01-01\n---\n# Plan B\n\nAnother doc.\n');
  writeFileSync(path.join(docsDir, 'c.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# Plan C\n\nOrphan doc.\n');
  return docsDir;
}

function run(args) {
  const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
  return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
    cwd: tmpDir, encoding: 'utf8',
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('export: markdown', () => {
  it('exports all docs to stdout', () => {
    setupProject();
    const result = run(['export']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('# Docs Export'), 'has header');
    ok(result.stdout.includes('Plan A'), 'includes doc A');
    ok(result.stdout.includes('Plan B'), 'includes doc B');
    ok(result.stdout.includes('Plan C'), 'includes doc C');
    ok(result.stdout.includes('Some **bold** content'), 'includes body');
  });

  it('exports to file with --output', () => {
    setupProject();
    const outPath = path.join(tmpDir, 'out.md');
    const result = run(['export', '--output', outPath]);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(existsSync(outPath), 'file created');
    const content = readFileSync(outPath, 'utf8');
    ok(content.includes('Plan A'), 'has content');
  });

  it('filters by --status', () => {
    setupProject();
    const result = run(['export', '--status', 'planned']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Plan B'), 'includes planned doc');
    ok(!result.stdout.includes('Plan A'), 'excludes active doc');
  });
});

describe('export: json', () => {
  it('exports all docs as JSON', () => {
    setupProject();
    const result = run(['export', '--format', 'json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    strictEqual(json.count, 3);
    ok(json.docs[0].body, 'includes body');
    ok(json.docs[0].path, 'includes path');
  });

  it('exports to file with --output', () => {
    setupProject();
    const outPath = path.join(tmpDir, 'out.json');
    run(['export', '--format', 'json', '--output', outPath]);
    const json = JSON.parse(readFileSync(outPath, 'utf8'));
    strictEqual(json.count, 3);
  });
});

describe('export: html', () => {
  it('generates HTML directory', () => {
    setupProject();
    const outDir = path.join(tmpDir, 'site');
    const result = run(['export', '--format', 'html', '--output', outDir]);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(existsSync(path.join(outDir, 'index.html')), 'index.html created');
    ok(existsSync(path.join(outDir, 'a.html')), 'a.html created');
    ok(existsSync(path.join(outDir, 'b.html')), 'b.html created');

    const indexHtml = readFileSync(path.join(outDir, 'index.html'), 'utf8');
    ok(indexHtml.includes('Plan A'), 'index lists doc A');
    ok(indexHtml.includes('a.html'), 'index links to a.html');

    const docHtml = readFileSync(path.join(outDir, 'a.html'), 'utf8');
    ok(docHtml.includes('Plan A'), 'doc page has title');
    ok(docHtml.includes('active'), 'doc page has status');
    ok(docHtml.includes('index.html'), 'doc page links to index');
    ok(docHtml.includes('<strong>bold</strong>'), 'body converted to HTML');
  });

  it('defaults output to dotmd-export/', () => {
    setupProject();
    const result = run(['export', '--format', 'html']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(existsSync(path.join(tmpDir, 'dotmd-export', 'index.html')), 'default dir used');
  });
});

describe('export: single doc + deps', () => {
  it('exports doc and its dependencies', () => {
    setupProject();
    const result = run(['export', 'docs/a.md', '--format', 'json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    // a.md depends on b.md via related_plans
    strictEqual(json.count, 2, 'exports doc + dep');
    const paths = json.docs.map(d => d.path);
    ok(paths.some(p => p.includes('a.md')), 'includes source doc');
    ok(paths.some(p => p.includes('b.md')), 'includes dependency');
    ok(!paths.some(p => p.includes('c.md')), 'excludes unrelated doc');
  });
});

describe('export: --help', () => {
  it('shows help', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-export-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);

    const result = run(['export', '--help']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('export'), 'shows help');
    ok(result.stdout.includes('--format'), 'shows format flag');
  });
});
