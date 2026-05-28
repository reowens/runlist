import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { green, dim, yellow } from './color.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
// Marker is no longer pinned to line 1 — it now lives below the YAML
// frontmatter that Claude Code surfaces as the slash command's description.
// The regex is intentionally non-anchored so getInstalledVersion finds it
// wherever it sits, and the marker string is specific enough that a false
// positive elsewhere in a user-edited file is not a realistic concern.
const VERSION_REGEX = /<!-- dotmd-generated: ([\d.]+) -->/;
function markerFor(version) { return `<!-- dotmd-generated: ${version} -->`; }

// Trigger sentences surfaced by Claude Code's available-skills system reminder.
// Front-load the "when to reach for it" cue so Claude can route to the right
// slash command without the user having to type the slash. The plans entry
// gets a per-type status vocab appended at generation time so agents arrive
// with the valid `dotmd status` / `dotmd archive` values already in context.
const SLASH_DESCRIPTIONS = {
  plans: "dotmd-managed plan briefing for this repo. Use when the user asks what's on the plate, references a plan slug, queues work, or wants to start / close / archive a plan.",
  docs: "dotmd-managed docs briefing for this repo. Use when the user asks to list, scaffold, query, validate, archive, or rename non-plan docs (reference docs, ADRs, RFCs, design notes), or asks how the dotmd doc lifecycle works here.",
  baton: "Save a resume prompt for the active plan and close it out — the minimum handoff. Use when the user says hand off / save a resume / wrap up, or when context is getting tight.",
};

const VOCAB_TRUNCATE_AT = 12;

// Per-type valid statuses, rendered as one clause per type. Appended to the
// plans description so it lands in Claude's available-skills listing at
// SessionStart — no discovery command needed before the first `dotmd status`
// / `dotmd archive` call. Types with no declared statuses are skipped (the
// generic global list applies); types with >VOCAB_TRUNCATE_AT statuses are
// truncated with an ellipsis so the description stays bounded.
function statusVocabClause(config) {
  if (!config?.typeStatuses) return '';
  const parts = [];
  for (const [type, statusesSet] of config.typeStatuses.entries()) {
    if (!statusesSet || statusesSet.size === 0) continue;
    let statuses = [...statusesSet];
    if (statuses.length > VOCAB_TRUNCATE_AT) {
      statuses = [...statuses.slice(0, VOCAB_TRUNCATE_AT), '…'];
    }
    parts.push(`Valid ${type} statuses: ${statuses.join(', ')}.`);
  }
  return parts.join(' ');
}

function frontmatterFor(name, config) {
  let description = SLASH_DESCRIPTIONS[name];
  if (name === 'plans') {
    const vocab = statusVocabClause(config);
    if (vocab) description = `${description} ${vocab}`;
  }
  return ['---', `description: ${description}`, '---'];
}

function generatePlansCommand(config, version) {
  const lines = [...frontmatterFor('plans', config), markerFor(version), ''];
  lines.push('Run `dotmd context` to get the current plans briefing, then use it to orient yourself.');
  lines.push('');
  lines.push(`Plans are managed by **dotmd** (v${version}). Config at \`dotmd.config.mjs\`. Always use \`dotmd\` directly.`);
  lines.push('');
  lines.push('Plan-specific commands:');
  lines.push('- `dotmd context` — briefing with active/paused/ready plans, age tags, next steps');
  lines.push('- `dotmd set <status> [<file>]` — single status verb. Use this to start, transition, or close any plan:');
  lines.push('    - `dotmd set in-session <file>` — start work on a plan (marks in-session + prints body)');
  lines.push('    - `dotmd set <status> [<file>]` — transition to any other status; closes out the in-session marker automatically');
  lines.push('    - `dotmd set archived <file>` — close out (same as `dotmd archive`)');
  lines.push('- `dotmd archive <file>` — explicit archive with ref-fixing (equivalent to `set archived`)');
  lines.push('- `dotmd bulk archive <files>` — archive multiple at once');
  lines.push('- `dotmd new plan <name>` — scaffold with full phase structure');
  lines.push('- `dotmd new prompt <name>` — save a resume-prompt to docs/prompts/ (pipe stdin or @path for body)');
  lines.push('- `dotmd use` — consume oldest pending prompt (prints body, auto-archives)');
  lines.push('- `dotmd use <file>` — open any doc by type: prompt → consume, plan → start work, doc → read');
  lines.push('- `dotmd unblocks <file>` — what depends on / is blocked by a plan');
  lines.push('- `dotmd actionable` — ready plans with next steps (what to promote)');
  lines.push('- `dotmd query --keyword <term>` — find plans by keyword');

  if (config.raw?.glossary) {
    lines.push('- `dotmd glossary <term>` — domain term lookup with related plans');
  }

  lines.push('');
  lines.push('If the user asks about a specific plan, read its file directly (path is in the briefing or findable via `dotmd query --keyword <term>`).');
  lines.push('');
  lines.push('If the user asks to change a plan\'s status, use `dotmd set <status> <file>`.');
  lines.push('If the user asks to archive a plan, use `dotmd set archived <file>` (or `dotmd archive <file>`).');
  lines.push('');
  lines.push('**Saved prompts (`docs/prompts/*.md`):** if the user references a file under `docs/prompts/` — e.g. "resume via docs/prompts/foo.md", "use this prompt", "load that one" — consume it with `dotmd use <file>` (atomically prints the body and archives the prompt so it cannot be double-consumed). Do NOT `cat` it, read it with the file-reading tool, or copy its body into chat. To pick the oldest pending prompt without naming a file, run `dotmd use` with no arg.');
  lines.push('');

  return lines.join('\n');
}

