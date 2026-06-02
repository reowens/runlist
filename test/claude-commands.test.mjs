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
    ok(!results.some(r => r.name === 'baton.md'), 'baton command must no longer be scaffolded');
    ok(existsSync(path.join(tmpDir, '.claude', 'commands', 'plans.md')));
    ok(existsSync(path.join(tmpDir, '.claude', 'commands', 'docs.md')));
    ok(!existsSync(path.join(tmpDir, '.claude', 'commands', 'baton.md')));
  });

  it('includes version marker in generated files', async () => {
    setup({ claude: true });
    const config = await resolveConfig(tmpDir);
    scaffoldClaudeCommands(tmpDir, config);
    const content = readFileSync(path.join(tmpDir, '.claude', 'commands', 'plans.md'), 'utf8');
    ok(content.includes('<!-- dotmd-generated:'));
  });

  it('appends per-type status vocab to the plans description', async () => {
    // Fix D: agents arriving via SessionStart should see valid statuses in
    // the available-skills system reminder, not need a `dotmd statuses list`
    // discovery round-trip before the first `dotmd status` / `dotmd archive`.
    setup({ claude: true });
    const config = await resolveConfig(tmpDir);
    scaffoldClaudeCommands(tmpDir, config);
    const content = readFileSync(path.join(tmpDir, '.claude', 'commands', 'plans.md'), 'utf8');
    const match = content.match(/^---\ndescription:\s*(.+)\n---\n/);
    ok(match, 'plans.md must have frontmatter description');
    const desc = match[1];

    // Every declared type from default config must contribute a vocab clause.
    for (const [type, statusesSet] of config.typeStatuses.entries()) {
      if (statusesSet.size === 0) continue;
      ok(desc.includes(`Valid ${type} statuses:`),
        `plans description should declare valid ${type} statuses; got: ${desc}`);
      for (const status of statusesSet) {
        ok(desc.includes(status),
          `plans description should list ${type} status \`${status}\`; got: ${desc}`);
      }
    }
  });

  it('respects per-type status override from user config', async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-claude-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    mkdirSync(path.join(tmpDir, '.claude'));
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const root = 'docs';
      export const types = {
        plan: { statuses: ['drafting', 'shipping', 'shipped'] },
        doc: { statuses: ['active', 'archived'] },
      };
    `);
    const config = await resolveConfig(tmpDir);
    scaffoldClaudeCommands(tmpDir, config);
    const content = readFileSync(path.join(tmpDir, '.claude', 'commands', 'plans.md'), 'utf8');
    const desc = content.match(/^---\ndescription:\s*(.+)\n---\n/)[1];
    ok(desc.includes('Valid plan statuses: drafting, shipping, shipped'),
      `plans description should reflect plan override; got: ${desc}`);
    ok(desc.includes('Valid doc statuses: active, archived'),
      `plans description should reflect doc override; got: ${desc}`);
    ok(!desc.includes('in-session'),
      `plans description should not leak built-in plan statuses when config overrides; got: ${desc}`);
  });

  it('truncates a type vocab with more than 12 statuses', async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-claude-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    mkdirSync(path.join(tmpDir, '.claude'));
    const manyStatuses = Array.from({ length: 15 }, (_, i) => `s${i}`);
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const root = 'docs';
      export const types = {
        plan: { statuses: ${JSON.stringify(manyStatuses)} },
      };
    `);
    const config = await resolveConfig(tmpDir);
    scaffoldClaudeCommands(tmpDir, config);
    const content = readFileSync(path.join(tmpDir, '.claude', 'commands', 'plans.md'), 'utf8');
    const desc = content.match(/^---\ndescription:\s*(.+)\n---\n/)[1];
    ok(desc.includes('s0') && desc.includes('s11'),
      `truncated vocab should include first 12 entries; got: ${desc}`);
    ok(desc.includes('…'), `truncated vocab should end with ellipsis; got: ${desc}`);
    ok(!desc.includes('s12') && !desc.includes('s14'),
      `truncated vocab should drop entries past the cap; got: ${desc}`);
  });

  it('leaves docs.md description unchanged (vocab only on plans)', async () => {
    setup({ claude: true });
    const config = await resolveConfig(tmpDir);
    scaffoldClaudeCommands(tmpDir, config);
    for (const name of ['docs.md']) {
      const content = readFileSync(path.join(tmpDir, '.claude', 'commands', name), 'utf8');
      const desc = content.match(/^---\ndescription:\s*(.+)\n---\n/)[1];
      ok(!/Valid \w+ statuses:/.test(desc),
        `${name} description should NOT carry vocab clause; got: ${desc}`);
    }
  });

  it('emits YAML frontmatter with a description for each command', async () => {
    // Claude Code surfaces this `description:` field in the available-skills
    // system reminder at session start. Without it, the listing shows the
    // version marker as the description (e.g. `plans: <!-- dotmd-generated: 0.38.1 -->`)
    // and Claude has no trigger context. This test pins the contract.
    setup({ claude: true });
    const config = await resolveConfig(tmpDir);
    scaffoldClaudeCommands(tmpDir, config);
    for (const name of ['plans.md', 'docs.md']) {
      const content = readFileSync(path.join(tmpDir, '.claude', 'commands', name), 'utf8');
      ok(content.startsWith('---\n'), `${name} should start with --- frontmatter`);
      const match = content.match(/^---\ndescription:\s*(.+)\n---\n/);
      ok(match, `${name} should have a description field in frontmatter`);
      ok(match[1].length > 30, `${name} description should be a real sentence, got: ${match[1]}`);
      // Frontmatter must come BEFORE the version marker
      ok(
        content.indexOf('---\ndescription:') < content.indexOf('<!-- dotmd-generated:'),
        `${name} frontmatter must precede the version marker`,
      );
    }
  });

  it('still detects outdated banner when frontmatter pushes it off line 1', async () => {
    // Regression: VERSION_REGEX was line-1-anchored. After moving the banner
    // below frontmatter, the regex was loosened — this test pins that it can
    // still detect old version markers wherever they sit in the file.
    // Banner regex no longer drives a warning (slash-command staleness is
    // silently self-healed by `dotmd hud`), but the parser still needs to
    // recognize banners wherever they sit. Pin parser behavior via
    // scaffoldClaudeCommands instead.
    setup({ claude: true });
    mkdirSync(path.join(tmpDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(
      path.join(tmpDir, '.claude', 'commands', 'plans.md'),
      '---\ndescription: stale\n---\n<!-- dotmd-generated: 0.0.1 -->\nold body\n',
    );
    const config = await resolveConfig(tmpDir);
    const results = scaffoldClaudeCommands(tmpDir, config);
    const plans = results.find(r => r.name === 'plans.md');
    ok(plans, 'parser sees plans.md');
    strictEqual(plans.action, 'updated', 'detects the outdated banner');
    strictEqual(plans.from, '0.0.1');
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

describe('checkClaudeCommands (silent self-heal contract)', () => {
  // checkClaudeCommands intentionally returns [] in all cases — stale stamps
  // are healed by `dotmd hud` on SessionStart and by the npm-version `version`
  // script during release. Surfacing a warning at `dotmd check` time was pure
  // noise (the user had no action to take). These tests pin the silence.

  it('returns empty when .claude/commands does not exist', () => {
    setup({ claude: false });
    strictEqual(checkClaudeCommands(tmpDir).length, 0);
  });

  it('returns empty when files are current version', async () => {
    setup({ claude: true });
    const config = await resolveConfig(tmpDir);
    scaffoldClaudeCommands(tmpDir, config);
    strictEqual(checkClaudeCommands(tmpDir).length, 0);
  });

  it('returns empty even when stamp is outdated (heal lives elsewhere)', () => {
    setup({ claude: true });
    mkdirSync(path.join(tmpDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(path.join(tmpDir, '.claude', 'commands', 'plans.md'), '<!-- dotmd-generated: 0.0.1 -->\nold');
    strictEqual(checkClaudeCommands(tmpDir).length, 0,
      'no warning fired — hud / doctor / release-script handle the heal');
  });

  it('returns empty for user-managed (no version marker) files', () => {
    setup({ claude: true });
    mkdirSync(path.join(tmpDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(path.join(tmpDir, '.claude', 'commands', 'plans.md'), '# User-managed');
    strictEqual(checkClaudeCommands(tmpDir).length, 0);
  });
});

describe('generated content teaches prompt consumption', () => {
  it('plans.md tells Claude to consume docs/prompts/ files via top-level `dotmd use`', async () => {
    setup({ claude: true });
    const config = await resolveConfig(tmpDir);
    scaffoldClaudeCommands(tmpDir, config);
    const content = readFileSync(path.join(tmpDir, '.claude', 'commands', 'plans.md'), 'utf8');
    ok(content.includes('dotmd use'), 'mentions `dotmd use`');
    ok(content.includes('docs/prompts/'), 'mentions docs/prompts/ convention');
    ok(/do not\s+`?cat`?/i.test(content), 'warns against cat/read');
  });

  it('docs.md teaches prompt creation and consumption via the flat verbs', async () => {
    setup({ claude: true });
    const config = await resolveConfig(tmpDir);
    scaffoldClaudeCommands(tmpDir, config);
    const content = readFileSync(path.join(tmpDir, '.claude', 'commands', 'docs.md'), 'utf8');
    ok(content.includes('dotmd use'), 'mentions `dotmd use` (top-level consumer)');
    ok(content.includes('dotmd new prompt'), 'mentions `dotmd new prompt` (top-level save)');
  });

  it('docs.md prescribes `dotmd doctor --apply` for auto-fix, not bare doctor (M2)', async () => {
    // M2: bare `dotmd doctor` previews by default (F4/0.37.0). The generated
    // briefing ships into every repo's .claude/commands, so a bare-doctor
    // "auto-fix everything" line misleads agents fleet-wide into a no-op.
    setup({ claude: true });
    const config = await resolveConfig(tmpDir);
    scaffoldClaudeCommands(tmpDir, config);
    const content = readFileSync(path.join(tmpDir, '.claude', 'commands', 'docs.md'), 'utf8');
    ok(content.includes('dotmd doctor --apply'), 'auto-fix line names --apply');
    ok(!/`dotmd doctor`\s+—\s+auto-fix/.test(content), 'no bare-doctor auto-fix prescription');
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
