import { describe, it, beforeEach, afterEach } from 'node:test';
import { ok, strictEqual, match, doesNotMatch } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

let tmpDir;
let docsDir;
let promptsDir;
let archivedDir;
let configPath;

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-arch-drift-'));
  spawnSync('git', ['init', '-q'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

  docsDir = path.join(tmpDir, 'docs');
  promptsDir = path.join(docsDir, 'prompts');
  archivedDir = path.join(docsDir, 'archived');
  mkdirSync(promptsDir, { recursive: true });
  mkdirSync(archivedDir, { recursive: true });

  configPath = path.join(tmpDir, 'dotmd.config.mjs');
  writeFileSync(configPath, `export const root = 'docs';\n`);
}

function writePromptAt(dir, name, { status = 'pending', created = '2025-01-01', body = 'do the thing' } = {}) {
  const file = path.join(dir, `${name}.md`);
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

describe('issue #13: archived/ path filters and heal', () => {
  beforeEach(setupProject);

  it('dotmd next skips status:pending prompts under archived/', () => {
    writePromptAt(archivedDir, 'drifted-resume', { status: 'pending', created: '2024-01-01', body: 'STALE BODY' });
    writePromptAt(promptsDir, 'real-pending', { status: 'pending', created: '2025-06-01', body: 'REAL BODY' });

    const result = run(['next']);
    strictEqual(result.status, 0, `dotmd next failed: ${result.stderr}`);
    match(result.stdout, /REAL BODY/, 'should pick up the live pending prompt');
    doesNotMatch(result.stdout, /STALE BODY/, 'must NOT surface the drifted-archived prompt');
  });

  it('dotmd next reports "No pending prompts" when the only pending is drifted-archived', () => {
    writePromptAt(archivedDir, 'only-drifted', { status: 'pending', body: 'STALE' });

    const result = run(['next']);
    strictEqual(result.status, 1, 'no live pending → exit 1');
    match(result.stderr, /No pending prompts/);
  });

  it('query --exclude-archived filters out files physically under archived/', () => {
    writePromptAt(archivedDir, 'drifted-resume', { status: 'pending', body: 'STALE' });
    writePromptAt(promptsDir, 'real-pending', { status: 'pending', body: 'REAL' });

    const result = run(['query', '--type', 'prompt', '--exclude-archived']);
    strictEqual(result.status, 0);
    match(result.stdout, /real-pending/);
    doesNotMatch(result.stdout, /drifted-resume/, 'drifted file path must be excluded by --exclude-archived');
  });

  it('dotmd archive heals stuck frontmatter on a file already under archived/', () => {
    const file = writePromptAt(archivedDir, 'stuck', { status: 'pending', body: 'body' });

    const result = run(['archive', file]);
    strictEqual(result.status, 0, `archive should heal, not die: ${result.stderr}`);
    const after = readFileSync(file, 'utf8');
    match(after, /status: archived/);
    match(result.stdout + result.stderr, /Healed/i, 'should report a heal');
  });

  it('dotmd archive still rejects re-archiving an already-archived file', () => {
    const file = writePromptAt(archivedDir, 'already-archived', { status: 'archived', body: 'body' });

    const result = run(['archive', file]);
    strictEqual(result.status, 1, 'archived → archived should still die');
    match(result.stderr, /Already archived/);
  });

  it('dotmd check flags inverse drift (file under archived/ with non-archive status)', () => {
    writePromptAt(archivedDir, 'drifted', { status: 'pending', body: 'body' });

    const result = run(['check']);
    ok(result.status !== 0, 'inverse drift should fail check');
    match(result.stdout + result.stderr, /under `archived\/` but `status: pending`/);
    match(result.stdout + result.stderr, /heal the frontmatter in place/);
  });
});
