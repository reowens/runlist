import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

function setup() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-health-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
  return path.join(tmpDir, 'docs');
}

function writeDoc(docsDir, name, frontmatter, body = '') {
  writeFileSync(path.join(docsDir, name), `---\n${frontmatter}\n---\n${body}`);
}

function run(args) {
  return spawnSync('node', [BIN, ...args], {
    cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('health command', () => {
  it('shows Plan Health heading', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01\ncreated: 2025-01-01', '# A');
    const result = run(['health']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Plan Health'));
  });

  it('shows pipeline status distribution', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01\ncreated: 2025-01-01', '# A');
    writeDoc(docsDir, 'b.md', 'type: plan\nstatus: planned\nupdated: 2025-01-01\ncreated: 2025-01-01', '# B');
    const result = run(['health']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Pipeline'));
    ok(result.stdout.includes('active'));
    ok(result.stdout.includes('planned'));
  });

  it('shows active plan aging', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01\ncreated: 2024-01-01', '# Old Plan');
    const result = run(['health']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Active plans'));
    ok(result.stdout.includes('Avg age'));
  });

  it('shows velocity section', () => {
    const docsDir = setup();
    const today = new Date().toISOString().slice(0, 10);
    writeDoc(docsDir, 'a.md', `type: plan\nstatus: archived\nupdated: ${today}\ncreated: 2025-01-01`, '# Done Plan');
    const result = run(['health']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Velocity'));
  });

  it('handles empty project (no plans)', () => {
    setup();
    const result = run(['health']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Plan Health'));
    ok(result.stdout.includes('Velocity'));
  });

  it('excludes type: doc from plan health', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'type: doc\nstatus: active\nupdated: 2025-01-01', '# A Doc');
    const result = run(['health', '--json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    strictEqual(json.totalPlans, 0);
  });

  it('shows blocked plan count', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'type: plan\nstatus: blocked\nupdated: 2025-01-01\ncreated: 2025-01-01', '# Stuck');
    const result = run(['health']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Blocked'));
  });
});

describe('health --json', () => {
  it('produces valid JSON with all fields', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01\ncreated: 2025-01-01', '# A');
    const result = run(['health', '--json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    ok('totalPlans' in json);
    ok('byStatus' in json);
    ok('active' in json);
    ok('paused' in json);
    ok('blocked' in json);
    ok('ready' in json);
    ok('planned' in json);
    ok('recentlyArchived' in json);
  });

  it('counts plans by status', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01\ncreated: 2025-01-01', '# A');
    writeDoc(docsDir, 'b.md', 'type: plan\nstatus: active\nupdated: 2025-01-01\ncreated: 2025-01-01', '# B');
    writeDoc(docsDir, 'c.md', 'type: plan\nstatus: planned\nupdated: 2025-01-01\ncreated: 2025-01-01', '# C');
    const result = run(['health', '--json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    strictEqual(json.byStatus.active, 2);
    strictEqual(json.byStatus.planned, 1);
    strictEqual(json.totalPlans, 3);
  });

  it('computes active plan ages from created date', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01\ncreated: 2025-01-01', '# A');
    const result = run(['health', '--json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    strictEqual(json.active.count, 1);
    ok(json.active.ages.length === 1);
    ok(json.active.avgAge > 0);
    ok(json.active.maxAge > 0);
  });

  it('returns null ages when no created dates', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# A');
    const result = run(['health', '--json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    strictEqual(json.active.ages.length, 0);
    strictEqual(json.active.avgAge, null);
    strictEqual(json.active.maxAge, null);
  });

  it('computes avgChecklistCompletion', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01\ncreated: 2025-01-01', '# A\n- [x] done\n- [ ] open');
    const result = run(['health', '--json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    strictEqual(json.active.avgChecklistCompletion, 50);
  });

  it('returns null avgChecklistCompletion when no checklists', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01\ncreated: 2025-01-01', '# A\nNo checklist here');
    const result = run(['health', '--json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    strictEqual(json.active.avgChecklistCompletion, null);
  });

  it('includes recently archived within last 30d', () => {
    const docsDir = setup();
    const today = new Date().toISOString().slice(0, 10);
    writeDoc(docsDir, 'done.md', `type: plan\nstatus: archived\nupdated: ${today}\ncreated: 2025-01-01`, '# Done');
    writeDoc(docsDir, 'old.md', 'type: plan\nstatus: archived\nupdated: 2020-01-01\ncreated: 2020-01-01', '# Old');
    const result = run(['health', '--json']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    strictEqual(json.recentlyArchived.count, 1);
    ok(json.recentlyArchived.last30d.includes('done'));
  });
});

describe('health plan filtering', () => {
  it('includes type: plan docs', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# A');
    const result = run(['health', '--json']);
    const json = JSON.parse(result.stdout);
    strictEqual(json.totalPlans, 1);
  });

  it('excludes type: doc and type: research', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'type: doc\nstatus: active\nupdated: 2025-01-01', '# A');
    writeDoc(docsDir, 'b.md', 'type: research\nstatus: active\nupdated: 2025-01-01', '# B');
    const result = run(['health', '--json']);
    const json = JSON.parse(result.stdout);
    strictEqual(json.totalPlans, 0);
  });
});