function generateBatonCommand(config, version) {
  const lines = [...frontmatterFor('baton', config), markerFor(version), ''];
  lines.push('Wrap this session. Two commands:');
  lines.push('');
  lines.push('1. **Save the resume prompt.** `dotmd new prompt resume-<plan-slug>` — pipe stdin or pass `@path`. 10-20 line body: the next concrete decision plus any gotchas. NOT a recap of the plan body. The saved prompt IS the handoff — never print it into chat for copy-paste.');
  lines.push('');
  lines.push('2. **Close out via `dotmd set <status>`.** Pick the status that matches reality:');
  lines.push('    - `dotmd set active <file>` — work continues, return the plan to the active queue');
  lines.push('    - `dotmd set archived <file>` — fully shipped (also: `dotmd archive <file>`)');
  lines.push('    - `dotmd set paused <file>` / `awaiting <file>` / `partial <file>` / `blocked <file>` — when the status really changed');
  lines.push('  `set` clears the in-session marker automatically when transitioning to any other status.');
  lines.push('');
  lines.push('If you don\'t already know which plan you have in-session: `dotmd hud --json` and read `.owned`. Do NOT use `dotmd plans --status in-session` — that lists every session\'s in-session plans, not just yours.');
  lines.push('');
  lines.push('The next session\'s `dotmd hud` (SessionStart hook) surfaces the pending prompt automatically.');
  lines.push('');

  return lines.join('\n');
}

function generateDocsCommand(config, version) {
  const roots = Array.isArray(config.raw?.root) ? config.raw.root : [config.raw?.root ?? 'docs'];
  const rootCount = roots.length;

  const lines = [...frontmatterFor('docs', config), markerFor(version), ''];
  lines.push(`All documentation in this repo is managed by **dotmd** (v${version}). Docs across ${rootCount} root${rootCount > 1 ? 's' : ''}: ${roots.join(', ')}. Config at \`dotmd.config.mjs\`.`);
  lines.push('');

  // Document types from config
  const types = config.raw?.types ? Object.keys(config.raw.types) : [];
  if (types.length > 0) {
    lines.push(`Document types: ${types.map(t => '`' + t + '`').join(', ')}.`);
    lines.push('');
  }

  lines.push('Commands for working with docs:');
  lines.push('- `dotmd context` — LLM-oriented briefing across all types');
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
  lines.push('- `dotmd new prompt <name>` — save a resume-prompt (pipe stdin or @path for body)');
  lines.push('- `dotmd use` — consume oldest pending prompt (prints body, auto-archives)');
  lines.push('- `dotmd use <file>` — open any doc by type: prompt → consume, plan → start work, doc → read');
  lines.push('- `dotmd set <status> [<file>]` — unified transition (archive / status bump; infers path from your active in-session plan)');
  lines.push('- `dotmd status <file> <status>` — transition status (legacy; `set` is preferred)');
  lines.push('- `dotmd archive <file>` — archive with auto ref-fixing');
  lines.push('- `dotmd bulk archive <files>` — archive multiple at once');
  lines.push('- `dotmd touch --git` — bulk-sync updated dates from git history');
  lines.push('- `dotmd lint --fix` — auto-fix frontmatter issues');
  lines.push('- `dotmd fix-refs` — repair broken references and body links');
  lines.push('- `dotmd rename <old> <new>` — rename doc + update all references');
  lines.push('');
  lines.push('**Saved prompts (`docs/prompts/*.md`):** if the user references a file under `docs/prompts/` — e.g. "resume via docs/prompts/foo.md", "use this prompt" — consume it with `dotmd use <file>` (prints the body and archives atomically). Do NOT `cat` it or read it with the file-reading tool. To pick the oldest pending prompt without naming a file, run `dotmd use` with no arg.');
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
  const { dryRun = false, version = pkg.version } = opts;
  const claudeDir = path.join(cwd, '.claude');
  if (!existsSync(claudeDir)) return [];

  const commandsDir = path.join(claudeDir, 'commands');
  const results = [];

  const files = [
    { name: 'plans.md', generate: () => generatePlansCommand(config, version) },
    { name: 'docs.md', generate: () => generateDocsCommand(config, version) },
    { name: 'baton.md', generate: () => generateBatonCommand(config, version) },
  ];

  for (const { name, generate } of files) {
    const filePath = path.join(commandsDir, name);
    const installedVersion = getInstalledVersion(filePath);

    if (installedVersion === version) {
      results.push({ name, action: 'current' });
    } else if (installedVersion) {
      // Outdated — regenerate
      if (!dryRun) {
        mkdirSync(commandsDir, { recursive: true });
        writeFileSync(filePath, generate(), 'utf8');
      }
      results.push({ name, action: 'updated', from: installedVersion, to: version });
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

export function checkClaudeCommands(cwd, opts = {}) {
  const { version = pkg.version } = opts;
  const commandsDir = path.join(cwd, '.claude', 'commands');
  if (!existsSync(commandsDir)) return [];

  const warnings = [];
  for (const name of ['plans.md', 'docs.md', 'baton.md']) {
    const filePath = path.join(commandsDir, name);
    const installedVersion = getInstalledVersion(filePath);
    if (installedVersion && installedVersion !== version) {
      warnings.push({
        path: `.claude/commands/${name}`,
        level: 'warning',
        message: `Claude command outdated (v${installedVersion} → v${version}). Run \`dotmd doctor\` to update.`,
      });
    }
  }
  return warnings;
}
