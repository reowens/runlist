import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/config.mjs';
import { runDoctor } from '../src/doctor.mjs';

let tmpDir;

function run(args) {
  const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
  return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
    cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
}

function setupStatusesProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-statuses-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
    export const root = 'docs';
    export const types = {
      plan: { statuses: ['active', 'backlog', 'archived'] },
    };
  `);
}

function writePlan(name, status, currentState, nextStep = '') {
  const lines = [
    '---',
    'type: plan',
    `status: ${status}`,
    'updated: 2025-01-01',
    `current_state: "${currentState.replace(/"/g, '\\"')}"`,
  ];
  if (nextStep) lines.push(`next_step: "${nextStep.replace(/"/g, '\\"')}"`);
  lines.push('---', `# ${name}`, '');
  writeFileSync(path.join(tmpDir, 'docs', `${name}.md`), lines.join('\n'));
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('doctor command', () => {
  it('rescans documents inside the index lock before rendering', async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-index-race-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const root = 'docs';
      export const index = {
        path: 'docs/docs.md',
        startMarker: '<!-- START -->',
        endMarker: '<!-- END -->',
      };
    `);
    const docPath = path.join(tmpDir, 'docs', 'race.md');
    writeFileSync(docPath, '---\ntype: plan\nstatus: active\ntitle: Race\nupdated: 2025-01-01\n---\n# Race\n');
    const indexPath = path.join(tmpDir, 'docs', 'docs.md');
    writeFileSync(indexPath, '# Docs\n\n<!-- START -->\n\nstale\n\n<!-- END -->\n');
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });
    const config = await resolveConfig(tmpDir, path.join(tmpDir, 'dotmd.config.mjs'));

    runDoctor([], config, {
      dryRun: false,
      testHooks: { beforeMutationSnapshot: () => {
        writeFileSync(docPath, readFileSync(docPath, 'utf8').replace('status: active', 'status: planned'));
      } },
    });

    const rendered = readFileSync(indexPath, 'utf8');
    ok(rendered.includes('## Planned'), rendered);
    ok(!rendered.includes('## Active'), rendered);
  });

  it('runs all steps without crashing', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n');
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const result = run(['doctor']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('dotmd doctor'), 'shows heading');
    ok(result.stdout.includes('Fixing broken references'), 'step 1');
    ok(result.stdout.includes('Fixing frontmatter issues'), 'step 2');
    ok(result.stdout.includes('Syncing dates from git'), 'step 3');
    ok(result.stdout.includes('Remaining issues'), 'step 5');
  });

  it('dry-run does not modify files', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n');
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const result = run(['doctor', '--dry-run']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('dotmd doctor'), 'shows heading');
  });

  it('F4: default `dotmd doctor` previews — shows preview banner and does not write', () => {
    // 0.37.0 (F4): default mode is dry-run. Without --apply, files must stay
    // byte-identical. Test that the banner names the right flag so users
    // can self-correct.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    // Seed a doc with a fixable issue (camelCase key) so lint --fix would normally rewrite it.
    const docPath = path.join(tmpDir, 'docs', 'a.md');
    const before = '---\nstatus: active\nupdated: 2025-01-01\nnextStep: do it\n---\n# A\n';
    writeFileSync(docPath, before);
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const result = run(['doctor']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('preview'), `banner should say preview; got: ${result.stdout}`);
    ok(result.stdout.includes('--apply'), `banner should name --apply; got: ${result.stdout}`);

    const after = readFileSync(docPath, 'utf8');
    strictEqual(after, before, 'file must be untouched in preview mode');
  });

  it('default preview discloses skipped custom validation and rendering hooks', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    const sentinel = path.join(tmpDir, 'hook-sentinel');
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      import { appendFileSync } from 'node:fs';
      export const root = 'docs';
      export function validate() { appendFileSync(${JSON.stringify(sentinel)}, 'validate'); return {}; }
      export function transformDoc(doc) { appendFileSync(${JSON.stringify(sentinel)}, 'transform'); return doc; }
      export function renderCheck(index, fallback) { appendFileSync(${JSON.stringify(sentinel)}, 'render'); return fallback(index); }
    `);
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n');
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const result = run(['doctor']);
    strictEqual(result.status, 0, result.stderr);
    ok(result.stdout.includes('Custom validate, transformDoc, renderCheck hooks skipped'), result.stdout);
    ok(result.stdout.includes('built-in behavior only'), result.stdout);
    ok(!existsSync(sentinel), 'preview did not invoke custom hooks');
  });

  it('F4: `dotmd doctor --apply` writes — shows applying banner and modifies files', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    const docPath = path.join(tmpDir, 'docs', 'a.md');
    writeFileSync(docPath, '---\nstatus: active\nupdated: 2025-01-01\nnextStep: do it\n---\n# A\n');
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const result = run(['doctor', '--apply']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('applying'), `banner should say applying; got: ${result.stdout}`);

    const after = readFileSync(docPath, 'utf8');
    ok(after.includes('next_step: do it'), 'lint --fix should have rewritten the camelCase key');
    ok(!after.includes('nextStep:'), 'camelCase key should be gone');
  });

  it('includes long-frontmatter repair in the default apply pass', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    const docPath = path.join(tmpDir, 'docs', 'long.md');
    const longState = 'A substantive sentence with enough detail. '.repeat(50);
    writeFileSync(docPath, `---\ntype: plan\nstatus: active\nupdated: 2025-01-01\ncurrent_state: "${longState}"\n---\n# Long\n`);
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const result = run(['doctor', '--apply']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const after = readFileSync(docPath, 'utf8');
    ok(after.includes('## Current State'), after);
  });

  it('keeps preview and closeout file counts aligned for lint and long-frontmatter fixes', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    const longState = 'A sentence that belongs partly in the body. '.repeat(50);
    writeFileSync(path.join(tmpDir, 'docs', 'drift.md'), `---\ntype: plan\nstatus: active\nupdated: 2025-01-01\nmodule:\nmodules:\n  - platform\nsurface:\nsurfaces:\n  - web\ncurrent_state: "${longState}"\n---\n# Drift\n`);
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const result = run(['doctor']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('2 fixes applied across 1 file(s)'), result.stdout);
    ok(result.stdout.includes('1 file(s) with over-cap fields'), result.stdout);
    ok(result.stdout.includes('dotmd lint --fix (1 file:'), result.stdout);
    ok(result.stdout.includes('dotmd doctor --frontmatter-fix (1 file:'), result.stdout);
  });

  it('keeps archived singular keys out of both lint preview and closeout counts', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    mkdirSync(path.join(tmpDir, 'docs', 'archive'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    writeFileSync(path.join(tmpDir, 'docs', 'archive', 'old.md'), '---\ntype: plan\nstatus: archived\nupdated: 2025-01-01\nsurface:\nsurfaces:\n  - web\n---\n# Old\n\n## Closeout\n\nShipped.\n');
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const result = run(['doctor']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('0 fixes applied across 0 file(s)'), result.stdout);
    ok(!result.stdout.includes('dotmd lint --fix ('), result.stdout);
  });

  it('F4: `--yes` is an alias for `--apply`', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    const docPath = path.join(tmpDir, 'docs', 'a.md');
    writeFileSync(docPath, '---\nstatus: active\nupdated: 2025-01-01\nnextStep: do it\n---\n# A\n');
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const result = run(['doctor', '--yes']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('applying'), 'banner says applying');
    const after = readFileSync(docPath, 'utf8');
    ok(after.includes('next_step: do it'), '--yes triggers writes like --apply');
  });

  it('F4: --dry-run wins over --apply (explicit safety prevails)', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    const docPath = path.join(tmpDir, 'docs', 'a.md');
    const before = '---\nstatus: active\nupdated: 2025-01-01\nnextStep: do it\n---\n# A\n';
    writeFileSync(docPath, before);
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const result = run(['doctor', '--apply', '--dry-run']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('preview'), 'banner stays preview when both flags present');
    const after = readFileSync(docPath, 'utf8');
    strictEqual(after, before, 'file must be untouched when --dry-run wins');
  });

  it('numbered steps are contiguous (1 through 8)', () => {
    // Pre-fix: step 5's heading was conditional on having Claude command
    // changes to report. On a repo with no `.claude/` dir (or already-current
    // commands), `5.` was silently skipped — output went `1, 2, 3, 4, 6` and
    // looked like a bug. Always-print fix: heading always shows; body says
    // "Nothing to refresh." when there's nothing to do.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n');
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const result = run(['doctor']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    // Verify all eight step headings appear in order.
    const steps = ['1.', '2.', '3.', '4.', '5.', '6.', '7.', '8.'];
    let lastIdx = -1;
    for (const step of steps) {
      const idx = result.stdout.indexOf(step);
      ok(idx > lastIdx, `step ${step} should appear in order; got: ${result.stdout}`);
      lastIdx = idx;
    }
    ok(result.stdout.includes('7. Claude Code commands'),
      `step 7 heading should print even with no .claude/ dir; got: ${result.stdout}`);
  });

  it('briefing Errors line hints at `dotmd check` when errors exist', () => {
    // Pre-fix: `Errors: 1` with no detail — user had to guess what or where.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    // A doc that will fail validation: status not in the configured set.
    writeFileSync(
      path.join(tmpDir, 'docs', 'bad.md'),
      '---\ntype: plan\nstatus: nonsense-status\nupdated: 2025-01-01\n---\n# Bad\n',
    );

    const result = run(['briefing']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    // When errors exist, the hint should be inline.
    ok(/Errors:\s*[1-9]/.test(result.stdout),
      `expected non-zero error count in briefing; got: ${result.stdout}`);
    ok(result.stdout.includes('run `dotmd check` to see'),
      'expected dotmd check hint inline; got: ' + result.stdout);
  });

  it('briefing Errors line stays terse when there are no errors', () => {
    // No hint when there's nothing to see — keeps the clean-state line clean.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    writeFileSync(
      path.join(tmpDir, 'docs', 'ok.md'),
      '---\ntype: plan\nstatus: active\nupdated: 2025-01-01\ntitle: OK\nsummary: fine\n---\n# OK\n',
    );

    const result = run(['briefing']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(/Errors:\s*0/.test(result.stdout),
      `expected zero error count; got: ${result.stdout}`);
    ok(!result.stdout.includes('run `dotmd check` to see'),
      `should not show hint when zero errors; got: ${result.stdout}`);
  });

  it('--help shows doctor help', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);

    const result = run(['doctor', '--help']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('auto-fix everything'), 'shows doctor help');
    ok(result.stdout.includes('--statuses'), 'mentions --statuses mode');
  });

  it('doctor --project reports CLI/dependency skew inputs', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ devDependencies: { 'dotmd-cli': '^0.42.1' } }));

    const result = run(['doctor', '--project']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('running CLI version'), result.stdout);
    ok(result.stdout.includes('^0.42.1'), result.stdout);
  });
});

