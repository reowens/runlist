import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scaffoldClaudeCommands, checkClaudeCommands } from '../src/claude-commands.mjs';
import { resolveConfig } from '../src/config.mjs';
import { KNOWN_COMMANDS } from '../src/commands.mjs';

let tmpDir;

function setup(opts = {}) {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-claude-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
  if (opts.claude) mkdirSync(path.join(tmpDir, '.claude'));
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('scaffoldClaudeCommands', () => {
  it('returns empty array when .claude/ does not exist', async () => {
    setup({ claude: false });
    const config = await resolveConfig(tmpDir);
    const results = scaffoldClaudeCommands(tmpDir, config);
    strictEqual(results.length, 0);
  });

  it('creates plans.md and docs.md when .claude/ exists', async () => {
    setup({ claude: true });
    const config = await resolveConfig(tmpDir);
    const results = scaffoldClaudeCommands(tmpDir, config);
    strictEqual(results.length, 2);
    ok(results.some(r => r.name === 'plans.md'));
    ok(results.some(r => r.name === 'docs.md'));
    ok(existsSync(path.join(tmpDir, '.claude', 'commands', 'plans.md')));
    ok(existsSync(path.join(tmpDir, '.claude', 'commands', 'docs.md')));
  });

  it('includes version marker in generated files', async () => {
    setup({ claude: true });
    const config = await resolveConfig(tmpDir);
    scaffoldClaudeCommands(tmpDir, config);
    const content = readFileSync(path.join(tmpDir, '.claude', 'commands', 'plans.md'), 'utf8');
    ok(content.includes('<!-- dotmd-generated:'));
  });

  it('reports action: created for new files', async () => {
    setup({ claude: true });
    const config = await resolveConfig(tmpDir);
    const results = scaffoldClaudeCommands(tmpDir, config);
    ok(results.every(r => r.action === 'created'));
  });

  it('reports action: current when version matches', async () => {
    setup({ claude: true });
    const config = await resolveConfig(tmpDir);
    // First run creates
    scaffoldClaudeCommands(tmpDir, config);
    // Second run finds them current
    const results = scaffoldClaudeCommands(tmpDir, config);
    ok(results.every(r => r.action === 'current'));
  });

  it('reports action: updated when version is outdated', async () => {
    setup({ claude: true });
    const config = await resolveConfig(tmpDir);
    // Create with a fake old version
    mkdirSync(path.join(tmpDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(path.join(tmpDir, '.claude', 'commands', 'plans.md'), '<!-- dotmd-generated: 0.0.1 -->\nold content');
    writeFileSync(path.join(tmpDir, '.claude', 'commands', 'docs.md'), '<!-- dotmd-generated: 0.0.1 -->\nold content');
    const results = scaffoldClaudeCommands(tmpDir, config);
    ok(results.every(r => r.action === 'updated'));
    ok(results[0].from === '0.0.1');
  });

  it('reports action: skipped for user-managed files (no version marker)', async () => {
    setup({ claude: true });
    const config = await resolveConfig(tmpDir);
    mkdirSync(path.join(tmpDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(path.join(tmpDir, '.claude', 'commands', 'plans.md'), '# My custom plans command');
    writeFileSync(path.join(tmpDir, '.claude', 'commands', 'docs.md'), '# My custom docs command');
    const results = scaffoldClaudeCommands(tmpDir, config);
    ok(results.every(r => r.action === 'skipped'));
  });
});

describe('checkClaudeCommands', () => {
  it('returns empty array when .claude/commands does not exist', () => {
    setup({ claude: false });
    const warnings = checkClaudeCommands(tmpDir);
    strictEqual(warnings.length, 0);
  });

  it('returns empty array when files are current version', async () => {
    setup({ claude: true });
    const config = await resolveConfig(tmpDir);
    scaffoldClaudeCommands(tmpDir, config);
    const warnings = checkClaudeCommands(tmpDir);
    strictEqual(warnings.length, 0);
  });

  it('returns warning when file version is outdated', () => {
    setup({ claude: true });
    mkdirSync(path.join(tmpDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(path.join(tmpDir, '.claude', 'commands', 'plans.md'), '<!-- dotmd-generated: 0.0.1 -->\nold');
    const warnings = checkClaudeCommands(tmpDir);
    ok(warnings.length > 0);
    ok(warnings[0].message.includes('outdated'));
  });

  it('does not warn about files without version marker', () => {
    setup({ claude: true });
    mkdirSync(path.join(tmpDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(path.join(tmpDir, '.claude', 'commands', 'plans.md'), '# User-managed');
    const warnings = checkClaudeCommands(tmpDir);
    strictEqual(warnings.length, 0);
  });
});

describe('generated content teaches prompt consumption', () => {
  it('plans.md tells Claude to consume docs/prompts/ files via `dotmd prompts use`', async () => {
    setup({ claude: true });
    const config = await resolveConfig(tmpDir);
    scaffoldClaudeCommands(tmpDir, config);
    const content = readFileSync(path.join(tmpDir, '.claude', 'commands', 'plans.md'), 'utf8');
    ok(content.includes('dotmd prompts use'), 'mentions `dotmd prompts use`');
    ok(content.includes('dotmd prompts next'), 'mentions `dotmd prompts next`');
    ok(content.includes('docs/prompts/'), 'mentions docs/prompts/ convention');
    ok(/do not\s+`?cat`?/i.test(content), 'warns against cat/read');
  });

  it('docs.md mentions the prompts subcommands', async () => {
    setup({ claude: true });
    const config = await resolveConfig(tmpDir);
    scaffoldClaudeCommands(tmpDir, config);
    const content = readFileSync(path.join(tmpDir, '.claude', 'commands', 'docs.md'), 'utf8');
    ok(content.includes('dotmd prompts use'), 'mentions `dotmd prompts use`');
    ok(content.includes('dotmd prompts new'), 'mentions `dotmd prompts new`');
  });

  it('every `dotmd <verb>` in generated templates points at a real command', async () => {
    // Pre-fix: the generated plans.md listed `dotmd next` — a phantom command
    // that has never existed in the dispatcher. Agents reading the slash
    // command doc hit `Unknown command: next`. This test parses every backtick
    // `dotmd <verb>` from both generated templates and asserts each verb is
    // in the canonical KNOWN_COMMANDS list. Prevents future template drift.
    setup({ claude: true });
    const config = await resolveConfig(tmpDir);
    scaffoldClaudeCommands(tmpDir, config);

    const known = new Set(KNOWN_COMMANDS);
    const referenced = new Set();
    for (const name of ['plans.md', 'docs.md']) {
      const content = readFileSync(path.join(tmpDir, '.claude', 'commands', name), 'utf8');
      // Match the first verb after `dotmd `: word chars, may contain `-`.
      for (const match of content.matchAll(/`dotmd ([a-z][a-z0-9-]*)/g)) {
        referenced.add(match[1]);
      }
    }

    ok(referenced.size > 0, 'sanity: should find at least one referenced command');
    const unknown = [...referenced].filter(v => !known.has(v));
    strictEqual(unknown.length, 0, `templates reference unknown commands: ${unknown.join(', ')}`);
  });
});
