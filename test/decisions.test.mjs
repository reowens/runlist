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