describe('doctor --statuses', () => {
  it('does not flag a bucket below the 10-plan threshold', () => {
    setupStatusesProject();
    for (let i = 0; i < 5; i++) {
      writePlan(`p${i}`, 'backlog', 'shipped most of the work, tail deferred');
    }

    const result = run(['doctor', '--statuses']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('No overloaded'), 'small bucket is not flagged');
  });

  it('does not flag a bucket where every plan matches the same cue', () => {
    setupStatusesProject();
    for (let i = 0; i < 14; i++) {
      writePlan(`p${i}`, 'backlog', 'shipped most of the plan; tail deferred to follow-up');
    }

    const result = run(['doctor', '--statuses']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('No overloaded'), 'one consistent cue → no split suggestion');
  });

  it('flags a bucket with two distinct cues above the floor', () => {
    setupStatusesProject();
    // 6 plans with partial cues
    for (let i = 0; i < 6; i++) {
      writePlan(`partial${i}`, 'backlog', 'shipped most of the plan; tail deferred');
    }
    // 5 plans with paused cues
    for (let i = 0; i < 5; i++) {
      writePlan(`paused${i}`, 'backlog', 'on hold pending re-evaluation; set aside');
    }

    const result = run(['doctor', '--statuses']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('11'), 'reports total bucket size of 11');
    ok(result.stdout.includes('backlog'), 'identifies the bucket');
    ok(/~\s*6 → partial/.test(result.stdout), 'suggests 6 → partial');
    ok(/~\s*5 → paused/.test(result.stdout), 'suggests 5 → paused');
    ok(result.stdout.includes('Heuristic'), 'hedges with "Heuristic — verify before migrating."');
  });

  it('--json output is parseable and stable', () => {
    setupStatusesProject();
    for (let i = 0; i < 6; i++) {
      writePlan(`partial${i}`, 'backlog', 'shipped most of the plan; tail deferred');
    }
    for (let i = 0; i < 5; i++) {
      writePlan(`paused${i}`, 'backlog', 'on hold pending re-evaluation; set aside');
    }

    const result = run(['doctor', '--statuses', '--json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const data = JSON.parse(result.stdout);
    ok(data.thresholds, 'has thresholds block');
    strictEqual(data.thresholds.minBucketSize, 10);
    ok(Array.isArray(data.suggestions), 'suggestions is an array');
    strictEqual(data.suggestions.length, 1, 'one bucket flagged');

    const sug = data.suggestions[0];
    strictEqual(sug.status, 'backlog');
    strictEqual(sug.type, 'plan');
    strictEqual(sug.total, 11);

    const targets = sug.splits.map(s => s.target).sort();
    deepStrictEqual(targets, ['partial', 'paused']);

    const partialSplit = sug.splits.find(s => s.target === 'partial');
    const pausedSplit = sug.splits.find(s => s.target === 'paused');
    strictEqual(partialSplit.count, 6);
    strictEqual(pausedSplit.count, 5);
  });

  it('keeps unmatched plans in the original bucket (does not force-bucket them)', () => {
    setupStatusesProject();
    for (let i = 0; i < 6; i++) {
      writePlan(`partial${i}`, 'backlog', 'shipped most of the plan; tail deferred');
    }
    for (let i = 0; i < 5; i++) {
      writePlan(`paused${i}`, 'backlog', 'on hold pending re-evaluation; set aside');
    }
    // 3 plans with no cue matches at all — should land in "kept"
    for (let i = 0; i < 3; i++) {
      writePlan(`unmatched${i}`, 'backlog', 'placeholder text with no signal words');
    }

    const result = run(['doctor', '--statuses', '--json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const data = JSON.parse(result.stdout);
    strictEqual(data.suggestions[0].kept, 3, '3 unmatched plans stay in original bucket');
    strictEqual(data.suggestions[0].total, 14);
  });

  it('plain `doctor` (no --statuses) still runs the auto-fix pass', () => {
    setupStatusesProject();
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    writePlan('a', 'active', 'placeholder');
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const result = run(['doctor']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Fixing broken references'), 'still runs auto-fix step 1');
    ok(result.stdout.includes('Remaining issues'), 'still runs final check');
    ok(!result.stdout.includes('Heuristic'), 'does not run --statuses diagnostic');
  });
});

describe('doctor --frontmatter-fix', () => {
  function setupPlanProject() {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-fmfix-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
  }

  function writeLongPlan(name, currentStateLen, nextStepLen = 0) {
    // Build sentence-rich text so the splitter has clean boundaries.
    const sentence = 'The quick brown fox jumps over the lazy dog. ';
    const currentState = sentence.repeat(Math.ceil(currentStateLen / sentence.length)).slice(0, currentStateLen);
    const nextStep = nextStepLen ? sentence.repeat(Math.ceil(nextStepLen / sentence.length)).slice(0, nextStepLen) : '';
    const lines = [
      '---',
      'type: plan',
      'status: active',
      'updated: 2026-05-26',
      `current_state: "${currentState.replace(/"/g, '\\"')}"`,
    ];
    if (nextStep) lines.push(`next_step: "${nextStep.replace(/"/g, '\\"')}"`);
    lines.push('---', `# ${name}`, '', '## Problem', 'Body text.', '');
    writeFileSync(path.join(tmpDir, 'docs', 'plans', `${name}.md`), lines.join('\n'));
  }

  it('does nothing when no fields are over-cap', () => {
    setupPlanProject();
    writeLongPlan('short', 100, 50);

    const result = run(['doctor', '--frontmatter-fix']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('No over-cap'), `expected no-op message; got: ${result.stdout}`);
  });

  it('skips over-cap fields on archived plans because validation does not warn for them', () => {
    setupPlanProject();
    const sentence = 'Archived detail that should remain historical. '.repeat(50);
    writeFileSync(path.join(tmpDir, 'docs', 'plans', 'archived.md'), `---\ntype: plan\nstatus: archived\nupdated: 2026-05-26\ncurrent_state: "${sentence}"\n---\n# Archived\n`);

    const result = run(['doctor', '--frontmatter-fix', '--dry-run']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('No over-cap fields found'), result.stdout);
  });

  it('shrinks current_state and inserts a `## Current State` section', () => {
    setupPlanProject();
    writeLongPlan('long-cs', 1700);
    const planPath = path.join(tmpDir, 'docs', 'plans', 'long-cs.md');

    const result = run(['doctor', '--frontmatter-fix']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('long-cs.md'), `should list the touched file; got: ${result.stdout}`);
    ok(result.stdout.includes('current_state'), 'mentions the field');

    const after = readFileSync(planPath, 'utf8');
    // Re-parse to confirm field shrank under cap.
    const fmEnd = after.indexOf('\n---\n', 4);
    const fmBlock = after.slice(4, fmEnd);
    const csLine = fmBlock.split('\n').find(l => l.startsWith('current_state:'));
    ok(csLine.endsWith('>'), `expected folded block scalar; got: ${csLine}`);
    ok(after.includes('## Current State'), 'body has the new section');
    // Tail content lives in the section.
    const bodyAfter = after.slice(fmEnd + 5);
    const csSectionIdx = bodyAfter.indexOf('## Current State');
    ok(csSectionIdx >= 0, 'section is in body');
    ok(csSectionIdx < bodyAfter.indexOf('## Problem'), 'section sits above first existing H2');
  });

  it('preserves top-level frontmatter comments after a long block scalar', () => {
    setupPlanProject();
    const longState = 'Long current state sentence. '.repeat(80);
    const planPath = path.join(tmpDir, 'docs', 'plans', 'commented.md');
    writeFileSync(planPath, `---\ntype: plan\nstatus: active\nupdated: 2026-05-26\ncurrent_state: >\n  ${longState}\n# Keep this metadata note\nnext_step: Review the result.\n---\n# Commented\n`);

    const result = run(['doctor', '--frontmatter-fix']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const after = readFileSync(planPath, 'utf8');
    ok(after.includes('# Keep this metadata note'), after);
    ok(after.includes('next_step: Review the result.'), after);
  });

  it('shrinks next_step independently of current_state', () => {
    setupPlanProject();
    writeLongPlan('long-ns', 100, 900);
    const planPath = path.join(tmpDir, 'docs', 'plans', 'long-ns.md');

    const result = run(['doctor', '--frontmatter-fix']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('next_step'), 'mentions the next_step fix');
    const after = readFileSync(planPath, 'utf8');
    ok(after.includes('## Next Step'), 'body has Next Step section');
    ok(!after.includes('## Current State'), 'untouched fields do not get sections');
  });

  it('--dry-run does not modify files', () => {
    setupPlanProject();
    writeLongPlan('preview', 1700);
    const planPath = path.join(tmpDir, 'docs', 'plans', 'preview.md');
    const before = readFileSync(planPath, 'utf8');

    const result = run(['doctor', '--frontmatter-fix', '--dry-run']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('preview'), 'banner shows preview mode');
    const after = readFileSync(planPath, 'utf8');
    strictEqual(after, before, 'file is byte-identical in dry-run');
  });

  it('reports a dead session\'s claim and releases it only with --apply', async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-claims-'));
    spawnSync('git', ['init', '-q'], { cwd: tmpDir });
    mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), "export const root = 'docs';\n");
    const planPath = path.join(tmpDir, 'docs', 'plans', 'wedged.md');
    writeFileSync(planPath, '---\ntype: plan\nstatus: active\ntitle: wedged\nupdated: 2025-01-01T00:00:00Z\ncurrent_state: testing\n---\n# wedged\n\n## Version History\n\n- **2025-01-01T00:00:00Z** Created.\n');

    const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    const claim = spawnSync('node', [path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs'),
      'use', 'docs/plans/wedged.md', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', CLAUDE_CODE_SESSION_ID: 'gone', DOTMD_SESSION_PID: String(victim.pid) },
    });
    strictEqual(claim.status, 0, claim.stderr);

    // Alive: reported, never released, even though --apply was passed.
    const alive = run(['doctor', '--claims', '--apply']);
    ok(alive.stdout.includes('owner live'), alive.stdout);
    ok(readFileSync(planPath, 'utf8').includes('status: in-session'));

    await new Promise(resolve => { victim.on('exit', resolve); victim.kill('SIGKILL'); });

    // Dead: reported as such, but a preview run still writes nothing.
    const preview = run(['doctor', '--claims']);
    ok(preview.stdout.includes('owner dead'), preview.stdout);
    ok(preview.stdout.includes('--claims --apply'), preview.stdout);
    ok(readFileSync(planPath, 'utf8').includes('status: in-session'), 'preview must not release');

    const applied = run(['doctor', '--claims', '--apply']);
    ok(applied.stdout.includes('Released 1 claim'), applied.stdout);
    ok(readFileSync(planPath, 'utf8').includes('status: active'));
    ok(run(['doctor', '--claims']).stdout.includes('No plans are claimed'));
  });

  it('never releases an unjudgeable claim without an explicit --older-than', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-claims-legacy-'));
    spawnSync('git', ['init', '-q'], { cwd: tmpDir });
    mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), "export const root = 'docs';\n");
    const planPath = path.join(tmpDir, 'docs', 'plans', 'legacy.md');
    writeFileSync(planPath, '---\ntype: plan\nstatus: active\ntitle: legacy\nupdated: 2025-01-01T00:00:00Z\ncurrent_state: testing\n---\n# legacy\n\n## Version History\n\n- **2025-01-01T00:00:00Z** Created.\n');
    spawnSync('node', [path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs'),
      'use', 'docs/plans/legacy.md', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', CLAUDE_CODE_SESSION_ID: 'gone', DOTMD_SESSION_PID: '' },
    });

    // Strip the owner the way every record written before this feature looks.
    const recordDir = path.join(tmpDir, '.dotmd', 'ownership');
    const recordPath = path.join(recordDir, readdirSync(recordDir)[0]);
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    delete record.sessionOwner;
    record.updatedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(recordPath, JSON.stringify(record, null, 2));

    const applied = run(['doctor', '--claims', '--apply']);
    ok(applied.stdout.includes('owner unverifiable'), applied.stdout);
    ok(!applied.stdout.includes('Released'), 'unverifiable claims are not dotmd\'s to release');
    ok(readFileSync(planPath, 'utf8').includes('status: in-session'));

    const policy = run(['doctor', '--claims', '--apply', '--older-than', '24h']);
    ok(policy.stdout.includes('Released 1 claim'), policy.stdout);
    ok(readFileSync(planPath, 'utf8').includes('status: active'));
  });

  // Found in the field: two of fourteen platform claims pinned plans that had
  // been deleted, so every --apply hit "File not found" from runSet and the
  // records survived. They also poison the path: the key is a hash of it, so a
  // plan later created there reads as owned by a session long gone.
  it('releases a claim whose plan file has vanished', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-claims-orphan-'));
    spawnSync('git', ['init', '-q'], { cwd: tmpDir });
    mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), "export const root = 'docs';\n");
    const planPath = path.join(tmpDir, 'docs', 'plans', 'deleted.md');
    writeFileSync(planPath, '---\ntype: plan\nstatus: active\ntitle: deleted\nupdated: 2025-01-01T00:00:00Z\ncurrent_state: testing\n---\n# deleted\n\n## Version History\n\n- **2025-01-01T00:00:00Z** Created.\n');
    spawnSync('node', [path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs'),
      'use', 'docs/plans/deleted.md', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', CLAUDE_CODE_SESSION_ID: 'gone', DOTMD_SESSION_PID: '' },
    });

    const recordDir = path.join(tmpDir, '.dotmd', 'ownership');
    const recordPath = path.join(recordDir, readdirSync(recordDir)[0]);
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    record.updatedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
    rmSync(planPath); // deleted outside dotmd — `rename` would have carried the record

    const applied = run(['doctor', '--claims', '--apply', '--older-than', '24h']);
    ok(applied.stdout.includes('Released 1 claim'), applied.stdout);
    ok(applied.stdout.includes('no longer exists'), `release must not claim the plan is active: ${applied.stdout}`);
    strictEqual(JSON.parse(readFileSync(recordPath, 'utf8')).state, 'released');
    ok(run(['doctor', '--claims']).stdout.includes('No plans are claimed'), 'the orphan must not survive the sweep');

    // The poisoned path is usable again: a plan recreated there is not born wedged.
    writeFileSync(planPath, '---\ntype: plan\nstatus: active\ntitle: deleted\nupdated: 2025-01-01T00:00:00Z\ncurrent_state: testing\n---\n# deleted\n\n## Version History\n\n- **2025-01-01T00:00:00Z** Created.\n');
    const reuse = spawnSync('node', [path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs'),
      'use', 'docs/plans/deleted.md', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', CLAUDE_CODE_SESSION_ID: 'fresh', DOTMD_SESSION_PID: '' },
    });
    strictEqual(reuse.status, 0, reuse.stderr);
  });

  // CI caught this: the repair demanded an *authoritative* session identity of
  // the operator, so it could not run from any shell without one — a bare login
  // shell, cron, a container. Exactly where you unwedge a repo from.
  it('releases from a shell with no session identity of its own', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-claims-nosession-'));
    spawnSync('git', ['init', '-q'], { cwd: tmpDir });
    mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), "export const root = 'docs';\n");
    const planPath = path.join(tmpDir, 'docs', 'plans', 'stranded.md');
    writeFileSync(planPath, '---\ntype: plan\nstatus: active\ntitle: stranded\nupdated: 2025-01-01T00:00:00Z\ncurrent_state: testing\n---\n# stranded\n\n## Version History\n\n- **2025-01-01T00:00:00Z** Created.\n');
    spawnSync('node', [path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs'),
      'use', 'docs/plans/stranded.md', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', CLAUDE_CODE_SESSION_ID: 'gone', DOTMD_SESSION_PID: '' },
    });
    const recordDir = path.join(tmpDir, '.dotmd', 'ownership');
    const recordPath = path.join(recordDir, readdirSync(recordDir)[0]);
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    record.updatedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');

    // Every identity source stripped — the shape a Linux CI runner actually has.
    const bare = { ...process.env, NO_COLOR: '1' };
    for (const key of ['DOTMD_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID',
      'OPENCODE_SESSION_ID', 'OPENCODE_SESSION', 'TERM_SESSION_ID']) delete bare[key];
    const applied = spawnSync('node', [path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs'),
      'doctor', '--claims', '--apply', '--older-than', '24h', '--config', path.join(tmpDir, 'dotmd.config.mjs')],
      { cwd: tmpDir, encoding: 'utf8', env: bare });
    ok(applied.stdout.includes('Released 1 claim'), `${applied.stdout}\n${applied.stderr}`);
    ok(readFileSync(planPath, 'utf8').includes('status: active'));
  });

  it('refuses to shortcut the release when the plan is still there', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-doctor-claims-present-'));
    spawnSync('git', ['init', '-q'], { cwd: tmpDir });
    mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), "export const root = 'docs';\n");
    const planPath = path.join(tmpDir, 'docs', 'plans', 'present.md');
    writeFileSync(planPath, '---\ntype: plan\nstatus: active\ntitle: present\nupdated: 2025-01-01T00:00:00Z\ncurrent_state: testing\n---\n# present\n\n## Version History\n\n- **2025-01-01T00:00:00Z** Created.\n');
    spawnSync('node', [path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs'),
      'use', 'docs/plans/present.md', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', CLAUDE_CODE_SESSION_ID: 'gone', DOTMD_SESSION_PID: '' },
    });
    const recordDir = path.join(tmpDir, '.dotmd', 'ownership');
    const recordPath = path.join(recordDir, readdirSync(recordDir)[0]);
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    record.updatedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');

    // A live plan takes the status-writing path, so the file must actually move.
    const applied = run(['doctor', '--claims', '--apply', '--older-than', '24h']);
    ok(applied.stdout.includes('is active again'), applied.stdout);
    ok(!applied.stdout.includes('no longer exists'), applied.stdout);
    ok(readFileSync(planPath, 'utf8').includes('status: active'));
  });

  it('clears the validatePlanShape warning after the fix', () => {
    setupPlanProject();
    writeLongPlan('verify', 1700, 900);

    // Sanity-check: pre-fix, `check --verbose` reports both length warnings.
    const before = run(['check', '--verbose']);
    ok(before.stdout.includes('current_state` is') || before.stderr.includes('current_state'),
      `pre-fix should warn about current_state length; got: ${before.stdout}\n${before.stderr}`);

    const fix = run(['doctor', '--frontmatter-fix']);
    strictEqual(fix.status, 0, `stderr: ${fix.stderr}`);

    const after = run(['check', '--verbose']);
    ok(!after.stdout.includes('cap: 1500') && !after.stdout.includes('cap: 800'),
      `post-fix should clear length warnings; got: ${after.stdout}`);
  });
});
