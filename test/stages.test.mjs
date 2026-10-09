import { describe, it, afterEach } from 'node:test';
import { deepStrictEqual, strictEqual, ok } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveConfig } from '../src/config.mjs';
import { parseDocFile } from '../src/index.mjs';
import { getStageDefinitions, readPlanStage, readShipsFrontmatter, validateStageDefinitions } from '../src/stages.mjs';

const temporary = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function repository(taxonomy) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'runlist-stages-'));
  temporary.push(directory);
  mkdirSync(path.join(directory, '.git'));
  mkdirSync(path.join(directory, 'docs'));
  writeFileSync(path.join(directory, 'runlist.config.mjs'), `export const root = 'docs';\nexport const taxonomy = ${JSON.stringify(taxonomy)};\n`);
  return { directory, config: await resolveConfig(directory) };
}

function parsePlan(repository, name, ships = '', status = 'planned', type = 'plan') {
  const file = path.join(repository.directory, 'docs', name);
  writeFileSync(file, `---\ntype: ${type}\nstatus: ${status}\nupdated: 2026-10-08\n${ships}\n---\n# Stage example\n\n> Summary.\n`);
  return parseDocFile(file, repository.config);
}

describe('repository delivery stage vocabulary', () => {
  it('preserves legacy ordering and supports explanatory rich definitions', async () => {
    const legacy = await repository({ milestones: ['Prototype', 'Launch', 'Later'] });
    deepStrictEqual(getStageDefinitions(legacy.config), [
      { word: 'Prototype', meaning: '' }, { word: 'Launch', meaning: '' }, { word: 'Later', meaning: '' },
    ]);
    const rich = await repository({ milestones: [
      { word: 'Launch', meaning: 'Ready for release' }, 'Later',
    ] });
    deepStrictEqual(getStageDefinitions(rich.config), [
      { word: 'Launch', meaning: 'Ready for release' }, { word: 'Later', meaning: '' },
    ]);
    deepStrictEqual(rich.config.raw.taxonomy.milestones, [{ word: 'Launch', meaning: 'Ready for release' }, 'Later']);
    deepStrictEqual(rich.config.configWarnings, []);
  });

  it('does not invent vocabulary in repositories without stages', async () => {
    const repo = await repository({});
    deepStrictEqual(getStageDefinitions(repo.config), []);
    const doc = parsePlan(repo, 'freeform.md', 'ships: Existing milestone');
    ok(!doc.errors.some(entry => entry.message.includes('ships')));
  });

  it('reports malformed config and duplicate stage words clearly', async () => {
    const repo = await repository({ milestones: [' Launch ', { word: 'Launch', meaning: 'Duplicate' }, {}, { word: 'Later', meaning: 5 }] });
    ok(repo.config.configWarnings.some(message => message.includes("duplicate stage 'Launch'")));
    ok(repo.config.configWarnings.some(message => message.includes('milestones[2]')));
    ok(repo.config.configWarnings.some(message => message.includes('milestones[3].meaning')));
    deepStrictEqual(validateStageDefinitions({ taxonomy: { milestones: {} } }), ['Config: taxonomy.milestones must be null or an array.']);
    deepStrictEqual(validateStageDefinitions({ taxonomy: { milestones: null } }), []);
  });

  it('rejects multiline and NUL words without exposing them as selectable stages', async () => {
    const repo = await repository({ milestones: ['Good', 'Bad\nword', 'Bad\rword', { word: 'Bad\0word', meaning: 'Unsafe' }] });
    strictEqual(repo.config.configWarnings.filter(message => message.includes('single line without NUL')).length, 3);
    deepStrictEqual(getStageDefinitions(repo.config), [{ word: 'Good', meaning: '' }]);
    for (const value of ['Good\nword', 'Good\0word', 'Good\rword']) deepStrictEqual(readPlanStage(value), { word: null, invalid: true });
    deepStrictEqual(readPlanStage('\n\t '), { word: null, invalid: false });
  });
});

