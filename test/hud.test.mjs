import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

let tmpDir;
const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-hud-'));
  spawnSync('git', ['init'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(path.join(docsDir, 'archived'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\n`);
  return docsDir;
}

function writeDoc(docsDir, filename, frontmatter, body = '') {
  const filePath = path.join(docsDir, filename);
  writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`);
  spawnSync('git', ['add', filePath], { cwd: tmpDir });
  spawnSync('git', ['commit', '-m', `add ${filename}`], { cwd: tmpDir });
  return filePath;
}

function runCli(args, { session = 'sess-A', input } = {}) {
  return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
    cwd: tmpDir,
    encoding: 'utf8',
    input,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: session, PATH: process.env.PATH },
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('dotmd hud', () => {
  it('is silent when there is nothing actionable', () => {
    setupProject();
    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    strictEqual(r.stdout, '', 'output should be empty when clean');
  });

  it('shows owned leases', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan-a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# A\n');
    runCli(['pickup', planPath]);

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(r.stdout.includes('You hold 1 plan'), `expected lease line, got: ${r.stdout}`);
    ok(r.stdout.includes('plan-a'), 'plan slug present');
  });

  it('shows queued handoffs', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan-a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# A\n');
    runCli(['pickup', planPath], { session: 'sess-A' });
    runCli(['handoff', planPath, 'resume note'], { session: 'sess-A' });

    // Run hud in a different session so we don't see the (now-released) lease, just the handoff
    const r = runCli(['hud'], { session: 'sess-B' });
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(r.stdout.includes('1 handoff queued'), `expected handoff line, got: ${r.stdout}`);
    ok(r.stdout.includes('plan-a'), 'slug present');
    ok(r.stdout.includes('resume:'), 'resume hint present');
  });

  it('shows held + queued together when both apply', () => {
    const docsDir = setupProject();
    const planA = writeDoc(docsDir, 'plan-a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# A\n');
    const planB = writeDoc(docsDir, 'plan-b.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# B\n');

    runCli(['pickup', planA], { session: 'sess-X' });
    runCli(['handoff', planA, 'note for next'], { session: 'sess-X' });
    runCli(['pickup', planB], { session: 'sess-Y' });

    const r = runCli(['hud'], { session: 'sess-Y' });
    ok(r.stdout.includes('You hold 1 plan'), 'lease line present');
    ok(r.stdout.includes('plan-b'), 'held plan slug present');
    ok(r.stdout.includes('1 handoff queued'), 'handoff line present');
    ok(r.stdout.includes('plan-a'), 'handoff slug present');
  });

  it('--json returns structured output', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan-a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# A\n');
    runCli(['pickup', planPath]);

    const r = runCli(['hud', '--json']);
    strictEqual(r.status, 0, `hud --json failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    ok(Array.isArray(parsed.owned), 'owned is array');
    ok(Array.isArray(parsed.queued), 'queued is array');
    ok(Array.isArray(parsed.stale), 'stale is array');
    ok(Array.isArray(parsed.prompts), 'prompts is array');
    strictEqual(parsed.owned.length, 1);
    ok(parsed.owned[0].includes('plan-a'));
  });

  it('shows pending prompts with consume hint', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'prompts'), { recursive: true });
    writeDoc(docsDir, 'prompts/resume-me.md', 'type: prompt\nstatus: pending\ncreated: 2025-01-01', 'body');

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(r.stdout.includes('1 pending prompt'), `expected prompt line, got: ${r.stdout}`);
    ok(r.stdout.includes('resume-me'), 'prompt slug present');
    ok(r.stdout.includes('dotmd prompts use'), 'consume hint present');
  });

  it('finds prompts when the prompts/ dir is configured directly as a root (#6)', () => {
    // Custom setup: root list points straight at docs/prompts rather than
    // at docs/ as a parent containing a prompts/ subdir.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-hud-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    const promptsDir = path.join(tmpDir, 'docs', 'prompts');
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      path.join(tmpDir, 'dotmd.config.mjs'),
      `export const root = ['docs/prompts'];\n`,
    );
    const filePath = path.join(promptsDir, 'foo.md');
    writeFileSync(filePath, '---\ntype: prompt\nstatus: pending\ncreated: 2025-01-01\n---\nbody');
    spawnSync('git', ['add', filePath], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'add foo'], { cwd: tmpDir });

    const r = runCli(['hud', '--json']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    ok(
      parsed.prompts.some(p => p.endsWith('docs/prompts/foo.md')),
      `expected docs/prompts/foo.md in prompts, got: ${JSON.stringify(parsed.prompts)}`,
    );
  });

  it('does not list already-archived prompts', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'prompts'), { recursive: true });
    writeDoc(docsDir, 'prompts/done.md', 'type: prompt\nstatus: archived\ncreated: 2025-01-01', 'body');

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    strictEqual(r.stdout, '', 'no prompt line when only archived prompts exist');
  });

  it('output stays under ~500 bytes when full of common signals', () => {
    const docsDir = setupProject();
    for (let i = 0; i < 5; i++) {
      writeDoc(docsDir, `held-${i}.md`, 'type: plan\nstatus: active\nupdated: 2025-01-01', '# held\n');
      runCli(['pickup', `held-${i}.md`]);
    }
    for (let i = 0; i < 5; i++) {
      const planPath = writeDoc(docsDir, `queued-${i}.md`, 'type: plan\nstatus: active\nupdated: 2025-01-01', '# queued\n');
      runCli(['pickup', planPath], { session: 'other' });
      runCli(['handoff', planPath, 'note'], { session: 'other' });
    }

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(r.stdout.length < 800, `hud output too large: ${r.stdout.length} bytes\n${r.stdout}`);
  });
});
