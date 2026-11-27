import { describe, it, afterEach } from 'node:test';
import { deepStrictEqual, strictEqual, ok, match } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { insertQuestion, nextQuestionNumber, questionItem } from '../src/decision.mjs';
import { planQuestions, questionSettings } from '../src/questions.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

function run(args, opts = {}) {
  return spawnSync('node', [BIN, ...args], { cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, ...opts });
}

function setup(config = '') {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-decision-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), `export const root = ['docs/plans', 'docs'];\n${config}`);
}

function plan(name, body) {
  const file = path.join(tmpDir, 'docs', 'plans', `${name}.md`);
  writeFileSync(file, `---\ntype: plan\nstatus: planned\nupdated: 2025-01-01T00:00:00Z\n---\n# ${name}\n\n${body}`);
  return file;
}

function record(text = 'The widget shelf is empty today. It lives in `src/shelf.ts:4`. Yes: the shelf fills. No: it stays empty.') {
  const file = path.join(tmpDir, 'record.md');
  writeFileSync(file, `${text}\n`);
  return `@${file}`;
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('nextQuestionNumber', () => {
  it('follows the highest question number, answered ones included', () => {
    const text = '## Questions\n\n1. **A?** x\n2. **B?** Ruled 2025-01-02: yes.\n7. **C?** y\n';
    strictEqual(nextQuestionNumber(text, null), 8);
  });
  it('follows an ID used at an item start, never a phase item or one named in prose', () => {
    const text = '## Questions\n\n1. AB-Q1 **A?** x\n\n## Work\n\n- [ ] AB-9.2 a box\n- AB-Q5 moved here\nsee AB-Q40 in prose\n';
    strictEqual(nextQuestionNumber(text, 'AB'), 6);
  });
  it('starts at 1', () => {
    strictEqual(nextQuestionNumber('## Problem\n\nText.\n', 'AB'), 1);
  });
});

describe('questionItem', () => {
  it('writes the ID and bold title first and indents the record under the marker', () => {
    const item = questionItem({ number: 12, id: 'AB-Q12', title: 'Which way?', record: 'The situation.\n\n1. a list line\n# not a heading' });
    deepStrictEqual(item, ['12. AB-Q12 **Which way?** The situation.', '', '    1. a list line', '    # not a heading']);
  });
});

describe('insertQuestion', () => {
  const item = ['3. AB-Q3 **Which way?** Record.'];

  it('appends after the last line of the Questions section, before a closing rule', () => {
    const text = '---\ntype: plan\n---\n## Questions\n\n<!-- how to write one -->\n\n1. **A?** x\n\n---\n\n## Phase 1\n';
    strictEqual(insertQuestion(text, item).markdown, '---\ntype: plan\n---\n## Questions\n\n<!-- how to write one -->\n\n1. **A?** x\n\n3. AB-Q3 **Which way?** Record.\n\n---\n\n## Phase 1\n');
  });

  it('adds a Questions section before Version History, leaving Decisions alone', () => {
    const text = '## Decisions\n\n### D1  Old?\n\nDisposition: OPEN.\n\n## Version History\n\n- x\n';
    const out = insertQuestion(text, item);
    strictEqual(out.markdown, '## Decisions\n\n### D1  Old?\n\nDisposition: OPEN.\n\n## Questions\n\n3. AB-Q3 **Which way?** Record.\n\n## Version History\n\n- x\n');
    match(out.placement, /new `## Questions` before `Version History`/);
  });

  it('writes under the top-level Questions heading, never one nested in a workstream', () => {
    const text = '## Work\n\n### Open questions\n\n1. **A?** x\n\n## Questions\n\n2. **B?** y\n';
    const out = insertQuestion(text, item).markdown;
    strictEqual(out, '## Work\n\n### Open questions\n\n1. **A?** x\n\n## Questions\n\n2. **B?** y\n\n3. AB-Q3 **Which way?** Record.\n');
  });

  it('adds a top-level Questions section beside nested ones, which are still read', () => {
    const text = '---\ntype: plan\n---\n## Work\n\n### Open questions\n\n1. **A?** x\n';
    const out = insertQuestion(text, item).markdown;
    match(out, /### Open questions\n\n1\. \*\*A\?\*\* x\n\n## Questions\n\n3\. AB-Q3/);
    deepStrictEqual(planQuestions(out).map(q => q.number), [1, 3]);
  });

  it('writes under the fallback heading of a plan read through it, so its questions stay read', () => {
    const settings = questionSettings({ fallbackHeading: '^#{2,4}\\s+Waiting on you\\b' });
    const text = '---\ntype: plan\n---\n## Waiting on you\n\n1. **A?** x\n\n## Phase 1\n';
    const out = insertQuestion(text, item, settings).markdown;
    strictEqual(out, '---\ntype: plan\n---\n## Waiting on you\n\n1. **A?** x\n\n3. AB-Q3 **Which way?** Record.\n\n## Phase 1\n');
    deepStrictEqual(planQuestions(out, settings).map(q => q.number), [1, 3]);
  });

  it('adds the section at the end when there is nowhere better, and ignores a heading inside a fence', () => {
    const out = insertQuestion('## Problem\n\n```\n## Questions\n```\n', item);
    strictEqual(out.markdown, '## Problem\n\n```\n## Questions\n```\n\n## Questions\n\n3. AB-Q3 **Which way?** Record.\n');
  });
});

describe('runlist new decision', () => {
  it('writes a question with the plan\'s new code, leaves the D records alone and bumps updated', () => {
    setup();
    const file = plan('widgets', '## Decisions\n\n### D1  First? RULED 2025-01-02.\n\nDone.\n');
    const r = run(['new', 'decision', 'widgets', '--question', 'Does the shelf fill', record()]);
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /Added WIDG-Q1 to docs\/plans\/widgets\.md/);
    match(r.stdout, /runlist question raise widgets 1/);
    const text = readFileSync(file, 'utf8');
    match(text, /^question_code: WIDG$/m);
    match(text, /## Decisions\n\n### D1  First\? RULED 2025-01-02\.\n\nDone\.\n\n## Questions\n\n1\. WIDG-Q1 \*\*Does the shelf fill\?\*\* The widget shelf is empty today\./);
    ok(!/### D2|Disposition: OPEN/.test(text));
    ok(!text.includes('updated: 2025-01-01T00:00:00Z'));
    const rows = JSON.parse(run(['questions', 'widgets', '--json']).stdout);
    deepStrictEqual(rows.map(q => [q.id, q.title, q.answered]), [['WIDG-Q1', 'Does the shelf fill?', false]]);
    const decisions = run(['decisions', 'docs/plans/widgets.md', '--all', '--json']);
    strictEqual(decisions.status, 0, decisions.stderr);
    match(decisions.stdout, /"D1"/);
  });

  it('numbers after every question the plan has, under its existing heading, with --answers at the record\'s end', () => {
    setup();
    const file = path.join(tmpDir, 'docs', 'plans', 'widgets.md');
    writeFileSync(file, '---\ntype: plan\nstatus: active\nquestion_code: WG\n---\n# widgets\n\n## Questions\n\n1. WG-Q1 **Old?** Ruled 2025-01-02: yes.\n2. WG-Q4 **Open one?** Still open.\n\n## Phase 1\n\n- [ ] Task\n');
    const r = run(['new', 'decision', 'widgets', '--question', 'Which bin?', '--answers', 'Blue: it fits. Red: it does not.', record('The bin is unset in `src/bin.ts:3`.')]);
    strictEqual(r.status, 0, r.stderr);
    const text = readFileSync(file, 'utf8');
    match(text, /2\. WG-Q4 \*\*Open one\?\*\* Still open\.\n\n5\. WG-Q5 \*\*Which bin\?\*\* The bin is unset in `src\/bin\.ts:3`\. Blue: it fits\. Red: it does not\.\n\n## Phase 1/);
    deepStrictEqual(planQuestions(text).map(q => [q.number, q.answered]), [[1, true], [4, false], [5, false]]);
  });

  it('writes no register row when the config names a register', () => {
    setup(`export const decisions = { register: { file: 'docs/plans/arc.md', statusLine: 'waiting on you:' } };`);
    const arcFile = plan('arc', 'Register.\n\n```\nOpen, waiting on you:\n\nD7 RULED 2025-01-02: done.\n```\n');
    const before = readFileSync(arcFile, 'utf8');
    plan('widgets', '');
    const r = run(['new', 'decision', 'widgets', '--question', 'Q?', record()]);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(readFileSync(arcFile, 'utf8'), before);
  });

  it('refuses --disposition held, a question that would read as answered, and a missing question or record, writing nothing', () => {
    setup();
    const file = plan('widgets', '## Questions\n');
    const before = readFileSync(file, 'utf8');
    const held = run(['new', 'decision', 'widgets', '--question', 'Q?', '--disposition', 'held', record()]);
    ok(held.status !== 0);
    match(held.stderr, /--disposition is no longer taken/);
    const answered = run(['new', 'decision', 'widgets', '--question', 'Closed or open?', record()]);
    ok(answered.status !== 0);
    match(answered.stderr, /would read as answered/);
    const noQuestion = run(['new', 'decision', 'widgets', record()]);
    ok(noQuestion.status !== 0);
    match(noQuestion.stderr, /--question is required/);
    const noRecord = run(['new', 'decision', 'widgets', '--question', 'Q?'], { input: '' });
    ok(noRecord.status !== 0);
    match(noRecord.stderr, /needs its record/);
    strictEqual(readFileSync(file, 'utf8'), before);
  });

  it('dry-run names the ID, the place and the new code, and writes nothing', () => {
    setup();
    const file = plan('widgets', '## Questions\n');
    const before = readFileSync(file, 'utf8');
    const r = run(['new', 'decision', 'widgets', '--question', 'Q?', record(), '-n']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /Would add WIDG-Q1 to docs\/plans\/widgets\.md under `Questions`, giving the plan the code WIDG/);
    strictEqual(readFileSync(file, 'utf8'), before);
  });

  it('refuses a plan that does not exist', () => {
    setup();
    const r = run(['new', 'decision', 'nope', '--question', 'Q?', record()]);
    ok(r.status !== 0);
    match(r.stderr, /No such plan: nope/);
  });
});

describe('runlist new hub and unknown types', () => {
  it('`new hub` makes a coordination hub plan', () => {
    setup();
    const r = run(['new', 'hub', 'platform']);
    strictEqual(r.status, 0, r.stderr);
    const text = readFileSync(path.join(tmpDir, 'docs', 'plans', 'platform.md'), 'utf8');
    match(text, /type: plan/);
    match(text, /execution_mode: coordination/);
  });

  it('`new hub --roadmap` makes a roadmap hub', () => {
    setup();
    strictEqual(run(['new', 'hub', 'q3', '--roadmap']).status, 0);
    match(readFileSync(path.join(tmpDir, 'docs', 'plans', 'q3.md'), 'utf8'), /execution_mode: roadmap/);
  });

  it('refuses an unknown type followed by a slug, and creates nothing', () => {
    setup();
    const r = run(['new', 'decison', 'foo']);
    ok(r.status !== 0);
    match(r.stderr, /Unknown type `decison`/);
    match(r.stderr, /runlist new doc decison "foo"/);
    ok(!readdirSync(path.join(tmpDir, 'docs')).includes('decison.md'));
  });

  it('still takes a name and a multi-word inline body with the type left out', () => {
    setup();
    const r = run(['new', 'notes', 'some inline body']);
    strictEqual(r.status, 0, r.stderr);
    ok(existsSync(path.join(tmpDir, 'docs', 'plans', 'notes.md')) || existsSync(path.join(tmpDir, 'docs', 'notes.md')));
  });
});
