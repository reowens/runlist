import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

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
