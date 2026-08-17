import { describe, it, afterEach } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseQueryArgs, filterDocs, displayableExcerptLine } from '../src/query.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

function spawnDotmd(args) {
  return spawnSync('node', [BIN, ...args], {
    cwd: tmpDir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('parseQueryArgs', () => {
  it('parses empty args to defaults', () => {
    const filters = parseQueryArgs([]);
    strictEqual(filters.statuses, null);
    strictEqual(filters.keyword, null);
    strictEqual(filters.limit, 20);
    strictEqual(filters.sort, 'updated');
    strictEqual(filters.all, false);
    strictEqual(filters.stale, false);
    strictEqual(filters.json, false);
  });

  it('parses --status with comma-separated values', () => {
    const filters = parseQueryArgs(['--status', 'active,ready']);
    deepStrictEqual(filters.statuses, ['active', 'ready']);
  });

  it('parses boolean flags', () => {
    const filters = parseQueryArgs(['--stale', '--has-next-step', '--has-blockers', '--all', '--json']);
    strictEqual(filters.stale, true);
    strictEqual(filters.hasNextStep, true);
    strictEqual(filters.hasBlockers, true);
    strictEqual(filters.all, true);
    strictEqual(filters.json, true);
  });

  it('parses --limit', () => {
    const filters = parseQueryArgs(['--limit', '5']);
    strictEqual(filters.limit, 5);
  });

  it('parses --sort', () => {
    const filters = parseQueryArgs(['--sort', 'title']);
    strictEqual(filters.sort, 'title');
  });

  it('collects positional terms (lowercased) as filter tokens', () => {
    const filters = parseQueryArgs(['rls', '--sort', 'updated', 'Platform']);
    deepStrictEqual(filters.positionalTerms, ['rls', 'platform']);
  });

  it('positional terms AND-match against slug + title', () => {
    const docs = [
      { path: 'docs/plans/rls-platform-rows.md', title: 'RLS Platform-Row Visibility', status: 'active' },
      { path: 'docs/plans/rls-location-anchored.md', title: 'RLS Location-anchored', status: 'active' },
      { path: 'docs/plans/pii-redesign.md', title: 'PII Redesign', status: 'active' },
    ];
    const config = { lifecycle: { archiveStatuses: new Set(), terminalStatuses: new Set() } };

    // Single term
    const single = filterDocs(docs, parseQueryArgs(['rls']), config);
    strictEqual(single.length, 2);

    // Multi-term AND
    const multi = filterDocs(docs, parseQueryArgs(['rls', 'platform']), config);
    strictEqual(multi.length, 1);
    strictEqual(multi[0].path, 'docs/plans/rls-platform-rows.md');

    // No matches
    const none = filterDocs(docs, parseQueryArgs(['nonexistent']), config);
    strictEqual(none.length, 0);

    // Matches title too, not just slug
    const titleMatch = filterDocs(docs, parseQueryArgs(['visibility']), config);
    strictEqual(titleMatch.length, 1);
  });

  it('parses multiple value flags', () => {
    const filters = parseQueryArgs(['--keyword', 'auth', '--module', 'catalog', '--owner', 'robert']);
    strictEqual(filters.keyword, 'auth');
    strictEqual(filters.module, 'catalog');
    strictEqual(filters.owner, 'robert');
  });
});

describe('filterDocs', () => {
  const config = {
    statusOrder: ['active', 'ready', 'planned', 'archived'],
    staleDaysByStatus: { active: 14, ready: 14, planned: 30 },
    lifecycle: { skipStaleFor: new Set(['archived']) },
  };

  const docs = [
    { title: 'Alpha', status: 'active', updated: '2025-03-10', surfaces: ['web'], modules: ['catalog'], owner: 'alice', isStale: false, hasNextStep: true, hasBlockers: false, checklist: { open: 0 }, blockers: [], nextStep: 'Do it' },
    { title: 'Beta', status: 'ready', updated: '2025-03-01', surfaces: ['ios'], modules: ['ledger'], owner: 'bob', isStale: true, hasNextStep: false, hasBlockers: true, checklist: { open: 2 }, blockers: ['dep'], nextStep: null },
    { title: 'Gamma', status: 'planned', updated: '2025-02-15', surfaces: ['api'], modules: ['roster'], owner: 'alice', isStale: false, hasNextStep: true, hasBlockers: false, checklist: { open: 0 }, blockers: [], nextStep: 'Plan it' },
  ];

  it('filters by status', () => {
    const result = filterDocs(docs, { ...parseQueryArgs(['--status', 'active']), all: true }, config);
    strictEqual(result.length, 1);
    strictEqual(result[0].title, 'Alpha');
  });

  it('filters by keyword', () => {
    const result = filterDocs(docs, { ...parseQueryArgs(['--keyword', 'beta']), all: true }, config);
    strictEqual(result.length, 1);
    strictEqual(result[0].title, 'Beta');
  });

  it('filters by --stale', () => {
    const result = filterDocs(docs, { ...parseQueryArgs(['--stale']), all: true }, config);
    strictEqual(result.length, 1);
    strictEqual(result[0].title, 'Beta');
  });

  it('filters by --has-next-step', () => {
    const result = filterDocs(docs, { ...parseQueryArgs(['--has-next-step']), all: true }, config);
    strictEqual(result.length, 2);
  });

  it('filters by --has-blockers', () => {
    const result = filterDocs(docs, { ...parseQueryArgs(['--has-blockers']), all: true }, config);
    strictEqual(result.length, 1);
    strictEqual(result[0].title, 'Beta');
  });

  it('filters by module', () => {
    const result = filterDocs(docs, { ...parseQueryArgs(['--module', 'roster']), all: true }, config);
    strictEqual(result.length, 1);
    strictEqual(result[0].title, 'Gamma');
  });

  it('filters by owner', () => {
    const result = filterDocs(docs, { ...parseQueryArgs(['--owner', 'alice']), all: true }, config);
    strictEqual(result.length, 2);
  });

  it('respects --limit', () => {
    const result = filterDocs(docs, parseQueryArgs(['--limit', '1']), config);
    strictEqual(result.length, 1);
  });

  it('sorts by title', () => {
    const result = filterDocs(docs, { ...parseQueryArgs(['--sort', 'title']), all: true }, config);
    strictEqual(result[0].title, 'Alpha');
    strictEqual(result[2].title, 'Gamma');
  });

  it('sorts by updated (default, descending)', () => {
    const result = filterDocs(docs, { ...parseQueryArgs([]), all: true }, config);
    strictEqual(result[0].title, 'Alpha');
    strictEqual(result[2].title, 'Gamma');
  });

  it('filters by --updated-since', () => {
    const result = filterDocs(docs, { ...parseQueryArgs(['--updated-since', '2025-03-05']), all: true }, config);
    strictEqual(result.length, 1);
    strictEqual(result[0].title, 'Alpha');
  });

  it('filters by --checklist-open', () => {
    const result = filterDocs(docs, { ...parseQueryArgs(['--checklist-open']), all: true }, config);
    strictEqual(result.length, 1);
    strictEqual(result[0].title, 'Beta');
  });

  it('combines multiple filters', () => {
    const result = filterDocs(docs, { ...parseQueryArgs(['--owner', 'alice', '--has-next-step']), all: true }, config);
    strictEqual(result.length, 2);
  });
});

describe('unknown --module value hint', () => {
  function setupProject() {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-query-hint-'));
    mkdirSync(path.join(tmpDir, '.git'));
    const docsDir = path.join(tmpDir, 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    writeFileSync(path.join(docsDir, 'a.md'),
      '---\nstatus: active\nupdated: 2025-01-01\nmodules:\n  - kiosk\n---\n# A\n');
    return docsDir;
  }

  it('suggests close module names when --module value is a typo', () => {
    setupProject();
    const r = spawnDotmd(['query', '--module', 'kiosl']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(r.stdout.includes('No module `kiosl`'), `expected unknown-module line, got: ${r.stdout}`);
    ok(r.stdout.includes('Did you mean'), `expected suggestion, got: ${r.stdout}`);
    ok(r.stdout.includes('kiosk'), `expected kiosk in suggestion, got: ${r.stdout}`);
  });

  it('omits hint when --module value exists (combination miss, not typo)', () => {
    setupProject();
    // The module exists, but the keyword filter knocks the lone doc out.
    const r = spawnDotmd(['query', '--module', 'kiosk', '--keyword', 'unmatchable']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(!r.stdout.includes('No module'), `should not emit unknown-module hint, got: ${r.stdout}`);
  });

  it('omits suggestion line when nothing in the index is close', () => {
    setupProject();
    const r = spawnDotmd(['query', '--module', 'zzzzzzzzz']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(r.stdout.includes('No module `zzzzzzzzz`'));
    ok(!r.stdout.includes('Did you mean'), `no close match should suppress hint, got: ${r.stdout}`);
  });
});

describe('truncation signal', () => {
  function setupCorpus(n) {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-query-trunc-'));
    mkdirSync(path.join(tmpDir, '.git'));
    const docsDir = path.join(tmpDir, 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    for (let i = 0; i < n; i++) {
      writeFileSync(path.join(docsDir, `doc-${i}.md`),
        `---\nstatus: active\nupdated: 2025-01-${String(i + 1).padStart(2, '0')}\n---\n# Doc ${i}\n`);
    }
  }

  it('query text render shows "N of M (use --all)" when truncated', () => {
    setupCorpus(5);
    const r = spawnDotmd(['query', '--limit', '2']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(r.stdout.includes('results: 2 of 5'), `expected truncation hint, got: ${r.stdout}`);
    ok(r.stdout.includes('use --all'), `expected --all hint, got: ${r.stdout}`);
  });

  it('query text render hides truncation hint with --all', () => {
    setupCorpus(5);
    const r = spawnDotmd(['query', '--limit', '2', '--all']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(!r.stdout.includes(' of 5'), `expected no truncation hint with --all, got: ${r.stdout}`);
    ok(!r.stdout.includes('use --all'), `expected no --all hint when --all set, got: ${r.stdout}`);
  });

  it('query text render hides truncation hint when result fits', () => {
    setupCorpus(2);
    const r = spawnDotmd(['query', '--limit', '5']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(r.stdout.includes('results: 2\n'), `expected plain count, got: ${r.stdout}`);
    ok(!r.stdout.includes('use --all'), `expected no --all hint when not truncated, got: ${r.stdout}`);
  });

  function setupPlans(n) {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-plans-trunc-'));
    mkdirSync(path.join(tmpDir, '.git'));
    const plansDir = path.join(tmpDir, 'docs', 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    for (let i = 0; i < n; i++) {
      writeFileSync(path.join(plansDir, `plan-${i}.md`),
        `---\ntype: plan\nstatus: active\nupdated: 2025-01-${String(i + 1).padStart(2, '0')}\nmodules:\n  - mod-${i % 2}\n---\n# Plan ${i}\n`);
    }
  }

  it('plans triage view shows "N more" footer when truncated', () => {
    setupPlans(5);
    const r = spawnDotmd(['plans', '--limit', '2']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(r.stdout.includes('3 more plans'), `expected "3 more plans" footer, got: ${r.stdout}`);
  });

  it('plans grouped-by-status view shows "N more" footer when truncated', () => {
    setupPlans(5);
    const r = spawnDotmd(['plans', '--limit', '2', '--sort', 'status']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(r.stdout.includes('3 more plans'), `expected "3 more plans" footer in grouped view, got: ${r.stdout}`);
  });

  it('plans group-by-module view shows "N more" footer when truncated', () => {
    setupPlans(5);
    const r = spawnDotmd(['plans', '--limit', '2', '--group', 'module']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(r.stdout.includes('3 more plans'), `expected "3 more plans" footer in group-by-module view, got: ${r.stdout}`);
  });
});

describe('--body keyword search', () => {
  const config = { lifecycle: { archiveStatuses: new Set(), terminalStatuses: new Set() } };

  function setupBodyProject() {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-query-body-'));
    mkdirSync(path.join(tmpDir, '.git'));
    const docsDir = path.join(tmpDir, 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    // Body-only match: "zanzibar" appears in the body, nowhere in frontmatter.
    writeFileSync(path.join(docsDir, 'body-hit.md'),
      '---\ntitle: Token Refresh\nstatus: active\nupdated: 2025-01-02\n---\n# Token Refresh\n\nWe decided to use zanzibar-style tuples here.\n');
    // Frontmatter match: keyword in title, body never mentions it.
    writeFileSync(path.join(docsDir, 'fm-hit.md'),
      '---\ntitle: Zanzibar Design\nstatus: active\nupdated: 2025-01-03\n---\n# Design\n\nNothing relevant in the body.\n');
    // No match anywhere.
    writeFileSync(path.join(docsDir, 'miss.md'),
      '---\ntitle: Unrelated\nstatus: active\nupdated: 2025-01-01\n---\n# Unrelated\n\nNope.\n');
    return docsDir;
  }

  it('parses --body', () => {
    strictEqual(parseQueryArgs([]).body, false);
    strictEqual(parseQueryArgs(['--body']).body, true);
  });

  it('filterDocs with --body matches bodies and attaches line-numbered excerpts', () => {
    setupBodyProject();
    const docs = [
      { path: 'docs/body-hit.md', title: 'Token Refresh', status: 'active' },
      { path: 'docs/miss.md', title: 'Unrelated', status: 'active' },
    ];
    const result = filterDocs(docs, parseQueryArgs(['--keyword', 'zanzibar', '--body']), { ...config, repoRoot: tmpDir });
    strictEqual(result.length, 1);
    strictEqual(result[0].path, 'docs/body-hit.md');
    strictEqual(result[0].bodyMatches.length, 1);
    // ---(1) title(2) status(3) updated(4) ---(5) #(6) blank(7) text(8)
    strictEqual(result[0].bodyMatches[0].line, 8);
    ok(result[0].bodyMatches[0].text.includes('zanzibar'));
  });

  it('filterDocs without --body still ignores bodies', () => {
    setupBodyProject();
    const docs = [{ path: 'docs/body-hit.md', title: 'Token Refresh', status: 'active' }];
    const result = filterDocs(docs, parseQueryArgs(['--keyword', 'zanzibar']), { ...config, repoRoot: tmpDir });
    strictEqual(result.length, 0);
  });

  it('frontmatter matches are kept without reading the file (lazy)', () => {
    // The file does not exist on disk — a body read would warn and drop it.
    const docs = [{ path: 'docs/ghost.md', title: 'Zanzibar Ghost', status: 'active' }];
    const result = filterDocs(docs, parseQueryArgs(['--keyword', 'zanzibar', '--body']), { ...config, repoRoot: '/nonexistent' });
    strictEqual(result.length, 1);
    strictEqual(result[0].bodyMatches, undefined);
  });

  it('caps excerpts at 2 per doc', () => {
    setupBodyProject();
    writeFileSync(path.join(tmpDir, 'docs', 'many.md'),
      '---\ntitle: Many\nstatus: active\nupdated: 2025-01-04\n---\nzanzibar one\nzanzibar two\nzanzibar three\n');
    const docs = [{ path: 'docs/many.md', title: 'Many', status: 'active' }];
    const result = filterDocs(docs, parseQueryArgs(['--keyword', 'zanzibar', '--body']), { ...config, repoRoot: tmpDir });
    strictEqual(result[0].bodyMatches.length, 2);
  });

  it('windows long lines so the needle stays visible', () => {
    setupBodyProject();
    const longLine = 'x'.repeat(200) + ' zanzibar ' + 'y'.repeat(200);
    writeFileSync(path.join(tmpDir, 'docs', 'long.md'),
      `---\ntitle: Long\nstatus: active\nupdated: 2025-01-04\n---\n${longLine}\n`);
    const docs = [{ path: 'docs/long.md', title: 'Long', status: 'active' }];
    const result = filterDocs(docs, parseQueryArgs(['--keyword', 'zanzibar', '--body']), { ...config, repoRoot: tmpDir });
    const text = result[0].bodyMatches[0].text;
    ok(text.includes('zanzibar'), `needle not visible in excerpt: ${text}`);
    ok(text.length < 130, `excerpt not windowed: ${text.length} chars`);
  });

  it('query --keyword --body finds body-only docs and renders match lines', () => {
    setupBodyProject();
    const r = spawnDotmd(['query', '--keyword', 'zanzibar', '--body']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(r.stdout.includes('results: 2'), `expected both hits, got: ${r.stdout}`);
    ok(r.stdout.includes('keyword: zanzibar (bodies scanned)'), `expected header note, got: ${r.stdout}`);
    ok(r.stdout.includes('match: L8:'), `expected match line with line number, got: ${r.stdout}`);
  });

  it('query --body without --keyword errors with guidance', () => {
    setupBodyProject();
    const r = spawnDotmd(['query', '--body']);
    strictEqual(r.status, 1);
    ok(r.stderr.includes('--keyword'), `expected guidance, got: ${r.stderr}`);
  });

  it('query --json includes bodyMatches', () => {
    setupBodyProject();
    const r = spawnDotmd(['query', '--keyword', 'zanzibar', '--body', '--json']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    strictEqual(out.count, 2);
    const bodyHit = out.docs.find(d => d.path === 'docs/body-hit.md');
    strictEqual(bodyHit.bodyMatches.length, 1);
    strictEqual(bodyHit.bodyMatches[0].line, 8);
  });
});

describe('grep alias', () => {
  function setupBodyProject() {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-grep-'));
    mkdirSync(path.join(tmpDir, '.git'));
    const docsDir = path.join(tmpDir, 'docs');
    mkdirSync(path.join(docsDir, 'plans'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    writeFileSync(path.join(docsDir, 'design.md'),
      '---\ntype: doc\ntitle: Design\nstatus: active\nupdated: 2025-01-02\n---\n# Design\n\nUses zanzibar tuples.\n');
    writeFileSync(path.join(docsDir, 'plans', 'roll-out.md'),
      '---\ntype: plan\ntitle: Roll Out\nstatus: active\nupdated: 2025-01-03\n---\n# Roll Out\n\nShip the zanzibar migration.\n');
  }

  it('grep <term> searches bodies and returns doc cards', () => {
    setupBodyProject();
    const r = spawnDotmd(['grep', 'zanzibar']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(r.stdout.includes('results: 2'), `expected 2 hits, got: ${r.stdout}`);
    ok(r.stdout.includes('match:'), `expected excerpts, got: ${r.stdout}`);
    ok(r.stdout.includes('status: active'), `expected doc card fields, got: ${r.stdout}`);
  });

  it('grep composes with --type', () => {
    setupBodyProject();
    const r = spawnDotmd(['grep', 'zanzibar', '--type', 'plan']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(r.stdout.includes('results: 1'), `expected plan-only hit, got: ${r.stdout}`);
    ok(r.stdout.includes('docs/plans/roll-out.md'), `expected plan path, got: ${r.stdout}`);
  });

  it('grep respects an explicit --limit instead of defaulting to --all', () => {
    setupBodyProject();
    const r = spawnDotmd(['grep', 'zanzibar', '--limit', '1']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(r.stdout.includes('results: 1 of 2'), `expected truncated result, got: ${r.stdout}`);
  });

  it('grep without a term errors with usage', () => {
    setupBodyProject();
    const r = spawnDotmd(['grep']);
    strictEqual(r.status, 1);
    ok(r.stderr.includes('Usage: dotmd grep <term>'), `expected usage, got: ${r.stderr}`);
  });
});

describe('excerpt HTML-comment stripping', () => {
  it('hides comments that surround the match', () => {
    const { text, at } = displayableExcerptLine(
      '| [child](child.md) | <!--s-->active<!--/s--> — next up |', 30, 'next up');
    strictEqual(text, '| [child](child.md) | active — next up |');
    strictEqual(text.slice(at, at + 7), 'next up');
  });

  it('keeps the raw line when the match is INSIDE a comment', () => {
    const raw = '| [child](child.md) | <!--s-->active<!--/s--> — done |';
    const { text } = displayableExcerptLine(raw, raw.indexOf('s-->act'), 's-->act');
    strictEqual(text, raw, 'stripping would have hidden the match');
  });

  it('leaves a comment-free line byte-identical', () => {
    const raw = '| [child](child.md) | active — next up |';
    const { text, at } = displayableExcerptLine(raw, 22, 'active');
    strictEqual(text, raw);
    strictEqual(at, 22);
  });

  it('squeezes the whitespace a removed comment leaves behind', () => {
    const { text } = displayableExcerptLine('status:  <!-- note -->  shipped', 24, 'shipped');
    strictEqual(text, 'status: shipped');
  });
});
