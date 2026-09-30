import { describe, it, afterEach } from 'node:test';
import { strictEqual, deepStrictEqual, match, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { codeCitations, resolveCitation, openWorkLines } from '../src/xref.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
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
}

function run(args) {
  return spawnSync('node', [BIN, ...args], { cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
}

const plan = (title, extra = '', body = '') => `---
type: plan
status: active
updated: 2025-01-01
${extra}---

# ${title}

${body}
`;

// A small repository: a lamp plan citing code, a shelf plan that names it and
// carries a decision the lamp plan disagrees with.
function setup() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-xref-'));
  git('init', '-q');
  write('runlist.config.mjs', "export const root = 'docs/plans';\n");
  write('src/lamp/bulb.ts', 'export const bulb = 1;\n');
  write('src/lamp/switch.ts', 'export const on = true;\n');
  write('src/lamp/wire.ts', 'export const wire = 1;\n');
  write('docs/plans/lamp.md', plan('Lamp', 'related_plans:\n  - ./shelf.md\n', [
    '## Phase 1',
    '',
    '- [ ] Fit a brighter one in `src/lamp/bulb.ts`.',
    '- [ ] Rewire `lamp/switch.ts`.',
    '- [x] Done long ago in `src/lamp/wire.ts`.',
    '- [ ] Add `src/lamp/shade.ts`, not written yet.',
    '',
    '## Decisions',
    '',
    '### D1  Which shade? [shelf.md](shelf.md)',
    '',
    'Disposition: OPEN.',
    '',
    'The shelf plan records it too.',
  ].join('\n')));
  write('docs/plans/shelf.md', plan('Shelf', 'related_plans:\n  - ./lamp.md\n', [
    'Holds the [lamp](lamp.md).',
    '',
    '## Decisions',
    '',
    '### D1  Which shade? [lamp.md](lamp.md)',
    '',
    'Disposition: RULED 2025-02-01: the paper one.',
  ].join('\n')));
  write('docs/plans/desk.md', plan('Desk', '', 'Sits under the [lamp](lamp.md).'));
  commit('start');
  mkdirSync(path.join(tmpDir, 'src/light'), { recursive: true });
  git('mv', 'src/lamp/bulb.ts', 'src/light/bulb.ts');
  git('rm', '-q', 'src/lamp/switch.ts');
  commit('move the bulb, drop the switch');
  write('src/lamp/wire.ts', 'export const wire = 2;\n');
  commit('rewire');
}

describe('codeCitations', () => {
  it('reads repo paths and drops documents, URLs and line suffixes', () => {
    deepStrictEqual([...codeCitations('see `src/a.ts:12`, https://example.com/x.js, [p](other.md) and lib/b/c.py.')].sort(), ['lib/b/c.py', 'src/a.ts']);
  });
});

describe('resolveCitation', () => {
  const repo = {
    tracked: new Map([['a/new.ts', ['a/new.ts']], ['new.ts', ['a/new.ts']]]),
    moved: new Map([['a/old.ts', 'a/new.ts'], ['a/gone.ts', null]]),
    movedSuffix: new Map([['a/old.ts', ['a/old.ts']], ['old.ts', ['a/old.ts']], ['a/gone.ts', ['a/gone.ts']], ['gone.ts', ['a/gone.ts']]]),
  };
  it('classifies live, renamed, removed and unknown', () => {
    strictEqual(resolveCitation('new.ts', repo).state, 'live');
    deepStrictEqual(resolveCitation('old.ts', repo), { state: 'renamed', from: 'a/old.ts', to: 'a/new.ts' });
    strictEqual(resolveCitation('gone.ts', repo).state, 'removed');
    strictEqual(resolveCitation('a/never.ts', repo).state, 'unknown');
  });
});

describe('openWorkLines', () => {
  it('reads unticked items and next_step, not ticked items', () => {
    const lines = openWorkLines('---\nnext_step: edit a/b.ts\n---\n\n- [ ] one\n- [x] two\n');
    deepStrictEqual(lines.map(l => l.text).sort(), ['edit a/b.ts', 'one']);
  });
});

describe('runlist xref', () => {
  it('prints who names the plan, its decisions and its cited code', () => {
    setup();
    const r = run(['xref', 'docs/plans/lamp.md']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /docs\/plans\/shelf\.md {2}\(active, related_plans, body\)\n/);
    match(r.stdout, /docs\/plans\/desk\.md {2}\(active, body\) {2}not named back/);
    match(r.stdout, /D1 {2}open {2}line \d+\n {6}ruled at docs\/plans\/shelf\.md:\d+/);
    match(r.stdout, /src\/lamp\/bulb\.ts {2}renamed to src\/light\/bulb\.ts/);
    match(r.stdout, /lamp\/switch\.ts {2}removed/);
    match(r.stdout, /1 commits since the last commit here touched 1 cited files/);
    match(r.stdout, /src\/lamp\/wire\.ts {2}1/);
  });

  it('--json carries the same card', () => {
    setup();
    const [card] = JSON.parse(run(['xref', 'lamp', '--json']).stdout);
    deepStrictEqual(card.namedBy.map(n => [n.path, n.namedBack]), [['docs/plans/desk.md', false], ['docs/plans/shelf.md', true]]);
    deepStrictEqual(card.code.map(c => [c.cited, c.state]), [
      ['lamp/switch.ts', 'removed'], ['src/lamp/bulb.ts', 'renamed'], ['src/lamp/shade.ts', 'unknown'], ['src/lamp/wire.ts', 'live'],
    ]);
    deepStrictEqual(card.commitsSince.map(c => c.subject), ['rewire']);
  });

  it('--check reports open work naming moved code and a decision that disagrees, and exits 1', () => {
    setup();
    const r = run(['xref', '--check', '--json']);
    strictEqual(r.status, 1);
    const findings = JSON.parse(r.stdout);
    deepStrictEqual(findings.map(f => f.text.replace(/:\d+\.$/, ':N.')), [
      'Open work names src/lamp/bulb.ts, which was renamed to src/light/bulb.ts.',
      'Open work names lamp/switch.ts, which was removed.',
      'D1 is open here and ruled at docs/plans/shelf.md:N.',
    ]);
    ok(findings.every(f => f.file === 'docs/plans/lamp.md'));
  });

  it('--check --flag syncs the findings into the flags list and resolves fixed ones', () => {
    setup();
    run(['xref', '--check', '--flag']);
    const open = () => JSON.parse(run(['flags', '--json']).stdout).filter(f => f.by?.name === 'xref');
    strictEqual(open().length, 3);
    const file = path.join(tmpDir, 'docs/plans/lamp.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('`src/lamp/bulb.ts`', '`src/light/bulb.ts`'));
    run(['xref', '--check', '--flag']);
    strictEqual(open().length, 2);
  });

  it('keeps the history walk in the state directory and reads only new commits after', () => {
    setup();
    run(['xref', 'lamp']);
    const cache = path.join(tmpDir, '.runlist', 'xref-moves.json');
    ok(existsSync(cache));
    git('rm', '-q', 'src/lamp/wire.ts');
    commit('drop the wire');
    const [card] = JSON.parse(run(['xref', 'lamp', '--json']).stdout);
    strictEqual(card.code.find(c => c.cited === 'src/lamp/wire.ts').state, 'removed');
    strictEqual(JSON.parse(readFileSync(cache, 'utf8')).head, git('rev-parse', 'HEAD').trim());
  });
});
