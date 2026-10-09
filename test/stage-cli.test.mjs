import { afterEach, describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { filterDocs, groupDocsByStage, parseQueryArgs } from '../src/query.mjs';
import { commandCompletionWords, validateCommandArgs } from '../src/commands.mjs';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'runlist.mjs');
let repo;
afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); repo = null; });
const config = { taxonomy: { milestones: [{ word: 'beta', meaning: 'Ready for invited users.' }, 'launch', 'later'] } };
const docs = [
  { path: 'unknown.md', title: 'Unknown', ships: 'future', status: 'active' },
  { path: 'later.md', title: 'Later', ships: 'later', status: 'planned' },
  { path: 'missing.md', title: 'Missing', status: 'active' },
  { path: 'beta.md', title: 'Beta', ships: ' beta ', status: 'blocked' },
  { path: 'invalid.md', title: 'Invalid', ships: ['later'], status: 'active' },
  { path: 'blank.md', title: 'Blank', ships: ' ', status: 'planned' },
];
function run(args) {
  return spawnSync(process.execPath, [bin, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
}
function corpus() {
  repo = mkdtempSync(path.join(os.tmpdir(), 'runlist-stage-cli-'));
  mkdirSync(path.join(repo, '.git'));
  mkdirSync(path.join(repo, 'docs', 'plans'), { recursive: true });
  writeFileSync(path.join(repo, 'runlist.config.mjs'), `export const root = 'docs';\nexport const taxonomy = ${JSON.stringify(config.taxonomy)};\n`);
  for (let i = 0; i < 12; i++) {
    const ships = i < 9 ? 'ships: beta\n' : i === 9 ? 'ships: later\n' : i === 10 ? 'ships: future\n' : '';
    writeFileSync(path.join(repo, 'docs', 'plans', `plan-${i}.md`), `---\ntype: plan\nstatus: active\nupdated: 2026-10-08\n${ships}---\n# Plan ${i}\n`);
  }
}

describe('CLI stages', () => {
  it('owns both group spellings and requires flag values', () => {
    deepStrictEqual(validateCommandArgs('plans', ['--stage', 'beta', '--group-by', 'stage']), ['--stage', 'beta', '--group-by', 'stage']);
    for (const flag of ['--stage', '--group', '--group-by']) {
      ok(commandCompletionWords('plans').includes(flag));
      throws(() => validateCommandArgs('plans', [flag]), /Missing value/);
    }
    const parsed = parseQueryArgs(['--stage', 'beta', '--group-by', 'stage']);
    strictEqual(parsed.stage, 'beta');
    strictEqual(parsed.group, 'stage');
    deepStrictEqual(parsed.positionalTerms, []);
  });

  it('filters stage independently of status and distinguishes unset, later, and malformed metadata', () => {
    deepStrictEqual(filterDocs(docs, parseQueryArgs(['--stage', 'beta']), config).map(d => d.path), ['beta.md']);
    deepStrictEqual(filterDocs(docs, parseQueryArgs(['--stage', 'later']), config).map(d => d.path), ['later.md']);
    deepStrictEqual(filterDocs(docs, parseQueryArgs(['--stage', '@unset']), config).map(d => d.path), ['blank.md', 'missing.md']);
    strictEqual(filterDocs(docs, parseQueryArgs(['--stage', 'beta', '--status', 'active']), config).length, 0);
    strictEqual(filterDocs(docs, parseQueryArgs(['--stage', 'future']), config).length, 1);
  });

  it('preserves literal unset, @unset, and word: prefixes with an explicit escape', () => {
    const withLiteral = [...docs, { path: 'literal.md', title: 'Literal', ships: 'unset' },
      { path: 'sentinel.md', title: 'Sentinel', ships: '@unset' },
      { path: 'prefix.md', title: 'Prefix', ships: 'word:beta' }];
    const literalConfig = { taxonomy: { milestones: ['unset', '@unset', 'word:beta'] } };
    deepStrictEqual(filterDocs(withLiteral, parseQueryArgs(['--stage', 'unset']), literalConfig).map(d => d.path), ['literal.md']);
    deepStrictEqual(filterDocs(withLiteral, parseQueryArgs(['--stage', '@unset']), literalConfig).map(d => d.path), ['blank.md', 'missing.md']);
    deepStrictEqual(filterDocs(docs, parseQueryArgs(['--stage', 'unset']), config).map(d => d.path), ['blank.md', 'missing.md']);
    deepStrictEqual(filterDocs(withLiteral, parseQueryArgs(['--stage', 'word:unset']), literalConfig).map(d => d.path), ['literal.md']);
    deepStrictEqual(filterDocs(withLiteral, parseQueryArgs(['--stage', 'word:@unset']), literalConfig).map(d => d.path), ['sentinel.md']);
    deepStrictEqual(filterDocs(withLiteral, parseQueryArgs(['--stage', 'word:word:beta']), literalConfig).map(d => d.path), ['prefix.md']);
  });

  it('orders groups by the repository vocabulary, retains unknown/unset/invalid plans, and shows meanings', () => {
    const groups = groupDocsByStage(docs, config);
    deepStrictEqual(groups.map(g => g.label), ['beta', 'later', 'future', 'Unset', 'Invalid']);
    strictEqual(groups[0].meaning, 'Ready for invited users.');
    strictEqual(groups.at(-1).invalid, true);
    deepStrictEqual(groups.flatMap(g => g.docs.map(d => d.path)).sort(), docs.map(d => d.path).sort());
  });

  it('stage grouping includes all plans by default in text and JSON; ordinary plans keep their cap', () => {
    corpus();
    const normal = run(['plans', '--json']);
    strictEqual(normal.status, 0, normal.stderr);
    strictEqual(JSON.parse(normal.stdout).count, 10);
    const grouped = run(['plans', '--group-by', 'stage', '--json']);
    strictEqual(grouped.status, 0, grouped.stderr);
    const json = JSON.parse(grouped.stdout);
    strictEqual(json.count, 12);
    deepStrictEqual(json.groups.map(g => g.label), ['beta', 'later', 'future', 'Unset']);
    strictEqual(json.groups.flatMap(g => g.docs).length, 12);
    const text = run(['plans', '--group', 'stage']);
    strictEqual(text.status, 0, text.stderr);
    ok(text.stdout.includes('Ready for invited users.'));
    ok(text.stdout.includes('Unset (1)'));
    ok(text.stdout.includes('later (1)'));
    ok(!text.stdout.includes('more plans'));
  });

  it('grep skips stage and grouping option values when finding its search term', () => {
    corpus();
    const result = run(['grep', '--stage', 'beta', '--group-by', 'stage', 'Plan', '--json']);
    strictEqual(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    strictEqual(json.filters.keyword, 'Plan');
    strictEqual(json.count, 9);
    deepStrictEqual(json.groups.map(group => group.word), ['beta']);
  });

  it('reports non-failing check coverage for plan stages in JSON', () => {
    corpus();
    const first = run(['check', '--json']);
    const baseline = JSON.parse(first.stdout);
    deepStrictEqual(baseline.stageCoverage, { set: 11, unset: 1, invalid: 0 });
    writeFileSync(path.join(repo, 'docs', 'plans', 'unset.md'), '---\ntype: plan\nstatus: active\nupdated: 2026-10-08\n---\n# Unset\n');
    const missing = run(['check', '--json']);
    const withMissing = JSON.parse(missing.stdout);
    deepStrictEqual(withMissing.stageCoverage, { set: 11, unset: 2, invalid: 0 });
    strictEqual(missing.status, first.status);
    strictEqual(withMissing.errorCount, baseline.errorCount);
    writeFileSync(path.join(repo, 'docs', 'plans', 'invalid.md'), '---\ntype: plan\nstatus: active\nupdated: 2026-10-08\nships: [beta]\n---\n# Invalid\n');
    const second = run(['check', '--json']);
    const withInvalid = JSON.parse(second.stdout);
    deepStrictEqual(withInvalid.stageCoverage, { set: 11, unset: 2, invalid: 1 });
    strictEqual(second.status, first.status);
    ok(withInvalid.errors.some(error => error.path?.endsWith('invalid.md') && error.message.includes('ships')));
  });

  it('honors an explicit group limit and reports truncation; unknown grouping is an error', () => {
    corpus();
    const limited = run(['plans', '--group-by', 'stage', '--limit', '2']);
    strictEqual(limited.status, 0, limited.stderr);
    ok(limited.stdout.includes('10 more plans'), limited.stdout);
    const unknown = run(['plans', '--group-by', 'stages']);
    strictEqual(unknown.status, 1);
    ok(unknown.stderr.includes('Unknown group'), unknown.stderr);
  });
});
