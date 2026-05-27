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

  it('suppresses body-scraped currentState on terminal-status docs', async () => {
    // gmax audit #3: After tagging archive docs with `status: archived`, the
    // generated index still showed body-scraped phrases like "FIXED
    // (uncommitted)" because extractStatusSnapshot ran regardless of status.
    // For terminal statuses (archived/reference/deprecated by default), body
    // scrape and the "No current_state set" fallback are both dropped — only
    // an explicit frontmatter `current_state:` is honored.
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: archived', '# A\n\n**Status:** FIXED (uncommitted)');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    strictEqual(doc.currentState, null,
      `terminal doc should have null currentState (got: ${doc.currentState})`);
    strictEqual(doc.currentStateOrigin, null,
      'terminal doc with no currentState should have null origin');
  });

  it('still honors explicit frontmatter current_state on terminal docs', async () => {
    // Frontmatter wins — the suppression is only for body-scrape and fallback.
    const docsDir = setup();
    writeDoc(docsDir, 'a.md',
      'status: archived\ncurrent_state: "settled in commit abc123"',
      '# A\n\n**Status:** stale body claim');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    strictEqual(doc.currentState, 'settled in commit abc123',
      'explicit frontmatter current_state should survive');
    strictEqual(doc.currentStateOrigin, 'frontmatter',
      'frontmatter-sourced state should be flagged as such');
  });

  it('still body-scrapes for non-terminal-status docs (regression)', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active', '# A\n\n**Status:** Phase 2 underway');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    strictEqual(doc.currentState, 'Phase 2 underway',
      'non-terminal status should still get the body scrape');
    strictEqual(doc.currentStateOrigin, 'body',
      'body-scraped state should be flagged so renderers can mark it (auto)');
  });

  it('leaves currentStateOrigin null on the placeholder fallback', async () => {
    // gmax audit enhancement D: only frontmatter and body-scrape get an
    // explicit origin. The 'No current_state set' nag is a UI placeholder,
    // not data from any source — origin stays null so renderers don't claim
    // the placeholder string was scraped from anywhere.
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active', '# A\n\nJust some body prose, no status snapshot.');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    strictEqual(doc.currentState, 'No current_state set',
      'placeholder fallback should still be present for non-terminal docs');
    strictEqual(doc.currentStateOrigin, null,
      'placeholder is not body-scraped — origin must stay null');
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
    deepStrictEqual(doc.refFieldDirections.depends_on, ['two-way']);
  });

  it('parses `>` prefix as one-way ref and strips it from the path', async () => {
    const docsDir = setup(`
export const referenceFields = {
  bidirectional: ['related_docs'],
  unidirectional: [],
};`);
    writeDoc(docsDir, 'a.md', 'status: active\nrelated_docs:\n  - "> b.md"', '# A');
    writeDoc(docsDir, 'b.md', 'status: active', '# B');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    deepStrictEqual(doc.refFields.related_docs, ['b.md']);
    deepStrictEqual(doc.refFieldDirections.related_docs, ['one-way']);
  });

  it('parses mixed list with one-way and two-way entries per-entry', async () => {
    const docsDir = setup(`
export const referenceFields = {
  bidirectional: ['related_docs'],
  unidirectional: [],
};`);
    writeDoc(docsDir, 'a.md', 'status: active\nrelated_docs:\n  - b.md\n  - "> c.md"\n  - d.md', '# A');
    writeDoc(docsDir, 'b.md', 'status: active', '# B');
    writeDoc(docsDir, 'c.md', 'status: active', '# C');
    writeDoc(docsDir, 'd.md', 'status: active', '# D');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    deepStrictEqual(doc.refFields.related_docs, ['b.md', 'c.md', 'd.md']);
    deepStrictEqual(doc.refFieldDirections.related_docs, ['two-way', 'one-way', 'two-way']);
  });

  it('accepts `>` prefix on unidirectional fields as a no-op marker', async () => {
    const docsDir = setup(`
export const referenceFields = {
  bidirectional: [],
  unidirectional: ['parent_plan'],
};`);
    writeDoc(docsDir, 'a.md', 'status: active\nparent_plan: "> b.md"', '# A');
    writeDoc(docsDir, 'b.md', 'status: active', '# B');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    deepStrictEqual(doc.refFields.parent_plan, ['b.md']);
    deepStrictEqual(doc.refFieldDirections.parent_plan, ['one-way']);
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

  it('accepts `blocked_by` as an alias for `blockers` (issue #10 finding #2)', async () => {
    // Agents reach for the JIRA/Linear-style name naturally. Both populate
    // the same indexed `blockers` field — pick whichever reads better.
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: blocked\nblocked_by:\n  - foo.md\n  - bar.md', '# A');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    deepStrictEqual(doc.blockers, ['foo.md', 'bar.md']);
    strictEqual(doc.hasBlockers, true);
  });

  it('merges `blockers` and `blocked_by` (de-duped) if both are set', async () => {
    // Tolerant of accidental dual-naming during a migration. mergeUniqueStrings
    // collapses overlaps so a doc with both names doesn't double-count.
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: blocked\nblockers:\n  - foo.md\nblocked_by:\n  - foo.md\n  - bar.md', '# A');
    const config = await resolveConfig(tmpDir);
    const doc = parseDocFile(path.join(docsDir, 'a.md'), config);
    deepStrictEqual(doc.blockers.sort(), ['bar.md', 'foo.md']);
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

  it('builds countsByType keyed by type/status (F6)', async () => {
    // F6: countsByStatus flat-counts `partial: 3` whether the docs are
    // plan/partial (shipped + tail deferred) or doc/partial (incomplete
    // reference). countsByType preserves the distinction so stats /
    // briefing can render them as separate buckets.
    const docsDir = setup();
    writeDoc(docsDir, 'p1.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# P1');
    writeDoc(docsDir, 'p2.md', 'type: plan\nstatus: partial\nupdated: 2025-01-01', '# P2');
    writeDoc(docsDir, 'd1.md', 'type: doc\nstatus: active\nupdated: 2025-01-01', '# D1');
    writeDoc(docsDir, 'd2.md', 'type: doc\nstatus: partial\nupdated: 2025-01-01', '# D2');
    writeDoc(docsDir, 'd3.md', 'type: doc\nstatus: partial\nupdated: 2025-01-01', '# D3');
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);

    ok(typeof index.countsByType === 'object', 'has countsByType field');
    strictEqual(index.countsByType.plan?.active, 1, 'plan/active = 1');
    strictEqual(index.countsByType.plan?.partial, 1, 'plan/partial = 1');
    strictEqual(index.countsByType.doc?.active, 1, 'doc/active = 1');
    strictEqual(index.countsByType.doc?.partial, 2, 'doc/partial = 2');
    // Flat sum is preserved for back-compat callers.
    strictEqual(index.countsByStatus.partial, 3, 'flat partial = 3 (sum)');
    strictEqual(index.countsByStatus.active, 2, 'flat active = 2 (sum)');
  });

  it('buckets untyped docs under `unknown` in countsByType (F6)', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01', '# A');
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    strictEqual(index.countsByType.unknown?.active, 1, 'untyped doc lands under `unknown`');
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
