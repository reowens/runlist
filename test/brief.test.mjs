import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { buildBrief, collapseFrontmatter, readSection, sectionSizes, LIMITS } from '../src/brief.mjs';

const PLAN = [
  '---', 'type: plan', 'status: active', '---', // 1-4
  '# Garden Shed', // 5
  '', // 6
  '## Materials', // 7
  '- [x] Buy cedar', // 8
  '- [ ] Buy hinges', // 9
  '```md', // 10
  '## Not a heading', // 11
  '- [ ] not a box', // 12
  '```', // 13
  '## Phases', // 14
  '### Phase 1 — Frame ✅', // 15
  '- [x] Posts', // 16
  '#### Notes', // 17
  'Level the posts first.', // 18
  '### Phase 2 — Roof ⬜', // 19
  '- [~] Rafters', // 20
  '- [ ] Felt', // 21
  '## Phase log', // 22
  '',
].join('\n');

describe('buildBrief', () => {
  it('reads headings and boxes outside code fences, in file line numbers', () => {
    const b = buildBrief(PLAN);
    strictEqual(b.lines, 22);
    strictEqual(b.frontmatterLines, 4);
    deepStrictEqual(b.outline.map(h => [h.line, h.level, h.heading, h.end]), [
      [5, 1, 'Garden Shed', 22],
      [7, 2, 'Materials', 13],
      [14, 2, 'Phases', 21],
      [15, 3, 'Phase 1 — Frame ✅', 18],
      [17, 4, 'Notes', 18],
      [19, 3, 'Phase 2 — Roof ⬜', 21],
      [22, 2, 'Phase log', 22],
    ]);
    deepStrictEqual(b.boxes, { open: 3, done: 2 });
    deepStrictEqual(b.open, [
      { line: 9, text: 'Buy hinges', phase: null },
      { line: 20, text: 'Rafters', phase: 'Phase 2 — Roof ⬜' },
      { line: 21, text: 'Felt', phase: 'Phase 2 — Roof ⬜' },
    ]);
    strictEqual(b.openOmitted, 0);
  });

  it('drops the deepest heading levels first when the outline is over the cap', () => {
    const b = buildBrief(PLAN, { limits: { ...LIMITS, outline: 6 } });
    deepStrictEqual(b.outline.map(h => h.level), [1, 2, 2, 3, 3, 2]);
    strictEqual(b.outlineOmitted, 1);
  });

  it('caps open boxes unless all is asked for', () => {
    const limits = { ...LIMITS, boxes: 2 };
    strictEqual(buildBrief(PLAN, { limits }).open.length, 2);
    strictEqual(buildBrief(PLAN, { limits }).openOmitted, 1);
    strictEqual(buildBrief(PLAN, { limits, all: true }).open.length, 3);
  });

  it('works on a file with no frontmatter', () => {
    const b = buildBrief('# Notes\n\n- [ ] one\n');
    strictEqual(b.frontmatterLines, 0);
    deepStrictEqual(b.outline.map(h => h.line), [1]);
    deepStrictEqual(b.open, [{ line: 3, text: 'one', phase: null }]);
  });
});

describe('buildBrief phases', () => {
  it('marks phase headings with their marker, own tally and the active phase', () => {
    const b = buildBrief(PLAN);
    deepStrictEqual(b.outline.filter(h => h.phase).map(h => [h.line, h.phase]), [
      [15, { marker: 'shipped', done: 1, total: 1, active: false, conflict: null }],
      [19, { marker: 'todo', done: 0, total: 2, active: true, conflict: null }],
    ]);
    deepStrictEqual(b.activePhase, { line: 19, heading: 'Phase 2 — Roof ⬜' });
  });

  it('names the phase each open box sits in', () => {
    deepStrictEqual(buildBrief(PLAN).open.map(o => o.phase), [null, 'Phase 2 — Roof ⬜', 'Phase 2 — Roof ⬜']);
  });

  it('reports a marker its own boxes contradict', () => {
    const b = buildBrief(['## Phases', '### Phase 1 — Walls ✅', '- [x] Studs', '- [ ] Drywall', '### Phase 2 — Trim ⬜', '- [x] Casing', ''].join('\n'));
    deepStrictEqual(b.outline.filter(h => h.phase).map(h => h.phase.conflict), [
      { declared: 'shipped', implied: 'in progress' },
      { declared: 'todo', implied: 'shipped' },
    ]);
    strictEqual(b.activePhase.line, 5);
  });
});

