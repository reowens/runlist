#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { die, warn, levenshtein } from '../src/util.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const HELP = {
  _main: `dotmd v${pkg.version} — frontmatter markdown document manager

View & Query:
  hud [--json]                      Two-line actionable triage (held / prompts / stuck) — silent when clean
  list [--verbose] [--json]         List docs grouped by status (default command)
  briefing [--json]                 Full briefing with plan status counts + next steps
  context [--summarize] [--json]    Full briefing (LLM-oriented)
  focus [status] [--json]           Detailed view for one status group
  query [filters] [--json]          Filtered search (--status, --keyword, --stale, etc.)
  plans                             Live plans (excludes archived; --include-archived for all)
  prompts [list|next|use|archive|new]
                                    Manage saved prompts (default: list pending)
  stale                             Stale docs (preset)
  actionable                        Docs with next steps (preset)

Analyze:
  stats [--json]                    Doc health dashboard
  health [--json]                   Plan velocity, aging, and pipeline health
  coverage [--json]                 Metadata coverage report
  graph [--dot] [--json]            Visualize document relationships
  deps [file] [--json]              Dependency tree or overview
  unblocks <file> [--json]          Show what completes when this doc ships
  diff [file] [--summarize]         Show changes since last updated date
  summary <file> [--json]           AI summary of a document
  glossary <term> [--list] [--json] Look up domain terms + related docs

Validate & Fix:
  check [--fix] [--errors-only] [--json]  Validate frontmatter and references
  doctor [--dry-run]                Auto-fix everything: refs, lint, dates, index
  lint [--fix]                      Check and auto-fix frontmatter issues
  fix-refs [--dry-run]              Auto-fix broken reference paths + body links

Lifecycle:
  pickup <file> [--takeover]        Pick up a plan (set in-session + print body)
  release [<file>] [--to <s>]       Release in-session lease (alias: unpickup)
  finish <file> [done|active]       Finish a plan (set done or active)
  status <file> <status>            Transition document status
  archive <file>                    Archive (status + move + update refs)
  bulk archive <f1> <f2> ...        Archive multiple files at once
  bulk-tag [files...]               Tag pre-existing untagged .md files
  touch <file>                      Bump updated date
  touch --git                       Bulk-sync dates from git history
  rename <old> <new>                Rename doc and update all references
  migrate <field> <old> <new> [f...]Batch update a frontmatter field value (optional file filter)

Create & Export:
  new <type> <name> [body]          Create doc of given type (plan, doc, prompt)
  index [--print]                   Generate/update docs.md index block
  export [--format md|html|json]    Export docs as markdown, HTML, or JSON
  notion import|export|sync [db-id] Notion database integration

Setup:
  init                              Create starter config + docs directory
  statuses [list|add|set|remove|migrate]  Manage per-project status taxonomy
  watch [command]                   Re-run a command on file changes
  completions <shell>               Shell completion script (bash, zsh)

Global Options:
  --config <path>        Explicit config file path
  --root <name>          Filter to a specific docs root
  --type <t1,t2>         Filter by document type (plan, doc, research)
  --dry-run, -n          Preview changes without writing anything
  --verbose              Show config details and doc count
  --help, -h             Show help (per-command: dotmd <cmd> --help)
  --version, -v          Show version`,

  list: `dotmd list — list docs grouped by status

Options:
  --verbose              Show full details per doc
  --json                 Output full index as JSON (same as dotmd json)`,

  json: `dotmd json — full index as JSON

Outputs the complete document index as JSON to stdout.`,

  completions: `dotmd completions <bash|zsh> — output shell completion script

Add to your shell config:
  bash: eval "$(dotmd completions bash)"
  zsh:  eval "$(dotmd completions zsh)"`,

  query: `dotmd query — filtered document search

Filters:
  --type <t1,t2>         Filter by type (plan, doc, research)
  --status <s1,s2>       Filter by status (comma-separated)
  --keyword <term>       Search title, summary, state, path
  --module <name>        Filter by module
  --surface <name>       Filter by surface
  --domain <name>        Filter by domain
  --owner <name>         Filter by owner
  --updated-since <date> Only docs updated after date
  --stale                Only stale docs
  --has-next-step        Only docs with a next step
  --has-blockers         Only docs with blockers
  --checklist-open       Only docs with open checklist items
  --sort <field>         Sort by: updated (default), title, status
  --group <field>        Group by: module, surface, owner (plans view)
  --limit <n>            Max results (default: 20)
  --all                  Show all results (no limit)
  --git                  Use git dates instead of frontmatter
  --json                 Output as JSON
  --summarize            Add AI summaries to results
  --summarize-limit <n>  Max docs to summarize (default: 5)
  --model <name>         Model for AI summaries`,

  pickup: `dotmd pickup <file> — pick up a plan and start working

Sets the plan to in-session and prints its content (prefixed with a
"[dotmd] holding <path>" line so the fresh session knows what it holds).
Writes a session lease to <repoRoot>/.dotmd/in-session.json so the same
Claude session can re-attach silently after compaction or /clear.

If a plan is already in-session:
- Same session → silent re-attach (prints body, no error).
- Different session, live pid → refuses with "Held by …" message.
- Different session, dead pid or >24h old → suggests --takeover.

Options:
  --takeover             Force-claim a plan held by another session
  --json                 Output as JSON
  --dry-run, -n          Preview without writing

If no file is given, prompts with a list of active/planned plans.`,

  unpickup: `dotmd unpickup [<file>] — release a plan from in-session

With no file: releases every lease owned by the current session.
This is the form intended for a Claude Code SessionEnd hook.

With <file>: releases that one. Refuses if held by another session
(use --force to override).

Flips the plan's frontmatter status from in-session back to its
prior status (recorded by pickup), or whatever --to specifies.

Options:
  --to <status>          Override target status (default: lease.oldStatus → fallback active)
  --all                  Release every lease in the file (administrative)
  --stale                Release leases whose pid is dead or age >24h
  --force                Override "not yours" refusal on a specific file
  --json                 Output as JSON ({ released, skipped })
  --dry-run, -n          Preview without writing

Manual-edit fallback: if the plan's status is in-session but no lease
exists, --to <status> flips it anyway with a warning.`,

  release: `dotmd release [<file>] [--to <s>] — alias of dotmd unpickup

Release the in-session lease(s) and flip frontmatter back to the prior
status. With no file, releases every lease owned by the current session.
Identical behavior to \`dotmd unpickup\`; both names route to the same
implementation. See \`dotmd unpickup --help\` for full option list.`,

  finish: `dotmd finish <file> [done|active] — finish working on a plan

Sets the plan status to done (default) or back to active.
Only works on plans currently in-session.

Options:
  --json                 Output as JSON
  --dry-run, -n          Preview without writing

If no file is given, prompts with a list of in-session plans.`,

  status: `dotmd status <file> <new-status> — transition document status

Moves the document to the new status. If transitioning to an archive
status, automatically moves the file to the archive directory and
regenerates the index (if configured).

Default plan statuses (each maps to a distinct unstuck-action):
  in-session     A Claude session is working on it now
  active         Ready to be picked up
  planned        Queued for future work
  blocked        External arrival wait — monitor (hardware, vendor, rollout)
  partial        Shipped + deferred tail — spawn successor plans
  paused         Intentionally set aside — re-evaluate to resume
  awaiting       Needs human input/decision — chase the answer
  queued-after   Sequenced behind another plan — check predecessor
  archived       No longer relevant; auto-moved to archive directory

Use --dry-run (-n) to preview changes without writing anything.`,

  check: `dotmd check — validate frontmatter and references

Options:
  --errors-only          Show only errors, suppress warnings
  --fix                  Auto-fix broken refs, lint issues, and regenerate index
  --json                 Output errors and warnings as JSON
  --dry-run, -n          Preview fixes without writing (with --fix)`,

  archive: `dotmd archive <file> — archive a document

Sets status to 'archived', moves to the archive directory, auto-updates
references in other docs, and regenerates the index.

Use --dry-run (-n) to preview changes without writing anything.`,

  coverage: `dotmd coverage — metadata coverage report

Shows which docs are missing surface, module, or audit metadata.

Options:
  --json                 Machine-readable JSON output`,

  focus: `dotmd focus [status] — detailed view for one status group

Shows detailed info for all docs matching the given status (default: active).

Options:
  --json                 Output as JSON`,

  hud: `dotmd hud — actionable triage for session start

Prints up to three lines, in order:
  ▶ You hold N plans: <slugs>       (leases owned by current session)
  ▶ N pending prompts: <slugs>      (saved prompts in docs/prompts/)
  ⚠ N stuck leases >24h             (suggest \`dotmd release --stale\`)

Silent when all three are empty — designed for SessionStart hooks where
zero noise is the right default. Distinct from \`dotmd briefing\`, which
dumps the full plan-status pipeline and per-plan next_step bodies (kilobytes
on large repos). Use hud for ergonomic session boot; use briefing for
explicit "give me the full picture."

The pending-prompts line tells Claude to consume them via
\`dotmd prompts use <file>\` rather than reading/cat'ing — that atomically
prints the body and archives the prompt so it cannot be double-consumed.

Recommended SessionStart hook (in ~/.claude/settings.json):
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "dotmd hud", "timeout": 5 }] }]

Options:
  --json                 Output as JSON ({ owned, queued, prompts, stale })`,

  briefing: `dotmd briefing — compact summary for session start

Shows plan statuses with next steps, doc/research counts, and health
in 5-10 lines. Designed for LLM context injection.

Options:
  --json                 Output as JSON`,

  context: `dotmd context — full briefing (LLM-oriented)

Generates a compact status briefing designed for AI/LLM consumption.

Options:
  --json                 Output as JSON
  --summarize            Add AI summaries for expanded docs
  --model <name>         Model for AI summaries`,

  stats: `dotmd stats — doc health dashboard

Shows aggregated metrics: status counts, staleness, errors/warnings,
freshness, completeness, checklist progress, and audit coverage.

Options:
  --json                 Machine-readable JSON output`,

  graph: `dotmd graph — visualize document relationships

Output formats:
  (default)              Text adjacency list
  --dot                  Graphviz DOT format (pipe to dot -Tpng)
  --json                 Machine-readable JSON

Filters:
  --status <s1,s2>       Show only docs with these statuses
  --module <name>        Show only docs with this module
  --surface <name>       Show only docs with this surface`,

  deps: `dotmd deps [file] — dependency tree or overview

Without a file, shows a flat overview: most blocking docs, most blocked
docs, docs with blockers, and orphans.

With a file, shows a tree: what the doc depends on (recursive) and what
depends on it.

Options:
  --depth <n>            Max tree depth (default: 5)
  --json                 Machine-readable JSON output`,

  doctor: `dotmd doctor — auto-fix everything in one pass

Runs in sequence: fix broken references, lint --fix, sync dates from
git, regenerate index, then show remaining issues.

Modes:
  (default)              Auto-fix pass (writes by default; honors --dry-run)
  --statuses             Read-only diagnostic: detect overloaded status
                         buckets where one status holds plans pursuing
                         multiple distinct unstuck-actions. Suggests how
                         a bucket might split (e.g. backlog → partial /
                         paused / queued-after). Heuristic only — verify
                         before migrating.
  --statuses --json      Machine-readable suggestion shape for tooling.
  --migrate-template     Plan-template migrator for plans created before
                         v0.21. Auto-fixes:
                           - drops singular \`surface:\` when \`surfaces:\`
                             array is populated (same for \`module:\`/\`modules:\`)
                           - renames \`## Open questions\` → \`## Open Questions\`,
                             \`## Out of scope\` / \`## Non-goals\` → \`## Non-Goals\`
                           - adds \`## Version History\` section if missing,
                             seeded with the file's \`updated\` timestamp
                         Skips non-plans. Per-file diff. Doesn't touch
                         long next_step/current_state or unmarked phase
                         headings (those need human input).
  --migrate-prompts      Retrofit pre-existing markdown files under any docs
                         root's prompts/ subdirectory with proper prompt
                         frontmatter (type, status, created from git
                         history, dotmd_version, context, related_plans).
                         Skips files that already have frontmatter.
  --migrate-template <file>  Migrate just one plan.
  --migrate-template --include-archived
                         Also touch plans in the archive directory.
                         Default skips archived plans (they're closed
                         history; a "Migrated to v0.21 template" entry
                         in their Version History would be misleading).
  --migrate-template --json  Machine-readable result.

Use --dry-run (-n) to preview all changes without writing anything.`,

  'fix-refs': `dotmd fix-refs — auto-fix broken reference paths

Scans all docs for reference fields that point to non-existent files,
then attempts to resolve them by matching the basename against all known
docs. Fixes are applied by rewriting the frontmatter path.

Use --dry-run (-n) to preview changes without writing anything.`,

  touch: `dotmd touch <file> — bump updated date
       dotmd touch --git  — bulk-sync dates from git history

Without --git, updates a single file's frontmatter updated date to today.
With --git, scans all docs (or a specific file) and syncs their updated
date to match the last git commit date, fixing date drift warnings.

Use --dry-run (-n) to preview changes without writing anything.`,

  index: `dotmd index [--print] — generate/update docs.md index

Updates the configured index file in place (writes by default as of 0.34.0).
Use --print to dump the regenerated content to stdout without writing.

Use --dry-run (-n) to preview without writing.`,

  new: `dotmd new <type> <name> [body] — create a new document

Types and their default destinations:
  plan        docs/plans/<slug>.md     (build-up template: Problem → Phases → Closeout)
  doc         docs/<slug>.md           (build-up lite: Overview → Version History → Related)
  prompt      docs/prompts/<slug>.md   (saved prompt to seed a future session — body required)

\`<type>\` can be omitted; defaults to \`doc\`.
\`<name>\` is slugified for the filename.

Body input (prompt type only):
  <text>                 Inline body as 3rd positional
  --message "<text>"     Explicit inline body
  -                      Read body from stdin (heredoc-friendly for agents)
  @path                  Read body from a file

Examples:
  dotmd new plan auth-revamp
  dotmd new prompt cleanup-tomorrow "look at remaining lint warnings"
  dotmd new prompt resume-foo - <<'EOF'
  multi-line
  prompt body
  EOF
  dotmd new prompt from-file @/tmp/draft.md

Other options:
  --status <s>         Set initial status (defaults to first valid status for the type)
  --title <t>          Override the auto-derived title
  --root <name>        Create in a specific docs root
  --list-types         Show registered types (alias: --list-templates)

For plans, the default status vocabulary is: in-session, active, planned,
blocked, partial, paused, awaiting, queued-after, archived.
For prompts: pending (default), claimed, archived.

Use --dry-run (-n) to preview without creating the file.`,

  watch: `dotmd watch [command] — re-run a command on file changes

Watches the docs root for .md file changes and re-runs the specified
command. Defaults to 'list' if no command given.

Examples:
  dotmd watch              # re-run list on changes
  dotmd watch check        # re-run check on changes
  dotmd watch context      # live briefing`,

  notion: `dotmd notion — Notion database integration

Subcommands:
  import <database-id>   Pull Notion database → local .md files
  export <database-id>   Push local docs → Notion database rows
  sync <database-id>     Bidirectional sync (merge by slug)

Options:
  --force                Overwrite existing files on import
  --dry-run, -n          Preview without changes

Requires NOTION_TOKEN env var or notion.token in config.`,

  export: `dotmd export — export docs as markdown, HTML, or JSON

Without a file, exports all docs (with optional filters).
With a file, exports that doc plus all its dependencies.

Options:
  --format <md|html|json>  Output format (default: md)
  --output <path>          Write to file/directory (default: stdout for md/json)
  --status <s1,s2>         Filter by status
  --type <t1,t2>           Filter by type (plan, doc, research)
  --module <name>          Filter by module
  --root <name>            Filter by root
  --dry-run, -n            Preview without writing`,

  summary: `dotmd summary <file> — AI summary of a document

Generates an AI-powered summary using a local model.

Options:
  --model <name>         Model to use (default: mlx-community/Llama-3.2-3B-Instruct-4bit)
  --max-tokens <n>       Max tokens for generation (default: 200)
  --json                 Output as JSON`,

  diff: `dotmd diff [file] — show changes since last updated date

Shows git diffs for docs that changed after their frontmatter updated date.
Without a file argument, shows all drifted docs.

Options:
  --stat                 Summary only (files changed, insertions/deletions)
  --since <date>         Override: diff since this date instead of frontmatter
  --summarize            Generate AI summary using local model
  --model <name>         Model to use (default: mlx-community/Llama-3.2-3B-Instruct-4bit)`,

  lint: `dotmd lint [--fix] — check and auto-fix frontmatter issues

Scans all docs for fixable problems:
  - Missing status (inferred via local AI model when available)
  - Missing updated date (set to today)
  - Status casing (e.g. Active → active)
  - camelCase key names (e.g. nextStep → next_step)
  - Comma-separated surface values (converted to surfaces: array)
  - Trailing whitespace in frontmatter values
  - Missing newline at end of file

Without --fix, reports all issues. With --fix, applies fixes in place.
Use --dry-run (-n) with --fix to preview without writing anything.`,

  rename: `dotmd rename <old> <new> — rename doc and update references

Renames a document using git mv and updates all frontmatter references
in other docs that point to the old filename.

Body markdown links are warned about but not auto-fixed.
Use --dry-run (-n) to preview changes without writing anything.`,

  migrate: `dotmd migrate <field> <old-value> <new-value> [files...] — batch update a frontmatter field

Finds all docs where the given field equals old-value and updates it
to new-value. With no file args, every matching doc in the project is
rewritten (whole-bucket rename).

Pass one or more file args to scope the rewrite — only those files
are considered. This is how you split one overloaded status into
several distinct ones (e.g. moving some \`backlog\` plans to
\`paused\` and others to \`partial\`). File args use the same matching
as \`bulk archive\`: exact path, then substring fallback.

Examples:
  dotmd migrate status research scoping
  dotmd migrate module auth identity
  dotmd migrate status backlog paused docs/plans/foo.md docs/plans/bar.md

Use --dry-run (-n) to preview changes without writing anything.`,

  init: `dotmd init — create starter config and docs directory

Creates dotmd.config.mjs, docs/, and docs/docs.md in the current
directory. Skips any files that already exist.

If docs/ already contains .md files, auto-detects statuses, surfaces,
modules, and reference fields to pre-populate the config.`,

  plans: `dotmd plans — list live plans (excludes archived by default)

Shows documents with type: plan, excluding terminal/archive statuses,
sorted by status. Supports all query flags (--status, --module, --json,
--sort, --group, etc.).

Default plan statuses: in-session, active, planned, blocked, partial,
paused, awaiting, queued-after, archived. Run \`dotmd status --help\` for
the unstuck-action behind each one.

Examples:
  dotmd plans                          # live plans (default)
  dotmd plans --include-archived       # all plans including archived
  dotmd plans --status active          # active plans only
  dotmd plans --status awaiting        # plans waiting on a human decision
  dotmd plans --status partial,paused  # shipped-tail and parked plans
  dotmd plans --module auth            # plans for the auth module
  dotmd plans --group module           # plans grouped by module
  dotmd plans --json                   # JSON output`,

  prompts: `dotmd prompts — manage saved prompts (subcommand namespace)

Prompts are documents with \`type: prompt\`, typically saved under
docs/prompts/. They seed future Claude sessions; consuming a prompt
prints its body to stdout and atomically archives it (one-shot).

Subcommands:
  list                       List pending prompts (default)
  next                       Consume the oldest pending prompt:
                             print body to stdout, flip status to archived
  use <file-or-slug>         Consume a specific prompt (same as next, but
                             targets the named prompt instead of picking oldest)
  archive <file-or-slug>     Archive a prompt without printing its body
  new <slug> [body]          Create a new prompt (alias for
                             \`dotmd new prompt <slug> [body]\`)

\`<file-or-slug>\` accepts: an exact path (with or without .md), a bare
slug matching a prompt basename, or a unique substring of a prompt
path. Ambiguous substrings error with the candidate list.

Default prompt statuses: pending, claimed, archived.

Examples:
  dotmd prompts                        # pending prompts (default)
  dotmd prompts list --include-archived # all prompts including archived
  dotmd prompts list --status claimed   # already-consumed prompts
  dotmd prompts --json                 # JSON output

  claude "$(dotmd prompts next)"       # consume oldest pending + run claude
  claude "$(dotmd prompts use resume-foo)"           # by slug
  claude "$(dotmd prompts use docs/prompts/foo.md)"  # by path

  dotmd prompts next --dry-run         # preview without consuming
  dotmd prompts archive old-thing
  dotmd prompts new my-prompt "Body text here"`,

  stale: `dotmd stale — list stale documents

Shows docs that haven't been updated within their staleness threshold.
Supports all query flags (--status, --json, --sort, etc.)`,

  actionable: `dotmd actionable — list docs with next steps

Shows active/ready docs that have a next_step defined.
Supports all query flags (--status, --json, --sort, etc.)`,

  unblocks: `dotmd unblocks <file> — show what completes when this doc ships

Shows documents that reference or depend on the given file.
Useful for impact analysis before archiving or changing a plan.

Options:
  --json                 Output as JSON`,

  health: `dotmd health — plan velocity, aging, and pipeline health

Shows plan pipeline status, active plan aging, recently archived
plans, and checklist progress. Plans-only view.

Options:
  --json                 Output as JSON`,

  glossary: `dotmd glossary <term> — look up domain terms and related docs

Searches the glossary table in your docs for matching terms.
Shows definition, related docs, and see-also entries.

Options:
  --list                 List all glossary terms
  --json                 Output as JSON`,

  statuses: `dotmd statuses — manage per-project status taxonomy

Subcommands:
  list [--type <t>] [--json]            Default. Table view of every status × type with all flags.
                                        --type accepts comma-separated types.
  add <name> --type <t> [--like <e>] [flags...]
                                        Add a new status. --like <existing> clones every flag from
                                        another status; user flags override. Inserts before the
                                        first terminal/archive status. Refuses if name already
                                        exists or is invalid.
  set <name> --type <t> <flags...>      Edit flags on an existing status. Refuses if status doesn't
                                        exist. Flags overwrite individually.
  remove <name> --type <t>              Delete a status entry. Refuses if any docs use the status
                                        (lists offenders, suggests \`dotmd migrate\`). Warns if an
                                        explicit lifecycle export references the name.
  migrate <type>                        One-shot conversion of array-form types.<t>.statuses to
                                        rich form, pulling in peer staleDays/context and per-status
                                        requiresModule from taxonomy.moduleRequiredFor.

Flags accepted by add/set:
  --context <expanded|listed|counted>   Briefing layout bucket
  --staleDays <n|null>                  Stale threshold; null = never stale
  --requiresModule / --no-requiresModule
  --terminal / --no-terminal            Closure state — excluded from active-work scope
  --archive / --no-archive              Auto-move to archive dir on transition
  --skipStale / --no-skipStale
  --skipWarnings / --no-skipWarnings
  --quiet / --no-quiet                  Sugar for skipStale + skipWarnings (explicit overrides win)

Workflow flags:
  --yes                                 Skip the confirmation prompt
  --dry-run, -n                         Show the diff without writing
  --ignore-lifecycle-override           Write even when an explicit \`lifecycle\` export
                                        would silently mask the per-status flags

Examples:
  dotmd statuses                                                  # list everything
  dotmd statuses add paused --type plan --like blocked --quiet
  dotmd statuses set archived --type plan --no-quiet
  dotmd statuses remove obsolete --type plan
  dotmd statuses migrate plan                                     # array → rich

Lifecycle-override gotcha: if your config has both rich-form types and an explicit
\`export const lifecycle\`, the runtime ignores per-status flags. The CLI refuses
to write in that case unless you pass --ignore-lifecycle-override; the recommended
fix is to delete the explicit \`lifecycle\` block so flags take effect.`,

  bulk: `dotmd bulk archive <f1> <f2> ... — archive multiple files at once

Archives each file: sets status to archived, moves to archive
directory, updates references, and regenerates the index.

Use --dry-run (-n) to preview changes without writing anything.`,

  'bulk-tag': `dotmd bulk-tag [files...] — fill in type/status frontmatter on pre-existing markdown

Scans the docs tree for files that are missing either \`type:\` or \`status:\`
(or have no frontmatter block at all) and writes minimal frontmatter so they
appear in \`dotmd list\`, \`query\`, and \`briefing\`.

Type is inferred from the file's subdir under docsRoot:
  docs/plans/foo.md    → type: plan,   status: planned
  docs/prompts/bar.md  → type: prompt, status: pending
  docs/baz.md          → type: doc,    status: draft

Already-tagged files (both \`type:\` and \`status:\` set) are skipped. Files
under the archive directory are excluded.

Flags:
  --type <t>       Override inferred type for every candidate.
  --status <s>     Override the per-type default status.
  --json           Emit a structured candidate list.
  --dry-run (-n)   Preview without writing.

Pass file paths as positional args to scope to those files only; otherwise
the whole docs tree is scanned.`,
};

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'list';

  // Pre-config flags
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${HELP._main}\n`);
    return;
  }

  // Per-command help
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${HELP[command] ?? HELP._main}\n`);
    return;
  }

  if (command === 'completions') {
    const { runCompletions } = await import('../src/completions.mjs');
    runCompletions(args.slice(1));
    return;
  }

  // Extract --config flag
  let explicitConfig = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
      explicitConfig = args[i + 1];
      break;
    }
  }

  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const verbose = args.includes('--verbose');

  const config = await resolveConfig(process.cwd(), explicitConfig);

  // Init — runInit re-resolves the config from disk internally (after any
  // starter-config write), so we don't need to pre-pass it.
  if (command === 'init') {
    const { runInit } = await import('../src/init.mjs');
    await runInit(process.cwd(), config, { dryRun });
    return;
  }

  // Watch is a pure proxy — pass raw args so the child process gets all flags
  if (command === 'watch') { const { runWatch } = await import('../src/watch.mjs'); runWatch(args.slice(1), config); return; }

  // Strip global flags from restArgs so commands don't have to filter them
  const restArgs = [];
  let rootArg = null;
  let typeArg = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--config') { i++; continue; }
    if (args[i] === '--type' && args[i + 1]) { typeArg = args[++i]; continue; }
    if (args[i] === '--root' && args[i + 1]) { rootArg = args[++i]; continue; }
    if (args[i] === '--dry-run' || args[i] === '-n' || args[i] === '--verbose') continue;
    restArgs.push(args[i]);
  }

  if (!config.configFound && command !== 'init') {
    warn('No dotmd config found — using defaults. Run `dotmd init` to create one.');
  }

  if (config.configWarnings && config.configWarnings.length > 0) {
    for (const w of config.configWarnings) {
      warn(w);
    }
  }

  if (verbose) {
    process.stderr.write(`Config: ${config.configPath ?? 'none'}\n`);
    const roots = config.docsRoots || [config.docsRoot];
    process.stderr.write(`Docs root${roots.length > 1 ? 's' : ''}: ${roots.join(', ')}\n`);
    process.stderr.write(`Repo root: ${config.repoRoot}\n`);
  }

  // Preset aliases (user config can override built-in commands below)
  if (config.presets[command]) {
    const { buildIndex } = await import('../src/index.mjs');
    const { runQuery } = await import('../src/query.mjs');
    const index = buildIndex(config);
    runQuery(index, [...config.presets[command], ...restArgs], config, { preset: command });
    return;
  }

  // Built-in list commands — stable across projects regardless of preset config.
  // Two views per type:
  //   `dotmd plans`         triage — top 10 by recency, flat with right-aligned [TAG]
  //   `dotmd plans status`  pipeline — grouped by status, no per-row tag, all plans
  if (command === 'plans') {
    const { buildIndex } = await import('../src/index.mjs');
    const { runQuery } = await import('../src/query.mjs');
    const index = buildIndex(config);
    const sub = restArgs[0];
    let defaults;
    let extras = restArgs;
    if (sub === 'status') {
      defaults = ['--type', 'plan', '--exclude-archived', '--sort', 'status', '--all'];
      extras = restArgs.slice(1);
    } else {
      defaults = ['--type', 'plan', '--exclude-archived', '--sort', 'updated', '--limit', '10'];
    }
    runQuery(index, [...defaults, ...extras], config, { preset: 'plans' });
    return;
  }
  if (command === 'prompts') {
    const { runPrompts } = await import('../src/prompts.mjs');
    await runPrompts(restArgs, config, { dryRun });
    return;
  }

  // Commands that handle their own index building
  if (command === 'diff') { const { runDiff } = await import('../src/diff.mjs'); runDiff(restArgs, config); return; }
  if (command === 'summary') { const { runSummary } = await import('../src/summary.mjs'); runSummary(restArgs, config); return; }
  if (command === 'deps') { const { runDeps } = await import('../src/deps.mjs'); runDeps(restArgs, config); return; }
  if (command === 'unblocks') { const { runUnblocks } = await import('../src/deps.mjs'); runUnblocks(restArgs, config); return; }
  if (command === 'health') { const { runHealth } = await import('../src/health.mjs'); runHealth(restArgs, config); return; }
  if (command === 'glossary') { const { runGlossary } = await import('../src/glossary.mjs'); runGlossary(restArgs, config); return; }
  if (command === 'export') { const { runExport } = await import('../src/export.mjs'); runExport(restArgs, config, { dryRun, root: rootArg, type: typeArg }); return; }
  if (command === 'notion') { const { runNotion } = await import('../src/notion.mjs'); await runNotion(restArgs, config, { dryRun }); return; }

  // Lifecycle commands
  if (command === 'hud') { const { runHud } = await import('../src/hud.mjs'); runHud(restArgs, config); return; }
  if (command === 'pickup') { const { runPickup } = await import('../src/lifecycle.mjs'); await runPickup(restArgs, config, { dryRun }); return; }
  if (command === 'unpickup' || command === 'release') { const { runUnpickup } = await import('../src/lifecycle.mjs'); await runUnpickup(restArgs, config, { dryRun }); return; }
  if (command === 'handoff') { die('`dotmd handoff` was removed in 0.31.0. Use `dotmd prompts new <name>` to create a saved prompt instead. The .dotmd/handoffs/ sidecar mechanism no longer exists; see CHANGELOG.'); }
  if (command === 'finish') { const { runFinish } = await import('../src/lifecycle.mjs'); await runFinish(restArgs, config, { dryRun }); return; }
  if (command === 'status') { const { runStatus } = await import('../src/lifecycle.mjs'); await runStatus(restArgs, config, { dryRun }); return; }
  if (command === 'archive') { const { runArchive } = await import('../src/lifecycle.mjs'); runArchive(restArgs, config, { dryRun }); return; }
  if (command === 'bulk' && restArgs[0] === 'archive') { const { runBulkArchive } = await import('../src/lifecycle.mjs'); runBulkArchive(restArgs.slice(1), config, { dryRun }); return; }
  if (command === 'bulk' && restArgs[0] === 'tag') { const { runBulkTag } = await import('../src/bulk-tag.mjs'); runBulkTag(restArgs.slice(1), config, { dryRun }); return; }
  if (command === 'bulk-tag') { const { runBulkTag } = await import('../src/bulk-tag.mjs'); runBulkTag(restArgs, config, { dryRun }); return; }
  if (command === 'touch') { const { runTouch } = await import('../src/lifecycle.mjs'); runTouch(restArgs, config, { dryRun }); return; }
  if (command === 'new') { const { runNew } = await import('../src/new.mjs'); await runNew(restArgs, config, { dryRun, root: rootArg }); return; }
  if (command === 'lint') { const { runLint } = await import('../src/lint.mjs'); runLint(restArgs, config, { dryRun }); return; }
  if (command === 'rename') { const { runRename } = await import('../src/rename.mjs'); await runRename(restArgs, config, { dryRun }); return; }
  if (command === 'migrate') { const { runMigrate } = await import('../src/migrate.mjs'); runMigrate(restArgs, config, { dryRun }); return; }
  if (command === 'fix-refs') { const { runFixRefs } = await import('../src/fix-refs.mjs'); runFixRefs(restArgs, config, { dryRun }); return; }
  if (command === 'doctor') { const { runDoctor } = await import('../src/doctor.mjs'); runDoctor(restArgs, config, { dryRun }); return; }
  if (command === 'statuses') { const { runStatuses } = await import('../src/statuses.mjs'); await runStatuses(restArgs, config, { dryRun, type: typeArg }); return; }

  // All remaining commands need the index + render modules
  const { buildIndex } = await import('../src/index.mjs');
  const { renderCompactList, renderVerboseList, renderContext, renderBriefing, renderCheck, renderCoverage, buildCoverage } = await import('../src/render.mjs');
  const { runFocus, runQuery } = await import('../src/query.mjs');
  const index = buildIndex(config);

  // Apply --root and --type filters
  const rootFilter = rootArg;
  const typeFilter = typeArg;

  function applyIndexFilters(idx) {
    if (rootFilter) {
      idx.docs = idx.docs.filter(d => d.root === rootFilter || d.root.endsWith('/' + rootFilter) || d.root.split('/').pop() === rootFilter);
    }
    if (typeFilter) {
      const types = typeFilter.split(',').map(t => t.trim()).filter(Boolean);
      idx.docs = idx.docs.filter(d => types.includes(d.type));
    }
    if (rootFilter || typeFilter) {
      idx.errors = idx.errors.filter(e => idx.docs.some(d => d.path === e.path));
      idx.warnings = idx.warnings.filter(w => idx.docs.some(d => d.path === w.path));
      idx.countsByStatus = {};
      for (const doc of idx.docs) {
        const s = doc.status ?? 'unknown';
        idx.countsByStatus[s] = (idx.countsByStatus[s] ?? 0) + 1;
      }
    }
  }

  applyIndexFilters(index);

  if (rootFilter || typeFilter) {
  }

  if (verbose) {
    process.stderr.write(`Docs found: ${index.docs.length}\n`);
  }

  if (command === 'json') {
    process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
    return;
  }

  if (command === 'list') {
    if (args.includes('--json')) {
      process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
    } else if (args.includes('--verbose')) {
      process.stdout.write(renderVerboseList(index, config));
    } else {
      process.stdout.write(renderCompactList(index, config));
    }
    return;
  }

  if (command === 'check') {
    const fix = args.includes('--fix');
    const errorsOnly = args.includes('--errors-only');

    if (fix) {
      // Auto-fix: broken refs, then lint, then rebuild index
      const { fixBrokenRefs } = await import('../src/fix-refs.mjs');
      const { runLint } = await import('../src/lint.mjs');
      fixBrokenRefs(config, { dryRun, quiet: false });
      runLint(['--fix'], config, { dryRun });
      if (config.indexPath) {
        if (!dryRun) {
          const { renderIndexFile: rif, writeIndex: wi } = await import('../src/index-file.mjs');
          const freshIndex = buildIndex(config);
          wi(rif(freshIndex, config), config);
          process.stdout.write('Index regenerated.\n');
        } else {
          process.stdout.write('[dry-run] Would regenerate index.\n');
        }
      }
      // Show remaining issues
      const freshIndex = buildIndex(config);
      applyIndexFilters(freshIndex);
      if (args.includes('--json')) {
        process.stdout.write(JSON.stringify({
          docsScanned: freshIndex.docs.length,
          errors: freshIndex.errors,
          warnings: errorsOnly ? [] : freshIndex.warnings,
          errorCount: freshIndex.errors.length,
          warningCount: freshIndex.warnings.length,
          passed: freshIndex.errors.length === 0,
        }, null, 2) + '\n');
      } else {
        process.stdout.write('\n' + renderCheck(freshIndex, config, { errorsOnly }));
      }
      if (freshIndex.errors.length > 0) process.exitCode = 1;
      return;
    }

    if (args.includes('--json')) {
      process.stdout.write(JSON.stringify({
        docsScanned: index.docs.length,
        errors: index.errors,
        warnings: errorsOnly ? [] : index.warnings,
        errorCount: index.errors.length,
        warningCount: index.warnings.length,
        passed: index.errors.length === 0,
      }, null, 2) + '\n');
      if (index.errors.length > 0) process.exitCode = 1;
      return;
    }

    process.stdout.write(renderCheck(index, config, { errorsOnly }));
    if (index.errors.length > 0) process.exitCode = 1;
    return;
  }

  if (command === 'coverage') {
    if (args.includes('--json')) {
      process.stdout.write(`${JSON.stringify(buildCoverage(index, config), null, 2)}\n`);
    } else {
      process.stdout.write(renderCoverage(index, config));
    }
    return;
  }

  if (command === 'stats') {
    const { buildStats, renderStats, renderStatsJson } = await import('../src/stats.mjs');
    const stats = buildStats(index, config);
    if (args.includes('--json')) {
      process.stdout.write(renderStatsJson(stats));
    } else {
      process.stdout.write(renderStats(stats, config));
    }
    return;
  }

  if (command === 'index') {
    if (!config.indexPath) {
      die('Index generation is not configured. Add an `index` section to your dotmd.config.mjs.');
    }
    const print = args.includes('--print');
    const { renderIndexFile, writeIndex } = await import('../src/index-file.mjs');
    const rendered = renderIndexFile(index, config);
    if (print) {
      process.stdout.write(rendered);
    } else if (dryRun) {
      process.stdout.write(`[dry-run] Would update ${config.indexPath}\n`);
    } else {
      writeIndex(rendered, config);
      process.stdout.write(`Updated ${config.indexPath}\n`);
    }
    return;
  }

  if (command === 'focus') { runFocus(index, restArgs, config); return; }
  if (command === 'query') { runQuery(index, restArgs, config); return; }
  if (command === 'briefing') {
    if (args.includes('--json')) {
      const plans = index.docs.filter(d => d.type === 'plan');
      const docs = index.docs.filter(d => d.type === 'doc');
      const research = index.docs.filter(d => d.type === 'research');
      const stale = index.docs.filter(d => d.isStale && !config.lifecycle.skipStaleFor.has(d.status)).length;
      process.stdout.write(JSON.stringify({
        plans: { total: plans.length, inSession: plans.filter(d => d.status === 'in-session').map(d => ({ path: d.path, title: d.title, nextStep: d.nextStep })), active: plans.filter(d => d.status === 'active').map(d => ({ path: d.path, title: d.title, nextStep: d.nextStep })) },
        docs: { total: docs.length, active: docs.filter(d => !config.lifecycle.terminalStatuses.has(d.status)).length },
        research: { total: research.length, active: research.filter(d => d.status === 'active').length },
        stale, errorCount: index.errors.length, warningCount: index.warnings.length,
      }, null, 2) + '\n');
    } else {
      process.stdout.write(renderBriefing(index, config));
    }
    return;
  }

  if (command === 'context') {
    const summarize = args.includes('--summarize');
    const modelIdx = args.indexOf('--model');
    const model = modelIdx !== -1 && args[modelIdx + 1] ? args[modelIdx + 1] : undefined;

    if (args.includes('--json')) {
      const byStatus = {};
      for (const doc of index.docs) {
        const s = doc.status ?? 'unknown';
        if (!byStatus[s]) byStatus[s] = [];
        byStatus[s].push(doc);
      }
      const byType = {};
      for (const doc of index.docs) {
        if (doc.type) {
          if (!byType[doc.type]) byType[doc.type] = [];
          byType[doc.type].push(doc);
        }
      }
      if (summarize) {
        const { summarizeDocBody } = await import('../src/ai.mjs');
        const { extractFrontmatter } = await import('../src/frontmatter.mjs');
        const { readFileSync } = await import('node:fs');
        const limit = 5;
        for (let i = 0; i < index.docs.length && i < limit; i++) {
          try {
            const absPath = path.resolve(config.repoRoot, index.docs[i].path);
            const raw = readFileSync(absPath, 'utf8');
            const { body } = extractFrontmatter(raw);
            if (body?.trim()) {
              const meta = { title: index.docs[i].title, status: index.docs[i].status, path: index.docs[i].path };
              index.docs[i].aiSummary = config.hooks.summarizeDoc
                ? config.hooks.summarizeDoc(body, meta)
                : summarizeDocBody(body, meta, { model });
            }
          } catch { /* skip */ }
        }
      }
      const stale = index.docs.filter(d => d.isStale && !config.lifecycle.skipStaleFor.has(d.status));
      process.stdout.write(JSON.stringify({
        generatedAt: new Date().toISOString(),
        docsByType: Object.keys(byType).length > 0 ? byType : undefined,
        docsByStatus: byStatus,
        countsByStatus: index.countsByStatus,
        stale: stale.map(d => ({ path: d.path, title: d.title, daysSinceUpdate: d.daysSinceUpdate })),
        errorCount: index.errors.length,
        warningCount: index.warnings.length,
      }, null, 2) + '\n');
      return;
    }
    process.stdout.write(renderContext(index, config, { summarize, model }));
    return;
  }

  if (command === 'graph') {
    const { buildGraph, renderGraphText, renderGraphDot, renderGraphJson } = await import('../src/graph.mjs');
    const statusFilter = (() => { const i = args.indexOf('--status'); return i !== -1 && args[i + 1] ? args[i + 1] : null; })();
    const moduleFilter = (() => { const i = args.indexOf('--module'); return i !== -1 && args[i + 1] ? args[i + 1] : null; })();
    const surfaceFilter = (() => { const i = args.indexOf('--surface'); return i !== -1 && args[i + 1] ? args[i + 1] : null; })();
    const graph = buildGraph(index, config, {
      statuses: statusFilter?.split(',') ?? null,
      module: moduleFilter,
      surface: surfaceFilter,
    });
    if (args.includes('--dot')) {
      process.stdout.write(renderGraphDot(graph, config));
    } else if (args.includes('--json')) {
      process.stdout.write(renderGraphJson(graph));
    } else {
      process.stdout.write(renderGraphText(graph, config));
    }
    return;
  }

  // Unknown command — suggest closest match
  const { KNOWN_COMMANDS } = await import('../src/commands.mjs');
  const matches = KNOWN_COMMANDS
    .map(c => ({ cmd: c, dist: levenshtein(command, c) }))
    .sort((a, b) => a.dist - b.dist);
  if (matches[0] && matches[0].dist <= 3) {
    die(`Unknown command: ${command}\n\nDid you mean \`dotmd ${matches[0].cmd}\`?`);
  }
  die(`Unknown command: ${command}\n\nRun \`dotmd --help\` for available commands.`);
}

main().catch(err => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
