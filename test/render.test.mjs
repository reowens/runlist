import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import {
  renderCompactList,
  renderProgressBar,
  formatSnapshot,
  renderCheck,
  buildCoverage,
} from '../src/render.mjs';

function makeConfig(overrides = {}) {
  return {
    statusOrder: ['active', 'ready', 'planned', 'blocked', 'archived'],
    display: { lineWidth: 120, truncateTitle: 30 },
    context: {
      expanded: [],
      listed: [],
      counted: [],
      recentStatuses: ['active', 'ready', 'planned'],
      recentDays: 3,
      recentLimit: 10,
      truncateNextStep: 80,
    },
    lifecycle: {
      skipStaleFor: new Set(),
      skipWarningsFor: new Set(),
      archiveStatuses: new Set(['archived']),
      terminalStatuses: new Set(['archived', 'deprecated', 'reference', 'done']),
    },
    hooks: {},
    ...overrides,
  };
}

function makeDoc(overrides = {}) {
  const base = {
    title: 'Test Doc',
    status: 'active',
    path: 'docs/test-doc.md',
    daysSinceUpdate: 2,
    checklist: null,
    nextStep: null,
    currentState: 'In progress',
    surface: 'web',
    module: 'catalog',
    auditLevel: null,
    isStale: false,
    errors: [],
    warnings: [],
    ...overrides,
  };
  // Mirror src/index.mjs:162-164 — readers consume the plural arrays, which
  // always contain the singular value. Tests can still set singular only.
  if (base.surfaces === undefined) base.surfaces = base.surface ? [base.surface] : [];
  if (base.modules === undefined) base.modules = base.module ? [base.module] : [];
  return base;
}

describe('renderCompactList', () => {
  it('returns string starting with "Index"', () => {
    const index = { docs: [makeDoc()] };
    const result = renderCompactList(index, makeConfig());
    ok(result.startsWith('Index'), `expected to start with "Index", got: ${result.slice(0, 30)}`);
  });

  it('groups docs by status', () => {
    const index = {
      docs: [
        makeDoc({ title: 'Alpha', status: 'active' }),
        makeDoc({ title: 'Beta', status: 'ready' }),
        makeDoc({ title: 'Gamma', status: 'active' }),
      ],
    };
    const result = renderCompactList(index, makeConfig());
    ok(result.includes('Active (2)'), 'shows active count');
    ok(result.includes('Ready (1)'), 'shows ready count');
  });

  it('omits statuses with no docs', () => {
    const index = { docs: [makeDoc({ status: 'active' })] };
    const result = renderCompactList(index, makeConfig());
    ok(!result.includes('Ready'), 'should not include Ready section');
    ok(!result.includes('Planned'), 'should not include Planned section');
  });

  it('includes doc titles', () => {
    const index = { docs: [makeDoc({ title: 'My Great Plan' })] };
    const result = renderCompactList(index, makeConfig());
    ok(result.includes('My Great Plan'), 'includes the doc title');
  });
});

describe('renderProgressBar', () => {
  it('returns empty string for null checklist', () => {
    strictEqual(renderProgressBar(null), '');
  });

  it('returns empty string for zero total', () => {
    strictEqual(renderProgressBar({ completed: 0, total: 0 }), '');
  });

  it('shows correct bar format for partial progress', () => {
    const result = renderProgressBar({ completed: 5, total: 10 });
    ok(result.includes('5/10'), 'includes fraction');
    match(result, /^[^\d]+5\/10$/, 'ends with count');
  });

  it('shows full bar for completed checklist', () => {
    const result = renderProgressBar({ completed: 4, total: 4 });
    ok(result.includes('4/4'), 'includes fraction');
    // 10 filled blocks
    ok(result.includes('\u2588'.repeat(10)), 'has 10 filled blocks');
  });

  it('shows empty bar for zero completed', () => {
    const result = renderProgressBar({ completed: 0, total: 5 });
    ok(result.includes('0/5'), 'includes fraction');
    ok(result.includes('\u2591'.repeat(10)), 'has 10 empty blocks');
  });
});

describe('formatSnapshot', () => {
  it('prepends status when current_state does not start with a status prefix', () => {
    const doc = makeDoc({ status: 'active', currentState: 'Working on phase 2' });
    const result = formatSnapshot(doc, makeConfig());
    strictEqual(result, 'Active: Working on phase 2');
  });

  it('passes through when current_state already starts with status prefix', () => {
    const doc = makeDoc({ status: 'active', currentState: 'Active: phase 2 underway' });
    const result = formatSnapshot(doc, makeConfig());
    strictEqual(result, 'Active: phase 2 underway');
  });

  it('handles null current_state', () => {
    const doc = makeDoc({ status: 'active', currentState: null });
    const result = formatSnapshot(doc, makeConfig());
    strictEqual(result, 'Active: No current_state set');
  });

  it('handles blocked: prefix', () => {
    const doc = makeDoc({ status: 'blocked', currentState: 'Blocked: waiting on API' });
    const result = formatSnapshot(doc, makeConfig());
    strictEqual(result, 'Blocked: waiting on API');
  });
});