describe('plan ships metadata', () => {
  it('keeps unset distinct from Later and refuses coercion', () => {
    for (const value of [undefined, null, '', '  ']) deepStrictEqual(readPlanStage(value), { word: null, invalid: false });
    deepStrictEqual(readPlanStage(' Later '), { word: 'Later', invalid: false });
    for (const value of [[], ['Later'], {}, true, 1]) deepStrictEqual(readPlanStage(value), { word: null, invalid: true });
  });

  it('indexes ships metadata and validates known, unknown, and invalid values', async () => {
    const repo = await repository({ milestones: ['Launch', 'Later'] });
    const known = parsePlan(repo, 'known.md', 'ships: Later');
    strictEqual(known.ships, 'Later');
    ok(!known.errors.some(entry => entry.message.includes('ships')));
    const unknown = parsePlan(repo, 'unknown.md', 'ships: Mystery');
    ok(unknown.errors.some(entry => entry.message.includes('Unknown stage `Mystery`')));
    const invalid = parsePlan(repo, 'invalid.md', 'ships: [Later]');
    deepStrictEqual(invalid.ships, ['Later']);
    ok(invalid.errors.some(entry => entry.message.includes('single stage string')));
    const missing = parsePlan(repo, 'missing.md');
    strictEqual(missing.ships, null);
    ok(!missing.errors.some(entry => entry.message.includes('ships')));
    ok(!missing.warnings.some(entry => entry.message.includes('ships')));
    const blank = parsePlan(repo, 'blank.md', 'ships:');
    strictEqual(blank.ships, null);
    ok(!blank.errors.some(entry => entry.message.includes('ships')));
    const emptyList = parsePlan(repo, 'empty-list.md', 'ships: []');
    deepStrictEqual(emptyList.ships, []);
    ok(emptyList.errors.some(entry => entry.message.includes('single stage string')));
    deepStrictEqual(readShipsFrontmatter('ships:\n  - Launch'), ['Launch']);
    deepStrictEqual(readShipsFrontmatter('ships: []\nships:'), []);
  });

  it('never guesses stage from status, including archived plans', async () => {
    const repo = await repository({ milestones: ['Launch', 'Later'] });
    for (const status of ['planned', 'active', 'partial', 'archived']) {
      const doc = parsePlan(repo, `${status}.md`, '', status);
      deepStrictEqual(readPlanStage(doc.ships), { word: null, invalid: false });
    }
    const archivedUnknown = parsePlan(repo, 'archived-unknown.md', 'ships: Mystery', 'archived');
    ok(archivedUnknown.errors.some(entry => entry.message.includes('Unknown stage')));
  });

  it('keeps stage validation scoped to plans', async () => {
    const repo = await repository({ milestones: ['Launch'] });
    const doc = parsePlan(repo, 'reference.md', 'ships: Other', 'reference', 'doc');
    ok(!doc.errors.some(entry => entry.message.includes('ships')));
  });

  it('refreshes legacy cache entries and preserves malformed metadata through current cache hits', async () => {
    const repo = await repository({ milestones: ['Launch'] });
    parsePlan(repo, 'cached.md', 'ships:');
    const file = path.join(repo.directory, 'docs', 'cached.md');
    let stored;
    const cache = { get: () => stored, set: (_key, _stamp, value) => { stored = structuredClone(value); } };
    strictEqual(parseDocFile(file, repo.config, { cache, fast: true }).ships, null);
    delete stored.shipsMetadataVersion;
    stored.parsedFrontmatter.ships = [];
    strictEqual(parseDocFile(file, repo.config, { cache, fast: true }).ships, null);
    strictEqual(stored.shipsMetadataVersion, 1);
    parsePlan(repo, 'cached.md', 'ships: [Launch]');
    // Force a refresh, then exercise the next fast and validating cache hits.
    stored = null;
    deepStrictEqual(parseDocFile(file, repo.config, { cache, fast: true }).ships, ['Launch']);
    deepStrictEqual(parseDocFile(file, repo.config, { cache, fast: true }).ships, ['Launch']);
    ok(parseDocFile(file, repo.config, { cache }).errors.some(entry => entry.message.includes('single stage string')));
  });
});
