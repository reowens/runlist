import { describe, it, afterEach } from 'node:test';
import { strictEqual, deepStrictEqual, ok, match } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../src/config.mjs';
import { buildIndex } from '../src/index.mjs';
import { buildCoverage, renderCoverage } from '../src/render.mjs';
import { buildFilingCoverage, filingFindings, scanFilingRows, filingOptions } from '../src/filing.mjs';

const temporary = [];
const cli = fileURLToPath(new URL('../bin/runlist.mjs', import.meta.url));
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function repo(filing = true, extra = '') {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'runlist-filing-'));
  temporary.push(directory);
  mkdirSync(path.join(directory, '.git'));
  mkdirSync(path.join(directory, 'docs', 'archived'), { recursive: true });
  writeFileSync(path.join(directory, 'runlist.config.mjs'), `export const root = 'docs';\nexport const filing = ${JSON.stringify(filing)};\n${extra}`);
  const config = await resolveConfig(directory);
  const write = (name, body = '', fields = '') => {
    const overrides = new Set([...fields.matchAll(/^([a-z_]+):/gm)].map(match => match[1]));
    const defaults = ['type: plan', 'status: active', 'updated: 2026-10-08', 'current_state: Working.', 'next_step: Finish the work.']
      .filter(line => !overrides.has(line.split(':')[0])).join('\n');
    writeFileSync(path.join(directory, 'docs', name), `---\n${defaults}\n${fields}\n---\n# Example\n\n${body}\n`);
    return `docs/${name}`;
  };
  const hub = (name, body, fields = '') => write(name, body, `${/^execution_mode:/m.test(fields) ? '' : 'execution_mode: coordination\n'}${fields}`);
  const index = () => buildIndex(config, { invokeHooks: false, gitStaleness: false });
  return { directory, config, write, hub, index };
}

const rowTable = rows => `| Plan | Notes | Status |\n|---|---|---|\n${rows}\n`;
const home = (name, notes = '', status = 'active') => `| [Plan](${name}) | ${notes} | ${status} |`;
const hubIndex = rows => `| Hub | Pickup source |\n|---|---|\n${rows}\n`;
const hubPointer = name => `| [Hub](${name}) | Follow the hub's next step. |`;
const get = (report, name) => report.plans.find(plan => plan.path === `docs/${name}`);
const findings = (index, kind) => index.warnings.filter(warning => warning.meta?.kind === kind);

