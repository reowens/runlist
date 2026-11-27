import { describe, it, beforeEach, afterEach } from 'node:test';
import { deepStrictEqual, ok, strictEqual, match } from 'node:assert';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  codeCandidates, codeFor, inQuestionScope, labelsWith, namesQuestion, numberClash, openBoxes, openQuestionRows, ownPrefix, parseQuestionId,
  planCode, planQuestions, questionId, questionReach, questionSettings, withIdOnLine,
} from '../src/questions.mjs';
import { SESSION_ID_VARIABLES } from '../src/util.mjs';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'runlist.mjs');
const shape = qs => qs.map(q => [q.number, q.title, q.answered]);

describe('planQuestions', () => {
  const PLAN = `---
type: plan
---
# A plan

## Work

### Questions

1. **Which door opens first?** Level 1 asks for a code.
2. **Who stops a worker?** Ruled 2026-01-01: the lead.
3. ~~Is the old vendor in scope?~~ **RULED 2026-01-02** — it moves.

4. **What a removed phone keeps.** A confirmation still counts.

## Next
5. **Not a question.** Under another heading.
`;

  it('reads the numbered items under each Questions heading, with file line numbers', () => {
    deepStrictEqual(planQuestions(PLAN).map(q => [q.number, q.line, q.title, q.answered]), [
      [1, 10, 'Which door opens first?', false],
      [2, 11, 'Who stops a worker?', true],
      [3, 12, 'Is the old vendor in scope?', true],
      [4, 14, 'What a removed phone keeps.', false],
    ]);
  });

  it('reads `Open Questions` and numbered headings, and a Questions heading inside another once', () => {
    const text = '## 8. Open questions\n\n1. **One?**\n\n### Questions\n\n2. **Two?**\n\n## After\n3. **Three?**\n';
    deepStrictEqual(planQuestions(text).map(q => q.number), [1, 2]);
  });

  it('reads `- **Qn. Title**` bullets', () => {
    const text = [
      '## Open Questions', '',
      '- **Q2, RULED 2026-01-03 (answering Q2): keep writing.** The other answer was no.',
      '- **Q3. A full hash in the copy.** A: keep it. B: let it through.',
      '- **Q9, withdrawn: the stopgap is not needed.**',
      '', '## Constraints', '- **Q12. Not a question.**',
    ].join('\n');
    deepStrictEqual(shape(planQuestions(text)), [
      [2, 'RULED 2026-01-03 (answering Q2): keep writing.', true],
      [3, 'A full hash in the copy.', false],
      [9, 'withdrawn: the stopgap is not needed.', false],
    ]);
  });

  it('reads plain `- Qn: ...` bullets, struck through once answered', () => {
    const text = [
      '## Open Questions', '',
      '- A note: not a numbered question.',
      '- Q9, for Phase 2b: whether an ask also shows in the list. Shown: it does.',
      '- Q1: whether the index holds history (Phase 4). Yes adds search.',
      '- ~~Q2: Is validation needed in production?~~ **Resolved 2026-01-04:** no.',
      "- Q3's receipts are in the assets folder.",
    ].join('\n');
    deepStrictEqual(shape(planQuestions(text)), [
      [9, 'for Phase 2b: whether an ask also shows in the list.', false],
      [1, 'whether the index holds history (Phase 4).', false],
      [2, 'Is validation needed in production?', true],
    ]);
  });

  it('reads table rows with a `Qn. Title` cell', () => {
    const text = `## Open questions

| Blocks | Question | Lane |
|---|---|---|
| 2 | Q1. Answered for own uploads. Are shared uploads unmarked? | [lane 6](a.md) |
| 2 | Q2. Does a fingerprint still matter? | lane 3 |
| 4 | ~~Q3. A tab, or inside the menu?~~ | lane 4 |
| 4 | Q4. Ruled 2026-01-05: the tree hash. | lane 3 |
`;
    deepStrictEqual(shape(planQuestions(text)), [
      [1, 'Answered for own uploads. Are shared uploads unmarked?', false],
      [2, 'Does a fingerprint still matter?', false],
      [3, 'A tab, or inside the menu?', true],
      [4, 'Ruled 2026-01-05: the tree hash.', true],
    ]);
  });

  it('reads lower-case ruling words only with a date, a colon or "by", and never after "not"', () => {
    const text = '## Questions\n\n1. **ruled 2026-01-06: a home sets Away by itself.**\n2. **T08, ruled:** yes.\n3. **Strictness, answered by data.**\n4. **Is the gate ruled out for vendors?** Open.\n5. **Put 2026-01-07, not answered: it depends.**\n';
    deepStrictEqual(planQuestions(text).map(q => [q.number, q.answered]), [[1, true], [2, true], [3, true], [4, false], [5, false]]);
  });

  it('takes its ruling words and fallback heading from settings', () => {
    const settings = questionSettings({ fallbackHeading: '^#{2,4}\\s+Waiting on the owner\\b', answered: ['\\bAgreed(?=:|\\s+\\d{4})', '~~'] });
    const text = '# A plan\n\n### Waiting on the owner for Phase 7\n\n1. Backups: here or there.\n2. **Keep it?** Agreed 2026-01-08: yes.\n3. **Drop it?** Ruled: no.\n\n## Other\n4. Not a question.\n';
    deepStrictEqual(planQuestions(text, settings).map(q => [q.number, q.answered]), [[1, false], [2, true], [3, false]]);
    deepStrictEqual(planQuestions(text), [], 'no fallback heading by default');
    deepStrictEqual(planQuestions(`${text}\n## Questions\n\n7. **The real list.**\n`, settings).map(q => q.number), [7]);
  });

  it("takes the number from the plan's own ID on the line, in either form, and never from a phase item", () => {
    const text = '---\nquestion_code: WXY\n---\n## Questions\n\n1. WXY-4 **Old form.**\n2. WXY-Q7 **New form.**\n3. USB-3 **Another code is text.**\n4. WXY-1.2 **A phase item is not an ID.**\n| 5 | WXY-Q9 Q2. A row. |\n';
    deepStrictEqual(planQuestions(text).map(q => [q.number, q.title]), [
      [4, 'Old form.'], [7, 'New form.'], [3, 'USB-3 **Another code is text.**'], [4, 'WXY-1.2 **A phase item is not an ID.**'], [9, 'A row.'],
    ]);
  });
});

