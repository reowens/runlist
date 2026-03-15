import { describe, it, beforeEach, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-new-'));
  mkdirSync(path.join(tmpDir, '.git'));
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
  return docsDir;
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('dotmd new', () => {
  it('creates a document and verifies content', () => {
    const docsDir = setupProject();
    const result = run(['new', 'my-feature']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Created'), 'shows Created message');

    const content = readFileSync(path.join(docsDir, 'my-feature.md'), 'utf8');
    ok(content.includes('status: active'), 'has default status');
    ok(content.includes('# My Feature'), 'has title');
    ok(content.startsWith('---\n'), 'starts with frontmatter');
  });

  it('slugifies names with spaces and special chars', () => {
    const docsDir = setupProject();
    const result = run(['new', 'My Cool Feature!']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(existsSync(path.join(docsDir, 'my-cool-feature.md')), 'slugified filename');
  });

  it('--status flag sets the status', () => {
    const docsDir = setupProject();
    const result = run(['new', 'planned-thing', '--status', 'planned']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const content = readFileSync(path.join(docsDir, 'planned-thing.md'), 'utf8');
    ok(content.includes('status: planned'), 'has planned status');
  });

  it('--title flag overrides the title', () => {
    const docsDir = setupProject();
    const result = run(['new', 'slug-name', '--title', 'Custom Title']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const content = readFileSync(path.join(docsDir, 'slug-name.md'), 'utf8');
    ok(content.includes('# Custom Title'), 'has custom title');
  });

  it('refuses to overwrite existing file', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'exists.md'), '---\nstatus: active\n---\n# Exists\n');

    const result = run(['new', 'exists']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('already exists'), 'shows error');
  });

  it('--dry-run does not create file', () => {
    const docsDir = setupProject();
    const result = run(['new', 'dry-test', '--dry-run']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Would create'), 'shows dry-run message');
    ok(!existsSync(path.join(docsDir, 'dry-test.md')), 'file not created');
  });

  it('rejects invalid status', () => {
    setupProject();
    const result = run(['new', 'bad-status', '--status', 'nonsense']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('Invalid status'), 'shows invalid status error');
  });
});
