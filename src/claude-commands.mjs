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
  lines.push('- `dotmd pickup <file>` — pick up a plan (set in-session + print body or queued handoff)');
  lines.push('- `dotmd release` — release current session\'s leases (alias: unpickup)');
  lines.push('- `dotmd handoff <file> -` — queue a resume-prompt sidecar + release (see /handoff)');
  lines.push('- `dotmd health` — plan velocity, aging, checklist progress, pipeline view');
  lines.push('- `dotmd unblocks <file>` — what depends on / is blocked by a plan');
  lines.push('- `dotmd next` — ready plans with next steps (what to promote)');
  lines.push('- `dotmd new plan <name>` — scaffold with full phase structure');
  lines.push('- `dotmd new prompt <name> "<body>"` — save a resume-prompt to docs/prompts/');
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

  return lines.join('\n');
}

function generateHandoffCommand(config) {
  const lines = [VERSION_MARKER, ''];
  lines.push('Queue a resume-prompt sidecar for every plan this session is currently holding. Use this whenever the user asks for a "resume prompt" / "handoff" / "context dump", or when you are about to stop mid-work and the next session will need to pick up where you left off. NEVER print the resume prompt into chat for copy-paste — write it as a handoff sidecar so the next `dotmd pickup` can consume it cleanly.');
  lines.push('');
  lines.push('Steps:');
  lines.push('');
  lines.push('1. Identify which plans this session is holding by running:');
  lines.push('   ```');
  lines.push('   dotmd plans --status in-session --json');
  lines.push('   ```');
  lines.push('   Filter to leases owned by the current session (compare `lease.session` against `$CLAUDE_CODE_SESSION_ID` if needed). If the user passed a specific plan path as an argument, use only that one.');
  lines.push('');
  lines.push('2. For each held plan, synthesize a handoff prompt covering:');
  lines.push('   - One-line summary of where the session got to');
  lines.push('   - What is already done (and verified working)');
  lines.push('   - What is in flight / partial / needs verification');
  lines.push('   - Concrete next step the resuming session should take');
  lines.push('   - Key files touched (with paths) and any non-obvious gotchas');
  lines.push('   - Open questions or decisions deferred');
  lines.push('');
  lines.push('3. Write each handoff via Bash heredoc:');
  lines.push('   ```bash');
  lines.push('   dotmd handoff <plan-path> - <<\'EOF\'');
  lines.push('   <synthesized handoff body>');
  lines.push('   EOF');
  lines.push('   ```');
  lines.push('   Append-mode is the default. The sidecar accumulates timestamped sections, so a session that writes multiple handoffs over time builds up a chronicle the next session reads in order.');
  lines.push('');
  lines.push('4. Report back which plans got handoffs queued and where their sidecars live (the `▶ Handoff queued: <path>` output line). The user closes their window; the next session runs `claude "$(dotmd pickup <plan>)"` and lands seeded with the handoff content.');
  lines.push('');
  lines.push('Rules:');
  lines.push('- If a plan is not held by this session, do not write a handoff for it (dotmd will refuse anyway).');
  lines.push('- If `dotmd handoff` errors with a recoverable message (existing sidecar conflict, etc.), read the path it cites, merge mentally, then re-run with `--replace`.');
  lines.push('- Never print the resume text into the conversation as a copy-paste block.');
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
  lines.push('- `dotmd new prompt <name> "<body>"` — save a resume-prompt');
  lines.push('- `dotmd new research <name>` — scaffold an audit/investigation');
  lines.push('- `dotmd status <file> <status>` — transition status');
  lines.push('- `dotmd archive <file>` — archive with auto ref-fixing');
  lines.push('- `dotmd bulk archive <files>` — archive multiple at once');
  lines.push('- `dotmd touch --git` — bulk-sync updated dates from git history');
  lines.push('- `dotmd lint --fix` — auto-fix frontmatter issues');
  lines.push('- `dotmd fix-refs` — repair broken references and body links');
  lines.push('- `dotmd rename <old> <new>` — rename doc + update all references');
  lines.push('');

  return lines.join('\n');
}

function getInstalledVersion(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf8');
  const match = content.match(VERSION_REGEX);
  return match ? match[1] : null;
}

export function scaffoldClaudeCommands(cwd, config) {
  const claudeDir = path.join(cwd, '.claude');
  if (!existsSync(claudeDir)) return [];

  const commandsDir = path.join(claudeDir, 'commands');
  const results = [];

  const files = [
    { name: 'plans.md', generate: () => generatePlansCommand(config) },
    { name: 'docs.md', generate: () => generateDocsCommand(config) },
    { name: 'handoff.md', generate: () => generateHandoffCommand(config) },
  ];

  for (const { name, generate } of files) {
    const filePath = path.join(commandsDir, name);
    const installedVersion = getInstalledVersion(filePath);

    if (installedVersion === pkg.version) {
      results.push({ name, action: 'current' });
    } else if (installedVersion) {
      // Outdated — regenerate
      mkdirSync(commandsDir, { recursive: true });
      writeFileSync(filePath, generate(), 'utf8');
      results.push({ name, action: 'updated', from: installedVersion, to: pkg.version });
    } else if (!existsSync(filePath)) {
      // New — create
      mkdirSync(commandsDir, { recursive: true });
      writeFileSync(filePath, generate(), 'utf8');
      results.push({ name, action: 'created' });
    } else {
      // File exists but no version marker — user-managed, don't touch
      results.push({ name, action: 'skipped' });
    }
  }

  return results;
}

export function checkClaudeCommands(cwd) {
  const commandsDir = path.join(cwd, '.claude', 'commands');
  if (!existsSync(commandsDir)) return [];

  const warnings = [];
  for (const name of ['plans.md', 'docs.md', 'handoff.md']) {
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
