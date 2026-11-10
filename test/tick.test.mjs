import { describe, it, beforeEach, afterEach } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'runlist.mjs');
let tmpDir;

const CONFIG = `export const root = 'docs';
export const types = {
  plan: {
    statuses: {
      active: { context: 'expanded' },
      planned: { context: 'listed' },
      shipping: { context: 'listed', requiresClosedBoxes: true },
      handover: { context: 'listed', requiresClosedBoxes: 'Close them, or ask about {slug} at {path}.' },
      archived: { context: 'counted', archive: true, terminal: true },
    },
  },
};
`;

const PLAN = `---
type: plan
status: active
updated: 2025-01-01
---
# Widget plan

## Phase 1

- [ ] Draft the widget
- [ ] Paint the widget
- [x] Order the paint
- [~] Sand the edges

\`\`\`md
- [ ] an example box, not work
\`\`\`
`;

function git(...args) {
  return spawnSync('git', args, { cwd: tmpDir, encoding: 'utf8' });
}

function cli(...args) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

const planPath = () => path.join(tmpDir, 'docs', 'plans', 'widget.md');
const planText = () => readFileSync(planPath(), 'utf8');

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-tick-'));
  git('init', '-q');
  git('config', 'user.email', 'test@test.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), CONFIG);
  writeFileSync(planPath(), PLAN);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('runlist tick', () => {
  it('ticks a box by the line number show prints, and bumps updated', () => {
    const shown = cli('show', 'docs/plans/widget.md');
    match(shown.stdout, /^\s+10\s+Draft the widget/m);
    const result = cli('tick', 'docs/plans/widget.md', '10');
    strictEqual(result.status, 0, result.stderr);
    match(result.stdout, /widget\.md:10 ticked: - \[x\] Draft the widget/);
    match(result.stdout, /2 open boxes left/);
    ok(planText().includes('- [x] Draft the widget\n- [ ] Paint the widget'));
    ok(!planText().includes('updated: 2025-01-01'), 'updated was bumped');
  });

  it('ticks a box by a unique piece of its text, case-insensitively, with a note', () => {
    const result = cli('tick', 'widget', 'PAINT THE', '--note', '(commit abc1234; 3 tests pass)');
    strictEqual(result.status, 0, result.stderr);
    ok(planText().includes('- [x] Paint the widget (commit abc1234; 3 tests pass)\n'));
  });

  it('writes the working tree only: nothing is staged and HEAD does not move', () => {
    const head = git('rev-parse', 'HEAD').stdout;
    strictEqual(cli('tick', 'docs/plans/widget.md', 'Draft').status, 0);
    strictEqual(git('rev-parse', 'HEAD').stdout, head);
    strictEqual(git('diff', '--cached', '--name-only').stdout, '');
    strictEqual(git('diff', '--name-only').stdout.trim(), 'docs/plans/widget.md');
  });

  it('ticks a partial box, and --undo reopens a ticked one', () => {
    strictEqual(cli('tick', 'docs/plans/widget.md', 'sand').status, 0);
    ok(planText().includes('- [x] Sand the edges'));
    const undo = cli('tick', 'docs/plans/widget.md', 'order the paint', '--undo');
    strictEqual(undo.status, 0, undo.stderr);
    match(undo.stdout, /reopened: - \[ \] Order the paint/);
    ok(planText().includes('- [ ] Order the paint'));
  });

  it('refuses an ambiguous item and lists the candidates', () => {
    const before = planText();
    const result = cli('tick', 'docs/plans/widget.md', 'the widget');
    strictEqual(result.status, 1);
    match(result.stderr, /matches 2 boxes; name one by its line number/);
    match(result.stderr, /10 {2}- \[ \] Draft the widget/);
    match(result.stderr, /11 {2}- \[ \] Paint the widget/);
    strictEqual(planText(), before);
  });

  it('refuses a missing item and a line that is not a box, listing the open boxes', () => {
    const missing = cli('tick', 'docs/plans/widget.md', 'nothing like it');
    strictEqual(missing.status, 1);
    match(missing.stderr, /No box matches "nothing like it"\. The open boxes/);
    match(missing.stderr, /13 {2}- \[~\] Sand the edges/);
    const notBox = cli('tick', 'docs/plans/widget.md', '7');
    strictEqual(notBox.status, 1);
    match(notBox.stderr, /Line 7 is not a checklist box/);
  });

  it('does not count a box inside a code fence', () => {
    const result = cli('tick', 'docs/plans/widget.md', 'example box');
    strictEqual(result.status, 1);
    match(result.stderr, /No box matches/);
  });

  it('leaves a box already in the target state alone', () => {
    const before = planText();
    const result = cli('tick', 'docs/plans/widget.md', 'order the paint');
    strictEqual(result.status, 0);
    match(result.stdout, /already ticked; nothing changed/);
    strictEqual(planText(), before);
  });

  it('previews with --dry-run and writes nothing', () => {
    const before = planText();
    const result = cli('tick', 'docs/plans/widget.md', '10', '--dry-run');
    strictEqual(result.status, 0);
    match(result.stdout, /\[dry-run\] Would write docs\/plans\/widget\.md:10: - \[x\] Draft the widget/);
    strictEqual(planText(), before);
  });

  it('refuses a multi-line note', () => {
    const result = cli('tick', 'docs/plans/widget.md', '10', '--note', 'one\ntwo');
    strictEqual(result.status, 1);
    match(result.stderr, /--note is one line/);
  });
});

describe('requiresClosedBoxes', () => {
  it('refuses the status while boxes are open, naming the count', () => {
    const result = cli('set', 'shipping', 'docs/plans/widget.md');
    strictEqual(result.status, 1);
    match(result.stderr, /docs\/plans\/widget\.md has 3 open boxes; shipping needs every box closed\. Nothing was changed\./);
    match(result.stderr, /Close the open boxes first\./);
    match(planText(), /^status: active$/m);
  });

  it('prints the configured line with {slug} and {path} filled in', () => {
    const result = cli('set', 'handover', 'docs/plans/widget.md');
    strictEqual(result.status, 1);
    match(result.stderr, /Close them, or ask about widget at docs\/plans\/widget\.md\./);
  });

  it('allows the status once every box is closed', () => {
    for (const item of ['Draft', 'Paint', 'Sand']) strictEqual(cli('tick', 'docs/plans/widget.md', item).status, 0);
    const result = cli('set', 'shipping', 'docs/plans/widget.md');
    strictEqual(result.status, 0, result.stderr);
    match(planText(), /^status: shipping$/m);
  });

  it('--force sets it anyway, with a warning', () => {
    const result = cli('set', 'shipping', 'docs/plans/widget.md', '--force');
    strictEqual(result.status, 0, result.stderr);
    match(result.stderr, /3 open boxes; setting shipping anyway \(--force\)/);
    match(planText(), /^status: shipping$/m);
  });

  it('leaves statuses without the option alone', () => {
    const result = cli('set', 'planned', 'docs/plans/widget.md');
    strictEqual(result.status, 0, result.stderr);
    match(planText(), /^status: planned$/m);
  });

  it('applies to the deprecated status verb too', () => {
    const result = cli('status', 'docs/plans/widget.md', 'shipping');
    strictEqual(result.status, 1);
    match(result.stderr, /3 open boxes; shipping needs every box closed/);
  });
});
