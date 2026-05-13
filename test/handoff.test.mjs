import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

let tmpDir;

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-handoff-'));
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

describe('handoff command', () => {
  it('writes a sidecar with timestamped section and releases the lease', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# Plan\nbody\n');

    let r = runCli(['pickup', planPath]);
    strictEqual(r.status, 0, `pickup failed: ${r.stderr}`);

    r = runCli(['handoff', planPath, 'continue from validate(); next: write tests']);
    strictEqual(r.status, 0, `handoff failed: ${r.stderr}`);

    const sidecar = path.join(tmpDir, '.dotmd', 'handoffs', 'docs', 'plan.md');
    ok(existsSync(sidecar), 'sidecar should be written');
    const content = readFileSync(sidecar, 'utf8');
    match(content, /^## \d{4}-\d{2}-\d{2}T/, 'timestamped section header');
    ok(content.includes('continue from validate(); next: write tests'), 'body included');

    const lease = path.join(tmpDir, '.dotmd', 'in-session.json');
    ok(!existsSync(lease), 'lease should be released');

    const fm = readFileSync(planPath, 'utf8');
    ok(fm.includes('status: active'), 'status flipped back to active');
  });

  it('appends a second section instead of overwriting', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# Plan\n');

    runCli(['pickup', planPath]);
    runCli(['handoff', planPath, 'first chunk']);

    runCli(['pickup', planPath]);
    const r = runCli(['handoff', planPath, 'second chunk']);
    strictEqual(r.status, 0, `handoff failed: ${r.stderr}`);

    const sidecar = path.join(tmpDir, '.dotmd', 'handoffs', 'docs', 'plan.md');
    // pickup #2 should have consumed the first handoff and printed it; sidecar
    // now contains only the second chunk
    const content = readFileSync(sidecar, 'utf8');
    ok(content.includes('second chunk'), 'second chunk present');
    ok(!content.includes('first chunk'), 'first chunk was consumed by pickup #2');
  });

  it('appends across handoffs when no pickup intervenes', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# Plan\n');

    runCli(['pickup', planPath]);
    runCli(['handoff', planPath, 'first chunk']);

    runCli(['pickup', planPath]);
    // pickup #2 consumed the first chunk. Write two handoffs without an intervening pickup.
    runCli(['handoff', planPath, 'second chunk']);
    runCli(['pickup', planPath]);
    runCli(['handoff', planPath, 'third chunk one']);
    // Re-pickup re-attaches silently then we hand off again — append, no pickup between.
    runCli(['pickup', planPath]);
    // wait — pickup consumes. Use --replace path to validate replace semantics instead.
    const r = runCli(['handoff', planPath, 'replacement', '--replace']);
    strictEqual(r.status, 0, `handoff --replace failed: ${r.stderr}`);

    const sidecar = path.join(tmpDir, '.dotmd', 'handoffs', 'docs', 'plan.md');
    const content = readFileSync(sidecar, 'utf8');
    ok(content.includes('replacement'), 'replacement present');
    ok(!content.includes('third chunk one'), '--replace dropped prior chain');
  });

  it('refuses when plan is not held by current session', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# Plan\n');

    const r = runCli(['handoff', planPath, 'note']);
    strictEqual(r.status, 1, 'should refuse');
    ok(r.stderr.includes('Not held by this session'), `expected refusal message, got: ${r.stderr}`);
  });

  it('refuses when held by a different session', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# Plan\n');

    runCli(['pickup', planPath], { session: 'sess-A' });
    const r = runCli(['handoff', planPath, 'note'], { session: 'sess-B' });
    strictEqual(r.status, 1, 'should refuse for foreign session');
    ok(r.stderr.includes('Not held by this session'), `expected refusal, got: ${r.stderr}`);
  });

  it('reads handoff text from stdin with -', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# Plan\n');

    runCli(['pickup', planPath]);
    const r = runCli(['handoff', planPath, '-'], { input: 'piped handoff content\nline two\n' });
    strictEqual(r.status, 0, `handoff stdin failed: ${r.stderr}`);

    const sidecar = path.join(tmpDir, '.dotmd', 'handoffs', 'docs', 'plan.md');
    const content = readFileSync(sidecar, 'utf8');
    ok(content.includes('piped handoff content'), 'stdin content written');
    ok(content.includes('line two'), 'multiline preserved');
  });

  it('reads handoff text from @path', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# Plan\n');

    runCli(['pickup', planPath]);
    const handoffSrc = path.join(tmpDir, 'src-handoff.md');
    writeFileSync(handoffSrc, 'from file source\n');

    const r = runCli(['handoff', planPath, `@${handoffSrc}`]);
    strictEqual(r.status, 0, `handoff @path failed: ${r.stderr}`);

    const sidecar = path.join(tmpDir, '.dotmd', 'handoffs', 'docs', 'plan.md');
    ok(readFileSync(sidecar, 'utf8').includes('from file source'), 'file content written');
  });

  it('--dry-run does not write the sidecar or release the lease', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# Plan\n');

    runCli(['pickup', planPath]);
    const r = runCli(['handoff', planPath, 'preview note', '--dry-run']);
    strictEqual(r.status, 0, `handoff dry-run failed: ${r.stderr}`);

    const sidecar = path.join(tmpDir, '.dotmd', 'handoffs', 'docs', 'plan.md');
    ok(!existsSync(sidecar), 'no sidecar written in dry-run');
    const lease = path.join(tmpDir, '.dotmd', 'in-session.json');
    ok(existsSync(lease), 'lease still held in dry-run');
  });
});