describe('subject rows define filing, rather than any link', () => {
  it('ignores prose, commentary, metadata, link lists, ranked non-subject cells and pointer tables', async () => {
    const r = await repo();
    r.write('home.md'); r.write('mentioned.md'); r.write('metadata.md'); r.write('ordered.md');
    r.write('ranked.md'); r.write('pointer.md');
    r.hub('area.md', `### Delivery\n${rowTable(home('home.md', '[Mention](mentioned.md)'))}
See [Mention](mentioned.md).
## Order of operations
1. [Ordered](ordered.md)
| Rank | Plan | Status |
|---|---|---|
| 1 | [Ranked](ranked.md) | active |

| Plan | Notes |
|---|---|
| [Pointer](pointer.md) | related |
`, 'related_plans:\n  - metadata.md');
    const index = r.index();
    strictEqual(get(index.filingCoverage, 'home.md').filing, 'direct');
    deepStrictEqual(index.filingCoverage.totals, { plans: 6, filedDirect: 1, filedThroughParent: 0, unfiled: 5, multiplyFiled: 0, noCategory: 0 });
    strictEqual(findings(index, 'filing-unfiled').length, 5);
  });

  it('reports each duplicate row and its exact physical source location', async () => {
    const r = await repo();
    r.write('work.md');
    r.hub('one.md', `### Delivery\n${rowTable(home('work.md'))}`);
    r.hub('two.md', `### Delivery\n${rowTable(home('work.md'))}`);
    const index = r.index();
    const entry = findings(index, 'filing-multiple')[0];
    strictEqual(entry.meta.rows.length, 2);
    for (const row of entry.meta.rows) {
      const source = readFileSync(path.join(r.directory, row.hub), 'utf8').split('\n');
      match(source[row.line - 1], /\[Plan\]\(work.md\)/);
      match(entry.message, new RegExp(`${row.hub}:${row.line}`));
    }
    strictEqual(index.filingCoverage.totals.multiplyFiled, 1);
  });

  it('does not infer categories from hub names or structural headings', async () => {
    const r = await repo();
    r.write('work.md');
    r.hub('area.md', `## Ranked Queue\n${rowTable(home('work.md'))}`);
    const index = r.index();
    strictEqual(index.filingCoverage.totals.noCategory, 1);
    match(findings(index, 'filing-no-category')[0].message, /docs\/area.md:\d+ \[no category\]/);
  });

  it('retains category depth across deeper headings and resets it at broader headings', () => {
    const rows = scanFilingRows(`### Delivery\n#### Subsection\n${rowTable(home('one.md'))}\n## Other\n${rowTable(home('two.md'))}`);
    deepStrictEqual(rows.map(row => row.category), ['Delivery', null]);
    strictEqual(scanFilingRows(`## Delivery\n${rowTable(home('one.md'))}`, 2)[0].category, 'Delivery');
  });

  it('ignores fenced examples, multiline comments and inline-code links, retaining coded link labels', async () => {
    const r = await repo();
    r.write('real.md'); r.write('sample.md');
    r.hub('area.md', `### Delivery
~~~md
${rowTable(home('sample.md'))}
~~~
<!--
${rowTable(home('sample.md'))}
-->
${rowTable('| [`real.md`](real.md) | | <!--s-->active<!--/s--> |\n| `[fake](sample.md)` | | active |')}`);
    const report = r.index().filingCoverage;
    strictEqual(get(report, 'real.md').filing, 'direct');
    strictEqual(get(report, 'sample.md').filing, 'unfiled');
  });

  it('requires a readable status from the subject type vocabulary', async () => {
    const r = await repo();
    r.write('blank.md'); r.write('unknown.md'); r.write('marked.md');
    r.hub('area.md', `### Delivery\n${rowTable(home('blank.md', '', '') + '\n' + home('unknown.md', '', 'invented') + '\n' + home('marked.md', '', '<!--s-->active<!--/s-->'))}`);
    const report = r.index().filingCoverage;
    strictEqual(report.totals.filedDirect, 1);
    strictEqual(get(report, 'marked.md').filing, 'direct');
  });

  it('resolves decoded Markdown paths and refuses broken links or repo-root fallbacks', async () => {
    const r = await repo();
    r.write('with space.md'); r.write('missing-route.md');
    r.hub('area.md', `### Delivery\n${rowTable(home('with%20space.md') + '\n' + home('docs/missing-route.md'))}`);
    const report = r.index().filingCoverage;
    strictEqual(get(report, 'with space.md').filing, 'direct');
    strictEqual(get(report, 'missing-route.md').filing, 'unfiled');
  });
});

