import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  removeGeneratedSlashCommands,
  refreshStaleSlashCommands,
  checkClaudeCommands,
} from '../src/claude-commands.mjs';

// Per-repo `.claude/commands/{plans,docs}.md` scaffolding is RETIRED — the
// dotmd plugin's SKILL.md carries the canonical workflow now. The module's only
// remaining job is teardown: delete the stale generated files (banner-gated, so
// hand-authored commands survive).

let tmpDir;

function setup({ claude = true } = {}) {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-claude-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
  if (claude) mkdirSync(path.join(tmpDir, '.claude'));
  return tmpDir;
}

function commandsDir() {
  return path.join(tmpDir, '.claude', 'commands');
}

function writeCommand(name, body) {
  mkdirSync(commandsDir(), { recursive: true });
  writeFileSync(path.join(commandsDir(), name), body);
}

const GENERATED = '---\ndescription: stale\n---\n<!-- dotmd-generated: 0.0.1 -->\nold body\n';
const USER_AUTHORED = '---\ndescription: my own command\n---\n# Hand-written, no dotmd banner\n';

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('removeGeneratedSlashCommands', () => {
  it('returns empty array when .claude/ does not exist', () => {
    setup({ claude: false });
    deepStrictEqual(removeGeneratedSlashCommands(tmpDir), []);
  });

  it('returns empty array when .claude/commands does not exist', () => {
    setup({ claude: true });
    deepStrictEqual(removeGeneratedSlashCommands(tmpDir), []);
  });

  it('removes banner-stamped generated files and reports them', () => {
    setup({ claude: true });
    writeCommand('plans.md', GENERATED);
    writeCommand('docs.md', GENERATED);
    const removed = removeGeneratedSlashCommands(tmpDir);
    strictEqual(removed.length, 2);
    ok(removed.every(r => r.action === 'removed'));
    ok(removed.some(r => r.name === 'plans.md'));
    ok(removed.some(r => r.name === 'docs.md'));
    ok(!existsSync(path.join(commandsDir(), 'plans.md')));
    ok(!existsSync(path.join(commandsDir(), 'docs.md')));
  });

  it('detects the banner even when frontmatter pushes it off line 1', () => {
    // The marker sits below the YAML frontmatter Claude Code surfaces as the
    // command description, so classification must not be line-1-anchored.
    setup({ claude: true });
    writeCommand('plans.md', GENERATED);
    strictEqual(removeGeneratedSlashCommands(tmpDir).length, 1);
  });

  it('detects the banner past 1KB of frontmatter (long vocab description)', () => {
    // Regression: the retired plans.md baked the full per-type status vocab into
    // its `description:` frontmatter — ~700+ chars — pushing the banner well
    // past any small head-read cap. Classification must scan the whole file.
    setup({ claude: true });
    const longDesc = 'dotmd-managed plan briefing. ' + 'Valid plan statuses: in-session, active, planned, blocked, partial, paused, awaiting, queued-after, archived. '.repeat(12);
    writeCommand('plans.md', `---\ndescription: ${longDesc}\n---\n<!-- dotmd-generated: 0.56.0 -->\n\nbody\n`);
    strictEqual(removeGeneratedSlashCommands(tmpDir).length, 1,
      'banner must be found even when it sits past 1KB of frontmatter');
    ok(!existsSync(path.join(commandsDir(), 'plans.md')));
  });

  it('never touches user-authored files (no dotmd banner)', () => {
    setup({ claude: true });
    writeCommand('baton.md', USER_AUTHORED);
    writeCommand('module-catalog.md', '# domain briefing, hand-written\n');
    const removed = removeGeneratedSlashCommands(tmpDir);
    deepStrictEqual(removed, []);
    ok(existsSync(path.join(commandsDir(), 'baton.md')), 'hand-authored command survives');
    ok(existsSync(path.join(commandsDir(), 'module-catalog.md')), 'hand-authored command survives');
  });

  it('removes only the generated files in a mixed directory', () => {
    setup({ claude: true });
    writeCommand('plans.md', GENERATED);     // generated → removed
    writeCommand('baton.md', USER_AUTHORED); // hand-authored → kept
    const removed = removeGeneratedSlashCommands(tmpDir);
    strictEqual(removed.length, 1);
    strictEqual(removed[0].name, 'plans.md');
    ok(!existsSync(path.join(commandsDir(), 'plans.md')));
    ok(existsSync(path.join(commandsDir(), 'baton.md')));
  });

  it('ignores non-markdown files', () => {
    setup({ claude: true });
    writeCommand('notes.txt', GENERATED); // banner present but not .md
    deepStrictEqual(removeGeneratedSlashCommands(tmpDir), []);
    ok(existsSync(path.join(commandsDir(), 'notes.txt')));
  });

  it('dry-run reports what would be removed without deleting', () => {
    setup({ claude: true });
    writeCommand('plans.md', GENERATED);
    const removed = removeGeneratedSlashCommands(tmpDir, { dryRun: true });
    strictEqual(removed.length, 1);
    strictEqual(removed[0].name, 'plans.md');
    ok(existsSync(path.join(commandsDir(), 'plans.md')), 'dry-run must not delete');
  });
});

describe('refreshStaleSlashCommands (hud SessionStart entrypoint)', () => {
  it('removes generated files via config.repoRoot and returns the removed entries', () => {
    setup({ claude: true });
    writeCommand('plans.md', GENERATED);
    const removed = refreshStaleSlashCommands({ repoRoot: tmpDir });
    strictEqual(removed.length, 1);
    strictEqual(removed[0].action, 'removed');
    ok(!existsSync(path.join(commandsDir(), 'plans.md')));
  });

  it('returns empty (silent-clean contract) when there is nothing to remove', () => {
    setup({ claude: true });
    writeCommand('baton.md', USER_AUTHORED);
    deepStrictEqual(refreshStaleSlashCommands({ repoRoot: tmpDir }), []);
  });
});

describe('checkClaudeCommands (no-op for API stability)', () => {
  it('returns empty regardless of state', () => {
    setup({ claude: true });
    writeCommand('plans.md', GENERATED);
    strictEqual(checkClaudeCommands(tmpDir).length, 0);
  });
});
