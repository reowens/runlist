import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { migrateOnePrompt } from '../src/migrate-prompts.mjs';

let tmpDir;
const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-mprom-'));
  spawnSync('git', ['init'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: tmpDir });
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(path.join(docsDir, 'prompts'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\n`);
  return docsDir;
}

function writePrompt(docsDir, filename, body) {
  const filePath = path.join(docsDir, 'prompts', filename);
  writeFileSync(filePath, body);
  spawnSync('git', ['add', filePath], { cwd: tmpDir });
  spawnSync('git', ['commit', '-m', `add ${filename}`], { cwd: tmpDir });
  return filePath;
}

function runCli(args) {
  return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
    cwd: tmpDir, encoding: 'utf8',
  });
}

afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

describe('migrateOnePrompt (pure)', () => {
  it('adds frontmatter to bare markdown', () => {
    const raw = `# Resume PII Phase 5.3\n\nDo the thing.\n`;
    const { changes, newRaw } = migrateOnePrompt(raw, { created: '2026-05-01T10:00:00Z', filePath: '/x/foo.md' });
    ok(changes.some(c => c.kind === 'add-frontmatter'));
    ok(newRaw.startsWith('---\n'), 'has frontmatter');
    ok(newRaw.includes('type: prompt'));
    ok(newRaw.includes('status: pending'));
    ok(newRaw.includes('created: 2026-05-01T10:00:00Z'));
    ok(newRaw.includes('Resume PII Phase 5.3'), 'context derived from H1');
    ok(newRaw.includes('# Resume PII Phase 5.3'), 'body preserved');
  });

  it('uses slug-cased filename when no H1', () => {
    const raw = `Just a paragraph of text with no heading.\n`;
    const { newRaw } = migrateOnePrompt(raw, { created: '2026-05-01T10:00:00Z', filePath: '/x/resume-foo-bar.md' });
    ok(newRaw.includes('context: "Resume Foo Bar"'), 'derived title from filename');
  });

  it('skips files that already have type: prompt frontmatter', () => {
    const raw = `---\ntype: prompt\nstatus: pending\n---\n\nbody\n`;
    const { changes, skipped, newRaw } = migrateOnePrompt(raw, {});
    strictEqual(skipped, 'already-prompt');
    strictEqual(changes.length, 0);
    strictEqual(newRaw, raw);
  });

  it('merges missing fields into partial/ad-hoc frontmatter', () => {
    const raw = `---\ntitle: Resume — foo\npurpose: paste me\n---\n\nbody\n`;
    const { changes, newRaw } = migrateOnePrompt(raw, { created: '2026-04-01T10:00:00Z' });
    ok(changes.some(c => c.kind === 'merge-frontmatter'));
    ok(newRaw.includes('type: prompt'));
    ok(newRaw.includes('title: Resume — foo'), 'preserves existing title');
    ok(newRaw.includes('purpose: paste me'), 'preserves existing purpose');
    ok(newRaw.includes('created: 2026-04-01T10:00:00Z'));
    ok(newRaw.includes('context: "Resume — foo"'), 'uses existing title as context');
  });
});

describe('dotmd doctor --migrate-prompts (CLI)', () => {
  it('migrates a bare prompt file', () => {
    const docsDir = setupProject();
    const promptPath = writePrompt(docsDir, 'resume-foo.md', '# Resume Foo\n\nBody text\n');
    const r = runCli(['doctor', '--migrate-prompts']);
    strictEqual(r.status, 0, `migrate failed: ${r.stderr}`);
    const after = readFileSync(promptPath, 'utf8');
    ok(after.startsWith('---\n'));
    ok(after.includes('type: prompt'));
    ok(after.includes('status: pending'));
    ok(after.includes('dotmd_version:'));
    ok(/created: \d{4}-\d{2}-\d{2}T/.test(after), 'has ISO created timestamp');
  });

  it('--dry-run does not write', () => {
    const docsDir = setupProject();
    const promptPath = writePrompt(docsDir, 'resume-foo.md', '# Resume Foo\n\nBody\n');
    const before = readFileSync(promptPath, 'utf8');
    const r = runCli(['doctor', '--migrate-prompts', '--dry-run']);
    strictEqual(r.status, 0);
    ok(r.stdout.includes('[dry-run]'));
    strictEqual(readFileSync(promptPath, 'utf8'), before);
  });

  it('skips files that already have frontmatter', () => {
    const docsDir = setupProject();
    writePrompt(docsDir, 'already-done.md', '---\ntype: prompt\nstatus: pending\n---\n\nbody\n');
    writePrompt(docsDir, 'needs-migration.md', '# Needs\n\nbody\n');
    const r = runCli(['doctor', '--migrate-prompts', '--json']);
    strictEqual(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    strictEqual(parsed.filesTouched, 1);
    ok(parsed.results[0].path.includes('needs-migration.md'));
  });

  it('targets a single file when path passed', () => {
    const docsDir = setupProject();
    writePrompt(docsDir, 'a.md', '# A\n');
    writePrompt(docsDir, 'b.md', '# B\n');
    const r = runCli(['doctor', '--migrate-prompts', 'a.md', '--json']);
    strictEqual(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    strictEqual(parsed.filesTouched, 1);
    ok(parsed.results[0].path.includes('a.md'));
  });

  it('reports cleanly when nothing to migrate', () => {
    setupProject();
    writePrompt(setupProject() && path.join(tmpDir, 'docs'), 'all-good.md', '---\ntype: prompt\nstatus: pending\n---\n\nbody\n');
    const r = runCli(['doctor', '--migrate-prompts']);
    strictEqual(r.status, 0);
    ok(r.stdout.includes('No prompts need migration'));
  });

  it('after migration, dotmd prompts lists the file', () => {
    const docsDir = setupProject();
    writePrompt(docsDir, 'cleanup.md', '# Cleanup\n\ndo X\n');
    runCli(['doctor', '--migrate-prompts']);
    const r = runCli(['prompts', '--json']);
    strictEqual(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    ok(parsed.docs.some(d => d.path.includes('cleanup.md')), 'prompts command finds the migrated file');
  });
});
