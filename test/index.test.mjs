import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildIndex, collectDocFiles, parseDocFile } from '../src/index.mjs';
import { resolveConfig } from '../src/config.mjs';

let tmpDir;

function setup(configExtra = '') {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-index-'));
  mkdirSync(path.join(tmpDir, '.git'));
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\n${configExtra}`);
  return docsDir;
}

function writeDoc(docsDir, name, frontmatter, body = '') {
  writeFileSync(path.join(docsDir, name), `---\n${frontmatter}\n---\n${body}`);
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ── collectDocFiles ─────────────────────────────────────────────────────

describe('collectDocFiles', () => {
  it('collects .md files from docs root', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active');
    writeDoc(docsDir, 'b.md', 'status: planned');
    const config = await resolveConfig(tmpDir);
    const files = collectDocFiles(config);
    strictEqual(files.length, 2);
    ok(files[0].endsWith('a.md'));
    ok(files[1].endsWith('b.md'));
  });

  it('skips non-.md files', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active');
    writeFileSync(path.join(docsDir, 'notes.txt'), 'not markdown');
    const config = await resolveConfig(tmpDir);
    const files = collectDocFiles(config);
    strictEqual(files.length, 1);
  });

  it('recurses into subdirectories', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active');
    mkdirSync(path.join(docsDir, 'sub'));
    writeDoc(path.join(docsDir, 'sub'), 'b.md', 'status: active');
    const config = await resolveConfig(tmpDir);
    const files = collectDocFiles(config);
    strictEqual(files.length, 2);
  });

  it('skips excluded directories', async () => {
    const docsDir = setup(`export const excludeDirs = ['archived'];`);
    writeDoc(docsDir, 'a.md', 'status: active');
    mkdirSync(path.join(docsDir, 'archived'));
    writeDoc(path.join(docsDir, 'archived'), 'old.md', 'status: archived');
    const config = await resolveConfig(tmpDir);
    const files = collectDocFiles(config);
    strictEqual(files.length, 1);
  });

  it('returns sorted file list', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'z.md', 'status: active');
    writeDoc(docsDir, 'a.md', 'status: active');
    writeDoc(docsDir, 'm.md', 'status: active');
    const config = await resolveConfig(tmpDir);
    const files = collectDocFiles(config);
    ok(files[0].endsWith('a.md'));
    ok(files[1].endsWith('m.md'));
    ok(files[2].endsWith('z.md'));
  });

  it('handles missing directory gracefully', async () => {
    setup();
    rmSync(path.join(tmpDir, 'docs'), { recursive: true, force: true });
    const config = await resolveConfig(tmpDir);
    const files = collectDocFiles(config);
    strictEqual(files.length, 0);
  });

  it('deduplicates files across multi-root', async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-index-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeDoc(path.join(tmpDir, 'docs'), 'a.md', 'status: active');
    // Both roots point to the same directory
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = ['docs', 'docs'];`);
    const config = await resolveConfig(tmpDir);
    const files = collectDocFiles(config);
    strictEqual(files.length, 1);
  });

  it('skips indexPath file', async () => {
    const docsDir = setup(`
export const index = {
  path: 'docs/docs.md',
  startMarker: '<!-- START -->',
  endMarker: '<!-- END -->',
};`);
    writeDoc(docsDir, 'a.md', 'status: active');
    writeFileSync(path.join(docsDir, 'docs.md'), '# Index\n<!-- START -->\n<!-- END -->');
    const config = await resolveConfig(tmpDir);
    const files = collectDocFiles(config);
    strictEqual(files.length, 1);
    ok(files[0].endsWith('a.md'));
  });
});

// ── parseDocFile ────────────────────────────────────────────────────────

