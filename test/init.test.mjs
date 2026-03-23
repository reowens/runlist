import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

function run(args, cwd) {
  return spawnSync('node', [BIN, ...args], {
    cwd: cwd ?? tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('init basic', () => {
  it('creates config, docs dir, and index file', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(existsSync(path.join(tmpDir, 'dotmd.config.mjs')));
    ok(existsSync(path.join(tmpDir, 'docs')));
    ok(existsSync(path.join(tmpDir, 'docs', 'docs.md')));
  });

  it('config contains default root', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    run(['init']);
    const content = readFileSync(path.join(tmpDir, 'dotmd.config.mjs'), 'utf8');
    ok(content.includes("root = 'docs'"));
  });

  it('index file contains markers', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    run(['init']);
    const content = readFileSync(path.join(tmpDir, 'docs', 'docs.md'), 'utf8');
    ok(content.includes('GENERATED:dotmd:start'));
    ok(content.includes('GENERATED:dotmd:end'));
  });
});

describe('init idempotency', () => {
  it('skips config file when it already exists', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), 'export const root = "custom";');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('exists'));
    const content = readFileSync(path.join(tmpDir, 'dotmd.config.mjs'), 'utf8');
    ok(content.includes('custom'), 'original config preserved');
  });

  it('skips docs dir when it already exists', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'));
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('exists'));
  });

  it('skips index file when it already exists', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'));
    writeFileSync(path.join(tmpDir, 'docs', 'docs.md'), '# Custom Index');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const content = readFileSync(path.join(tmpDir, 'docs', 'docs.md'), 'utf8');
    strictEqual(content, '# Custom Index', 'original index preserved');
  });
});

describe('init scanning', () => {
  it('detects statuses from existing frontmatter', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\n---\n# A');
    writeFileSync(path.join(tmpDir, 'docs', 'b.md'), '---\nstatus: blocked\n---\n# B');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('detected'));
    const config = readFileSync(path.join(tmpDir, 'dotmd.config.mjs'), 'utf8');
    ok(config.includes('active'));
    ok(config.includes('blocked'));
  });

  it('detects surfaces from existing frontmatter', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\nsurface: web\n---\n# A');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const config = readFileSync(path.join(tmpDir, 'dotmd.config.mjs'), 'utf8');
    ok(config.includes('web'));
    ok(config.includes('taxonomy'));
  });

  it('detects reference fields from existing frontmatter', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\ndepends_on:\n  - b.md\n---\n# A');
    writeFileSync(path.join(tmpDir, 'docs', 'b.md'), '---\nstatus: active\n---\n# B');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const config = readFileSync(path.join(tmpDir, 'dotmd.config.mjs'), 'utf8');
    ok(config.includes('referenceFields'));
    ok(config.includes('depends_on'));
  });

  it('preserves known status ordering', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: blocked\n---\n# A');
    writeFileSync(path.join(tmpDir, 'docs', 'b.md'), '---\nstatus: active\n---\n# B');
    run(['init']);
    const config = readFileSync(path.join(tmpDir, 'dotmd.config.mjs'), 'utf8');
    const activeIdx = config.indexOf("'active'");
    const blockedIdx = config.indexOf("'blocked'");
    ok(activeIdx < blockedIdx, 'active appears before blocked in status order');
  });

  it('skips files without frontmatter', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'readme.md'), '# Just a readme\nNo frontmatter here.');
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\n---\n# A');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('detected 1 docs'));
  });
});

describe('init Claude integration', () => {
  it('scaffolds .claude/commands when .claude/ exists and config found', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, '.claude'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    // Config must exist before init so config is passed to scaffoldClaudeCommands
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(existsSync(path.join(tmpDir, '.claude', 'commands', 'plans.md')));
    ok(existsSync(path.join(tmpDir, '.claude', 'commands', 'docs.md')));
  });

  it('skips Claude commands when .claude/ does not exist', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!existsSync(path.join(tmpDir, '.claude', 'commands')));
  });
});