describe('question IDs and codes', () => {
  it('reads the code from frontmatter only', () => {
    strictEqual(planCode('---\ntype: plan\nquestion_code: "AB2"\n---\n'), 'AB2');
    strictEqual(planCode('# no frontmatter\nquestion_code: AB\n'), null);
    strictEqual(planCode('---\nquestion_code: abc\n---\n'), null);
  });

  it('writes the new form and reads every form back', () => {
    strictEqual(questionId('WXY', 3), 'WXY-Q3');
    strictEqual(questionId(null, 3, 'some-plan'), 'some-plan Q3');
    for (const typed of ['WXY-Q3', 'wxy q3', 'WXY-3', 'wxy 3', 'wxy:3', 'WXYQ3']) {
      ok(parseQuestionId(typed).some(k => k.key === 'WXY' && k.number === 3), typed);
    }
    deepStrictEqual(parseQuestionId('AB22').map(k => [k.key, k.number]), [['AB', 22], ['AB2', 2]]);
    ok(parseQuestionId('some-plan Q3').some(k => k.key === 'some-plan' && k.number === 3));
    deepStrictEqual(parseQuestionId('not an id'), []);
  });

  it('counts the boxes and next_step that name a question, never by a dotted phase item', () => {
    const text = '---\nquestion_code: WXY\nnext_step: wait for WXY-Q2,\n  then build\n---\n- [ ] Build once WXY-2 is answered\n- [ ] Build once WXY-Q2 is answered\n- [ ] WXY-2.3 Build the part\n- [ ] WXY-1 to WXY-4 hold this\n- [x] WXY-2 done\n- [ ] Q2 waits\n';
    deepStrictEqual(questionReach(text, 2, 'WXY'), { nextStep: true, boxes: 4 });
    ok(!namesQuestion('- [ ] WXY-2.3 Build', 2, 'WXY'));
    ok(namesQuestion('waits on question 2.', 2, 'WXY'));
  });

  it('reads a written list or range of questions as naming each one in it', () => {
    for (const n of [1, 3, 5]) ok(namesQuestion('his answers, Questions 1 to 5', n, null), String(n));
    ok(!namesQuestion('his answers, Questions 1 to 5', 6, null));
    ok(namesQuestion('follows the answers to § Questions 1 and 2, and the rest', 2, null));
    ok(namesQuestion('Questions 1, 3 and 5', 3, null));
    ok(!namesQuestion('Questions 1, 3 and 5', 4, null));
    ok(namesQuestion('Questions 2 to 4 and 7', 7, null));
    ok(namesQuestion('Questions 3–5', 4, null));
    ok(!namesQuestion('Questions 1 and 2.3', 2, null), 'a dotted number is a phase item');
    deepStrictEqual(questionReach('---\nnext_step: his answers to Questions 1 to 3\n---\n- [ ] Ship after Questions 2 and 3\n', 3, null), { nextStep: true, boxes: 1 });
  });

  it('reads open boxes outside code fences, and the open questions of a document in scope with the boxes each holds', () => {
    const text = '---\ntype: plan\nquestion_code: WXY\n---\n- [ ] Fit WXY-Q1\n```\n- [ ] WXY-Q1 in a fence\n```\n~~~md\n- [ ] Also fenced, WXY-Q1\n~~~\n- [ ] Free\n\n## Questions\n\n1. WXY-Q1 **Which?** A or B.\n2. WXY-Q2 **Done?** Ruled 2026-01-01: yes.\n';
    deepStrictEqual(openBoxes(text), [{ line: 5, text: 'Fit WXY-Q1' }, { line: 12, text: 'Free' }]);
    const settings = questionSettings({ paths: ['docs/plans'] });
    deepStrictEqual(openQuestionRows('docs/plans/a.md', text, settings).map(r => [r.id, r.boxes, r.held.map(b => b.line)]), [['WXY-Q1', 1, [5]]]);
    deepStrictEqual(openQuestionRows('docs/notes/a.md', text, settings), []);
    deepStrictEqual(openQuestionRows('docs/plans/a.md', text.replace('type: plan', 'type: doc'), settings), []);
    ok(inQuestionScope('docs/plans/b.md', null, settings));
  });

  it('gives a code that is free, not labelled in the plan and not another plan\'s own prefix', () => {
    deepStrictEqual(codeCandidates('alpha-beta-gamma', '').slice(0, 3), ['ABG', 'ALB', 'ALBE']);
    ok(labelsWith('ruling ABG4 says', 'ABG'));
    ok(!codeCandidates('alpha-beta-gamma', 'ruling **ABG4**').includes('ABG'));
    strictEqual(ownPrefix('- **HD1** x\n- **HD2** y\n'), 'HD');
    const markdown = '---\ntype: plan\n---\nbody\n';
    const taken = new Map([['ABG', ['docs/plans/other.md']]]);
    const reserved = new Map([['ALB', 'docs/plans/third.md']]);
    const { code, markdown: next } = codeFor('alpha-beta-gamma', markdown, { taken, reserved });
    strictEqual(code, 'ALBE');
    strictEqual(next, '---\ntype: plan\nquestion_code: ALBE\n---\nbody\n');
  });

  it('writes the ID on the line once, and refuses a number used twice', () => {
    const text = '---\nquestion_code: WXY\n---\n## Questions\n\n1. **One?**\n2. WXY-2 **Two?**\n| 3 | Q3. A row? |\n';
    const qs = planQuestions(text);
    const once = withIdOnLine(text, qs[0], 'WXY');
    ok(once.includes('1. WXY-Q1 **One?**'));
    strictEqual(withIdOnLine(text, qs[1], 'WXY'), text, 'the old form is left as written');
    ok(withIdOnLine(text, qs[2], 'WXY').includes('| 3 | WXY-Q3 Q3. A row? |'));
    const twice = '## Questions\n\n1. **A?**\n1. **B?**\n';
    match(numberClash(twice, planQuestions(twice), planQuestions(twice)[0], null), /listed 2 times/);
    const used = '---\nquestion_code: WXY\n---\n## Rulings\n\n- WXY-Q1 was ruled.\n\n## Questions\n\n1. **A?**\n';
    match(numberClash(used, planQuestions(used), planQuestions(used)[0], 'WXY'), /WXY-Q1 was already used on line 6/);
  });
});