describe('renderCheck', () => {
  it('shows "No issues found" when clean', () => {
    const index = { docs: [makeDoc()], errors: [], warnings: [] };
    const result = renderCheck(index, makeConfig());
    ok(result.includes('No issues found'), 'includes no issues message');
    ok(result.includes('errors: 0'), 'shows zero errors');
    ok(result.includes('warnings: 0'), 'shows zero warnings');
  });

  it('shows errors when present', () => {
    const index = {
      docs: [makeDoc()],
      errors: [{ path: 'docs/bad.md', message: 'missing status' }],
      warnings: [],
    };
    const result = renderCheck(index, makeConfig());
    ok(result.includes('errors: 1'), 'shows error count');
    ok(result.includes('docs/bad.md: missing status'), 'shows error detail');
    ok(result.includes('Check failed'), 'shows failure message');
  });

  it('shows warnings when present', () => {
    const index = {
      docs: [makeDoc()],
      errors: [],
      warnings: [{ path: 'docs/warn.md', message: 'stale doc' }],
    };
    const result = renderCheck(index, makeConfig());
    ok(result.includes('warnings: 1'), 'shows warning count');
    ok(result.includes('docs/warn.md: stale doc'), 'shows warning detail');
    ok(result.includes('Check passed with warnings'), 'shows passed with warnings');
  });

  it('shows both errors and warnings', () => {
    const index = {
      docs: [makeDoc()],
      errors: [{ path: 'docs/e.md', message: 'err' }],
      warnings: [{ path: 'docs/w.md', message: 'warn' }],
    };
    const result = renderCheck(index, makeConfig());
    ok(result.includes('errors: 1'), 'shows error count');
    ok(result.includes('warnings: 1'), 'shows warning count');
    ok(result.includes('Check failed'), 'errors cause failure');
  });
});

describe('buildCoverage', () => {
  it('counts scoped docs correctly', () => {
    const index = {
      docs: [
        makeDoc({ status: 'active', surface: 'web', module: 'catalog' }),
        makeDoc({ status: 'planned', surface: null, module: 'catalog' }),
        makeDoc({ status: 'archived', surface: 'web', module: 'catalog' }),
      ],
    };
    const coverage = buildCoverage(index, makeConfig());
    strictEqual(coverage.totals.scopedDocs, 2, 'excludes archived');
  });

  it('identifies missing surface', () => {
    const index = {
      docs: [
        makeDoc({ status: 'active', surface: null }),
        makeDoc({ status: 'active', surface: 'web' }),
      ],
    };
    const coverage = buildCoverage(index, makeConfig());
    strictEqual(coverage.totals.missingSurface, 1);
  });

  it('identifies missing module', () => {
    const index = {
      docs: [
        makeDoc({ status: 'ready', module: null }),
        makeDoc({ status: 'ready', module: 'core' }),
      ],
    };
    const coverage = buildCoverage(index, makeConfig());
    strictEqual(coverage.totals.missingModule, 1);
  });

  it('counts module:platform and module:none', () => {
    const index = {
      docs: [
        makeDoc({ status: 'active', module: 'platform' }),
        makeDoc({ status: 'active', module: 'none' }),
        makeDoc({ status: 'active', module: 'catalog' }),
      ],
    };
    const coverage = buildCoverage(index, makeConfig());
    strictEqual(coverage.totals.modulePlatform, 1);
    strictEqual(coverage.totals.moduleNone, 1);
  });

  it('counts plural-only surfaces/modules (no singular field)', () => {
    // The default plan template writes `surfaces:`/`modules:` (plural).
    // Before the fix, coverage filtered on singular only — plural-only docs
    // showed up as "missing" even when populated.
    const index = {
      docs: [
        makeDoc({ status: 'active', surface: null, surfaces: ['cli'], module: null, modules: ['init', 'doctor'] }),
        makeDoc({ status: 'active', surface: null, surfaces: ['cli'], module: null, modules: ['platform'] }),
        makeDoc({ status: 'active', surface: null, surfaces: [], module: null, modules: [] }),
      ],
    };
    const coverage = buildCoverage(index, makeConfig());
    strictEqual(coverage.totals.scopedDocs, 3);
    strictEqual(coverage.totals.missingSurface, 1, 'plural-only surfaces must not count as missing');
    strictEqual(coverage.totals.missingModule, 1, 'plural-only modules must not count as missing');
    strictEqual(coverage.totals.modulePlatform, 1, 'module:platform inside plural array must count');
  });

  it('counts audited docs (pass1/pass2/deep)', () => {
    const index = {
      docs: [
        makeDoc({ status: 'active', auditLevel: 'pass1' }),
        makeDoc({ status: 'active', auditLevel: 'pass2' }),
        makeDoc({ status: 'active', auditLevel: 'deep' }),
        makeDoc({ status: 'active', auditLevel: 'none' }),
        makeDoc({ status: 'active', auditLevel: null }),
      ],
    };
    const coverage = buildCoverage(index, makeConfig());
    strictEqual(coverage.totals.audited, 3);
    strictEqual(coverage.totals.auditLevelNone, 1);
  });
});
