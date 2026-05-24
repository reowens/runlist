import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

let tmpDir;
const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-pslint-'));
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

function checkJson() {
  const r = spawnSync('node', [bin, 'check', '--json', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
    cwd: tmpDir, encoding: 'utf8',
  });
  return JSON.parse(r.stdout);
}

afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

describe('plan-shape lint', () => {
  it('warns when next_step exceeds 300 chars', () => {
    const docsDir = setupProject();
    const longText = 'x'.repeat(500);
    writeDoc(docsDir, 'plan.md', `type: plan\nstatus: active\nupdated: 2026-05-13\nnext_step: ${longText}`);

    const idx = checkJson();
    const w = idx.warnings.find(x => x.message.includes('next_step') && x.message.includes('chars'));
    ok(w, `expected next_step warning, got: ${JSON.stringify(idx.warnings)}`);
    ok(w.message.includes('500'), 'reports actual length');
  });

  it('warns when current_state exceeds 500 chars', () => {
    const docsDir = setupProject();
    const longText = 'x'.repeat(700);
    writeDoc(docsDir, 'plan.md', `type: plan\nstatus: active\nupdated: 2026-05-13\ncurrent_state: ${longText}`);

    const idx = checkJson();
    const w = idx.warnings.find(x => x.message.includes('current_state') && x.message.includes('chars'));
    ok(w, 'expected current_state warning');
    ok(w.message.includes('700'));
  });

  it('warns when surface and surfaces array diverge (singular not in array)', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'plan.md', `type: plan\nstatus: active\nupdated: 2026-05-13\nsurface: web\nsurfaces:\n  - backend\n  - api`);

    const idx = checkJson();
    const w = idx.warnings.find(x => x.message.includes('surface') && x.message.includes('surfaces'));
    ok(w, 'expected surface/surfaces warning when values diverge');
  });

  it('does NOT warn when surface is already a member of the surfaces array', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'plan.md', `type: plan\nstatus: active\nupdated: 2026-05-13\nsurface: web\nsurfaces:\n  - web\n  - api`);

    const idx = checkJson();
    const w = idx.warnings.find(x => x.message.includes('surface') && x.message.includes('surfaces'));
    ok(!w, 'no warning when singular ∈ plural (index.mjs merges them transparently)');
  });

  it('warns when module and modules array diverge (singular not in array)', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'plan.md', `type: plan\nstatus: active\nupdated: 2026-05-13\nmodule: auth\nmodules:\n  - identity\n  - billing`);

    const idx = checkJson();
    const w = idx.warnings.find(x => x.message.includes('module') && x.message.includes('modules'));
    ok(w, 'expected module/modules warning when values diverge');
  });

  it('does NOT warn when module is already a member of the modules array', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'plan.md', `type: plan\nstatus: active\nupdated: 2026-05-13\nmodule: auth\nmodules:\n  - auth\n  - identity`);

    const idx = checkJson();
    const w = idx.warnings.find(x => x.message.includes('module') && x.message.includes('modules'));
    ok(!w, 'no warning when singular ∈ plural (index.mjs merges them transparently)');
  });

  it('warns on lowercase ## Open questions heading drift', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'plan.md', `type: plan\nstatus: active\nupdated: 2026-05-13`, `# P\n\n## Open questions\n\n- q\n`);

    const idx = checkJson();
    const w = idx.warnings.find(x => x.message.startsWith('Heading drift'));
    ok(w, 'expected heading drift warning');
    ok(w.message.includes('Open Questions'), 'suggests the canonical form');
  });

  it('warns on ## Out of scope heading (should be ## Non-Goals)', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'plan.md', `type: plan\nstatus: active\nupdated: 2026-05-13`, `# P\n\n## Out of scope\n\n- x\n`);

    const idx = checkJson();
    const w = idx.warnings.find(x => x.message.startsWith('Heading drift'));
    ok(w, 'expected heading drift warning');
    ok(w.message.includes('Non-Goals'));
  });

  it('warns when Phases section has unmarked phase headings', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'plan.md', `type: plan\nstatus: active\nupdated: 2026-05-13`, `# P\n\n## Phases\n\n### Phase 1 — Foo\n\n### Phase 2 — Bar ✅\n\n### Phase 3 — Baz\n`);

    const idx = checkJson();
    const w = idx.warnings.find(x => x.message.includes('phase heading(s) lack'));
    ok(w, 'expected phase-marker warning');
    ok(w.message.includes('2 of 3'), `expected "2 of 3", got: ${w.message}`);
  });

  it('no warning when all phase headings have markers', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'plan.md', `type: plan\nstatus: active\nupdated: 2026-05-13`, `# P\n\n## Phases\n\n### Phase 1 ✅\n\n### Phase 2 🟡\n\n### Phase 3 ⬜\n`);

    const idx = checkJson();
    const w = idx.warnings.find(x => x.message.includes('phase heading(s) lack'));
    ok(!w, 'should not warn when all phases marked');
  });

  it('does not warn on non-plan documents', () => {
    const docsDir = setupProject();
    const longText = 'x'.repeat(600);
    writeDoc(docsDir, 'doc.md', `type: doc\nstatus: active\nupdated: 2026-05-13\nnext_step: ${longText}`);

    const idx = checkJson();
    const w = idx.warnings.find(x => x.message.includes('next_step'));
    ok(!w, 'plan-shape lint should be plan-only');
  });

  it('does not warn on archived plans', () => {
    const docsDir = setupProject();
    const longText = 'x'.repeat(600);
    writeDoc(docsDir, 'archived/plan.md', `type: plan\nstatus: archived\nupdated: 2026-05-13\nnext_step: ${longText}`);

    const idx = checkJson();
    const w = idx.warnings.find(x => x.path.includes('archived/plan.md') && x.message.includes('next_step'));
    ok(!w, 'archived plans should not trigger plan-shape lint');
  });
});