describe('runlist questions and runlist question', () => {
  let tmp;
  const CONFIG = `export const root = 'docs';
export const questions = { paths: ['docs/plans'] };
`;
  const DEMO = `---
type: plan
status: active
next_step: answer question 2
---
# Demo plan

## Work

- [ ] Build after question 2
- [ ] Build after Q4

## Questions

1. **Which door?** Ruled 2026-01-01: the left.
2. **Who stops it?** Open.
3. ~~Is it in scope?~~
4. **What it keeps.** A confirmation counts.
`;
  const env = extra => {
    const e = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
    for (const v of SESSION_ID_VARIABLES) delete e[v];
    return { ...e, ...extra };
  };
  const cli = (args, extra = {}) => spawnSync(process.execPath, [bin, ...args], { cwd: tmp, encoding: 'utf8', env: env(extra) });
  const plan = (slug = 'demo-plan') => readFileSync(path.join(tmp, 'docs/plans', `${slug}.md`), 'utf8');
  const raisedDir = () => path.join(tmp, '.runlist', 'questions');

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'runlist-questions-'));
    spawnSync('git', ['init', '-q'], { cwd: tmp });
    mkdirSync(path.join(tmp, 'docs/plans/archived'), { recursive: true });
    writeFileSync(path.join(tmp, 'runlist.config.mjs'), CONFIG);
    writeFileSync(path.join(tmp, 'docs/plans/demo-plan.md'), DEMO);
    writeFileSync(path.join(tmp, 'docs/plans/archived/old-dusty-plan.md'), '---\ntype: plan\nstatus: archived\nquestion_code: DP\n---\n# Old\n');
  });
  afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

  it('lists the open questions with what each holds, and a plan\'s questions with answered ones', () => {
    const open = cli(['questions', '--json']);
    strictEqual(open.status, 0, open.stderr);
    ok(!open.stderr.includes('unknown key'), open.stderr);
    deepStrictEqual(JSON.parse(open.stdout).map(r => [r.id, r.number, r.line, r.nextStep, r.boxes]), [
      ['demo-plan Q2', 2, 16, true, 1], ['demo-plan Q4', 4, 18, false, 1],
    ]);
    const one = cli(['questions', 'demo-plan']);
    strictEqual(one.status, 0, one.stderr);
    match(one.stdout, /4 questions, 2 open/);
    match(one.stdout, /answered\s+Which door\?/);
  });

  it('raises a question: gives the plan a code free of archived plans, writes the ID, and lists it for its session', () => {
    const raised = cli(['question', 'raise', 'demo-plan', '2'], { CLAUDE_CODE_SESSION_ID: 'sess-a' });
    strictEqual(raised.status, 0, raised.stderr);
    const code = planCode(plan());
    strictEqual(code, 'DEP', 'the initials DP belong to an archived plan');
    match(raised.stdout, /raised DEP-Q2, "Who stops it\?" \(docs\/plans\/demo-plan\.md\) for session sess-a/);
    ok(plan().includes(`2. ${code}-Q2 **Who stops it?**`));
    deepStrictEqual(readdirSync(raisedDir()), ['demo-plan-2-sess-a.json']);
    const file = JSON.parse(readFileSync(path.join(raisedDir(), 'demo-plan-2-sess-a.json'), 'utf8'));
    deepStrictEqual([file.sessionId, file.path, file.number, file.id, file.title], ['sess-a', 'docs/plans/demo-plan.md', 2, `${code}-Q2`, 'Who stops it?']);

    cli(['question', 'raise', 'demo-plan', '4', '--session', 'sess-b']);
    const mine = JSON.parse(cli(['questions', '--raised', '--session', 'sess-a', '--json']).stdout);
    deepStrictEqual(mine.map(r => [r.id, r.raisedBy.map(x => x.sessionId), r.nextStep, r.boxes]), [[`${code}-Q2`, ['sess-a'], true, 1]]);
    strictEqual(JSON.parse(cli(['questions', '--raised', '--json']).stdout).length, 2);

    const shown = cli(['questions', `${code.toLowerCase()} 2`]);
    match(shown.stdout, new RegExp(`${code}-Q2: open, raised on this machine`));
    match(cli(['questions', `${code}-2`]).stdout, new RegExp(`^${code}-Q2:`));
  });

  it('drops a raised question once the plan answers it, and prunes its file on the next raise', () => {
    cli(['question', 'raise', 'demo-plan', '2', '--session', 's1']);
    writeFileSync(path.join(tmp, 'docs/plans/demo-plan.md'), plan().replace('**Who stops it?** Open.', '**Who stops it?** Ruled 2026-01-09: the lead.'));
    deepStrictEqual(JSON.parse(cli(['questions', '--raised', '--json']).stdout), []);
    const again = cli(['question', 'raise', 'demo-plan', '4', '--session', 's1']);
    match(again.stdout, /removed demo-plan-2-s1\.json/);
    deepStrictEqual(readdirSync(raisedDir()), ['demo-plan-4-s1.json']);
  });

  it('refuses an answered question, a missing one and a shell with no session', () => {
    match(cli(['question', 'raise', 'demo-plan', '1', '--session', 's']).stderr, /already answered/);
    match(cli(['question', 'raise', 'demo-plan', '9', '--session', 's']).stderr, /has no question 9; its questions are 1, 2, 3, 4/);
    match(cli(['question', 'raise', 'demo-plan', '2']).stderr, /no agent session id/);
    ok(!existsSync(raisedDir()));
    strictEqual(planCode(plan()), null, 'a refused raise writes nothing');
  });

  it('codes a plan with a named code and writes the ID beside each open question only', () => {
    const coded = cli(['question', 'code', 'demo-plan', 'DMO']);
    strictEqual(coded.status, 0, coded.stderr);
    match(coded.stdout, /docs\/plans\/demo-plan\.md: DMO, wrote DMO-Q2 DMO-Q4/);
    ok(plan().includes('1. **Which door?**'));
    ok(plan().includes('4. DMO-Q4 **What it keeps.**'));
    match(cli(['question', 'code', 'demo-plan', 'XYZ']).stderr, /already has the code DMO/);
    match(cli(['questions', 'DMO-Q4']).stdout, /DMO-Q4: open in the plan, not raised on this machine/);
  });

  it('refuses a code another plan holds, archived included', () => {
    match(cli(['question', 'code', 'demo-plan', 'DP']).stderr, /the code DP is taken by docs\/plans\/archived\/old-dusty-plan\.md/);
  });

  it('lists pending decision records after the questions with --all', () => {
    writeFileSync(path.join(tmp, 'docs/plans/demo-plan.md'), `${DEMO}\n## Decisions\n\n### D1  Which vendor?\n\nDisposition: OPEN.\n`);
    const all = JSON.parse(cli(['questions', '--all', '--json']).stdout);
    deepStrictEqual(all.questions.map(r => r.number), [2, 4]);
    deepStrictEqual(all.decisions.map(d => d.id), ['D1']);
    const text = cli(['questions', '--all']).stdout;
    match(text, /^2 open questions in 1 plan\.\n[\s\S]*\n\n1 open or held decision record:\nD1 {2}Which vendor\?/);
  });
});
