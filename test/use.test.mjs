import { describe, it, beforeEach, afterEach } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// Direct coverage for the `dotmd use` dispatch verb (src/use.mjs). It was only
// exercised incidentally through lifecycle/prompts tests; these pin the
// type-routed behavior end-to-end: prompt → consume+archive, plan → in-session,
// doc → read-only print, plus no-arg oldest-pending and the empty-queue error.

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

let tmpDir;
let docsDir;
let configPath;

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-use-'));
  spawnSync('git', ['init', '-q'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

  docsDir = path.join(tmpDir, 'docs');
  mkdirSync(path.join(docsDir, 'plans'), { recursive: true });
  mkdirSync(path.join(docsDir, 'prompts'), { recursive: true });
  mkdirSync(path.join(docsDir, 'archived'), { recursive: true });
  mkdirSync(path.join(docsDir, 'prompts', 'archived'), { recursive: true });

  configPath = path.join(tmpDir, 'dotmd.config.mjs');
  writeFileSync(configPath, `export const root = 'docs';\n`);
}

function commit(file, msg) {
  spawnSync('git', ['add', file], { cwd: tmpDir });
  spawnSync('git', ['commit', '-qm', msg], { cwd: tmpDir });
}

function writePrompt(name, { created = '2025-01-01', body = 'do the thing' } = {}) {
  const file = path.join(docsDir, 'prompts', `${name}.md`);
  const fm = ['type: prompt', 'status: pending', `created: ${created}`, 'related_plans: []'].join('\n');
  writeFileSync(file, `---\n${fm}\n---\n${body}\n`);
  commit(file, `add prompt ${name}`);
  return file;
}

function writePlan(name, { status = 'active', body = '## Problem\nDo it.\n' } = {}) {
  const file = path.join(docsDir, 'plans', `${name}.md`);
  const fm = ['type: plan', `status: ${status}`, `title: ${name}`, 'updated: 2025-01-01'].join('\n');
  writeFileSync(file, `---\n${fm}\n---\n# ${name}\n\n${body}`);
  commit(file, `add plan ${name}`);
  return file;
}

function writeDoc(name, { body = 'reference material body' } = {}) {
  const file = path.join(docsDir, `${name}.md`);
  const fm = ['type: doc', 'status: active', `title: ${name}`].join('\n');
  writeFileSync(file, `---\n${fm}\n---\n# ${name}\n\n${body}\n`);
  commit(file, `add doc ${name}`);
  return file;
}

function run(args, env = {}) {
  return spawnSync('node', [bin, ...args, '--config', configPath], {
    cwd: tmpDir, encoding: 'utf8',
    env: { ...process.env, ...env, NO_COLOR: '1' },
  });
}

beforeEach(setupProject);
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('dotmd use — prompt', () => {
  it('consumes an explicit prompt: prints its body and archives it', () => {
    writePrompt('foo', { body: 'unique prompt marker AABBCC' });
    const res = run(['use', 'docs/prompts/foo.md']);
    strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    ok(res.stdout.includes('unique prompt marker AABBCC'), `body printed; got: ${res.stdout}`);
    ok(!existsSync(path.join(docsDir, 'prompts', 'foo.md')), 'original removed');
    ok(existsSync(path.join(docsDir, 'prompts', 'archived', 'foo.md')), 'moved to prompts/archived/');
  });

  it('resolves a bare slug to the pending prompt and consumes it', () => {
    writePrompt('resume-bar', { body: 'slug-resolved body XYZ' });
    const res = run(['use', 'resume-bar']);
    strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    ok(res.stdout.includes('slug-resolved body XYZ'), `body printed; got: ${res.stdout}`);
    ok(existsSync(path.join(docsDir, 'prompts', 'archived', 'resume-bar.md')), 'archived');
  });
});

describe('dotmd use — no argument', () => {
  it('consumes the OLDEST pending prompt, leaving newer ones queued', () => {
    writePrompt('older', { created: '2025-01-01', body: 'OLDEST body 111' });
    writePrompt('newer', { created: '2025-06-01', body: 'NEWER body 222' });

    const res = run(['use']);
    strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    ok(res.stdout.includes('OLDEST body 111'), `oldest consumed; got: ${res.stdout}`);
    ok(!res.stdout.includes('NEWER body 222'), 'newer not consumed');
    ok(existsSync(path.join(docsDir, 'prompts', 'archived', 'older.md')), 'oldest archived');
    ok(existsSync(path.join(docsDir, 'prompts', 'newer.md')), 'newer still pending');
  });

  it('errors when there are no pending prompts', () => {
    const res = run(['use']);
    ok(res.status !== 0, `expected non-zero exit; got ${res.status}`);
    ok((res.stderr + res.stdout).includes('No pending prompts'),
      `expected the no-prompts message; got: ${res.stderr}${res.stdout}`);
  });
});

describe('dotmd use — plan', () => {
  it('marks the plan in-session and prints the plan card', () => {
    const file = writePlan('payments-refactor', { status: 'active' });
    const res = run(['use', 'docs/plans/payments-refactor.md']);
    strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    const after = readFileSync(file, 'utf8');
    ok(after.includes('status: in-session'), `status flipped; got frontmatter in:\n${after}`);
    ok(res.stdout.includes('payments-refactor'), `card prints the plan; got: ${res.stdout}`);
    ok(existsSync(file), 'plan stays in place (no archive/move)');
  });
});

describe('dotmd use — doc', () => {
  it('prints the doc body read-only without changing status or moving the file', () => {
    const file = writeDoc('token-design', { body: 'design rationale ZZZTOP' });
    const before = readFileSync(file, 'utf8');
    const res = run(['use', 'docs/token-design.md']);
    strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    ok(res.stdout.includes('design rationale ZZZTOP'), `body printed; got: ${res.stdout}`);
    strictEqual(readFileSync(file, 'utf8'), before, 'doc is byte-identical (read-only)');
  });
});
