import { describe, it, afterEach } from 'node:test';
import { strictEqual, deepStrictEqual, match, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'runlist.mjs');
let tmpDir;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

function git(...args) {
  const r = spawnSync('git', args, { cwd: tmpDir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

function write(rel, text) {
  mkdirSync(path.dirname(path.join(tmpDir, rel)), { recursive: true });
  writeFileSync(path.join(tmpDir, rel), text);
}

function commit(message) {
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
  return git('rev-parse', '--short', 'HEAD').trim();
}

function run(args) {
  return spawnSync('node', [BIN, ...args], { cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
}

const json = args => {
  const r = run([...args, '--json']);
  strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

const plan = (title, extra = '', body = '') => `---
type: plan
status: active
updated: 2025-01-01
${extra}---

# ${title}

${body}
`;

// A lamp plan with a records folder the index excludes, a shelf plan that
// says the lamp plan supersedes it, an archived bulb plan it replaces, and a
// record of the lamp plan kept in another plan's folder.
function setup() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-history-'));
  git('init', '-q');
  write('runlist.config.mjs', "export const root = 'docs/plans';\nexport const excludeDirs = ['assets'];\n");
  write('docs/plans/lamp.md', plan('Lamp', '', [
    'Replaces the [bulb plan](archived/bulb.md).',
    '',
    '## Phase 1',
    '',
    'The brass fitting holds a warm bulb.',
    '',
    '## Decisions',
    '',
    '### D1  Which shade?',
    '',
    'Disposition: OPEN.',
    '',
    '### D2  Which cord?',
    '',
    'Disposition: RULED 2025-02-01: the cloth one.',
  ].join('\n')));
  write('docs/plans/shelf.md', plan('Shelf', '', 'Superseded by [the lamp](lamp.md).'));
  write('docs/plans/archived/bulb.md', plan('Bulb').replace('status: active', 'status: archived'));
  commit('lamp plan');
}

describe('runlist history <plan>', () => {
  it('lists records, before and after, inbound links, commits and decisions', () => {
    setup();
    write('docs/plans/assets/lamp/fittings.md', '# Fittings\n\nRecord of [Lamp](../../lamp.md).\n');
    write('docs/plans/assets/lamp/photo.png', 'png');
    write('docs/plans/assets/shelf/lamp-notes.md', '# Notes\n\nMoved verbatim from [lamp.md](../../lamp.md).\n');
    write('docs/plans/assets/shelf/unrelated.md', '# Unrelated\n\nSee [shelf](../../shelf.md); the [lamp](../../lamp.md) too.\n'.replace('# Unrelated\n\n', '# Unrelated\n\n\n\n\n\n\n\n\n'));
    const hash = commit('lamp records');

    const card = json(['history', 'docs/plans/lamp.md']);
    deepStrictEqual(card.records.folders, ['docs/plans/assets/lamp']);
    deepStrictEqual(card.records.markdown.map(r => [r.path, r.where, r.namesPlanInHeader]), [
      ['docs/plans/assets/lamp/fittings.md', 'folder', true],
      ['docs/plans/assets/shelf/lamp-notes.md', 'header', true],
    ]);
    deepStrictEqual(card.records.otherFiles, { png: 1 });
    const lineage = Object.fromEntries(card.lineage.map(l => [l.path, l.relation]));
    deepStrictEqual(lineage, { 'docs/plans/archived/bulb.md': 'before', 'docs/plans/shelf.md': 'before' });
    deepStrictEqual(card.linkedFrom.map(n => n.path), ['docs/plans/shelf.md']);
    strictEqual(card.commits.total, 2);
    strictEqual(card.commits.shown[0].hash, hash);
    deepStrictEqual(card.decisions.items.map(d => [d.id, d.disposition]), [['D1', 'open'], ['D2', 'ruled']]);

    const text = run(['history', 'lamp']).stdout;
    match(text, /Records \(2\)/);
    match(text, /before {2}docs\/plans\/archived\/bulb\.md/);
    match(text, /Decisions \(2: 1 open, 1 ruled\)/);
    match(text, /D1 {2}open/);
    ok(!/D2 {2}ruled/.test(text), 'ruled decisions are listed only with --all');
  });

  it('reads an archived plan\'s decisions alone and finds its records beside the archive', () => {
    setup();
    write('docs/plans/archived/bulb.md', plan('Bulb', '', '## Decisions\n\n### B1  Warm or cool?\n\nDisposition: RULED 2025-01-02: warm.\n').replace('status: active', 'status: archived'));
    write('docs/plans/assets/bulb/test.md', '# Test\n\nRecord of [Bulb](../../archived/bulb.md).\n');
    commit('bulb records');
    const card = json(['history', 'docs/plans/archived/bulb.md']);
    deepStrictEqual(card.records.markdown.map(r => r.path), ['docs/plans/assets/bulb/test.md']);
    match(card.decisions.readFrom, /alone/);
    deepStrictEqual(card.decisions.items.map(d => d.id), ['B1']);
    deepStrictEqual(card.lineage.map(l => [l.path, l.relation]), [['docs/plans/lamp.md', 'after']]);
  });
});

describe('runlist history --find', () => {
  it('follows text moved from a plan into a record back to the commit that wrote it', () => {
    setup();
    const first = git('rev-parse', '--short', 'HEAD').trim();
    write('docs/plans/lamp.md', readFileSync(path.join(tmpDir, 'docs/plans/lamp.md'), 'utf8').replace('The brass fitting holds a warm bulb.', 'Moved to [fittings](assets/lamp/fittings.md).'));
    write('docs/plans/assets/lamp/fittings.md', '# Fittings\n\nMoved verbatim from [lamp.md](../../lamp.md).\n\nThe brass fitting holds a warm bulb.\n');
    commit('move the fitting into a record');

    const r = json(['history', '--find', 'brass fitting holds']);
    deepStrictEqual(r.files.map(f => [f.path, f.line, f.kind, f.plan?.plan]), [['docs/plans/assets/lamp/fittings.md', 5, 'record', 'docs/plans/lamp.md']]);
    strictEqual(r.firstWritten.hash, first);
    deepStrictEqual(r.firstWritten.files, ['docs/plans/lamp.md']);
    strictEqual(r.cameFrom.plan, 'docs/plans/lamp.md');
    strictEqual(r.pickaxe.total, 2, 'the write and the move');

    const text = run(['history', '--find', 'brass fitting holds']).stdout;
    match(text, new RegExp(`First written: ${first} `));
    match(text, /Came from: docs\/plans\/lamp\.md/);
  });

  it('names commit messages and skips git log -S when no file holds the text', () => {
    setup();
    write('docs/plans/shelf.md', plan('Shelf'));
    commit('the oak shelf goes');
    const r = json(['history', '--find', 'oak shelf']);
    deepStrictEqual(r.files, []);
    strictEqual(r.pickaxe.ran, false);
    match(r.pickaxe.reason, /no file/);
    deepStrictEqual(r.messages.map(m => m.subject), ['the oak shelf goes']);
  });

  it('skips git log -S when the text is in too many files', () => {
    setup();
    for (let i = 0; i < 26; i++) write(`docs/plans/note-${i}.md`, plan(`Note ${i}`, '', 'a common phrase'));
    commit('notes');
    const r = json(['history', '--find', 'a common phrase']);
    strictEqual(r.files.length, 26);
    strictEqual(r.pickaxe.ran, false);
    match(r.pickaxe.reason, /26 files/);
  });

  it('leaves what other commands skip unchanged', () => {
    setup();
    write('docs/plans/assets/lamp/fittings.md', '---\ntype: plan\nstatus: active\n---\n# Fittings\n');
    commit('record');
    json(['history', '--find', 'Fittings']);
    const listed = json(['list']);
    const paths = JSON.stringify(listed);
    ok(!paths.includes('assets/lamp/fittings.md'), 'list still skips the excluded records folder');
  });
});
