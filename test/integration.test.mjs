import { describe, it, beforeEach, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

function run(args, opts = {}) {
  return spawnSync('node', [BIN, ...args], {
    cwd: tmpDir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    ...opts,
  });
}

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-int-'));

  spawnSync('git', ['init'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(path.join(docsDir, 'archived'), { recursive: true });

  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
    export const root = 'docs';
  `);

  return docsDir;
}

function writeDoc(docsDir, filename, fm, body = '') {
  const p = path.join(docsDir, filename);
  writeFileSync(p, `---\n${fm}\n---\n${body}`);
  spawnSync('git', ['add', p], { cwd: tmpDir });
  spawnSync('git', ['commit', '-m', `add ${filename}`], { cwd: tmpDir });
  return p;
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('CLI integration', () => {
  it('--version prints version', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-ver-'));
    const result = run(['--version']);
    ok(/^\d+\.\d+\.\d+/.test(result.stdout.trim()), `got: ${result.stdout}`);
  });

  it('--help prints usage', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-help-'));
    const result = run(['--help']);
    ok(result.stdout.includes('View & Query:'));
  });

  it('list shows docs grouped by status', () => {
    const docsDir = setupProject();
    const today = new Date().toISOString().slice(0, 10);
    writeDoc(docsDir, 'alpha.md', `status: active\nupdated: ${today}`, '# Alpha\n> Summary A\n');
    writeDoc(docsDir, 'beta.md', `status: planned\nupdated: ${today}`, '# Beta\n> Summary B\n');

    const result = run(['list']);
    ok(result.stdout.includes('Alpha'), 'shows Alpha');
    ok(result.stdout.includes('Beta'), 'shows Beta');
  });

  it('json outputs valid JSON', () => {
    const docsDir = setupProject();
    const today = new Date().toISOString().slice(0, 10);
    writeDoc(docsDir, 'doc.md', `status: active\nupdated: ${today}\ntitle: Test Doc`, '# Test Doc\n');

    const result = run(['json']);
    const parsed = JSON.parse(result.stdout);
    ok(parsed.docs.length > 0, 'has docs');
    strictEqual(parsed.docs[0].title, 'Test Doc');
    strictEqual(parsed.docs[0].status, 'active');
  });

  it('check reports errors for missing status', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'bad.md', 'updated: 2025-01-01', '# Bad Doc\n');

    const result = run(['check']);
    ok(result.stdout.includes('Missing frontmatter `status`'), 'reports missing status');
  });

  it('check passes for valid doc', () => {
    const docsDir = setupProject();
    const today = new Date().toISOString().slice(0, 10);
    writeDoc(docsDir, 'good.md', `status: active\nupdated: ${today}\ntitle: Good\nsummary: A valid doc\ncurrent_state: All good\nnext_step: Keep going`, '# Good\n');

    const result = run(['check']);
    ok(result.stdout.includes('0') || result.stdout.includes('No issues') || result.stdout.includes('passed'), `check output: ${result.stdout}`);
  });

  it('query --status filters correctly', () => {
    const docsDir = setupProject();
    const today = new Date().toISOString().slice(0, 10);
    writeDoc(docsDir, 'a.md', `status: active\nupdated: ${today}\ntitle: Active One`, '# Active One\n');
    writeDoc(docsDir, 'p.md', `status: planned\nupdated: ${today}\ntitle: Planned One`, '# Planned One\n');

    const result = run(['query', '--status', 'planned', '--all']);
    ok(result.stdout.includes('Planned One'), 'shows planned doc');
    ok(!result.stdout.includes('Active One'), 'hides active doc');
  });

  it('context outputs briefing', () => {
    const docsDir = setupProject();
    const today = new Date().toISOString().slice(0, 10);
    writeDoc(docsDir, 'ctx.md', `status: active\nupdated: ${today}\ntitle: Context Doc\nnext_step: Do the thing`, '# Context Doc\n');

    const result = run(['context']);
    ok(result.stdout.includes('BRIEFING'), 'outputs briefing header');
  });

  it('--verbose prints config details and doc count', () => {
    const docsDir = setupProject();
    const today = new Date().toISOString().slice(0, 10);
    writeDoc(docsDir, 'v.md', `status: active\nupdated: ${today}`, '# Verbose Doc\n');

    const result = run(['list', '--verbose']);
    // --verbose is also the list verbose flag; test the dedicated --verbose flag with json
    const result2 = run(['json', '--verbose']);
    ok(result2.stderr.includes('Config:'), 'shows config path');
    ok(result2.stderr.includes('Docs root:'), 'shows docs root');
    ok(result2.stderr.includes('Repo root:'), 'shows repo root');
    ok(result2.stderr.includes('Docs found:'), 'shows doc count');
  });

  it('warns when no config found', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-noconf-'));
    // No config file, no .git — just an empty dir
    const result = run(['json']);
    ok(result.stderr.includes('No dotmd config found'), 'shows no-config warning');
  });

  it('focus shows docs for a specific status', () => {
    const docsDir = setupProject();
    const today = new Date().toISOString().slice(0, 10);
    writeDoc(docsDir, 'f.md', `status: ready\nupdated: ${today}\ntitle: Ready Doc\ncurrent_state: Waiting`, '# Ready Doc\n');

    const result = run(['focus', 'ready']);
    ok(result.stdout.includes('Ready Doc'), 'shows the ready doc');
    ok(result.stdout.includes('READY'), 'shows status header');
  });
});
