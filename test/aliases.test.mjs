import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

let tmpDir;
const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-aliases-'));
  spawnSync('git', ['init'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(path.join(docsDir, 'prompts'), { recursive: true });
  mkdirSync(path.join(docsDir, 'prompts', 'archived'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\n`);
  return docsDir;
}

function writePrompt(docsDir, filename, frontmatter, body = 'body') {
  const filePath = path.join(docsDir, 'prompts', filename);
  writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`);
  spawnSync('git', ['add', filePath], { cwd: tmpDir });
  spawnSync('git', ['commit', '-m', `add ${filename}`], { cwd: tmpDir });
  return filePath;
}

function runCli(args) {
  return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
    cwd: tmpDir,
    encoding: 'utf8',
    env: { ...process.env, PATH: process.env.PATH },
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('command aliases (F20)', () => {
  it('`dotmd prompt list` produces the same output as `dotmd prompts list`', () => {
    const docsDir = setupProject();
    writePrompt(docsDir, 'a.md', 'type: prompt\nstatus: pending\ncreated: 2025-01-01');
    writePrompt(docsDir, 'b.md', 'type: prompt\nstatus: pending\ncreated: 2025-01-02');

    const plural = runCli(['prompts', 'list', '--json']);
    const singular = runCli(['prompt', 'list', '--json']);
    strictEqual(plural.status, 0, `prompts failed: ${plural.stderr}`);
    strictEqual(singular.status, 0, `prompt failed: ${singular.stderr}`);
    strictEqual(singular.stdout, plural.stdout,
      'singular `prompt` must produce byte-identical JSON to plural `prompts`');
  });

  it('`dotmd prompt --help` prints the prompts help (HELP.prompts)', () => {
    setupProject();
    const plural = runCli(['prompts', '--help']);
    const singular = runCli(['prompt', '--help']);
    strictEqual(plural.status, 0);
    strictEqual(singular.status, 0);
    strictEqual(singular.stdout, plural.stdout,
      '`prompt --help` must route to HELP.prompts (singular rewrite must precede --help dispatch)');
    ok(plural.stdout.includes('dotmd prompts — manage saved prompts'),
      'sanity: help text is the prompts namespace help');
  });

  it('`dotmd prompts resume <file>` produces the same output as `dotmd prompts use <file>`', () => {
    // Use two distinct prompts so each invocation has its own consumable target —
    // `use` archives the prompt, so we can't consume the same file twice.
    const docsDir = setupProject();
    writePrompt(docsDir, 'p1.md', 'type: prompt\nstatus: pending\ncreated: 2025-01-01', 'body-one');
    writePrompt(docsDir, 'p2.md', 'type: prompt\nstatus: pending\ncreated: 2025-01-01', 'body-one');

    const viaUse = runCli(['prompts', 'use', 'docs/prompts/p1.md']);
    const viaResume = runCli(['prompts', 'resume', 'docs/prompts/p2.md']);
    strictEqual(viaUse.status, 0, `use failed: ${viaUse.stderr}`);
    strictEqual(viaResume.status, 0, `resume failed: ${viaResume.stderr}`);

    // Normalize the filename diff before comparing — bodies are identical, but
    // each output names its own input file in the "Archived: …" line.
    const normalize = s => s.replace(/p[12]\.md/g, 'pX.md');
    strictEqual(normalize(viaResume.stdout), normalize(viaUse.stdout),
      '`resume` must emit the same output shape as `use`');
  });

  it('`dotmd prompt resume <file>` chains both aliases (singular + verb)', () => {
    // Belt-and-suspenders: the singular rewrite happens at the dispatcher
    // layer, so subcommand-level aliases (`resume` → `use`) must still apply
    // after the rewrite. If the rewrite were positioned wrong, this would
    // fall through to "unknown subcommand."
    const docsDir = setupProject();
    writePrompt(docsDir, 'p.md', 'type: prompt\nstatus: pending\ncreated: 2025-01-01', 'chained-body');

    const r = runCli(['prompt', 'resume', 'docs/prompts/p.md']);
    strictEqual(r.status, 0, `chained alias failed: ${r.stderr}`);
    ok(r.stdout.includes('chained-body'), `expected prompt body on stdout; got: ${r.stdout}`);
    ok(/Consumed/.test(r.stderr), `canonical "Consumed" line on stderr; got: ${r.stderr}`);
  });
});
