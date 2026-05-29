import { describe, it, afterEach } from 'node:test';
import { ok, strictEqual, match } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

let tmpDir;
let docsDir;
let plansDir;
let configPath;

function setupFiledProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-filed-'));
  spawnSync('git', ['init', '-q'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: tmpDir });

  docsDir = path.join(tmpDir, 'docs');
  plansDir = path.join(docsDir, 'plans');
  mkdirSync(plansDir, { recursive: true });
  mkdirSync(path.join(docsDir, 'archived'), { recursive: true });

  configPath = path.join(tmpDir, 'dotmd.config.mjs');
  // Config: declare a `backlog` status with `filed: true` on the plan type.
  // This is the canonical F15 use case (parked plans land in a backlog/ dir
  // without churning the active set).
  writeFileSync(configPath, `
export const root = 'docs';
export const types = {
  plan: {
    statuses: {
      active: { context: 'expanded' },
      backlog: { filed: true, staleDays: 60 },
      archived: { archive: true, terminal: true, quiet: true },
    },
  },
};
`);
}

function writePlan(name, status = 'active', currentState = 'live') {
  const file = path.join(plansDir, `${name}.md`);
  const fm = [
    'type: plan',
    `status: ${status}`,
    'created: 2026-01-01',
    'updated: 2026-01-01',
    'modules:',
    '  - none',
    `current_state: ${currentState}`,
  ].join('\n');
  writeFileSync(file, `---\n${fm}\n---\n# ${name}\n`);
  spawnSync('git', ['add', file], { cwd: tmpDir });
  spawnSync('git', ['commit', '-qm', `add ${name}`], { cwd: tmpDir });
  return file;
}

function run(args) {
  return spawnSync('node', [bin, ...args, '--config', configPath], {
    cwd: tmpDir, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

describe('F15: filed-primitive', () => {
  it('transition INTO a filed status moves the file into the type folder bucket', () => {
    setupFiledProject();
    const file = writePlan('alpha');
    const r = run(['set', 'backlog', file]);
    strictEqual(r.status, 0, `set backlog should succeed: ${r.stderr}`);
    const expected = path.join(plansDir, 'backlog','alpha.md');
    ok(existsSync(expected), `expected file at ${expected}, stderr=${r.stderr}`);
    ok(!existsSync(file), 'original flat file should have moved');
    match(readFileSync(expected, 'utf8'), /status: backlog/);
  });

  it('transition OUT of a filed status moves the file back to the type folder', () => {
    setupFiledProject();
    const file = writePlan('beta');
    run(['set', 'backlog', file]);  // file in plans/backlog/beta.md
    const filed = path.join(plansDir, 'backlog','beta.md');
    const r = run(['set', 'active', filed]);
    strictEqual(r.status, 0, `set active should succeed: ${r.stderr}`);
    const back = path.join(plansDir, 'beta.md');
    ok(existsSync(back), `expected file back at ${back}, stderr=${r.stderr}`);
    ok(!existsSync(filed), 'filed location should be empty');
    match(readFileSync(back, 'utf8'), /status: active/);
  });

  it('transition between filed-status and archive status uses archive path (file goes to archived/)', () => {
    setupFiledProject();
    const file = writePlan('gamma');
    run(['set', 'backlog', file]);
    const filed = path.join(plansDir, 'backlog','gamma.md');
    const r = run(['set', 'archived', filed]);
    strictEqual(r.status, 0, `set archived should succeed: ${r.stderr}`);
    const archived = path.join(docsDir, 'archived', 'gamma.md');
    ok(existsSync(archived), `expected file at ${archived}, stderr=${r.stderr}`);
    ok(!existsSync(filed), 'filed location should be empty');
  });

  it('plain archive: true behavior unchanged when no filed statuses are configured', () => {
    // Smoke test: a config with NO filed statuses must produce identical
    // behavior to historical archive paths. Uses minimal config (no types
    // override) — archive: true comes from defaults.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-noarch-'));
    spawnSync('git', ['init', '-q'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'T'], { cwd: tmpDir });
    docsDir = path.join(tmpDir, 'docs');
    plansDir = path.join(docsDir, 'plans');
    mkdirSync(plansDir, { recursive: true });
    configPath = path.join(tmpDir, 'dotmd.config.mjs');
    writeFileSync(configPath, `export const root = 'docs';\n`);
    const file = writePlan('classic');

    const r = run(['set', 'archived', file]);
    strictEqual(r.status, 0, `archive transition should succeed: ${r.stderr}`);
    const expected = path.join(docsDir, 'archived', 'classic.md');
    ok(existsSync(expected), `expected classic archive at ${expected}`);
  });

  it('default paused plans move into docs/plans/held/', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-held-plan-'));
    spawnSync('git', ['init', '-q'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'T'], { cwd: tmpDir });
    docsDir = path.join(tmpDir, 'docs');
    plansDir = path.join(docsDir, 'plans');
    mkdirSync(plansDir, { recursive: true });
    configPath = path.join(tmpDir, 'dotmd.config.mjs');
    writeFileSync(configPath, `export const root = 'docs';\n`);
    const file = writePlan('pause-me');

    const r = run(['set', 'paused', file]);
    strictEqual(r.status, 0, `set paused should succeed: ${r.stderr}`);
    const expected = path.join(plansDir, 'held', 'pause-me.md');
    ok(existsSync(expected), `expected paused plan at ${expected}`);
    match(readFileSync(expected, 'utf8'), /status: paused/);
  });

  it('docs in filed bucket dirs do not trigger archive-drift validator errors', () => {
    setupFiledProject();
    const file = writePlan('delta');
    run(['set', 'backlog', file]);
    const r = run(['check']);
    // backlog status on a doc in plans/backlog/delta.md is the expected state
    // — neither forward nor inverse drift should fire.
    strictEqual(r.status, 0, `check should pass for legitimately filed doc: ${r.stdout}\n${r.stderr}`);
  });
});
