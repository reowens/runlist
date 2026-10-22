import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { buildBrief, collapseFrontmatter, readSection, LIMITS } from '../src/brief.mjs';

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
      { line: 9, text: 'Buy hinges' },
      { line: 20, text: 'Rafters' },
      { line: 21, text: 'Felt' },
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
    deepStrictEqual(b.open, [{ line: 3, text: 'one' }]);
  });
});

describe('readSection', () => {
  it('runs from the heading to the next heading at the same or a higher level', () => {
    const r = readSection(PLAN, 'phase 1');
    strictEqual(r.heading.line, 15);
    deepStrictEqual(r.rows.map(x => x.line), [15, 16, 17, 18]);
    strictEqual(r.next, null);
  });

  it('takes the first match in document order and names the others', () => {
    const r = readSection(PLAN, '## phase');
    strictEqual(r.heading.heading, 'Phases');
    deepStrictEqual(r.others.map(o => o.line), [15, 19, 22]);
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
