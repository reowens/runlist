import { describe, it, beforeEach, afterEach } from 'node:test';
import { ok, strictEqual, match } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

let tmpDir;
let docsDir;
let promptsDir;
let configPath;

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-prompts-'));
  spawnSync('git', ['init', '-q'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

  docsDir = path.join(tmpDir, 'docs');
  promptsDir = path.join(docsDir, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  mkdirSync(path.join(docsDir, 'archived'), { recursive: true });

  configPath = path.join(tmpDir, 'dotmd.config.mjs');
  writeFileSync(configPath, `export const root = 'docs';\n`);
}

function writePrompt(name, { status = 'pending', created = '2025-01-01', body = 'do the thing' } = {}) {
  const file = path.join(promptsDir, `${name}.md`);
  const fm = [
    'type: prompt',
    `status: ${status}`,
    `created: ${created}`,
    'related_plans: []',
  ].join('\n');
  writeFileSync(file, `---\n${fm}\n---\n${body}\n`);
  spawnSync('git', ['add', file], { cwd: tmpDir });
  spawnSync('git', ['commit', '-qm', `add ${name}`], { cwd: tmpDir });
  return file;
}

function run(args, env = {}) {
  return spawnSync('node', [bin, ...args, '--config', configPath], {
    cwd: tmpDir, encoding: 'utf8',
    env: { ...process.env, ...env, NO_COLOR: '1' },
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('dotmd prompts list', () => {
  beforeEach(setupProject);

  it('bare `prompts` lists pending prompts (default)', () => {
    writePrompt('a-prompt', { status: 'pending' });
    writePrompt('b-prompt', { status: 'archived' });
    const r = run(['prompts']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('a-prompt'), 'lists pending');
    ok(!r.stdout.includes('b-prompt'), 'excludes archived');
  });

  it('`prompts list` works as alias', () => {
    writePrompt('foo-prompt');
    const r = run(['prompts', 'list']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('foo-prompt'), `expected listing to include foo-prompt:\n${r.stdout}`);
  });

  it('`prompts list` puts the next consumed pending prompt first and marks it', () => {
    writePrompt('newer', { created: '2025-06-01' });
    writePrompt('older', { created: '2025-01-01' });
    const r = run(['prompts', 'list']);
    strictEqual(r.status, 0, r.stderr);
    const olderIdx = r.stdout.indexOf('older');
    const newerIdx = r.stdout.indexOf('newer');
    ok(olderIdx > -1 && newerIdx > -1, `expected both prompts:\n${r.stdout}`);
    ok(olderIdx < newerIdx, `oldest pending should be first:\n${r.stdout}`);
    match(r.stdout, /\[NEXT\].*older/);
  });

  it('`prompts list --verbose` shows target plan from related_plans frontmatter', () => {
    const file = path.join(promptsDir, 'resume-foo.md');
    writeFileSync(file, `---\ntype: prompt\nstatus: pending\ncreated: 2025-01-01\nrelated_plans: [foo-plan]\n---\nresume foo\n`);
    spawnSync('git', ['add', file], { cwd: tmpDir });
    spawnSync('git', ['commit', '-qm', 'add resume-foo'], { cwd: tmpDir });
    const r = run(['prompts', 'list', '--verbose']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('resume-foo'), 'lists prompt name');
    ok(r.stdout.includes('docs/plans/foo-plan.md'), `expected docs/plans/foo-plan.md, got:\n${r.stdout}`);
  });

  it('`prompts list --verbose` falls back to first body markdown link', () => {
    const file = path.join(promptsDir, 'resume-bar.md');
    writeFileSync(file, `---\ntype: prompt\nstatus: pending\ncreated: 2025-01-01\n---\nContinue [bar plan](../plans/bar-plan.md) where we left off.\n`);
    spawnSync('git', ['add', file], { cwd: tmpDir });
    spawnSync('git', ['commit', '-qm', 'add resume-bar'], { cwd: tmpDir });
    const r = run(['prompts', 'list', '--verbose']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('docs/plans/bar-plan.md'), `expected docs/plans/bar-plan.md, got:\n${r.stdout}`);
  });

  it('`prompts list --verbose` marks prompts with no target', () => {
    const file = path.join(promptsDir, 'orphan.md');
    writeFileSync(file, `---\ntype: prompt\nstatus: pending\ncreated: 2025-01-01\n---\nNo target plan referenced.\n`);
    spawnSync('git', ['add', file], { cwd: tmpDir });
    spawnSync('git', ['commit', '-qm', 'add orphan'], { cwd: tmpDir });
    const r = run(['prompts', 'list', '--verbose']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('no target plan'), `expected no-target marker, got:\n${r.stdout}`);
  });
});

describe('dotmd prompts next', () => {
  beforeEach(setupProject);

  it('picks oldest pending by created date', () => {
    writePrompt('newer', { created: '2025-06-01', body: 'newer body' });
    writePrompt('older', { created: '2025-01-01', body: 'older body' });

    const r = run(['prompts', 'next']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('older body'), 'emits oldest body');
    ok(!r.stdout.includes('newer body'), 'does not emit newer body');
    ok(r.stderr.includes('Archived'), 'archive status on stderr');
    ok(r.stderr.includes('Consumed'), 'consume confirmation on stderr');
  });

  it('archives the file (moves to archived/, flips status)', () => {
    const file = writePrompt('foo');
    const r = run(['prompts', 'next']);
    strictEqual(r.status, 0, r.stderr);
    ok(!existsSync(file), 'original file gone');
    const archived = path.join(docsDir, 'archived', 'foo.md');
    ok(existsSync(archived), 'moved to archived dir');
    const content = readFileSync(archived, 'utf8');
    ok(content.includes('status: archived'), 'status flipped');
  });

  it('errors when queue is empty', () => {
    const r = run(['prompts', 'next']);
    ok(r.status !== 0, 'non-zero exit');
    ok(r.stderr.includes('No pending prompts'), 'clear error');
    strictEqual(r.stdout, '', 'no stdout');
  });

  it('does not double-consume the same prompt', () => {
    writePrompt('foo', { body: 'body' });
    run(['prompts', 'next']);

    const r2 = run(['prompts', 'next']);
    ok(r2.status !== 0, 'second call fails');
    ok(r2.stderr.includes('No pending prompts'), 'queue is empty after consume');
  });

  it('dry-run does not mutate', () => {
    const file = writePrompt('foo', { body: 'body' });
    const before = readFileSync(file, 'utf8');
    const r = run(['prompts', 'next', '--dry-run']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stderr.includes('[dry-run]'), 'dry-run prefix');
    ok(existsSync(file), 'file still in place');
    const after = readFileSync(file, 'utf8');
    strictEqual(after, before, 'file unchanged');
  });

  it('dry-run previews the body that would be emitted (issue #10 finding #11)', () => {
    writePrompt('foo', { body: 'this is the unique-needle body content' });
    const r = run(['prompts', 'next', '--dry-run']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stderr.includes('body preview'), 'shows preview heading');
    ok(r.stderr.includes('unique-needle'), `expected body content in preview, got stderr:\n${r.stderr}`);
    strictEqual(r.stdout, '', 'stdout stays empty in dry-run (no piping surprises)');
  });

  // Regression: if the archive step fails (read-only archive dir here), the
  // body must NOT have already been emitted to stdout. Otherwise
  // `claude "$(dotmd prompts next)"` consumes the body and the prompt stays
  // pending in docs/prompts/ — the failure mode that motivated the reorder.
  it('does not emit body when archive fails', { skip: process.platform === 'win32' }, () => {
    const file = writePrompt('foo', { body: 'unique-must-not-leak' });
    const archivedDir = path.join(docsDir, 'archived');
    chmodSync(archivedDir, 0o555);
    try {
      const r = run(['prompts', 'next']);
      ok(r.status !== 0, 'archive failure exits non-zero');
      strictEqual(r.stdout, '', `stdout must stay empty when archive fails, got:\n${r.stdout}`);
      ok(existsSync(file), 'source file still in docs/prompts/');
    } finally {
      chmodSync(archivedDir, 0o755);
    }
  });
});

describe('dotmd prompts use', () => {
  beforeEach(setupProject);

  it('consumes specific file regardless of queue order', () => {
    writePrompt('older', { created: '2025-01-01', body: 'older body' });
    const target = writePrompt('target', { created: '2025-06-01', body: 'target body' });

    const r = run(['prompts', 'use', target]);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('target body'));
    ok(!r.stdout.includes('older body'));
    ok(!existsSync(target), 'target archived');
  });

  it('refuses non-prompt files', () => {
    const file = path.join(docsDir, 'plan.md');
    writeFileSync(file, '---\ntype: plan\nstatus: active\n---\n# plan body\n');
    spawnSync('git', ['add', file], { cwd: tmpDir });
    spawnSync('git', ['commit', '-qm', 'add plan'], { cwd: tmpDir });

    const r = run(['prompts', 'use', file]);
    ok(r.status !== 0, 'non-zero exit');
    ok(r.stderr.includes('Not a prompt'), 'clear error');
  });

  it('refuses already-archived prompts', () => {
    const file = writePrompt('done', { status: 'archived' });
    const r = run(['prompts', 'use', file]);
    ok(r.status !== 0);
    ok(r.stderr.includes('Already consumed'));
  });

  it('errors when file argument missing', () => {
    const r = run(['prompts', 'use']);
    ok(r.status !== 0);
    ok(r.stderr.includes('Usage'));
  });

  it('accepts a bare slug (no .md, no path) matching a prompt basename', () => {
    writePrompt('resume-ios-comms-color-tokens', { body: 'resume body' });
    const r = run(['prompts', 'use', 'resume-ios-comms-color-tokens']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('resume body'));
    ok(!existsSync(path.join(promptsDir, 'resume-ios-comms-color-tokens.md')), 'archived');
  });

  it('accepts slug with .md suffix', () => {
    writePrompt('with-ext', { body: 'ext body' });
    const r = run(['prompts', 'use', 'with-ext.md']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('ext body'));
  });

  it('falls back to substring match when no exact basename match', () => {
    writePrompt('resume-payments-final-phase', { body: 'substr body' });
    const r = run(['prompts', 'use', 'payments-final']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('substr body'));
  });

  it('errors with candidate list when substring matches multiple prompts', () => {
    writePrompt('resume-a-foo', { body: 'a' });
    writePrompt('resume-b-foo', { body: 'b' });
    const r = run(['prompts', 'use', 'foo']);
    ok(r.status !== 0);
    ok(r.stderr.includes('Multiple prompts'), `expected ambiguity error:\n${r.stderr}`);
    ok(r.stderr.includes('resume-a-foo'));
    ok(r.stderr.includes('resume-b-foo'));
  });

  it('errors clearly when slug matches nothing', () => {
    writePrompt('exists', { body: 'x' });
    const r = run(['prompts', 'use', 'does-not-exist']);
    ok(r.status !== 0);
    ok(r.stderr.includes('No prompt found'), `expected no-match error:\n${r.stderr}`);
  });

  // "It should be very pasteable" — every common form a user might paste
  // into the terminal must resolve to the same prompt. Don't let this drift.
  describe('pasteable input forms', () => {
    it('accepts `docs/prompts/<slug>` (repo-relative path, no .md)', () => {
      writePrompt('path-no-ext', { body: 'path-no-ext body' });
      const r = run(['prompts', 'use', 'docs/prompts/path-no-ext']);
      strictEqual(r.status, 0, r.stderr);
      ok(r.stdout.includes('path-no-ext body'));
    });

    it('accepts `docs/prompts/<slug>.md` (repo-relative path with .md)', () => {
      writePrompt('full-path', { body: 'full-path body' });
      const r = run(['prompts', 'use', 'docs/prompts/full-path.md']);
      strictEqual(r.status, 0, r.stderr);
      ok(r.stdout.includes('full-path body'));
    });

    it('accepts `prompts/<slug>.md` (docsRoot-relative)', () => {
      writePrompt('docsroot-rel', { body: 'docsroot-rel body' });
      const r = run(['prompts', 'use', 'prompts/docsroot-rel.md']);
      strictEqual(r.status, 0, r.stderr);
      ok(r.stdout.includes('docsroot-rel body'));
    });

    it('accepts `./docs/prompts/<slug>.md` (./ prefix)', () => {
      writePrompt('dot-prefix', { body: 'dot-prefix body' });
      const r = run(['prompts', 'use', './docs/prompts/dot-prefix.md']);
      strictEqual(r.status, 0, r.stderr);
      ok(r.stdout.includes('dot-prefix body'));
    });

    it('accepts an absolute path', () => {
      const target = writePrompt('abs-path', { body: 'abs-path body' });
      const r = run(['prompts', 'use', target]);
      strictEqual(r.status, 0, r.stderr);
      ok(r.stdout.includes('abs-path body'));
    });
  });
});

describe('dotmd prompts archive', () => {
  beforeEach(setupProject);

  it('archives without emitting body to stdout', () => {
    const file = writePrompt('foo', { body: 'should-not-appear' });
    const r = run(['prompts', 'archive', file]);
    strictEqual(r.status, 0, r.stderr);
    ok(!r.stdout.includes('should-not-appear'), 'body suppressed');
    ok(!existsSync(file), 'archived');
  });

  it('refuses non-prompt files', () => {
    const file = path.join(docsDir, 'plan.md');
    writeFileSync(file, '---\ntype: plan\nstatus: active\n---\n');
    spawnSync('git', ['add', file], { cwd: tmpDir });
    spawnSync('git', ['commit', '-qm', 'add plan'], { cwd: tmpDir });

    const r = run(['prompts', 'archive', file]);
    ok(r.status !== 0);
    ok(r.stderr.includes('Not a prompt'));
  });

  it('accepts a bare slug', () => {
    writePrompt('cleanup-todo', { body: 'should-not-appear' });
    const r = run(['prompts', 'archive', 'cleanup-todo']);
    strictEqual(r.status, 0, r.stderr);
    ok(!existsSync(path.join(promptsDir, 'cleanup-todo.md')), 'archived by slug');
  });
});

describe('F14: shelved prompt status', () => {
  beforeEach(setupProject);

  it('`prompts list` shows shelved prompts alongside pending', () => {
    writePrompt('parked', { status: 'shelved' });
    writePrompt('active-one', { status: 'pending' });
    const r = run(['prompts', 'list', '--include-archived']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('parked'), `list should show shelved prompt:\n${r.stdout}`);
    ok(r.stdout.includes('active-one'), `list should still show pending:\n${r.stdout}`);
  });

  it('`prompts next` skips shelved and only consumes pending', () => {
    writePrompt('shelf', { status: 'shelved', created: '2025-01-01', body: 'shelf body' });
    writePrompt('hot', { status: 'pending', created: '2025-06-01', body: 'hot body' });
    const r = run(['prompts', 'next']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('hot body'), `should consume the pending one:\n${r.stdout}`);
    ok(!r.stdout.includes('shelf body'), `must not consume shelved:\n${r.stdout}`);
  });

  it('`prompts next` reports empty queue when only shelved prompts exist', () => {
    writePrompt('only-shelved', { status: 'shelved' });
    const r = run(['prompts', 'next']);
    ok(r.status !== 0, 'non-zero exit when no pending');
    ok(r.stderr.includes('No pending prompts'), `expected empty-queue error:\n${r.stderr}`);
  });

  it('`prompts shelve` flips status pending → shelved', () => {
    const file = writePrompt('todo-later', { status: 'pending' });
    const r = run(['prompts', 'shelve', 'todo-later']);
    strictEqual(r.status, 0, r.stderr);
    const after = readFileSync(file, 'utf8');
    ok(after.includes('status: shelved'), `status should flip:\n${after}`);
  });

  it('`prompts unshelve` flips status shelved → pending', () => {
    const file = writePrompt('back-on-deck', { status: 'shelved' });
    const r = run(['prompts', 'unshelve', 'back-on-deck']);
    strictEqual(r.status, 0, r.stderr);
    const after = readFileSync(file, 'utf8');
    ok(after.includes('status: pending'), `status should flip back:\n${after}`);
  });

  it('`dotmd use` skips shelved prompts when picking the oldest pending', () => {
    // HUD no longer surfaces prompt counts; the load-bearing assertion moved
    // to `dotmd use` (the canonical consumer): shelved prompts must not be
    // returned as "oldest pending".
    writePrompt('parked', { status: 'shelved' });
    const r = run(['use']);
    ok(r.status !== 0, 'should refuse with no pending prompts');
    ok(/No pending prompts/.test(r.stderr ?? r.stdout),
      `expected "No pending prompts"; got: ${r.stderr}\n${r.stdout}`);
  });
});

describe('dotmd prompts new', () => {
  beforeEach(setupProject);

  it('creates a new prompt with given body', () => {
    const r = run(['prompts', 'new', 'fresh-prompt', 'inline body content']);
    strictEqual(r.status, 0, r.stderr);

    const created = path.join(promptsDir, 'fresh-prompt.md');
    ok(existsSync(created), 'file created');
    const content = readFileSync(created, 'utf8');
    ok(content.includes('type: prompt'));
    ok(content.includes('status: pending'));
    ok(content.includes('inline body content'));
  });

  it('errors without slug', () => {
    const r = run(['prompts', 'new']);
    ok(r.status !== 0);
    ok(r.stderr.includes('Usage'));
  });
});