describe('explicit parent homes and category propagation', () => {
  it('reads status-less hub index categories without filing ordinary plans or hub children', async () => {
    const r = await repo();
    r.hub('root.md', `### Delivery\n${hubIndex(hubPointer('area.md') + '\n' + hubPointer('pointer.md'))}`, 'execution_mode: roadmap');
    r.hub('area.md', rowTable(home('work.md')));
    r.write('work.md'); r.write('child.md', '', 'parent_plan: work.md');
    r.write('pointer.md'); r.write('hub-child.md', '', 'parent_plan: area.md');
    const index = r.index();
    const report = index.filingCoverage;
    deepStrictEqual(get(report, 'work.md').rows[0].categories, ['Delivery']);
    deepStrictEqual(get(report, 'child.md').rows[0].categories, ['Delivery']);
    strictEqual(get(report, 'child.md').filing, 'parent');
    strictEqual(get(report, 'pointer.md').filing, 'unfiled');
    strictEqual(get(report, 'hub-child.md').filing, 'unfiled');
    deepStrictEqual(report.totals, { plans: 4, filedDirect: 1, filedThroughParent: 1, unfiled: 2, multiplyFiled: 0, noCategory: 0 });
    strictEqual(findings(index, 'filing-no-category').length, 0);
    strictEqual(scanFilingRows(`### Delivery\n${hubIndex(hubPointer('area.md'))}`).length, 0);
  });

  it('propagates category-only indexes through nested hubs and cycles', async () => {
    const r = await repo();
    r.hub('root.md', `### Delivery\n${hubIndex(hubPointer('middle.md'))}`);
    r.hub('middle.md', hubIndex(hubPointer('area.md')));
    r.hub('area.md', `${hubIndex(hubPointer('middle.md'))}\n${rowTable(home('work.md'))}`);
    r.write('work.md');
    deepStrictEqual(get(r.index().filingCoverage, 'work.md').rows[0].categories, ['Delivery']);
  });

  it('retains competing category-only mappings and category evidence from home rows', async () => {
    const r = await repo();
    r.hub('root.md', `### Delivery\n${hubIndex(hubPointer('area.md'))}\n### Operations\n${hubIndex(hubPointer('area.md'))}\n### Research\n${rowTable(home('area.md'))}`);
    r.hub('area.md', rowTable(home('work.md'))); r.write('work.md');
    const report = r.index().filingCoverage;
    deepStrictEqual(get(report, 'work.md').rows[0].categories, ['Delivery', 'Operations', 'Research']);
    strictEqual(report.totals.multiplyFiled, 1);
    strictEqual(report.totals.noCategory, 0);
  });

  it('keeps a plan row category ahead of inherited hub mappings at the configured depth', async () => {
    const r = await repo({ categoryDepth: 2 });
    r.hub('root.md', `## Delivery\n### Detail\n${hubIndex(hubPointer('area.md'))}`);
    r.hub('area.md', `## Operations\n${rowTable(home('work.md'))}\n# Unclassified\n${rowTable(home('other.md'))}`);
    r.write('work.md'); r.write('other.md');
    const report = r.index().filingCoverage;
    deepStrictEqual(get(report, 'work.md').rows[0].categories, ['Operations']);
    deepStrictEqual(get(report, 'other.md').rows[0].categories, ['Delivery']);
  });

  it('ignores category mappings from prose, commentary, examples and closed hubs', async () => {
    const r = await repo();
    r.hub('area.md', rowTable(home('work.md'))); r.write('work.md');
    r.hub('closed.md', `### Closed\n${hubIndex(hubPointer('area.md'))}`, 'status: archived');
    r.hub('root.md', `### Ignored
See [Hub](area.md).
| Plan | Notes |
|---|---|
| [Work](work.md) | [Hub](area.md) |

~~~md
${hubIndex(hubPointer('area.md'))}
~~~
<!--
${hubIndex(hubPointer('area.md'))}
-->
${hubIndex('| `[fake](area.md)` | example |')}`);
    strictEqual(r.index().filingCoverage.totals.noCategory, 1);
    // A genuine index subject is admitted after the excluded references.
    r.hub('index.md', `### Delivery\n${hubIndex('| [`area.md`](area.md) | |')}`);
    deepStrictEqual(get(r.index().filingCoverage, 'work.md').rows[0].categories, ['Delivery']);
  });

  it('files a child and grandchild through a rowed parent and says where', async () => {
    const r = await repo();
    r.write('parent.md'); r.write('child.md', '', 'parent_plan: parent.md');
    r.write('grandchild.md', '', 'parent_plan: child.md');
    r.hub('area.md', `### Delivery\n${rowTable(home('parent.md'))}`);
    const index = r.index();
    for (const name of ['child.md', 'grandchild.md']) {
      const item = get(index.filingCoverage, name);
      strictEqual(item.filing, 'parent'); strictEqual(item.filedThrough, 'docs/parent.md');
      deepStrictEqual(item.rows[0].categories, ['Delivery']);
    }
    strictEqual(index.filingCoverage.totals.filedThroughParent, 2);
    match(renderCoverage(index, r.config), /grandchild.md: parent through parent docs\/parent.md/);
  });

  it('lets a child with its own row use that home without counting its parent again', async () => {
    const r = await repo();
    r.write('parent.md'); r.write('child.md', '', 'parent_plan: parent.md');
    r.hub('area.md', `### Delivery\n${rowTable(home('parent.md') + '\n' + home('child.md'))}`);
    const report = r.index().filingCoverage;
    strictEqual(get(report, 'child.md').filing, 'direct');
    strictEqual(report.totals.multiplyFiled, 0);
  });

  it('files ordered-hub children through the hub row in a roadmap', async () => {
    const r = await repo();
    r.hub('root.md', `### Delivery\n${rowTable(home('sequence.md'))}`, 'execution_mode: roadmap');
    r.write('sequence.md', '## Order of operations\n1. [Child](child.md)', 'runlist:\n  - child.md');
    r.write('child.md', '', 'parent_plan: sequence.md');
    const report = r.index().filingCoverage;
    strictEqual(report.totals.plans, 1);
    strictEqual(get(report, 'child.md').filedThrough, 'docs/sequence.md');
    deepStrictEqual(get(report, 'child.md').rows[0].categories, ['Delivery']);
  });

  it('propagates duplicate and uncategorized parent homes to children', async () => {
    const r = await repo();
    r.write('parent.md'); r.write('child.md', '', 'parent_plan: parent.md');
    r.hub('one.md', `### Delivery\n${rowTable(home('parent.md'))}`);
    r.hub('two.md', rowTable(home('parent.md')));
    const index = r.index();
    strictEqual(index.filingCoverage.totals.multiplyFiled, 2);
    strictEqual(index.filingCoverage.totals.noCategory, 2);
    match(findings(index, 'filing-multiple').find(item => item.path.endsWith('/child.md')).message, /through parent `docs\/parent.md`/);
  });

  it('inherits an explicit category through nested roadmap and area hubs', async () => {
    const r = await repo();
    r.hub('root.md', `### Delivery\n${rowTable(home('middle.md'))}`, 'execution_mode: roadmap');
    r.hub('middle.md', rowTable(home('area.md')));
    r.hub('area.md', rowTable(home('work.md')));
    r.write('work.md');
    const report = r.index().filingCoverage;
    deepStrictEqual(get(report, 'work.md').rows[0].categories, ['Delivery']);
    strictEqual(report.totals.noCategory, 0);
  });

  it('retains conflicting inherited categories without choosing one', async () => {
    const r = await repo();
    r.hub('root.md', `### Delivery\n${rowTable(home('area.md'))}\n### Operations\n${rowTable(home('area.md'))}`);
    r.hub('area.md', rowTable(home('work.md'))); r.write('work.md');
    const report = r.index().filingCoverage;
    deepStrictEqual(get(report, 'work.md').rows[0].categories, ['Delivery', 'Operations']);
    strictEqual(report.totals.multiplyFiled, 1);
  });

  it('does not infer a home from related links, cycles, missing or ambiguous parents', async () => {
    const r = await repo();
    r.write('a.md', '', 'parent_plan: b.md'); r.write('b.md', '', 'parent_plan: a.md');
    r.write('missing.md', '', 'parent_plan: gone.md');
    r.write('ambiguous.md', '', 'parent_plan:\n  - a.md\n  - b.md');
    r.hub('area.md', '# No home rows', 'related_plans:\n  - a.md\n  - b.md');
    strictEqual(r.index().filingCoverage.totals.unfiled, 4);
  });
});

