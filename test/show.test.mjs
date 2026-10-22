import { describe, it, afterEach } from 'node:test';
import { strictEqual, deepStrictEqual, match } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

function setup() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-show-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'docs', 'dev'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), "export const root = ['docs/plans', 'docs'];\n");
}

function write(rel, text) {
  writeFileSync(path.join(tmpDir, rel), text);
}

function run(args) {
  return spawnSync('node', [BIN, ...args], { cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
}

describe('runlist show', () => {
  it('prints a plan card as data: status, next step, related plans and docs, body links', () => {
    setup();
    write('docs/plans/shelf.md', [
      '---', 'type: plan', 'status: in-session', 'updated: 2025-01-01T00:00:00Z',
      'next_step: Hang the oak shelf.', 'blockers:', '  - "The oak has not arrived."',
      'related_plans:', '  - bins.md', '  - gone.md', 'related_docs:', '  - ../dev/tools.md', '---',
      '# The Shelf', '', 'See [bins](bins.md), [tools](../dev/tools.md) and [hooks](hooks.md).', '',
      '- [x] Measure', '- [ ] Hang', '',
    ].join('\n'));
    write('docs/plans/bins.md', '---\ntype: plan\nstatus: active\nupdated: 2025-01-01T00:00:00Z\nrelated_plans:\n  - shelf.md\n---\n# Bins\n');
    write('docs/plans/hooks.md', '---\ntype: plan\nstatus: planned\nupdated: 2025-01-01T00:00:00Z\n---\n# Hooks\n');
    write('docs/dev/tools.md', '---\ntype: doc\nstatus: active\nupdated: 2025-01-01T00:00:00Z\n---\n# Tools\n');

    const res = run(['show', 'shelf', 'nowhere', '--json']);
    strictEqual(res.status, 0, res.stderr);
    const [card, missing] = JSON.parse(res.stdout);
    strictEqual(card.path, 'docs/plans/shelf.md');
    strictEqual(card.title, 'The Shelf');
    strictEqual(card.status, 'in-session');
    strictEqual(card.nextStep, 'Hang the oak shelf.');
    deepStrictEqual(card.blockers, ['The oak has not arrived.']);
    deepStrictEqual(card.checklist, { completed: 1, open: 1, total: 2 });
    deepStrictEqual(card.related.map(r => [r.field, r.path, r.exists, r.title, r.status]), [
      ['related_plans', 'docs/plans/bins.md', true, 'Bins', 'active'],
      ['related_plans', null, false, null, null],
      ['related_docs', 'docs/dev/tools.md', true, 'Tools', 'active'],
    ]);
    deepStrictEqual(card.links.map(l => [l.path, l.title]), [['docs/plans/hooks.md', 'Hooks']]);
    deepStrictEqual(missing, { path: 'nowhere', error: 'not found' });

    const text = run(['show', 'shelf']);
    match(text.stdout, /^The Shelf {2}\(in-session\)\ndocs\/plans\/shelf\.md\nNext: Hang the oak shelf\./);
  });
  it('follows the card with an outline and open boxes, and names the other fields', () => {
    setup();
    write('docs/plans/porch.md', [
      '---', 'type: plan', 'status: active', 'owner: sam', 'updated: 2025-01-01T00:00:00Z', '---',
      '# Porch', '', '## Steps', '- [x] Pour footings', '- [ ] Set joists', '```', '- [ ] example only', '```', '## Notes', 'Treat the wood.', '',
    ].join('\n'));

    const text = run(['show', 'porch']);
    strictEqual(text.status, 0, text.stderr);
    match(text.stdout, /^Porch {2}\(active\)\ndocs\/plans\/porch\.md\n\nOutline: 16 lines, 1 KB \(line, heading\)\n {3}7 {2}# Porch\n {3}9 {2}## Steps\n  15 {2}## Notes\n/);
    match(text.stdout, /Open boxes: 1 of 2 \(line, text\)\n  11 {2}Set joists\n/);
    match(text.stdout, /Other fields: type, owner, updated \(--frontmatter prints them\)/);
    match(text.stdout, /One section: runlist show docs\/plans\/porch\.md --section "<heading>"\n$/);
    strictEqual(/Checklist:/.test(text.stdout), false);

    const [card] = JSON.parse(run(['show', 'porch', '--json']).stdout);
    deepStrictEqual(card.brief.boxes, { open: 1, done: 1 });
    deepStrictEqual(card.brief.open, [{ line: 11, text: 'Set joists' }]);
    deepStrictEqual(card.otherFields, ['type', 'owner', 'updated']);

    const cardOnly = run(['show', 'porch', '--card']);
    match(cardOnly.stdout, /Checklist: 1 of 2 done\n$/);
    strictEqual(/Outline:/.test(cardOnly.stdout), false);

    match(run(['show', 'porch', '--frontmatter']).stdout, /Frontmatter \(lines 1 to 6\):\n {2}type: plan\n/);
  });

  it('reads one section with line numbers, and fails listing the headings when none matches', () => {
    setup();
    write('docs/plans/porch.md', '---\ntype: plan\nstatus: active\n---\n# Porch\n## Steps\n- [ ] Set joists\n## Notes\nTreat the wood.\n');

    const res = run(['show', 'porch', '--section', 'steps']);
    strictEqual(res.status, 0, res.stderr);
    strictEqual(res.stdout, 'docs/plans/porch.md lines 6 to 7 (## Steps):\n6\t## Steps\n7\t- [ ] Set joists\n');

    const json = JSON.parse(run(['show', 'porch', '-s', 'notes', '--json']).stdout);
    deepStrictEqual([json.from, json.to, json.next, json.rows.map(r => r.text)], [8, 9, null, ['## Notes', 'Treat the wood.']]);

    const miss = run(['show', 'porch', '--section', 'roof']);
    strictEqual(miss.status, 1);
    match(miss.stderr, /No heading in docs\/plans\/porch\.md matches "roof"\. Headings:\n {2}5 {2}# Porch\n {2}6 {2}## Steps\n/);

    strictEqual(run(['show', 'porch', 'porch', '--section', 'steps']).status, 1);
    strictEqual(run(['show', 'porch', '--from', '3']).status, 1);
  });

  it('reads any Markdown file in the repo, with or without frontmatter', () => {
    setup();
    write('NOTES.md', '# Notes\n\n- [ ] Call the roofer\n');
    const res = run(['show', 'NOTES.md']);
    strictEqual(res.status, 0, res.stderr);
    match(res.stdout, /Open boxes: 1 of 1 \(line, text\)\n {2}3 {2}Call the roofer\n/);
  });
});
