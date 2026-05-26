import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

function setup(configExtra = '') {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-modules-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\n${configExtra}`);
  return path.join(tmpDir, 'docs');
}

function writeDoc(docsDir, name, frontmatter, body = '') {
  writeFileSync(path.join(docsDir, name), `---\n${frontmatter}\n---\n${body}`);
}

function run(args) {
  return spawnSync('node', [BIN, ...args], {
    cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
}

function runJson(args) {
  const result = run([...args, '--json']);
  if (result.status !== 0) {
    throw new Error(`exit ${result.status}: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

const today = new Date().toISOString().slice(0, 10);

describe('dotmd modules — dashboard', () => {
  it('renders one row per discovered module', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', `type: plan\nstatus: active\nupdated: ${today}\nmodules: [catalog]`, '# A');
    writeDoc(docsDir, 'b.md', `type: plan\nstatus: active\nupdated: ${today}\nmodules: [suite]`, '# B');
    writeDoc(docsDir, 'c.md', `type: plan\nstatus: planned\nupdated: ${today}\nmodules: [beacon]`, '# C');
    const out = runJson(['modules']);
    strictEqual(out.modules.length, 3);
    const names = out.modules.map(m => m.name).sort();
    deepStrictEqual(names, ['beacon', 'catalog', 'suite']);
    strictEqual(out._totalUnique, 3);
  });

  it('orders by --sort cleanup formula (stale × avgAge / total)', () => {
    // catalog: 1 stale plan, very old → high cleanup score per plan.
    // suite: 0 stale plans, lots of active work → low cleanup score.
    const docsDir = setup();
    writeDoc(docsDir, 'catalog-old.md', 'type: plan\nstatus: active\nupdated: 2020-01-01\nmodules: [catalog]', '# catalog-old');
    writeDoc(docsDir, 'catalog-new.md', `type: plan\nstatus: active\nupdated: ${today}\nmodules: [catalog]`, '# catalog-new');
    writeDoc(docsDir, 'suite-1.md', `type: plan\nstatus: active\nupdated: ${today}\nmodules: [suite]`, '# s1');
    writeDoc(docsDir, 'suite-2.md', `type: plan\nstatus: active\nupdated: ${today}\nmodules: [suite]`, '# s2');
    writeDoc(docsDir, 'suite-3.md', `type: plan\nstatus: active\nupdated: ${today}\nmodules: [suite]`, '# s3');
    const out = runJson(['modules', '--sort', 'cleanup']);
    strictEqual(out.modules[0].name, 'catalog',
      `catalog (1 stale × huge age) should rank above suite (0 stale): ${JSON.stringify(out.modules.map(m => m.name))}`);
    ok(out.modules[0].stale >= 1, `catalog expected stale ≥1, got ${out.modules[0].stale}`);
  });

  it('double-counts multi-module plans and surfaces _totalUnique in JSON', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'shared.md', `type: plan\nstatus: active\nupdated: ${today}\nmodules: [catalog, suite]`, '# shared');
    writeDoc(docsDir, 'only-catalog.md', `type: plan\nstatus: active\nupdated: ${today}\nmodules: [catalog]`, '# catalog-only');
    const out = runJson(['modules']);
    const catalog = out.modules.find(m => m.name === 'catalog');
    const suite = out.modules.find(m => m.name === 'suite');
    strictEqual(catalog.total, 2, 'catalog should count shared + only-catalog');
    strictEqual(suite.total, 1, 'suite should count shared');
    strictEqual(out._totalUnique, 2,
      'unique plan count is 2 even though per-module sum is 3');
  });

  it('surfaces a `(none)` row for plans with no modules', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'tagged.md', `type: plan\nstatus: active\nupdated: ${today}\nmodules: [catalog]`, '# tagged');
    writeDoc(docsDir, 'untagged.md', `type: plan\nstatus: active\nupdated: ${today}`, '# untagged');
    const out = runJson(['modules']);
    const none = out.modules.find(m => m.name === '(none)');
    ok(none, `expected (none) row, got: ${JSON.stringify(out.modules.map(m => m.name))}`);
    strictEqual(none.total, 1);
  });

  it('discovers status columns dynamically from a custom-status config', () => {
    // Mock custom config: redefine plan statuses to include `research` and
    // a custom `backlog`. The dashboard should expose those, not the defaults.
    const docsDir = setup(`
export const types = {
  plan: {
    statuses: ['active', 'research', 'backlog', 'archived'],
  },
};
`);
    writeDoc(docsDir, 'a.md', `type: plan\nstatus: research\nupdated: ${today}\nmodules: [catalog]`, '# A');
    writeDoc(docsDir, 'b.md', `type: plan\nstatus: backlog\nupdated: ${today}\nmodules: [catalog]`, '# B');
    const result = run(['modules']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('resea'),
      `expected truncated 'research' column header, got: ${result.stdout}`);
    ok(result.stdout.includes('backl'),
      `expected truncated 'backlog' column header, got: ${result.stdout}`);
    ok(!result.stdout.match(/\bin-se\b/),
      `default 'in-session' status had no plans; column should be dropped. got: ${result.stdout}`);
  });
});

describe('dotmd module <name> — detail', () => {
  it('groups plans by status in config.statusOrder and flags stale inline', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'live.md', `type: plan\nstatus: active\nupdated: ${today}\nmodules: [catalog]\nnext_step: do the thing`, '# live');
    writeDoc(docsDir, 'old.md', 'type: plan\nstatus: active\nupdated: 2020-01-01\nmodules: [catalog]\nnext_step: y', '# old');
    writeDoc(docsDir, 'planned.md', `type: plan\nstatus: planned\nupdated: ${today}\nmodules: [catalog]\nnext_step: z`, '# planned');
    const result = run(['module', 'catalog']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const activeIdx = result.stdout.indexOf('active (');
    const plannedIdx = result.stdout.indexOf('planned (');
    ok(activeIdx >= 0 && plannedIdx >= 0, `expected both status groups, got: ${result.stdout}`);
    ok(activeIdx < plannedIdx, 'active should come before planned per statusOrder');
    ok(result.stdout.includes('[stale]'),
      `old.md should be flagged stale, got: ${result.stdout}`);
  });

  it('exits with hint when module name is unknown', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', `type: plan\nstatus: active\nupdated: ${today}\nmodules: [catalog]`, '# A');
    const result = run(['module', 'foyr']);
    ok(result.status !== 0, 'should exit non-zero');
    ok(result.stderr.includes("not found"), `expected 'not found' message, got: ${result.stderr}`);
    ok(result.stderr.includes('catalog'),
      `expected suggestion of real module 'catalog', got: ${result.stderr}`);
  });
});

describe('dotmd modules — JSON shape stability', () => {
  it('produces the documented shape', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', `type: plan\nstatus: active\nupdated: ${today}\nmodules: [catalog]\nnext_step: do thing`, '# A');
    const out = runJson(['modules', '--sort', 'stale']);
    // Top-level keys
    deepStrictEqual(Object.keys(out).sort(), ['_totalUnique', 'modules', 'sort', 'type']);
    strictEqual(out.type, 'plan');
    strictEqual(out.sort, 'stale');
    // Per-row keys
    const row = out.modules[0];
    deepStrictEqual(
      Object.keys(row).sort(),
      ['avgAgeDays', 'byStatus', 'name', 'nextStepPct', 'oldest', 'stale', 'total']
    );
  });
});
