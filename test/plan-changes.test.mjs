import { describe, it, afterEach } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { planChangesSince, formatPlanChanges } from '../src/plan-changes.mjs';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'runlist.mjs');
let tmpDir;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  tmpDir = undefined;
});

function setup() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-plan-changes-'));
  spawnSync('git', ['init', '-q'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
  mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'docs', 'prompts'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), `export const root = 'docs';\n`);
  return { repoRoot: tmpDir };
}

function commitAt(file, content, date, message) {
  writeFileSync(path.join(tmpDir, file), content);
  spawnSync('git', ['add', file], { cwd: tmpDir });
  spawnSync('git', ['commit', '-qm', message], {
    cwd: tmpDir,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

const plan = (status, nextStep) => `---\ntype: plan\nstatus: ${status}\nnext_step: ${nextStep}\n---\n# Widget\n\nbody\n`;

describe('planChangesSince', () => {
  it('lists the commits after the prompt and says next_step changed', () => {
    const config = setup();
    commitAt('docs/plans/widget.md', plan('active', 'build the frame'), '2025-01-01T00:00:00Z', 'start widget');
    commitAt('docs/plans/widget.md', plan('active', 'fit the panels'), '2025-03-01T00:00:00Z', 'widget panels next');
    const changes = planChangesSince('docs/plans/widget.md', '2025-02-01T00:00:00Z', config);
    strictEqual(changes.tracked, true);
    strictEqual(changes.commits.length, 1);
    ok(changes.commits[0].endsWith('widget panels next'), changes.commits[0]);
    strictEqual(changes.nextStepChanged, true);
    const lines = formatPlanChanges(changes);
    ok(lines[0].includes('changed in 1 commit'), lines.join('\n'));
    ok(lines.at(-1).includes('next_step changed'), lines.join('\n'));
  });

  it('says so when nothing changed', () => {
    const config = setup();
    commitAt('docs/plans/widget.md', plan('active', 'build the frame'), '2025-01-01T00:00:00Z', 'start widget');
    const changes = planChangesSince('docs/plans/widget.md', '2025-02-01T00:00:00Z', config);
    deepStrictEqual(changes.commits, []);
    strictEqual(changes.nextStepChanged, false);
    ok(formatPlanChanges(changes)[0].includes('no commits since'), formatPlanChanges(changes).join('\n'));
  });

  it('falls back to the file clock for a plan git does not track', () => {
    const config = setup();
    writeFileSync(path.join(tmpDir, '.gitignore'), 'docs/\n');
    writeFileSync(path.join(tmpDir, 'docs/plans/widget.md'), plan('active', 'x'));
    const changes = planChangesSince('docs/plans/widget.md', '2025-02-01T00:00:00Z', config);
    strictEqual(changes.tracked, false);
    strictEqual(changes.modifiedAfter, true);
    utimesSync(path.join(tmpDir, 'docs/plans/widget.md'), new Date('2025-01-01'), new Date('2025-01-01'));
    strictEqual(planChangesSince('docs/plans/widget.md', '2025-02-01T00:00:00Z', config).modifiedAfter, false);
  });

  it('returns null for an unreadable time or a missing plan', () => {
    const config = setup();
    strictEqual(planChangesSince('docs/plans/widget.md', 'not a date', config), null);
    strictEqual(planChangesSince('docs/plans/missing.md', '2025-02-01', config), null);
  });
});

describe('runlist use on a prompt linked to a plan', () => {
  it('prints what changed in the plan since the prompt was written', () => {
    setup();
    commitAt('docs/plans/widget.md', plan('active', 'build the frame'), '2025-01-01T00:00:00Z', 'start widget');
    commitAt('docs/plans/widget.md', plan('active', 'fit the panels'), '2025-03-01T00:00:00Z', 'widget panels next');
    writeFileSync(path.join(tmpDir, 'docs/prompts/resume-widget.md'),
      '---\ntype: prompt\nstatus: pending\ncreated: 2025-02-01T00:00:00Z\nplan: ../plans/widget.md\n---\nResume the widget.\n');
    const r = spawnSync('node', [bin, 'use', 'docs/prompts/resume-widget.md', '--no-index'], {
      cwd: tmpDir, encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', RUNLIST_SESSION_ID: 'sid-a' },
    });
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('Resume the widget.'), r.stdout);
    ok(r.stderr.includes('docs/plans/widget.md changed in 1 commit'), r.stderr);
    ok(r.stderr.includes('widget panels next'), r.stderr);
    ok(r.stderr.includes('next_step changed'), r.stderr);
    ok(readFileSync(path.join(tmpDir, 'docs/plans/widget.md'), 'utf8').includes('next_step: fit the panels'));
  });
});
