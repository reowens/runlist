import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
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

  it('preserves nested identity and rewrites only emitted Markdown document links', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'guides'));
    writeFileSync(path.join(docsDir, 'guides', 'a.md'), `---
status: active
---
# Nested A

[B](../b.md#details) [missing](missing.md) [asset](image.png) [web](https://example.com/a?x=1&y=2)
`);
    const outDir = path.join(tmpDir, 'site');
    const result = run(['export', '--format', 'html', '--output', outDir]);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const nested = readFileSync(path.join(outDir, 'guides', 'a.html'), 'utf8');
    ok(nested.includes('href="../b.html#details"'), 'rewrites emitted document link and preserves fragment');
    ok(nested.includes('<nav><a href="../index.html"'), 'links nested page back to root index');
    ok(!nested.includes('href="missing.md"'), 'does not manufacture a link to an unresolved document');
    ok(nested.includes('href="image.png"'), 'retains asset link');
    ok(nested.includes('href="https://example.com/a?x=1&amp;y=2"'), 'retains and escapes external link');
  });

  it('allocates collision URLs from the full corpus during filtered exports', () => {
    setupProject();
    const notesDir = path.join(tmpDir, 'notes');
    mkdirSync(notesDir);
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = ['docs', 'notes'];`);
    writeFileSync(path.join(notesDir, 'a.md'), '---\nstatus: planned\n---\n# Notes A\n');

    const fullDir = path.join(tmpDir, 'full');
    const filteredDir = path.join(tmpDir, 'filtered');
    strictEqual(run(['export', '--format', 'html', '--output', fullDir]).status, 0);
    const filtered = run(['export', '--format', 'html', '--status', 'active', '--output', filteredDir]);
    strictEqual(filtered.status, 0, `stderr: ${filtered.stderr}`);

    const fullFallbacks = readdirSync(path.join(fullDir, '__dotmd')).sort();
    const filteredFallbacks = readdirSync(path.join(filteredDir, '__dotmd')).sort();
    strictEqual(filteredFallbacks.length, 1);
    ok(fullFallbacks.includes(filteredFallbacks[0]), 'filtered page keeps its full-export allocation');
    ok(!existsSync(path.join(filteredDir, 'a.html')), 'does not reclaim the preferred path after filtering');
  });

  it('reserves index.html for the generated site index', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'index.md'), '---\nstatus: active\n---\n# Source Index\n');
    const outDir = path.join(tmpDir, 'site');
    const result = run(['export', '--format', 'html', '--output', outDir]);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(readFileSync(path.join(outDir, 'index.html'), 'utf8').includes('<h1>Docs Export</h1>'));
    ok(readdirSync(path.join(outDir, '__dotmd')).some(file => file.endsWith('.html')), 'source index uses fallback page');
  });

  it('rejects descendant output symlinks before writing and validates them in dry-run', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'guides'));
    writeFileSync(path.join(docsDir, 'guides', 'nested.md'), '---\nstatus: active\n---\n# Nested\n');
    const outDir = path.join(tmpDir, 'site');
    const outside = path.join(tmpDir, 'outside');
    mkdirSync(outDir);
    mkdirSync(outside);
    symlinkSync(outside, path.join(outDir, 'guides'));

    for (const args of [[], ['--dry-run']]) {
      const result = run(['export', '--format', 'html', '--output', outDir, ...args]);
      strictEqual(result.status, 1);
      ok(result.stderr.includes('descendant symlink'), result.stderr);
      ok(!existsSync(path.join(outside, 'nested.html')), 'does not follow output symlink');
    }
    ok(!existsSync(path.join(outDir, 'index.html')), 'fails before publishing any page');
  });

  it('runs complete HTML planning in dry-run without creating the output root', () => {
    setupProject();
    const outDir = path.join(tmpDir, 'missing', 'site');
    const result = run(['export', '--format', 'html', '--output', outDir, '--dry-run']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!existsSync(path.join(tmpDir, 'missing')), 'dry-run creates no directories');
  });

  it('rejects incompatible existing entries in preflight without partial publication', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'guides'));
    writeFileSync(path.join(docsDir, 'guides', 'nested.md'), '---\nstatus: active\n---\n# Nested\n');

    for (const dryRun of [false, true]) {
      const outDir = path.join(tmpDir, dryRun ? 'dry-site' : 'site');
      mkdirSync(outDir);
      writeFileSync(path.join(outDir, 'guides'), 'not a directory');
      const args = ['export', '--format', 'html', '--output', outDir];
      if (dryRun) args.push('--dry-run');
      const result = run(args);
      strictEqual(result.status, 1);
      ok(result.stderr.includes('incompatible existing entry'), result.stderr);
      ok(!existsSync(path.join(outDir, 'index.html')), 'preflight prevents partial publication');
    }
  });

  it('rejects dangling symlinks in the output-root path in dry-run and real export', () => {
    setupProject();
    for (const dryRun of [false, true]) {
      const parent = path.join(tmpDir, dryRun ? 'dry-parent' : 'parent');
      mkdirSync(parent);
      symlinkSync(path.join(tmpDir, 'missing-target'), path.join(parent, 'dangling'));
      const outDir = path.join(parent, 'dangling', 'site');
      const args = ['export', '--format', 'html', '--output', outDir];
      if (dryRun) args.push('--dry-run');
      const result = run(args);
      strictEqual(result.status, 1);
      ok(result.stderr.includes('ENOENT'), result.stderr);
      ok(!existsSync(path.join(outDir, 'index.html')));
    }
  });

  it('honors an existing unindexed document-relative target over an indexed repo-relative target', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'guides'));
    mkdirSync(path.join(docsDir, 'guides', 'docs', 'hidden'), { recursive: true });
    mkdirSync(path.join(docsDir, 'hidden'));
    writeFileSync(path.join(docsDir, 'guides', 'source.md'), '---\nstatus: active\n---\n# Source\n\n[Target](docs/hidden/target.md)\n');
    writeFileSync(path.join(docsDir, 'guides', 'docs', 'hidden', 'target.md'), '# Unindexed local target\n');
    writeFileSync(path.join(docsDir, 'hidden', 'target.md'), '---\nstatus: active\n---\n# Indexed repo target\n');

    // Only exclude the nested directory so the repository-relative spelling remains indexed.
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = ['docs/guides', 'docs/hidden'];\nexport const excludeDirs = ['hidden'];`);
    const outDir = path.join(tmpDir, 'site');
    const result = run(['export', '--format', 'html', '--output', outDir]);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const source = readFileSync(path.join(outDir, 'source.html'), 'utf8');
    ok(!source.includes('href="hidden/target.html"'), 'does not fall through to repository-relative indexed target');
    ok(source.includes('<p>Target</p>') || source.includes('Target'), 'retains the link label as text');
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
