import { describe, it, afterEach } from 'node:test';
import { strictEqual, deepStrictEqual, ok, match } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  isDecisionHeading,
  parseDecisionItems,
  dispositionOf,
  recordParts,
  analyzeDecisions,
  pendingRows,
  decisionDefects,
  decisionSettings,
  namesId,
  statedBlocks,
  openWork,
  blocksOf,
} from '../src/decisions.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

function setup(config = '') {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-decisions-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), `export const root = ['docs/plans', 'docs'];\n${config}`);
}

function plan(name, body, status = 'planned') {
  writeFileSync(path.join(tmpDir, 'docs', 'plans', `${name}.md`), `---\ntype: plan\nstatus: ${status}\nupdated: 2025-01-01T00:00:00Z\n---\n# ${name}\n\n${body}`);
}

function run(args) {
  return spawnSync('node', [BIN, ...args], { cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
}

const RECORD = 'The widget shelf is empty on every screen today and nobody can stock it. It lives in `src/shelf.ts:4`. Yes: the shelf fills from the catalog. No: it stays empty.';

describe('isDecisionHeading', () => {
  it('matches the section word among the first 4 words, after an enumerator', () => {
    ok(isDecisionHeading('Decisions'));
    ok(isDecisionHeading('Open decisions — owner'));
    ok(isDecisionHeading('B. Decisions for the owner'));
    ok(isDecisionHeading('Phase 0: Design decisions, rulings required'));
    ok(isDecisionHeading('Decision'));
  });
  it('ignores a heading that mentions a decision further along', () => {
    ok(!isDecisionHeading('Attempt 2, closed as build work rather than a decision'));
    ok(!isDecisionHeading('What counts as a decision'));
    ok(!isDecisionHeading('Related decision-engine scope'));
  });
});

describe('parseDecisionItems', () => {
  it('reads heading, list, table and bold items inside the section only', () => {
    const text = [
      '## Build', '', '- **D9 not an item** outside the section', '',
      '## Decisions', '',
      '### D1  Which shelf?', '', 'Disposition: OPEN.', '', RECORD, '',
      '- **D2 — Which bin?** Ruled 2025-02-01: the blue one.',
      '| D3 | Which lid? | closed as duplicate of D2 in the catalog plan |',
      '**D4. Which label?** Held until the printer arrives.',
      '', '## Next', '', '### D5 also not an item',
    ].join('\n');
    const items = parseDecisionItems(text);
    deepStrictEqual(items.map(i => [i.id, i.kind]), [['D1', 'heading'], ['D2', 'list'], ['D3', 'table'], ['D4', 'record']]);
    ok(items[0].text.includes('src/shelf.ts:4'), 'a heading record runs to the next heading');
  });

  it('reads register rows in a fence whose first line carries the status line', () => {
    const text = '```\nOpen, waiting on you:\n\nD7  Which door? Yes: this. No: that.\nD8  RULED 2025-03-01: the red one.\n```\n';
    const s = decisionSettings({ register: { file: 'x.md', statusLine: 'waiting on you:' } });
    const items = parseDecisionItems(text, s);
    deepStrictEqual(items.map(i => [i.id, i.kind, dispositionOf(i, s)]), [['D7', 'register', 'open'], ['D8', 'register', 'ruled']]);
  });

  it('keeps file line numbers with frontmatter present', () => {
    const items = parseDecisionItems('---\ntype: plan\n---\n## Decisions\n\n- **D1 x** open.');
    strictEqual(items[0].line, 6);
  });
});

describe('dispositionOf', () => {
  const item = (text, context = null) => ({ text, context });
  it('reads the explicit line first, then a shouted opening word', () => {
    strictEqual(dispositionOf(item('x\n\nDisposition: HELD 2025-01-01.\n\nruled 2025-01-02')), 'held');
    strictEqual(dispositionOf(item('CLOSED 2025-01-01: merged into the other row')), 'closed');
  });
  it('reads prose only when configured, with a ruling word needing its date', () => {
    strictEqual(dispositionOf(item('it was ruled 2025-01-01 by the owner')), null);
    const s = { prose: true };
    strictEqual(dispositionOf(item('it was ruled 2025-01-01 by the owner'), s), 'ruled');
    strictEqual(dispositionOf(item('it was ruled, then reopened: still open'), s), 'open');
    strictEqual(dispositionOf(item('ratified (by the owner, 2025-01-01)'), s), 'ruled');
  });
  it('prefers the lead above over a lowercase word, never over a shouted one', () => {
    const s = { prose: true };
    strictEqual(dispositionOf(item('the geocoder is open source', 'ruled'), s), 'ruled');
    strictEqual(dispositionOf(item('OPEN again after the review', 'ruled'), s), 'open');
  });
  it('takes a shouted disposition on the heading above as the items\' lead', () => {
    const s = { prose: true };
    const [row] = parseDecisionItems('## Decisions, both RESOLVED 2025-01-01\n\n- **D1 — Which bin?** The open one.\n', s);
    strictEqual(dispositionOf(row, s), 'ruled');
  });
  it('takes extra markers from config', () => {
    const s = { prose: true, patterns: { ruled: ['\\(owner[^)]*20\\d{2}-\\d{2}-\\d{2}\\)'] } };
    strictEqual(dispositionOf(item('shelf goes left (owner, 2025-01-01)'), s), 'ruled');
  });
});

describe('recordParts', () => {
  it('detects prose, a citation and two answers', () => {
    deepStrictEqual(recordParts(RECORD), { prose: true, citation: true, answers: true });
    deepStrictEqual(recordParts('Which shelf?'), { prose: false, citation: false, answers: false });
  });
});

describe('pendingRows', () => {
  const settings = {
    prose: true,
    register: { file: 'docs/plans/arc.md', statusLine: 'waiting on you:' },
    requires: { open: ['prose', 'citation', 'answers'] },
  };
  const docs = [
    {
      path: 'docs/plans/arc.md',
      text: '```\nOpen, waiting on you:\n\nD7  Which door? Yes: this. No: that. Record: [shelf.md](shelf.md).\nD8  RULED 2025-03-01: the red one.\n```\n',
    },
    { path: 'docs/plans/shelf.md', text: `## Decisions\n\n### D7  Which door?\n\nDisposition: OPEN.\n\n${RECORD}\n` },
    { path: 'docs/plans/bins.md', text: '## Decisions\n\n- **D7 — Which bin?** Open. Nothing else here.\n' },
  ];

  it('collapses a register row with the record it links, and keeps an unrelated same id apart', () => {
    const rows = pendingRows(analyzeDecisions(docs, settings));
    deepStrictEqual(rows.map(r => [r.label, r.doc, r.kind]), [
      ['D7 (arc.md)', 'docs/plans/arc.md', 'register'],
      ['D7 (bins.md)', 'docs/plans/bins.md', 'list'],
    ]);
    match(rows[0].text, /^Which door\? Yes: this/);
    strictEqual(rows[1].text, '(record incomplete: missing prose, citation, answers)');
  });

  it('lets a register row govern the record it indexes', () => {
    const ruled = [
      { path: 'docs/plans/arc.md', text: '```\nOpen, waiting on you:\n\nD7  RULED 2025-04-01: this. Record: shelf.md.\n```\n' },
      docs[1],
    ];
    deepStrictEqual(pendingRows(analyzeDecisions(ruled, settings)), []);
    const defects = decisionDefects(analyzeDecisions(ruled, settings));
    ok(defects.some(d => d.id === 'D7' && /open here, ruled at docs\/plans\/arc\.md:4/.test(d.message)));
  });

  it('names items with no id, no disposition, or an id used twice', () => {
    const items = analyzeDecisions([{ path: 'docs/plans/p.md', text: '## Decisions\n\n- **Decision: the shelf.**\n- **D1 x.** A note.\n- **D1 y.** Ruled 2025-01-01: z.\n' }], settings);
    const messages = decisionDefects(items).map(d => `${d.id ?? '-'} ${d.message}`);
    deepStrictEqual(messages, ['- missing id, disposition', 'D1 missing disposition', 'D1 id used again in this document (first at line 4)']);
  });
});

describe('misreads', () => {
  const s = { prose: true };

  it('reads a bold Decision field inside a heading record as part of that record', () => {
    const text = [
      '## Decisions', '',
      '### W-001 — Shelves use pegs', '',
      '- **Status:** settled, ruled 2025-01-01',
      '- **Decision:** pegs, not brackets.', '',
      '### W-002 — RULED 2025-01-02: lids stay', '',
      '**Decision (owner):** the lids stay on.', '',
      '## Other decisions', '',
      '- **Decision: a bin with no name.**',
    ].join('\n');
    const items = parseDecisionItems(text, s);
    deepStrictEqual(items.map(i => [i.id, i.kind]), [['W-001', 'heading'], ['W-002', 'heading'], [null, 'unnamed']]);
    ok(items[0].text.includes('pegs, not brackets'));
  });

  it('reads a compound id whole, and a sentence-end period is not part of it', () => {
    const text = [
      '## Decisions', '',
      '- **D1 — Which shelf?** Ruled 2025-01-01: the left one.',
      '- **D1-R — Which shelf, again?** Ruled 2025-02-01: the right one.',
      '- **P4-D2, RULED 2025-01-01 — Which hook?** Brass.',
      '- **D2-B — Which lid?** Held.',
      '- **D1.2 — Which label?** Held.',
      '- **D3. Which bin?** Held.',
    ].join('\n');
    const items = analyzeDecisions([{ path: 'docs/plans/p.md', text }], s);
    deepStrictEqual(items.map(i => i.id), ['D1', 'D1-R', 'P4-D2', 'D2-B', 'D1.2', 'D3']);
    deepStrictEqual(decisionDefects(items).filter(d => /used again/.test(d.message)), []);
  });

  it('keeps a configured id pattern in force', () => {
    const items = parseDecisionItems('## Decisions\n\n- **Q-12 — Which bin?** Held.\n- **D1 — Which lid?** Held.\n', { id: 'Q-\\d+' });
    deepStrictEqual(items.map(i => i.id), ['Q-12']);
  });

  it('pairs records across documents only when the link names the id beside it', () => {
    const shelf = { path: 'docs/plans/shelf.md', text: '## Decisions\n\n- **D1 — Which peg?** RULED 2025-01-01: brass.\n' };
    const cited = {
      path: 'docs/plans/bins.md',
      text: '## Decisions\n\n**D1 — Which bin size?** Open.\n\n- *A small bin.* The guidance recorded in [shelf.md](./shelf.md) calls it fragile.\n',
    };
    const after = { path: 'docs/plans/hooks.md', text: '## Decisions\n\n- **D1 — Which peg?** Open, recorded in full in `shelf.md` Decisions, D1.\n' };
    const before = { path: 'docs/plans/lids.md', text: '## Decisions\n\n- **D1 — Which peg?** Open.\n  See D1 in [the shelf plan](shelf.md) for the record.\n' };
    const defects = decisionDefects(analyzeDecisions([shelf, cited, after, before], s));
    deepStrictEqual(defects.filter(d => /ruled at/.test(d.message)).map(d => d.doc), ['docs/plans/hooks.md', 'docs/plans/lids.md']);
  });

  it('lets a heading with a dated ruling govern its items, and not a bare lowercase open', () => {
    const ruled = parseDecisionItems('## Decisions, ruled by the owner 2025-01-01\n\n| D1 | Which bin? | The blue one. |\n', s);
    strictEqual(dispositionOf(ruled[0], s), 'ruled');
    const paren = parseDecisionItems('## Decisions (ratified 2025-01-01, owner)\n\n- **D2 — Which lid?** The red one.\n', s);
    strictEqual(dispositionOf(paren[0], s), 'ruled');
    const bare = parseDecisionItems('## Decisions still open\n\n- **D3 — Which hook?** The brass one.\n', s);
    strictEqual(dispositionOf(bare[0], s), null);
  });
});

describe('runlist decisions (CLI)', () => {
  const config = `export const decisions = { listHeading: 'Waiting on you:', requires: { open: ['citation'] } };\n`;

  it('prints the bare list: status line, blank line, one row per decision', () => {
    setup(config);
    plan('shelf', `## Decisions\n\n### D2  Which shelf?\n\nDisposition: OPEN.\n\n${RECORD}\n\n### D1  Which bin?\n\nDisposition: RULED 2025-01-01.\n\nThe blue one.\n`);
    plan('lids', '## Decisions\n\n- **D3 — Which lid?** Disposition: held. See `src/lid.ts:9`.\n');
    plan('old', '## Decisions\n\n### D4  Gone?\n\nDisposition: OPEN.\n', 'archived');
    const res = run(['decisions']);
    strictEqual(res.status, 0, res.stderr);
    strictEqual(res.stdout, 'Waiting on you:\n\nD2  Which shelf? The widget shelf is empty on every screen today and nobody can stock it. It lives in src/shelf.ts:4. Yes: the shelf fills from the catalog.\nD3  Which lid? Disposition: held. See src/lid.ts:9.\n');
    strictEqual(res.stderr, '');
  });

  it('scopes to one document, shows one record whole, and reports what it could not read', () => {
    setup(config);
    plan('shelf', `## Decisions\n\n### D2  Which shelf?\n\nDisposition: OPEN.\n\n${RECORD}\n\n- **D5 — Which hook?** Nothing says.\n`);
    plan('lids', '## Decisions\n\n- **D3 — Which lid?** Disposition: held. See `src/lid.ts:9`.\n');

    const scoped = run(['decisions', 'lids']);
    strictEqual(scoped.stdout, 'Waiting on you:\n\nD3  Which lid? Disposition: held. See src/lid.ts:9.\n');

    const one = run(['decisions', 'D2']);
    match(one.stdout, /^docs\/plans\/shelf\.md:10 {2}open\n### D2 {2}Which shelf\?\n\nDisposition: OPEN\.\n\nThe widget shelf/);

    const all = run(['decisions']);
    match(all.stderr, /1 decision items could not be read \(0 with no id, 1 with no disposition\)/);

    const check = run(['decisions', '--check']);
    strictEqual(check.status, 1);
    match(check.stdout, /docs\/plans\/shelf\.md:\d+ {2}D5 {2}missing disposition/);
  });

  it('says so when nothing is pending, and emits rows as JSON', () => {
    setup(config);
    plan('shelf', '## Decisions\n\n### D1  Which bin?\n\nDisposition: CLOSED 2025-01-01, merged into the catalog plan.\n');
    strictEqual(run(['decisions']).stdout, 'No open or held decisions.\n');
    const rows = JSON.parse(run(['decisions', '--all', '--json']).stdout);
    deepStrictEqual(rows.map(r => [r.id, r.disposition]), [['D1', 'closed']]);
  });
});

describe('what a decision blocks', () => {
  it('names an id alone or inside a written range, and not a longer id', () => {
    ok(namesId('- [ ] Build the shelf once D3 is ruled.', 'D3'));
    ok(namesId('12 questions, A1 to A12 in § Decisions, wait on him', 'A7'));
    ok(namesId('A2-A12 wait on him', 'A12'));
    ok(!namesId('A2 to A12 wait on him', 'A13'));
    ok(!namesId('Build it after D31.', 'D3'));
    ok(!namesId('See D3-B for the lid.', 'D3'));
    ok(!namesId('B1 to B4 wait', 'A2'));
  });

  it('reads a table row indexing a range of ids as one item, named by any id in it', () => {
    const text = '## Decisions\n\n| ID | Question | Disposition |\n|---|---|---|\n| A1 | Which folder? | **OPEN.** |\n| A2 to A12 | The other questions. | **OPEN, recorded.** |\n';
    deepStrictEqual(parseDecisionItems(text).map(i => i.id), ['A1', 'A2 to A12']);
    ok(namesId('12 questions, A1 to A12, wait on him', 'A2 to A12'));
    ok(namesId('Build it once A7 is ruled.', 'A2 to A12'));
    ok(!namesId('Build it once A1 is ruled.', 'A2 to A12'));
  });

  it('reads what a record says it blocks, and not a noun', () => {
    deepStrictEqual(statedBlocks('Open, blocks Phase 5: where the owner reads it first.'), ['Phase 5']);
    deepStrictEqual(statedBlocks('Whether PoE draw counts, which switch sizing waits on.'), ['switch sizing']);
    deepStrictEqual(statedBlocks('The code blocks went out unreadable.'), []);
  });

  it('lists unticked items with their heading, and frontmatter blockers', () => {
    const text = '---\ntype: plan\nblockers:\n  - "Waits on D2, the shelf."\n---\n# P\n\n## Phase 1 ⬜\n\n- [x] Done after D2.\n- [ ] Hang it once D2 is ruled.\n\n```\n- [ ] D2 in a fence\n```\n';
    deepStrictEqual(openWork(text).map(e => [e.line, e.kind, e.section, e.text]), [
      [4, 'blocker', null, 'Waits on D2, the shelf.'],
      [11, 'item', 'Phase 1', 'Hang it once D2 is ruled.'],
    ]);
  });

  it('gathers stated blocks, own items, and another plan\'s items only beside a link', () => {
    const shelf = { path: 'docs/plans/shelf.md', text: '## Decisions\n\n- **D2 — Which shelf?** Open, blocks Phase 3.\n\n## Phase 3\n\n- [ ] Hang the shelf D2 picks.\n- [ ] **D2** is not a record here.\n' };
    const bins = { path: 'docs/plans/bins.md', text: '## Work\n\n- [ ] Size the bins after [shelf.md](shelf.md) D2.\n- [ ] Our own D2 is something else.\n' };
    const items = analyzeDecisions([shelf, bins], { prose: true });
    const d2 = items.find(i => i.id === 'D2');
    const found = blocksOf([d2], [shelf, bins], items).get(d2);
    deepStrictEqual(found.map(b => [b.kind, b.doc, b.line, b.section]), [
      ['stated', 'docs/plans/shelf.md', 3, null],
      ['item', 'docs/plans/shelf.md', 7, 'Phase 3'],
      ['item', 'docs/plans/shelf.md', 8, 'Phase 3'],
      ['item', 'docs/plans/bins.md', 3, 'Work'],
    ]);
    strictEqual(found[0].text, 'Phase 3');
  });

  it('carries blocks, the question and the document title on --json rows', () => {
    setup('');
    plan('shelf', '## Decisions\n\n- **D2 — Which shelf, oak or pine?** Disposition: open. It blocks Phase 3.\n\n## Phase 3\n\n- [ ] Hang the shelf D2 picks.\n');
    const res = run(['decisions', '--json']);
    strictEqual(res.status, 0, res.stderr);
    const [row] = JSON.parse(res.stdout);
    strictEqual(row.docTitle, 'shelf');
    strictEqual(row.question, 'Which shelf, oak or pine?');
    deepStrictEqual(row.blocks.map(b => [b.kind, b.line, b.text]), [['stated', 10, 'Phase 3'], ['item', 14, 'Hang the shelf D2 picks.']]);
    ok(!run(['decisions']).stdout.includes('blocks:'), 'the text list is unchanged');
  });
});
