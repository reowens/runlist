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
});
