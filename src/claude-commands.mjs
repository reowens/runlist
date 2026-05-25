import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { green, dim, yellow } from './color.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const VERSION_MARKER = `<!-- dotmd-generated: ${pkg.version} -->`;
const VERSION_REGEX = /^<!-- dotmd-generated: ([\d.]+) -->/;

function generatePlansCommand(config) {
  const lines = [VERSION_MARKER, ''];
  lines.push('Run `dotmd context` to get the current plans briefing, then use it to orient yourself.');
  lines.push('');
  lines.push(`Plans are managed by **dotmd** (v${pkg.version}). Config at \`dotmd.config.mjs\`. Always use \`dotmd\` directly.`);
  lines.push('');
  lines.push('Plan-specific commands:');
  lines.push('- `dotmd context` — briefing with active/paused/ready plans, age tags, next steps');
  lines.push('- `dotmd pickup <file>` — pick up a plan (set in-session + print body)');
  lines.push('- `dotmd release` — release current session\'s leases (alias: unpickup)');
  lines.push('- `dotmd health` — plan velocity, aging, checklist progress, pipeline view');
  lines.push('- `dotmd unblocks <file>` — what depends on / is blocked by a plan');
  lines.push('- `dotmd actionable` — ready plans with next steps (what to promote)');
  lines.push('- `dotmd new plan <name>` — scaffold with full phase structure');
  lines.push('- `dotmd prompts new <name> "<body>"` — save a resume-prompt to docs/prompts/');
  lines.push('- `dotmd prompts next` — consume oldest pending prompt (prints body, auto-archives)');
  lines.push('- `dotmd prompts use <file>` — consume a specific prompt (prints body, auto-archives)');
  lines.push('- `dotmd archive <file>` — archive with auto ref-fixing (both directions)');
  lines.push('- `dotmd bulk archive <files>` — archive multiple at once');
  lines.push('- `dotmd status <file> <status>` — transition status');
  lines.push('- `dotmd query --keyword <term>` — find plans by keyword');

  if (config.raw?.glossary) {
    lines.push('- `dotmd glossary <term>` — domain term lookup with related plans');
  }

  lines.push('');
  lines.push('If the user asks about a specific plan, read its file directly (path is in the briefing or findable via `dotmd query --keyword <term>`).');
  lines.push('');
  lines.push('If the user asks to change a plan\'s status, use `dotmd status <file> <status>`.');
  lines.push('If the user asks to archive a plan, use `dotmd archive <file>`.');
  lines.push('');
  lines.push('**Saved prompts (`docs/prompts/*.md`):** if the user references a file under `docs/prompts/` — e.g. "resume via docs/prompts/foo.md", "use this prompt", "load that one" — consume it with `dotmd prompts use <file>` (atomically prints the body and archives the prompt so it cannot be double-consumed). Do NOT `cat` it, read it with the file-reading tool, or copy its body into chat. To pick the oldest pending prompt without naming a file, use `dotmd prompts next`.');
  lines.push('');

  return lines.join('\n');
}

function generateBatonCommand() {
  const lines = [VERSION_MARKER, ''];
  lines.push('You are wrapping this session. Hand the baton cleanly to the next one.');
  lines.push('');
  lines.push('1. **Update the in-flight plan.** Find it via `dotmd plans --status in-session`. Edit its `current_state:` / `next_step:` frontmatter so they reflect where things actually stand. If status should change (shipped → archive, stuck on a human decision → awaiting, etc.), transition with `dotmd status <file> <status>` — or `dotmd archive <file>` if work is done.');
  lines.push('');
  lines.push('2. **Save ONE lean handoff prompt.** Run `dotmd new prompt resume-<plan-slug>` with a body of ~10-20 lines: point at the plan file, name the next concrete decision, flag any gotchas. Do NOT recap the plan body (the plan is for that). Do NOT print the handoff into chat for the user to copy-paste — the saved prompt is the handoff.');
  lines.push('');
  lines.push('3. **Release the lease.** `dotmd release` (skip if `dotmd archive` already closed out — archive auto-releases).');
  lines.push('');
  lines.push('The next session\'s `dotmd hud` (SessionStart hook) surfaces the pending prompt automatically.');
  lines.push('');

  return lines.join('\n');
}

