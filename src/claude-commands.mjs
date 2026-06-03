import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// dotmd used to scaffold per-repo `.claude/commands/{plans,docs}.md` slash
// commands — version-stamped, generated from each repo's status vocab, and
// self-healed by `dotmd hud`. That mechanism is RETIRED. The dotmd Claude Code
// plugin (plugins/dotmd/skills/dotmd/SKILL.md + bundled hooks) now carries the
// canonical agent-facing workflow into every repo and every subagent, and
// `dotmd hud` injects the dynamic per-project status vocab at runtime. A static
// skill + a runtime hook covers the full picture with no per-repo file to drift.
//
// The only job left in this module is teardown: delete the stale generated
// command files dotmd left behind so retired scaffolding stops shadowing the
// plugin skill. Removal is banner-gated — files WITHOUT the dotmd marker are
// hand-authored (e.g. a repo's own module-*.md / domain-*.md briefings) and are
// NEVER touched. Every dotmd-stamped file is fair game, including legacy ones
// dotmd no longer generates (e.g. the old baton.md).

const GENERATED_MARKER = '<!-- dotmd-generated:';

// The marker sits just below the YAML frontmatter Claude Code surfaces as the
// command description. That description can be long (the retired plans.md baked
// the full per-type status vocab into it), pushing the banner well past the
// first kilobyte — so classify against the whole file, not a head slice. These
// are tiny command files, so reading them in full is cheap.
function isGeneratedCommandFile(filePath) {
  try {
    return readFileSync(filePath, 'utf8').includes(GENERATED_MARKER);
  } catch {
    return false;
  }
}

// Remove every dotmd-generated slash-command file under .claude/commands.
// Returns [{ name, action: 'removed' }] for each file cleaned (or that would be
// cleaned, in dry-run). Never throws — teardown must not break a hook or a
// command. User-authored command files (no dotmd banner) survive untouched.
export function removeGeneratedSlashCommands(cwd, opts = {}) {
  const { dryRun = false } = opts;
  const commandsDir = path.join(cwd, '.claude', 'commands');
  if (!existsSync(commandsDir)) return [];
  let entries;
  try { entries = readdirSync(commandsDir); } catch { return []; }
  const removed = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const filePath = path.join(commandsDir, name);
    if (!isGeneratedCommandFile(filePath)) continue;
    if (!dryRun) {
      try { unlinkSync(filePath); } catch { continue; }
    }
    removed.push({ name, action: 'removed' });
  }
  return removed;
}

// Self-heal entrypoint for `dotmd hud` (SessionStart hook). Was: regenerate
// stale slash commands. Now: delete the retired generated files so the plugin
// skill is the single source of truth. Returns only the removed entries; an
// empty array preserves hud's silent-clean contract. Kept under the old name so
// hud's call site (and its swallow-all-errors wrapper) is unchanged.
export function refreshStaleSlashCommands(config) {
  return removeGeneratedSlashCommands(config.repoRoot);
}

// Retained as a no-op for API stability. `dotmd check` never warned on slash
// commands (the old auto-heal made it pure noise), and now there is nothing to
// generate at all. See git history for the retired scaffolder.
export function checkClaudeCommands(_cwd, _opts = {}) {
  return [];
}