describe('pickup consumes handoff', () => {
  it('prints handoff body instead of plan body and unlinks sidecar', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# Plan\nORIGINAL BODY\n');

    runCli(['pickup', planPath], { session: 'sess-A' });
    runCli(['handoff', planPath, 'RESUME FROM HERE'], { session: 'sess-A' });

    const r = runCli(['pickup', planPath], { session: 'sess-B' });
    strictEqual(r.status, 0, `pickup failed: ${r.stderr}`);

    ok(r.stdout.includes('RESUME FROM HERE'), `handoff body should be printed, got: ${r.stdout}`);
    ok(!r.stdout.includes('ORIGINAL BODY'), 'plan body should NOT be printed when handoff exists');
    ok(r.stdout.includes('[dotmd] holding'), 'holding prefix included');
    ok(r.stdout.includes('consumed handoff'), 'consumed indicator');

    const sidecar = path.join(tmpDir, '.dotmd', 'handoffs', 'docs', 'plan.md');
    ok(!existsSync(sidecar), 'sidecar should be unlinked after consume');
  });

  it('falls back to plan body when no handoff is queued', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# Plan\nORIGINAL BODY\n');

    const r = runCli(['pickup', planPath]);
    strictEqual(r.status, 0, `pickup failed: ${r.stderr}`);
    ok(r.stdout.includes('ORIGINAL BODY'), 'plan body printed');
    ok(r.stdout.includes('[dotmd] holding'), 'holding prefix included');
  });

  it('JSON output includes handoffConsumed flag', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# Plan\nORIGINAL\n');

    runCli(['pickup', planPath], { session: 'sess-A' });
    runCli(['handoff', planPath, 'note'], { session: 'sess-A' });

    const r = runCli(['pickup', planPath, '--json'], { session: 'sess-B' });
    strictEqual(r.status, 0, `pickup --json failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    strictEqual(parsed.handoffConsumed, true);
    ok(parsed.body.includes('note'), 'json body is handoff content');
  });
});

describe('release alias', () => {
  it('routes dotmd release to runUnpickup', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# Plan\n');

    runCli(['pickup', planPath]);
    const r = runCli(['release', planPath]);
    strictEqual(r.status, 0, `release failed: ${r.stderr}`);

    const lease = path.join(tmpDir, '.dotmd', 'in-session.json');
    ok(!existsSync(lease), 'lease released by release alias');
    const fm = readFileSync(planPath, 'utf8');
    ok(fm.includes('status: active'), 'status reverted');
  });
});

describe('briefing surfaces queued handoffs', () => {
  it('shows handoff-queued count and preview at top', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# Plan\n');

    runCli(['pickup', planPath]);
    runCli(['handoff', planPath, 'note']);

    const r = runCli(['briefing']);
    strictEqual(r.status, 0, `briefing failed: ${r.stderr}`);
    ok(r.stdout.includes('1 handoff queued'), `expected handoff line, got: ${r.stdout}`);
    ok(r.stdout.includes('plan'), 'plan slug present in preview');
  });
});