describe('parseDocFile', () => {
  it('extracts title from frontmatter', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'title: My Title\nstatus: active', '# Heading');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    strictEqual(doc.title, 'My Title');
  });

  it('falls back to H1 heading for title', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active', '# Heading Title');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    strictEqual(doc.title, 'Heading Title');
  });

  it('falls back to filename when no title or H1', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'my-doc.md', 'status: active', 'No heading here');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'my-doc.md'), config);
    strictEqual(doc.title, 'my-doc');
  });

  it('extracts status, owner, surface, module', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active\nowner: alice\nsurface: web\nmodule: auth', '# A');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    strictEqual(doc.status, 'active');
    strictEqual(doc.owner, 'alice');
    strictEqual(doc.surface, 'web');
    strictEqual(doc.module, 'auth');
  });

  it('merges singular surface into surfaces array', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active\nsurface: web\nsurfaces:\n  - mobile', '# A');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    ok(doc.surfaces.includes('web'));
    ok(doc.surfaces.includes('mobile'));
    strictEqual(doc.surfaces.length, 2);
  });

  it('merges singular module into modules array', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active\nmodule: auth\nmodules:\n  - billing', '# A');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    ok(doc.modules.includes('auth'));
    ok(doc.modules.includes('billing'));
  });

  it('extracts checklist counts', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active', '# A\n- [x] done\n- [ ] open\n- [x] also done');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    strictEqual(doc.checklist.completed, 2);
    strictEqual(doc.checklist.open, 1);
    strictEqual(doc.checklist.total, 3);
  });

  it('computes checklistCompletionRate', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active', '# A\n- [x] done\n- [ ] open');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    strictEqual(doc.checklistCompletionRate, 0.5);
  });

  it('extracts body links', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active', '# A\nSee [other](other.md) for details.');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    ok(doc.bodyLinks.length > 0);
    ok(doc.bodyLinks.some(l => l.href === 'other.md'));
  });

  it('detects hasCloseout section', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active', '# A\n\n## Closeout\nDone.');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    strictEqual(doc.hasCloseout, true);
  });

  it('sets hasCloseout false when absent', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active', '# A\nNo closeout');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    strictEqual(doc.hasCloseout, false);
  });

  it('extracts reference fields from config', async () => {
    const docsDir = setup(`
export const referenceFields = {
  bidirectional: ['depends_on'],
  unidirectional: [],
};`);
    writeDoc(docsDir, 'a.md', 'status: active\ndepends_on:\n  - b.md', '# A');
    writeDoc(docsDir, 'b.md', 'status: active', '# B');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    deepStrictEqual(doc.refFields.depends_on, ['b.md']);
  });

  it('tags doc with correct root label', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active', '# A');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    strictEqual(doc.root, 'docs');
  });

  it('computes daysSinceUpdate', async () => {
    const docsDir = setup();
    const today = new Date().toISOString().slice(0, 10);
    writeDoc(docsDir, 'a.md', `status: active\nupdated: ${today}`, '# A');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    strictEqual(doc.daysSinceUpdate, 0);
  });

  it('sets null for missing optional fields', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active', '# A');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    strictEqual(doc.owner, null);
    strictEqual(doc.surface, null);
    strictEqual(doc.module, null);
    strictEqual(doc.domain, null);
    strictEqual(doc.audience, null);
    strictEqual(doc.created, null);
  });

  it('computes hasNextStep and hasBlockers', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active\nnext_step: do the thing\nblockers:\n  - something', '# A');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    strictEqual(doc.hasNextStep, true);
    strictEqual(doc.hasBlockers, true);
  });
});

// ── buildIndex ──────────────────────────────────────────────────────────

describe('buildIndex', () => {
  it('returns docs, countsByStatus, warnings, errors', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01', '# A');
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    ok(Array.isArray(index.docs));
    ok(typeof index.countsByStatus === 'object');
    ok(Array.isArray(index.warnings));
    ok(Array.isArray(index.errors));
    ok(index.generatedAt);
  });

  it('counts statuses correctly', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01', '# A');
    writeDoc(docsDir, 'b.md', 'status: active\nupdated: 2025-01-01', '# B');
    writeDoc(docsDir, 'c.md', 'status: planned\nupdated: 2025-01-01', '# C');
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    strictEqual(index.countsByStatus.active, 2);
    strictEqual(index.countsByStatus.planned, 1);
  });

  it('counts unknown statuses', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: custom-status\nupdated: 2025-01-01', '# A');
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    strictEqual(index.countsByStatus['custom-status'], 1);
  });

  it('runs validate hook and collects hook warnings', async () => {
    const docsDir = setup(`
export function validate(doc) {
  return { warnings: [{ path: doc.path, level: 'warning', message: 'hook warning' }] };
}`);
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01', '# A');
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    ok(index.warnings.some(w => w.message === 'hook warning'));
  });

  it('catches validate hook that throws', async () => {
    const docsDir = setup(`
export function validate() {
  throw new Error('hook exploded');
}`);
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01', '# A');
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    ok(index.errors.some(e => e.message.includes('hook exploded')));
  });

  it('runs transformDoc hook', async () => {
    const docsDir = setup(`
export function transformDoc(doc) {
  return { ...doc, title: 'transformed' };
}`);
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01', '# A');
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    strictEqual(index.docs[0].title, 'transformed');
  });

  it('catches transformDoc hook that throws', async () => {
    const docsDir = setup(`
export function transformDoc() {
  throw new Error('transform boom');
}`);
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01', '# A');
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    ok(index.warnings.some(w => w.message.includes('transform boom')));
    strictEqual(index.docs.length, 1, 'doc is preserved despite hook error');
  });

  it('handles empty docs directory', async () => {
    setup();
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    strictEqual(index.docs.length, 0);
    strictEqual(index.errors.length, 0);
  });
});