describe('repository scope and CLI reports', () => {
  it('is opt-in, supports explicit disable, and validates malformed settings', async () => {
    for (const setting of [null, false, { enabled: false }]) {
      const r = await repo(setting); r.write('work.md');
      strictEqual(r.index().filingCoverage, null);
      strictEqual(buildCoverage(r.index(), r.config).filing, null);
    }
    strictEqual(filingOptions({ enabled: 'yes' }), null);
    const r = await repo({ categoryDepth: 1 });
    ok(r.config.configWarnings.some(message => message.includes('filing.categoryDepth')));
  });

  it('excludes archived/terminal plans and docs with the same status name as terminal plans', async () => {
    const r = await repo(true, `export const types = { plan: { statuses: { active: {}, settled: { terminal: true }, archived: { archive: true, terminal: true } } }, doc: { statuses: { active: {}, settled: {} } } };`);
    r.write('work.md'); r.write('settled.md', '', 'status: settled');
    r.write('archived/old.md');
    r.write('reference.md', '', 'type: doc\nstatus: settled');
    strictEqual(r.index().filingCoverage.totals.plans, 1);
  });

  it('does not treat closed hubs as current homes', async () => {
    const r = await repo(); r.write('work.md');
    r.hub('closed.md', `### Delivery\n${rowTable(home('work.md'))}`, 'status: archived');
    strictEqual(get(r.index().filingCoverage, 'work.md').filing, 'unfiled');
  });

  it('suppresses absence/uniqueness findings when a hub could not be read', async () => {
    const r = await repo(); r.write('work.md'); r.hub('area.md', '');
    const docs = r.index().docs;
    rmSync(path.join(r.directory, 'docs', 'area.md'));
    const report = buildFilingCoverage(docs, r.config);
    strictEqual(report.complete, false);
    deepStrictEqual(filingFindings(report).map(item => item.meta.kind), ['filing-read-failure']);
  });

  it('keeps scoped checks incomplete when an excluded hub disappears after discovery', async () => {
    const r = await repo(true, `import { unlinkSync } from 'node:fs';
export function transformDoc(doc) { if (doc.path === 'docs/area.md') unlinkSync(new URL('./docs/area.md', import.meta.url)); return doc; }`);
    r.write('work.md'); r.hub('area.md', `### Delivery\n${rowTable(home('work.md'))}`);
    const result = spawnSync(process.execPath, [cli, 'check', 'docs/work.md', '--json'], { cwd: r.directory, encoding: 'utf8' });
    strictEqual(result.status, 0, result.stderr);
    const checked = JSON.parse(result.stdout);
    strictEqual(checked.filingCoverage.complete, false);
    strictEqual(checked.passed, null);
    ok(!checked.warnings.some(warning => warning.meta?.kind === 'filing-unfiled'));
  });

  it('exposes the same homes in check and coverage JSON and keeps full evidence for path scopes', async () => {
    const r = await repo(); r.write('parent.md'); r.write('child.md', '', 'parent_plan: parent.md');
    r.hub('root.md', `### Delivery\n${hubIndex(hubPointer('area.md'))}`);
    r.hub('area.md', rowTable(home('parent.md')));
    const run = args => {
      const result = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: r.directory, encoding: 'utf8' });
      strictEqual(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(result.stdout);
    };
    const check = run(['check']); const coverage = run(['coverage']);
    deepStrictEqual(check.filingCoverage, coverage.filing);
    deepStrictEqual(get(coverage.filing, 'parent.md').rows[0].categories, ['Delivery']);
    strictEqual(coverage.filing.totals.noCategory, 0);
    const scoped = run(['check', 'docs/child.md']);
    strictEqual(scoped.filingCoverage.totals.plans, 1);
    strictEqual(scoped.filingCoverage.totals.filedThroughParent, 1);
    strictEqual(scoped.filingCoverage.plans[0].rows[0].hub, 'docs/area.md');
    deepStrictEqual(scoped.filingCoverage.plans[0].rows[0].categories, ['Delivery']);
    const filtered = run(['coverage', '--type', 'plan']);
    strictEqual(filtered.filing.totals.plans, 2);
    strictEqual(run(['coverage', '--type', 'doc']).filing.totals.plans, 0);
    const text = spawnSync(process.execPath, [cli, 'check'], { cwd: r.directory, encoding: 'utf8' });
    match(text.stdout, /plan filing: 0 unfiled; 0 multiply filed; 0 under no category; 1 through parent/);
  });
});