function generateDocsCommand(config) {
  const roots = Array.isArray(config.raw?.root) ? config.raw.root : [config.raw?.root ?? 'docs'];
  const rootCount = roots.length;

  const lines = [VERSION_MARKER, ''];
  lines.push(`All documentation in this repo is managed by **dotmd** (v${pkg.version}). Docs across ${rootCount} root${rootCount > 1 ? 's' : ''}: ${roots.join(', ')}. Config at \`dotmd.config.mjs\`.`);
  lines.push('');

  // Document types from config
  const types = config.raw?.types ? Object.keys(config.raw.types) : [];
  if (types.length > 0) {
    lines.push(`Document types: ${types.map(t => '`' + t + '`').join(', ')}.`);
    lines.push('');
  }

  lines.push('Commands for working with docs:');
  lines.push('- `dotmd context` — LLM-oriented briefing across all types');
  lines.push('- `dotmd check` — validate frontmatter, refs, body links (target: 0 errors)');
  lines.push('- `dotmd doctor` — auto-fix everything in one pass (refs, lint, dates, index)');
  lines.push('- `dotmd query [filters]` — search by status, keyword, module, surface, type, staleness');
  lines.push('- `dotmd health` — plan pipeline, velocity, aging');
  lines.push('- `dotmd stats` — doc health dashboard (completeness, checklists, audit coverage)');
  lines.push('- `dotmd graph [--dot]` — visualize document relationships');
  lines.push('- `dotmd deps [file]` — dependency tree');
  lines.push('- `dotmd unblocks <file>` — impact analysis for a doc');
  lines.push('- `dotmd diff [file]` — git changes since last updated date');
  lines.push('- `dotmd list` — all docs grouped by status');
  lines.push('- `dotmd focus <status>` — detailed view for one status group');

  if (config.raw?.glossary) {
    lines.push('- `dotmd glossary <term>` — domain term lookup with related docs and plans');
  }

  lines.push('');
  lines.push('Lifecycle:');
  lines.push('- `dotmd new plan <name>` — scaffold new plan');
  lines.push('- `dotmd new doc <name>` — scaffold reference doc');
  lines.push('- `dotmd prompts new <name> "<body>"` — save a resume-prompt');
  lines.push('- `dotmd prompts next` — consume oldest pending prompt (prints body, auto-archives)');
  lines.push('- `dotmd prompts use <file>` — consume a specific prompt (prints body, auto-archives)');
  lines.push('- `dotmd status <file> <status>` — transition status');
  lines.push('- `dotmd archive <file>` — archive with auto ref-fixing');
  lines.push('- `dotmd bulk archive <files>` — archive multiple at once');
  lines.push('- `dotmd touch --git` — bulk-sync updated dates from git history');
  lines.push('- `dotmd lint --fix` — auto-fix frontmatter issues');
  lines.push('- `dotmd fix-refs` — repair broken references and body links');
  lines.push('- `dotmd rename <old> <new>` — rename doc + update all references');
  lines.push('');
  lines.push('**Saved prompts (`docs/prompts/*.md`):** if the user references a file under `docs/prompts/` — e.g. "resume via docs/prompts/foo.md", "use this prompt" — consume it with `dotmd prompts use <file>` (prints the body and archives atomically). Do NOT `cat` it or read it with the file-reading tool. To pick the oldest pending prompt without naming a file, use `dotmd prompts next`.');
  lines.push('');

  return lines.join('\n');
}

function getInstalledVersion(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf8');
  const match = content.match(VERSION_REGEX);
  return match ? match[1] : null;
}

export function scaffoldClaudeCommands(cwd, config, opts = {}) {
  const { dryRun = false } = opts;
  const claudeDir = path.join(cwd, '.claude');
  if (!existsSync(claudeDir)) return [];

  const commandsDir = path.join(claudeDir, 'commands');
  const results = [];

  const files = [
    { name: 'plans.md', generate: () => generatePlansCommand(config) },
    { name: 'docs.md', generate: () => generateDocsCommand(config) },
    { name: 'baton.md', generate: () => generateBatonCommand() },
  ];

  for (const { name, generate } of files) {
    const filePath = path.join(commandsDir, name);
    const installedVersion = getInstalledVersion(filePath);

    if (installedVersion === pkg.version) {
      results.push({ name, action: 'current' });
    } else if (installedVersion) {
      // Outdated — regenerate
      if (!dryRun) {
        mkdirSync(commandsDir, { recursive: true });
        writeFileSync(filePath, generate(), 'utf8');
      }
      results.push({ name, action: 'updated', from: installedVersion, to: pkg.version });
    } else if (!existsSync(filePath)) {
      // New — create
      if (!dryRun) {
        mkdirSync(commandsDir, { recursive: true });
        writeFileSync(filePath, generate(), 'utf8');
      }
      results.push({ name, action: 'created' });
    } else {
      // File exists but no version marker — user-managed, don't touch
      results.push({ name, action: 'skipped' });
    }
  }

  return results;
}

// Self-heal: regen any slash-command file whose banner is older than pkg.version.
// Designed for runHud to call at SessionStart — closes the gap between "user
// upgraded dotmd" and "slash-command body reflects the new version" without
// requiring a manual `dotmd doctor`. Returns only the entries that actually
// changed so the caller can surface a one-line note; an empty array means the
// hud silent-clean contract is preserved. `skipped` (user-managed, no banner)
// and `current` entries are filtered out — callers don't care about them.
export function refreshStaleSlashCommands(config) {
  const results = scaffoldClaudeCommands(config.repoRoot, config);
  return results.filter(r => r.action === 'updated');
}

export function checkClaudeCommands(cwd) {
  const commandsDir = path.join(cwd, '.claude', 'commands');
  if (!existsSync(commandsDir)) return [];

  const warnings = [];
  for (const name of ['plans.md', 'docs.md', 'baton.md']) {
    const filePath = path.join(commandsDir, name);
    const installedVersion = getInstalledVersion(filePath);
    if (installedVersion && installedVersion !== pkg.version) {
      warnings.push({
        path: `.claude/commands/${name}`,
        level: 'warning',
        message: `Claude command outdated (v${installedVersion} → v${pkg.version}). Run \`dotmd doctor\` to update.`,
      });
    }
  }
  return warnings;
}
