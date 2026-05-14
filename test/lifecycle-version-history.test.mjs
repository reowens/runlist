import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

let tmpDir;
const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-vh-'));
  spawnSync('git', ['init'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: tmpDir });
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(path.join(docsDir, 'archived'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\n`);
  return docsDir;
}

function writePlan(docsDir, filename, frontmatter, body) {
  const filePath = path.join(docsDir, filename);
  writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`);
  spawnSync('git', ['add', filePath], { cwd: tmpDir });
  spawnSync('git', ['commit', '-m', `add ${filename}`], { cwd: tmpDir });
  return filePath;
}

function runCli(args, { session = 'sess-A', input } = {}) {
  return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
    cwd: tmpDir, encoding: 'utf8', input,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: session, PATH: process.env.PATH },
  });
}

const baseBody = `# Plan\n\n## Phases\n\n### Phase 1 ⬜\n\n## Version History\n\n- **2026-05-01T00:00:00Z** Created.\n\n## Closeout\n`;

afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

describe('auto Version History on lifecycle commands', () => {
  it('runStatus appends "Status: <old> → <new>." entry at top', () => {
    const docsDir = setupProject();
    const planPath = writePlan(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2026-05-13T00:00:00Z', baseBody);

    const r = runCli(['status', planPath, 'planned']);
    strictEqual(r.status, 0, `status failed: ${r.stderr}`);

    const after = readFileSync(planPath, 'utf8');
    match(after, /\*\*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\*\* Status: active → planned\./);
    ok(after.indexOf('Status: active → planned') < after.indexOf('Created.'), 'new entry is above old one (newest-first)');
  });

  it('runPickup appends "Picked up (<old> → in-session)." entry', () => {
    const docsDir = setupProject();
    const planPath = writePlan(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2026-05-13T00:00:00Z', baseBody);

    const r = runCli(['pickup', planPath]);
    strictEqual(r.status, 0, `pickup failed: ${r.stderr}`);

    const after = readFileSync(planPath, 'utf8');
    match(after, /\*\*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\*\* Picked up \(active → in-session\)\./);
  });

  it('runUnpickup appends "Released (in-session → <new>)." entry', () => {
    const docsDir = setupProject();
    const planPath = writePlan(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2026-05-13T00:00:00Z', baseBody);

    runCli(['pickup', planPath]);
    const r = runCli(['release', planPath]);
    strictEqual(r.status, 0, `release failed: ${r.stderr}`);

    const after = readFileSync(planPath, 'utf8');
    // Both pickup and release entries present
    match(after, /Picked up \(active → in-session\)\./);
    match(after, /Released \(in-session → active\)\./);
    // Released is above Picked up (newest-first)
    ok(after.indexOf('Released') < after.indexOf('Picked up'), 'release entry is newer (above pickup)');
  });

  it('runHandoff appends "Handoff queued (in-session → <new>)." entry', () => {
    const docsDir = setupProject();
    const planPath = writePlan(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2026-05-13T00:00:00Z', baseBody);

    runCli(['pickup', planPath]);
    const r = runCli(['handoff', planPath, 'note for next session']);
    strictEqual(r.status, 0, `handoff failed: ${r.stderr}`);

    const after = readFileSync(planPath, 'utf8');
    match(after, /Handoff queued \(in-session → active\)\./);
  });

  it('runArchive appends "Archived." entry', () => {
    const docsDir = setupProject();
    const planPath = writePlan(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2026-05-13T00:00:00Z', baseBody);

    const r = runCli(['archive', planPath]);
    strictEqual(r.status, 0, `archive failed: ${r.stderr}`);

    // File moved to archived/
    const archivedPath = path.join(docsDir, 'archived', 'plan.md');
    const after = readFileSync(archivedPath, 'utf8');
    match(after, /\*\*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\*\* Archived\./);
  });

  it('takeover writes "Took over from <session>." entry', () => {
    const docsDir = setupProject();
    const planPath = writePlan(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2026-05-13T00:00:00Z', baseBody);

    // Session A picks it up
    runCli(['pickup', planPath], { session: 'sess-A' });
    // Force the lease to look stale by hand-editing — easier: just have B takeover
    const r = runCli(['pickup', planPath, '--takeover'], { session: 'sess-B' });
    strictEqual(r.status, 0, `takeover failed: ${r.stderr}`);

    const after = readFileSync(planPath, 'utf8');
    match(after, /Took over from sess-A\./);
  });

  it('reattach (same-session re-pickup) does NOT add a VH entry', () => {
    const docsDir = setupProject();
    const planPath = writePlan(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2026-05-13T00:00:00Z', baseBody);

    runCli(['pickup', planPath]);
    const before = readFileSync(planPath, 'utf8');
    const bulletCountBefore = (before.match(/^- \*\*/gm) || []).length;
    runCli(['pickup', planPath]); // same session = silent reattach
    const after = readFileSync(planPath, 'utf8');
    const bulletCountAfter = (after.match(/^- \*\*/gm) || []).length;
    strictEqual(bulletCountAfter, bulletCountBefore, 'reattach should not add a new bullet');
  });

  it('plan without ## Version History section: lifecycle commands skip silently (no error)', () => {
    const docsDir = setupProject();
    const bodyNoVH = `# Plan\n\n## Phases\n\n### Phase 1 ⬜\n`;
    const planPath = writePlan(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2026-05-13T00:00:00Z', bodyNoVH);

    const r = runCli(['status', planPath, 'planned']);
    strictEqual(r.status, 0, 'status command still succeeds');

    const after = readFileSync(planPath, 'utf8');
    ok(!after.includes('## Version History'), 'VH section was NOT auto-created');
    ok(after.includes('status: planned'), 'frontmatter still updated');
  });

  it('preserves existing entries below the new one', () => {
    const docsDir = setupProject();
    const planPath = writePlan(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2026-05-13T00:00:00Z', baseBody);

    runCli(['status', planPath, 'planned']);
    const after = readFileSync(planPath, 'utf8');
    // Both entries present
    match(after, /Status: active → planned\./);
    match(after, /\*\*2026-05-01T00:00:00Z\*\* Created\./);
  });
});
