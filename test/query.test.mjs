import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { parseQueryArgs, filterDocs } from '../src/query.mjs';

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