describe('readSection', () => {
  it('runs from the heading to the next heading at the same or a higher level', () => {
    const r = readSection(PLAN, 'phase 1');
    strictEqual(r.heading.line, 15);
    deepStrictEqual(r.rows.map(x => x.line), [15, 16, 17, 18]);
    strictEqual(r.next, null);
  });

  it('takes a unique best match and names the others', () => {
    const r = readSection(PLAN, '## phases');
    strictEqual(r.heading.heading, 'Phases');
    deepStrictEqual(r.others.map(o => o.line), []);
    strictEqual(readSection(PLAN, 'phase 2').heading.line, 19);
  });

  it('refuses a loose match that more than one heading meets, naming them', () => {
    const r = readSection(PLAN, '## phase');
    strictEqual(r.found, false);
    strictEqual(r.ambiguous, true);
    deepStrictEqual(r.candidates.map(c => c.line), [14, 15, 19, 22]);
  });

  it('cuts a long section and says where to continue', () => {
    const limits = { ...LIMITS, sectionLines: 3 };
    const first = readSection(PLAN, 'Phases', { limits });
    deepStrictEqual([first.from, first.to, first.next], [14, 16, 17]);
    const rest = readSection(PLAN, 'Phases', { limits, from: first.next });
    deepStrictEqual([rest.from, rest.to, rest.next], [17, 19, 20]);
  });

  it('reports a start past the end of the section', () => {
    strictEqual(readSection(PLAN, 'Materials', { from: 30 }).past, true);
  });

  it('lists the headings when nothing matches', () => {
    const r = readSection(PLAN, 'gutters');
    strictEqual(r.found, false);
    strictEqual(r.headings.length, 7);
  });
});

describe('collapseFrontmatter', () => {
  it('collapses long lists and cuts long values', () => {
    const fm = ['type: plan', 'tags:', ...Array.from({ length: 10 }, (_, i) => `  - t${i}`), `note: ${'x'.repeat(200)}`].join('\n');
    const out = collapseFrontmatter(fm);
    strictEqual(out.length, 2 + 8 + 1 + 1);
    strictEqual(out[10], '  (+2 more)');
    strictEqual(out[11].length, LIMITS.width);
  });
});

describe('sectionSizes', () => {
  const doc = [
    '---', 'type: plan', '---', // 1-3
    '# Boathouse', // 4
    'Intro.', // 5
    '## Hull', // 6
    'x'.repeat(99), // 7
    '### Keel', // 8
    'k'.repeat(299), // 9
    '## Sails', // 10
    's'.repeat(49), // 11
  ].join('\n') + '\n';

  it('measures each section on file lines, largest first', () => {
    const sizes = sectionSizes(doc);
    deepStrictEqual(sizes.map(s => [s.heading, s.line]), [['Boathouse', 4]]);
    strictEqual(sizes[0].bytes, Buffer.byteLength(doc.split('\n').slice(3).join('\n')));
  });

  it('lists a section over splitOver as its subsections and its own text', () => {
    const sizes = sectionSizes(doc, { splitOver: 200 });
    deepStrictEqual(sizes.map(s => [s.heading, s.level, s.line, s.bytes]), [
      ['Keel', 3, 8, 9 + 300],
      ['Hull', 2, 6, 8 + 100],
      ['Sails', 2, 10, 9 + 50],
      ['Boathouse', 1, 4, 12 + 7],
    ]);
  });

  it('returns nothing for a document with no headings', () => {
    deepStrictEqual(sectionSizes('just text\n'), []);
  });
});
