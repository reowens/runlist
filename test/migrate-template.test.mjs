import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { migrateOne } from '../src/migrate-template.mjs';

let tmpDir;
const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-migrate-'));
  spawnSync('git', ['init'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: tmpDir });
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(path.join(docsDir, 'archived'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\n`);
  return docsDir;
}

function writeDoc(docsDir, filename, frontmatter, body = '') {
  const filePath = path.join(docsDir, filename);
  writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`);
  return filePath;
}

function runCli(args) {
  return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
    cwd: tmpDir, encoding: 'utf8',
  });
}

afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

describe('migrateOne (pure)', () => {
  it('drops singular surface when surfaces array is populated', () => {
    const raw = `---\ntype: plan\nstatus: active\nupdated: 2026-05-13\nsurface: web\nsurfaces:\n  - web\n  - api\n---\n# P\n\n## Phases\n\n### Phase 1 ✅\n`;
    const { changes, newRaw } = migrateOne(raw);
    ok(changes.some(c => c.kind === 'drop-singular' && c.detail.startsWith('surface:')), 'reports drop');
    ok(!/^surface: web$/m.test(newRaw), 'singular surface removed');
    ok(/^surfaces:/m.test(newRaw), 'array preserved');
  });

  it('drops singular module when modules array is populated', () => {
    const raw = `---\ntype: plan\nstatus: active\nupdated: 2026-05-13\nmodule: auth\nmodules:\n  - auth\n  - identity\n---\n# P\n`;
    const { changes, newRaw } = migrateOne(raw);
    ok(changes.some(c => c.kind === 'drop-singular' && c.detail.startsWith('module:')));
    ok(!/^module: auth$/m.test(newRaw));
    ok(/^modules:/m.test(newRaw));
  });

  it('preserves singular surface when no array is set', () => {
    const raw = `---\ntype: plan\nstatus: active\nupdated: 2026-05-13\nsurface: web\n---\n# P\n`;
    const { changes, newRaw } = migrateOne(raw);
    ok(!changes.some(c => c.kind === 'drop-singular' && c.detail.startsWith('surface:')), 'singular preserved');
    ok(/^surface: web$/m.test(newRaw));
  });

  it('preserves singular when array exists but is empty', () => {
    const raw = `---\ntype: plan\nstatus: active\nupdated: 2026-05-13\nsurface: web\nsurfaces: []\n---\n# P\n`;
    const { changes } = migrateOne(raw);
    ok(!changes.some(c => c.kind === 'drop-singular' && c.detail.startsWith('surface:')), 'empty array does not redundant-ify singular');
  });

  it('renames ## Open questions to ## Open Questions', () => {
    const raw = `---\ntype: plan\nstatus: active\nupdated: 2026-05-13\n---\n# P\n\n## Open questions\n\n- q\n`;
    const { changes, newRaw } = migrateOne(raw);
    ok(changes.some(c => c.kind === 'rename-heading'));
    ok(/^## Open Questions$/m.test(newRaw));
    ok(!/^## Open questions$/m.test(newRaw));
  });

  it('renames ## Out of scope to ## Non-Goals', () => {
    const raw = `---\ntype: plan\nstatus: active\nupdated: 2026-05-13\n---\n# P\n\n## Out of scope\n\nstuff\n`;
    const { changes, newRaw } = migrateOne(raw);
    ok(changes.some(c => c.kind === 'rename-heading'));
    ok(/^## Non-Goals$/m.test(newRaw));
  });

  it('adds ## Version History section when missing', () => {
    const raw = `---\ntype: plan\nstatus: active\nupdated: 2026-05-13\n---\n# P\n\n## Problem\n\nstuff\n`;
    const { changes, newRaw } = migrateOne(raw);
    ok(changes.some(c => c.kind === 'add-version-history'));
    ok(/^## Version History$/m.test(newRaw));
    ok(/\*\*2026-05-13\*\* Migrated to v0\.21 template/.test(newRaw), 'seeded with updated timestamp');
  });

  it('inserts Version History BEFORE Closeout when Closeout exists', () => {
    const raw = `---\ntype: plan\nstatus: active\nupdated: 2026-05-13\n---\n# P\n\n## Problem\n\nstuff\n\n## Closeout\n\nfinal notes\n`;
    const { newRaw } = migrateOne(raw);
    const vhIdx = newRaw.indexOf('## Version History');
    const coIdx = newRaw.indexOf('## Closeout');
    ok(vhIdx >= 0 && coIdx >= 0 && vhIdx < coIdx, 'Version History inserted before Closeout');
  });

  it('does not add Version History when it already exists', () => {
    const raw = `---\ntype: plan\nstatus: active\nupdated: 2026-05-13\n---\n# P\n\n## Version History\n\n- **2025-01-01** existing\n`;
    const { changes } = migrateOne(raw);
    ok(!changes.some(c => c.kind === 'add-version-history'));
  });

  it('skips non-plan documents', () => {
    const raw = `---\ntype: doc\nstatus: active\nupdated: 2026-05-13\nsurface: web\nsurfaces:\n  - web\n---\n# D\n`;
    const { changes, skipped } = migrateOne(raw);
    strictEqual(skipped, 'not-plan');
    strictEqual(changes.length, 0);
  });

  it('returns no changes when nothing needs migrating', () => {
    const raw = `---\ntype: plan\nstatus: active\nupdated: 2026-05-13\nsurfaces:\n  - web\n---\n# P\n\n## Version History\n\n- **2025** y\n`;
    const { changes, newRaw } = migrateOne(raw);
    strictEqual(changes.length, 0);
    strictEqual(newRaw, raw);
  });
});

describe('dotmd doctor --migrate-template (CLI)', () => {
  it('writes when not --dry-run', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2026-05-13\nsurface: web\nsurfaces:\n  - web', '# P\n');
    const r = runCli(['doctor', '--migrate-template']);
    strictEqual(r.status, 0, `migrate failed: ${r.stderr}`);
    const after = readFileSync(planPath, 'utf8');
    ok(!/^surface: web$/m.test(after), 'singular removed from disk');
    ok(/^## Version History$/m.test(after), 'Version History added');
  });

  it('--dry-run does not modify files', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2026-05-13\nsurface: web\nsurfaces:\n  - web', '# P\n');
    const before = readFileSync(planPath, 'utf8');
    const r = runCli(['doctor', '--migrate-template', '--dry-run']);
    strictEqual(r.status, 0);
    ok(r.stdout.includes('[dry-run]'), 'shows dry-run prefix');
    strictEqual(readFileSync(planPath, 'utf8'), before, 'file unchanged');
  });

  it('skips archived plans by default', () => {
    const docsDir = setupProject();
    const livePath = writeDoc(docsDir, 'live.md', 'type: plan\nstatus: active\nupdated: 2026-05-13\nsurface: web\nsurfaces:\n  - web', '# Live\n');
    const archivedPath = writeDoc(docsDir, 'archived/old.md', 'type: plan\nstatus: archived\nupdated: 2026-04-01\nsurface: web\nsurfaces:\n  - web', '# Old\n');
    const r = runCli(['doctor', '--migrate-template', '--json']);
    strictEqual(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    const paths = parsed.results.map(x => x.path);
    ok(paths.some(p => p.includes('live.md')), 'live plan migrated');
    ok(!paths.some(p => p.includes('archived/old.md')), 'archived plan skipped');
  });

  it('--include-archived processes archived plans', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'live.md', 'type: plan\nstatus: active\nupdated: 2026-05-13\nsurface: web\nsurfaces:\n  - web', '# Live\n');
    writeDoc(docsDir, 'archived/old.md', 'type: plan\nstatus: archived\nupdated: 2026-04-01\nsurface: web\nsurfaces:\n  - web', '# Old\n');
    const r = runCli(['doctor', '--migrate-template', '--include-archived', '--json']);
    strictEqual(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    const paths = parsed.results.map(x => x.path);
    ok(paths.some(p => p.includes('archived/old.md')), 'archived plan now included');
  });

  it('targets a single file when path passed', () => {
    const docsDir = setupProject();
    const planA = writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active\nupdated: 2026-05-13\nsurface: web\nsurfaces:\n  - web', '# A\n');
    const planB = writeDoc(docsDir, 'b.md', 'type: plan\nstatus: active\nupdated: 2026-05-13\nsurface: api\nsurfaces:\n  - api', '# B\n');
    const r = runCli(['doctor', '--migrate-template', planA, '--json']);
    strictEqual(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    strictEqual(parsed.filesTouched, 1, 'only one file processed');
    ok(parsed.results[0].path.includes('a.md'));
  });

  it('exits with code 0 and reports cleanly when nothing to migrate', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2026-05-13\nsurfaces:\n  - web', '# P\n\n## Version History\n\n- **x** y\n');
    const r = runCli(['doctor', '--migrate-template']);
    strictEqual(r.status, 0);
    ok(r.stdout.includes('No template migrations needed') || r.stdout.includes('0 plans'));
  });
});
