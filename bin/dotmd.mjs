#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { die, warn, levenshtein, isArchivedPath, toRepoPath } from '../src/util.mjs';
import { recordCliInvocation, recordGlobalError, sanitizeTelemetryArgv } from '../src/journal.mjs';
import { findRepeatFailureHint } from '../src/hints.mjs';
import {
  KNOWN_COMMANDS,
  canonicalCommand,
  commandOwnsOption,
  commandPolicy,
  commandUsage,
  validateCommandArgs,
} from '../src/commands.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const QUERY_VALUE_FLAGS = new Set([
  '--type', '--status', '--keyword', '--owner', '--surface', '--module',
  '--domain', '--audience', '--execution-mode', '--updated-since', '--limit',
  '--sort', '--group', '--summarize-limit', '--model',
]);

function requireCommandPolicy(command, policy) {
  if (policy) return policy;
  const matches = KNOWN_COMMANDS
    .map(cmd => ({ cmd, dist: levenshtein(command, cmd) }))
    .sort((a, b) => a.dist - b.dist);
  if (matches[0] && matches[0].dist <= 3) {
    die(`Unknown command: ${command}\n\nDid you mean \`runlist ${matches[0].cmd}\`?`);
  }
  die(`Unknown command: ${command}\n\nRun \`runlist --help\` for available commands.`);
}

function resolveExistingPath(input, config) {
  if (!input) return null;
  const candidates = [];
  if (path.isAbsolute(input)) {
    candidates.push(input);
    if (!input.endsWith('.md')) candidates.push(`${input}.md`);
  } else {
    candidates.push(path.resolve(config.repoRoot, input));
    if (!input.endsWith('.md')) candidates.push(path.resolve(config.repoRoot, `${input}.md`));
    for (const root of config.docsRoots || [config.docsRoot]) {
      candidates.push(path.resolve(root, input));
      if (!input.endsWith('.md')) candidates.push(path.resolve(root, `${input}.md`));
    }
  }
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

function applyPathScopeToIndex(index, config, inputs) {
  if (!inputs.length) return;

  const selected = new Set();
  for (const input of inputs) {
    const resolved = resolveExistingPath(input, config);
    if (!resolved) die(`Could not resolve check path: ${input}`);

    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      const dir = path.resolve(resolved);
      const before = selected.size;
      for (const doc of index.docs) {
        const abs = path.resolve(config.repoRoot, doc.path);
        if (abs === dir || abs.startsWith(dir + path.sep)) selected.add(doc.path);
      }
      if (selected.size === before) {
        die(`No runlist documents found under check path: ${toRepoPath(dir, config.repoRoot)}`);
      }
      continue;
    }

    if (!stat.isFile() || !resolved.endsWith('.md')) die(`Check path is not a markdown file or directory: ${input}`);
    const repoPath = toRepoPath(resolved, config.repoRoot);
    if (!index.docs.some(d => d.path === repoPath)) {
      die(`Check path is outside configured docs roots: ${repoPath}`);
    }
    selected.add(repoPath);
  }

  index.docs = index.docs.filter(d => selected.has(d.path));
  index.errors = index.errors.filter(e => selected.has(e.path));
  index.warnings = index.warnings.filter(w => selected.has(w.path));
  index.countsByStatus = {};
  index.countsByType = {};
  for (const doc of index.docs) {
    const status = doc.status ?? 'unknown';
    index.countsByStatus[status] = (index.countsByStatus[status] ?? 0) + 1;
    const type = doc.type || 'unknown';
    if (!index.countsByType[type]) index.countsByType[type] = {};
    index.countsByType[type][status] = (index.countsByType[type][status] ?? 0) + 1;
  }
}

const HELP = {
  _main: `runlist v${pkg.version} — frontmatter markdown document manager

Common commands:
  plans                 Live plans (excludes archived)
  prompts               Prompt queue/admin (list, next, archive, new)
  briefing              Full briefing with plan counts + next steps
  agent-context         Compact bounded JSON context for agents
  set <status> [file]   Transition status (start work, finish, archive — all via target status)
  new <type> <name>     Create plan/doc/prompt (pipe stdin or @path for body)
  use [<file-or-slug>]  Open a doc by type: prompt → consume, plan → start, doc → read
                        (no file: consume oldest pending prompt)
  baton [<plan>|<slug>] @<draft-file>
                        Save a resume prompt (+ release the plan, if one is in-session)
  archive <file>        Close out a plan (status → archived, move, update refs)

More help:
  runlist help all        Full command list
  runlist help statuses   Status vocabulary + transitions
  runlist <cmd> --help    Per-command details

Global flags: --config <path>  --root <name>  --type <t,…>  --dry-run/-n  --verbose  --version`,

  guard: `runlist guard — PreToolUse hook handler (reads the tool-call JSON on stdin)

Wire it into Claude Code as a PreToolUse hook to intercept the wrong-moves
sessions keep making, and to log every one for audit:

  {"matcher":"Bash|Read|Edit|Write","hooks":[{"type":"command","command":"runlist guard"}]}

Rules:
  commit-prompt  deny  git add/commit of a (often gitignored) saved prompt
  cat-prompt     warn  cat/less/head of a docs/prompts/*.md (use \`runlist use\`)
  read-prompt    warn  Read tool on a saved prompt (use \`runlist use\`)
  edit-status    deny  CHANGING a \`status:\` line — via Edit/Write or in-place
                       stream editors (sed -i, perl -pi, awk -i inplace).
                       Use \`runlist set <status> <file>\`. Edits that merely
                       carry an unchanged status: line as context don't fire.

\`guard: { deny: false }\` in runlist.config.mjs drops edit-status back to
warn-only. Every catch is appended to the cross-repo misuse log. Disable the
guard entirely with RUNLIST_GUARD=0. Read the log with \`runlist misuse\`; when one
rule trips ≥3× in 7 days in a repo, \`runlist hud\` opens the next session there
with a one-line recap naming the habit to break.`,

  install: `runlist install [<host>] — install runlist's integration into an agent host

  runlist install                report what is installed for each known host
  runlist install claude         install the Claude Code plugin (marketplace + plugin)
  runlist install codex          install/refresh the Codex plugin (personal marketplace)
  runlist install opencode       install/refresh the OpenCode plugin (global config dir)
  runlist install opencode --remove
  runlist install opencode --path <dir>   write to a specific plugin directory
  runlist install opencode --force        overwrite a runlist.js runlist did not write

The CLI on its own gives an agent no orientation and no session identity. Each
host gets that a different way:

  claude    Drives \`claude plugin marketplace add ${'reowens/dotmd'}\` +
            \`claude plugin install dotmd@dotmd\`. This is the FIRST install;
            \`runlist update\` only refreshes a plugin already present (it skips
            with "plugin not installed"), and the README's slash commands only
            work from inside a session. Without the \`claude\` CLI on PATH the
            two in-session commands are printed instead.
            It also repairs a plugin Claude lists as "failed to load: Marketplace
            runlist not found" — an install record whose marketplace registration
            is gone — by re-adding the marketplace and updating the plugin. If
            Claude refuses the marketplace, ~/.claude/settings.json declares it
            under extraKnownMarketplaces with a source that no longer matches;
            runlist names the field but never edits that file.

  codex     Copies the npm-packaged runlist-codex plugin into the personal
            marketplace and invokes \`codex plugin add\`. It supplies a compact
            skill, SessionStart orientation, and a PreToolUse guard. Codex
            requires a separate hook trust review; start a new thread after
            installing. CODEX_THREAD_ID remains the ownership identity.

  opencode  Writes one auto-discovered plugin file. OpenCode has no plugin
            registry but globs \`{plugin,plugins}/*.{ts,js}\` under its global
            config dir, so no opencode.json edit is needed. It supplies two
            things the CLI cannot get on its own:
              - Per-session ownership identity. OpenCode exports no session id
                to a tool shell, so without it every session in one OpenCode
                process shares one identity and can release the others'
                in-session plans.
              - The \`runlist hud\` primer at session start, the equivalent of
                Claude Code's SessionStart hook. OpenCode's Claude Code
                compatibility covers skills and the system prompt — not hooks —
                so nothing else runs it.
            The file is version-stamped and refreshed by \`runlist update\`. A
            \`runlist.js\` without that stamp is treated as hand-authored and is
            never overwritten or removed without --force.

Writing outside the repo is why this is an explicit verb: \`runlist doctor\`
reports a missing integration but never installs one.`,

  update: `runlist update — update the runlist CLI and the Claude Code plugin together

  runlist update                 npm i -g runlist  +  claude plugin update dotmd@dotmd
  runlist update --check         report CLI vs plugin versions, do nothing (network-free)
  runlist update --cli-only      only the npm CLI
  runlist update --plugin-only   only the plugin

The plugin and CLI ship in lockstep; a release bumps both. Updating the plugin
requires a session restart (or /reload-plugins) to apply. The plugin step needs
the \`claude\` CLI on PATH — otherwise it prints the \`/plugin update\` command to
run from a session instead. The OpenCode file is refreshed in the same run when
it is present and behind. The hosts are independent, so a failing step does not
stop the others: every step runs, the failures are listed together, and the
exit code is 1. A plugin whose marketplace registration is gone gets the
marketplace re-added before the update (see \`runlist install claude\`).`,

  errors: `runlist errors — the newest failed runlist commands, newest first

Every runlist command that fails (an error, or a non-zero exit such as
\`check\` finding errors) appends one line to ~/.claude/logs/runlist-errors.log
(RUNLIST_ERROR_LOG_DIR moves it): when, the command with secrets redacted, and
the error's one-line message. It rolls over to runlist-errors.log.1 at 5 MB or
a new runlist version; this reads both. Dry runs and the session-start hud are
never logged.

  runlist errors                 last 20
  runlist errors --limit 50      last N (--tail is the same)
  runlist errors --repo <name>   only failures in a matching repo
  runlist errors --json          [{ at, command, message, repo, exit }]`,

  misuse: `runlist misuse — read the cross-repo guard log (~/.claude/logs/runlist-misuse.log,
merged by time with the legacy dotmd-misuse.log that older CLIs wrote)

  runlist misuse                last 20 intercepted wrong-moves
  runlist misuse --tail 50      last N
  runlist misuse --by-rule      counts per rule (deny/warn split)
  runlist misuse --repo <name>  filter by repo
  runlist misuse --json         machine-readable

Populated by the \`runlist guard\` PreToolUse hook — see \`runlist help guard\`.`,

  // Full command list — opt-in via \`dotmd help all\`. Kept exhaustive so the
  // top-level \`--help\` can stay terse without losing discoverability. When you
  // add a new command, add it here too.
  'help:all': `runlist v${pkg.version} — full command list

View & Query:
  hud [--json]                      Command primer + pending-prompt triage — silent when clean
  list [--verbose] [--json]         List docs grouped by status (default command)
  briefing [--json]                 Full briefing with plan status counts + next steps
  context [--summarize] [--json]    Full briefing (LLM-oriented; use --json --compact for bounded JSON)
  agent-context [--json]            Compact bounded JSON context for agents
  focus [status] [--json]           Detailed view for one status group
  query [filters] [--json]          Filtered search (--status, --keyword, --body, --stale, etc.)
  grep <term>                       Keyword search incl. document bodies (query --keyword --body --all)
  plans                             Live plans (excludes archived; --include-archived for all)
  use [<file-or-slug>]              Open a doc by type: prompt → consume, plan → start, doc → read
  baton [<plan>|<slug>] @<draft>     Save a resume prompt; releases the plan + prints the commit when one is in-session
  prompts [list|show|archive|new] Prompt admin (list / peek / archive / save). Use \`runlist use\` to consume.
  stale                             Stale docs (preset)
  actionable                        Docs with next steps (preset)

Analyze:
  stats [--json]                    Doc health dashboard
  health [--json]                   Plan velocity, aging, and pipeline health
  coverage [--json]                 Metadata coverage report
  graph [--dot] [--json]            Visualize document relationships
  deps [file] [--json]              Dependency tree or overview
  modules [--sort cleanup] [--json] Module dashboard (plans grouped by module)
  module <name> [--json]            Plans for one module, grouped by status
  surfaces [--json]                 List configured surface taxonomy
  unblocks <file> [--json]          Show what completes when this doc ships
  diff [file] [--summarize]         Show changes since last updated date
  summary <file> [--json]           AI summary of a document
  model [start|stop|use|cap]        The local model: server, which model, memory cap
  glossary <term> [--list] [--json] Look up domain terms + related docs
  decisions [doc|id] [--all|--check] Open and held decisions, read from the corpus
  show <file...> [--json]           One document's card: status, next step, related plans and docs, links

Validate & Fix:
  doctor [--apply]                  Auto-fix everything: refs, membership, lint, long fields, dates, index (preview by default)
  doctor --transactions             Report/clear wedged mutation transactions (run this if mutations refuse repo-wide)
  doctor --claims                   Report/release plan claims held by sessions that are gone ("busy in another session")
  self-check                        Project/version skew diagnostic (alias: doctor --project)
  lint [--fix]                      Check and auto-fix frontmatter issues
  fix-refs [--dry-run]              Auto-fix broken reference paths + body links
  refs <old> <new> [--fix]          Report (or rewrite) code-root citations of a moved document
  refs repair [--fix]               Same, for every archived document still cited at its old path
  fix-membership [<hub>...]         Add unambiguous missing child parent_plan back-references
  sync-status [<hub>...] [--adopt]  Rewrite hub table rows whose printed status drifted from the plan

Lifecycle:
  use <file>                        Open a plan (mark in-session + print it) or consume a prompt
  set <status> <file>               Change a document's status (frontmatter write; archive also moves the file)
  runlist <hub> [next|add|remove|reorder]   Show, walk, or mutate an ordered group of plans (see \`runlist help runlist\`)
  runlists                          List coordination-hub runlists (the Runlists dashboard)
  roadmap [<hub>] [next]            Tier-3: show a roadmap (runlists + rolled-up progress), or pick up its next action
  roadmaps                          List roadmap hubs (the Roadmaps dashboard)
  status <file> <status>            Transition document status (deprecated; prefer \`set\`)
  archive <file>                    Archive (status + move + update refs)
  bulk archive <f1> <f2> ...        Archive multiple files at once
  ship [patch|minor|major]          Regen + commit + bump in one step (default: patch)
  bulk-tag [files...]               Tag pre-existing untagged .md files
  touch <file>                      Bump updated date
  touch --git [<file>...]           Sync dates from substantive git history
  rename <old> <new>                Rename doc and update all references
  migrate <field> <old> <new> [f...]Batch update a frontmatter field value (optional file filter)

Create & Export:
  new <type> <name> [body]          Create doc of given type (plan, doc, prompt)
  index [--print]                   Generate/update docs.md index block
  export [--format md|html|json]    Export docs as markdown, HTML, or JSON

Setup:
  init                              Create starter config + docs directory
  install [claude|codex|opencode]  Install the agent-host integration (no arg = status)
  update [--check|--cli-only|--plugin-only]  Update the CLI + Claude Code plugin (--check reports skew, no network)
  statuses [list|add|set|remove|migrate]  Manage per-project status taxonomy
  help statuses                     Full status vocabulary + unstuck-actions + transitions
  watch [command]                   Re-run a command on file changes
  completions <shell>               Shell completion script (bash, zsh)
  journal [--tail N|--errors|--by-command|--session id|--since iso|--json]
                                    View opt-in JSONL command journal (enable: RUNLIST_JOURNAL=1 or journal: true)
  errors [--limit N] [--json]       The newest failed runlist commands, from the cross-repo error log

Global Options:
  --config <path>        Explicit config file path
  --root <name>          Filter to a specific docs root
  --type <t1,t2>         Filter by document type (plan, doc, prompt)
  --dry-run, -n          Preview changes without writing anything
  --verbose              Show config details and doc count
  --help, -h             Show help (per-command: runlist <cmd> --help)
  --version, -v          Show version`,

  list: `runlist list — list docs grouped by status

Options:
  --verbose              Show full details per doc
  --json                 Output full index as JSON (same as runlist json)`,

  json: `runlist json — full index as JSON

Outputs the complete document index as JSON to stdout.`,

  // Help topic accessed via \`dotmd help statuses\` (not a command — see dispatch
  // below). Single-source-of-truth for the built-in status vocabulary across all
  // three doc types. User-defined types/statuses live in config; introspect them
  // with \`dotmd statuses list\`.
  'help:statuses': `runlist help statuses — status vocabulary, unstuck-actions, and transitions

Every document has a \`type:\` field; each type has its own valid statuses.
Status validation is type-aware (type > root > global). To inspect or edit
the status taxonomy in a specific project, use \`runlist statuses list\`.

────────────────────────────────────────────────────────────────────
plan statuses (each maps to a distinct unstuck-action)

  in-session     A Claude session is working on it now.
                 \`runlist use <file>\` marks it in-session and prints the plan.

  active         Ready to be worked on.
                 \`runlist use <file>\` → in-session.

  planned        Queued for future work, not yet ready to execute.
                 Transition to active when ready to start.

  blocked        External arrival wait — monitor.
                 Hardware, vendor delivery, third-party rollout. Quiet
                 (skipStale) — you can't speed it up by nagging.

  partial        Shipped + deferred tail — spawn successor plans.
                 Plan body should reference the successor plan(s). Quiet.

  paused         Started but stopped mid-work — re-evaluate to resume.
                 Short stale window (3 days) so resume-decisions don't decay.

  awaiting       Needs human input/decision — chase the answer.
                 NOT quiet — generates stale pressure so pings aren't forgotten.

  queued-after   Sequenced behind another plan — check predecessor.
                 Quiet. Can start once the predecessor ships.

  archived       No longer relevant; auto-moved to archive directory.

Canonical transitions:
  active → in-session              \`runlist use <file>\` (or \`runlist set in-session <file>\`)
  in-session → active              \`runlist set active <file>\`
  in-session → partial             \`runlist set partial <file>\`
  in-session → awaiting            \`runlist set awaiting <file>\`
  any → archived                   \`runlist set archived <file>\` (or \`runlist archive\`)

────────────────────────────────────────────────────────────────────
doc statuses

  draft          Work-in-progress reference doc.
  active         Living document, kept up-to-date.
  review         Awaiting peer review.
  reference      Stable canonical reference (excluded from stale checks).
  deprecated     Superseded but kept for history.
  archived       No longer relevant; moved to archive directory.

────────────────────────────────────────────────────────────────────
prompt statuses

  A prompt has two states and no third.

  pending        Ready for the next session to consume.
                 \`runlist prompts use <file>\` prints body + archives atomically.
                 \`runlist prompts next\` does the same for the oldest pending.

  archived       Consumed prompt; body preserved in the archive directory,
                 which is the only directory a prompt ever moves into.

  \`held\`, \`shelved\` and \`claimed\` were removed 2026-08-30, along with
  \`prompts hold\` / \`unhold\` / \`shelve\` / \`unshelve\` and the
  prompts/held/ bucket. A prompt directs work, so parking one instead of
  archiving it left work state outside the plan that owns it, fighting with
  that plan's own status. If a prompt should not be consumed, lift its content
  into the plan and archive the prompt.

────────────────────────────────────────────────────────────────────
Related commands:
  runlist statuses              Inspect/manage per-project status taxonomy
  runlist status <f> <new>      Transition a document's status
  runlist briefing              See plans grouped by status
  runlist plans --status <s>    Filter live plans by status
  runlist hud                   Command primer + pending-prompt triage

Run \`runlist statuses list --type plan\` to see the full set (including any
project-specific custom statuses) with their flags.`,

  completions: `runlist completions <bash|zsh> — output shell completion script

Add to your shell config:
  bash: eval "$(runlist completions bash)"
  zsh:  eval "$(runlist completions zsh)"`,

  journal: `runlist journal — view opt-in command-usage journal

runlist's primary user is an agent (per docs/audit-example-project.md F17),
but the CLI gives no usage signal by default. Turn on the journal and every
invocation appends one JSONL line to .runlist/journal.jsonl with argv, exit
code, elapsed ms, session id, and (on error) a single-line err message.

Enable:
  - env:    RUNLIST_JOURNAL=1
  - config: \`export const journal = true;\` in runlist.config.mjs

The env var beats config (RUNLIST_JOURNAL=0 forces off). The journal is
default-off so non-agent users don't pay the size/PII cost.

Reader options:
  --tail N            Last N entries (default: 20 when no other filter)
  --errors            Only non-zero exits
  --session <id>      Only entries from one session
  --since <iso>       Only entries with ts >= iso
  --by-command        Group by argv[0]: count, median ms, error rate
  --json              Emit selected entries as a JSON array

Storage:
  Rotates to .runlist/journal.jsonl.1 on runlist version change, at >5MB,
  or when the oldest entry is >30 days.
  Single backup retained for up to 30 days; older history is dropped on
  rotation or pruned after the retention window.

Examples:
  RUNLIST_JOURNAL=1 runlist plans
  runlist journal --tail 5
  runlist journal --errors
  runlist journal --by-command
  runlist journal --since 2025-01-01 --json`,

  query: `runlist query — filtered document search

Filters:
  --type <t1,t2>         Filter by type (plan, doc, prompt)
  --status <s1,s2>       Filter by status (comma-separated)
  --keyword <term>       Search title, summary, state, path
  --body                 Extend --keyword into document bodies (lazy scan, shows matching-line excerpts)
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

  grep: `runlist grep <term> — keyword search across frontmatter AND document bodies

Alias for \`runlist query --keyword <term> --body --all\`. Answers "which doc
discussed X?" with full doc cards (type, status, updated, path) plus 1-2
matching-line excerpts per body hit — instead of raw-grep's bare paths.

Bodies are read lazily: frontmatter filters run first, only surviving
candidates are opened. Archived docs are included but clearly labeled.

Composes with the usual query flags:
  runlist grep skipStale                     everything mentioning skipStale
  runlist grep retries --type plan           only plans
  runlist grep retries --status active       only active docs
  runlist grep retries --limit 5             cap results (default: unlimited)
  runlist grep retries --json                machine-readable (bodyMatches per doc)`,

  ship: `runlist ship [patch|minor|major] — commit + bump in one step

Bundles the release steps into a single command:
  1. Auto-stage every dirty file matching the release allowlist
     (src/, test/, bin/, docs/, plugins/, .claude-plugin/,
     .claude/commands/, package*.json, runlist.config*.mjs, README.md,
     CLAUDE.md, .gitignore). A real ship refuses while anything outside
     the allowlist is dirty; dry-run reports those files without changing them.
  2. Commit with an auto-generated \`chore: release <version>\` message.
  3. Run \`npm version <bump>\` to bump package.json, tag, push, run
     the publish workflow, and reinstall locally.

(Per-repo \`.claude/commands\` scaffolding is retired — the runlist plugin's
SKILL.md is canonical now — so ship no longer regenerates anything.)

Options:
  --dry-run, -n          Show what would happen without staging or bumping.

Defaults to patch. Pass \`minor\` or \`major\` to bump those instead.

Network failures after the version tag exists are resumed with
\`npm run release:resume\`. Never push tags or publish manually.`,

  set: `runlist set <status> [<file-or-slug>] — change a document's status

Writes the new status into the file's frontmatter. In-session plans carry a
local, gitignored ownership record under .runlist/ so one session cannot release
another session's work.
  - target is an archive status → archive the file (move + ref update)
  - everything else             → plain frontmatter status bump

<file-or-slug> resolves like \`runlist use\`/\`archive\`: exact path first, then
a unique bare slug / basename across the doc roots (\`set paused auth-revamp\`).
Ambiguous slugs error with the candidate list instead of guessing.
When the path is omitted, exactly one plan must be owned by this session.
Claude Code and Codex session IDs are recognized automatically (Codex exports
CODEX_THREAD_ID to every tool shell), as is OpenCode (via OPENCODE_PID — per
OpenCode process, not per session). Other hosts must set RUNLIST_SESSION_ID;
anonymous ownership mutations fail closed.
Pickup hooks use at-least-once delivery with a stable operationId; hook side
effects must deduplicate that ID.

Options:
  --note "<text>"        Append the reason to \`## Version History\` in the
                         same call (creates the section if missing). Saves
                         the status-change + worklog-edit round-trip.
  --no-index             Skip index regen (see \`runlist archive --help\`).
  --show-files           Append \`files: …\` footer.
  --force                Recover another session's plan (explicit path required).
  --dry-run, -n          Preview without writing.

Examples:
  runlist set in-session docs/plans/x  # mark a plan in-session
  runlist set partial docs/plans/x --note "tail tracked in y.md"
  runlist set archived docs/plans/x    # archive a specific plan
  runlist set active                   # release this session's sole owned plan

To open a plan (mark in-session AND print its body), use \`runlist use <file>\`.`,

  status: `runlist status <file> <new-status> — transition document status

Moves the document to the new status. If transitioning to an archive
status, automatically moves the file to the archive directory and
regenerates the index (if configured).

Options:
  --no-index             Skip index regen (useful in concurrent-session repos
                         doing path-limited commits — see \`runlist archive --help\`).
  --show-files           Append \`files: …\` line to stderr (see \`runlist archive --help\`).

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

Run \`runlist help statuses\` for the full vocabulary across all doc types
(plan, doc, prompt) plus canonical transitions and related commands.

Use --dry-run (-n) to preview changes without writing anything.`,

  check: `runlist check — validate frontmatter and references

By default the warning list is suppressed: you see counts plus a one-line
pointer to \`runlist doctor\` (auto-fix) or \`runlist check --verbose\`
(per-doc detail). Errors are always shown in full.

Options:
  --verbose              Show every warning per-doc (with category collapse
                         applied — high-frequency auto-fixable categories
                         summarize to a one-line bulk-fix hint).
  --no-collapse          Like --verbose but disables category collapse too —
                         every warning prints raw.
  --errors-only          Show only errors, suppress warnings entirely
  --fix                  Auto-fix broken refs, lint issues, and regenerate index
  --json                 Output errors and warnings as JSON (always full detail)
  --min-docs <n>         Fail if fewer than <n> docs were scanned — a floor that
                         tells "nothing is wrong" apart from "nothing was looked
                         at". Overrides \`minDocs\` in config for this run;
                         skipped when checking specific paths.
  --dry-run, -n          Preview fixes without writing (with --fix)`,

  archive: `runlist archive <file-or-slug> — archive a document

Sets status to 'archived', moves to the archive directory, auto-updates
references in other docs, and regenerates the index.

<file-or-slug> resolves like \`runlist use\`: an exact path wins, but a bare
slug / basename (e.g. \`archive resume-foo\`) falls back to a recursive
basename match under the doc roots. An ambiguous basename (the same name in
two places) errors with the candidate list instead of guessing.

Options:
  --note "<text>"        Append \`Archived — <text>\` to \`## Version History\`
                         in the same call (creates the section if missing).
  --no-index             Skip index regen. Use when multiple sessions are
                         working concurrently and you want a path-limited
                         commit that doesn't pull other agents' uncommitted
                         index changes into your staging area. Run \`runlist index\`
                         later (or wire it into a commit hook) to refresh.
  --show-files           Append a final \`files: a b c …\` line to stderr
                         listing every doc/index path the command touched
                         (deduped, sorted, repo-relative). Lets agents do
                          \`git add\` with the exact set instead of guessing.
  --force                Recover another session's plan (explicit path required).
  --closeout-template    Inject a \`## Closeout\` skeleton into the plan body
                         before archiving — bullets for outcomes, key
                         commits, deferrals. No-op if a \`## Closeout\`
                         section already exists. Placed just before
                         \`## Version History\` if present, else at end
                         of body. Fill it in after archive (the archived
                         file is still editable).
  --dry-run, -n          Preview changes without writing anything.`,

  coverage: `runlist coverage — metadata coverage report

Shows which docs are missing surface, module, or audit metadata.

Options:
  --json                 Machine-readable JSON output`,

  focus: `runlist focus [status] — detailed view for one status group

Shows detailed info for all docs matching the given status (default: active).

Options:
  --json                 Output as JSON`,

  hud: `runlist hud — actionable triage for session start

Prints the runlist command primer (the verb cheat-sheet) plus, in --json mode,
pending prompts and the check-error count for programmatic callers.

Silent when there's nothing actionable — designed for SessionStart hooks where
zero noise is the right default. Distinct from \`runlist briefing\`, which
dumps the full plan-status pipeline and per-plan next_step bodies (kilobytes
on large repos). Use hud for ergonomic session boot; use briefing for
explicit "give me the full picture."

The pending-prompts line tells Claude to consume them via
\`runlist prompts use <file>\` rather than reading/cat'ing — that atomically
prints the body and archives the prompt so it cannot be double-consumed.

Recommended SessionStart hook (in ~/.claude/settings.json):
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "runlist hud", "timeout": 5 }] }]

Options:
  --json                 Output as JSON ({ owned, prompts, errors, previousSelf,
                         fleet, recentRejections, misuseRecap, drift })`,

  briefing: `runlist briefing — comprehensive live-work summary

Shows every live plan with its next step, plus doc/research counts and health.
Output grows with the corpus; use \`runlist plans\` for compact orientation or
\`runlist agent-context\` for structured agent context.

Options:
  --json                 Output as JSON`,

  context: `runlist context — full briefing (LLM-oriented)

Generates a status briefing designed for AI/LLM consumption. The default
JSON form is the full index grouped by type/status; use --compact for bounded
agent-safe JSON.

Options:
  --json                 Output as JSON
  --compact              With --json, return counts + bounded next-action lists
  --summarize            Add AI summaries for expanded docs
  --model <name>         Model for AI summaries`,

  'agent-context': `runlist agent-context — compact bounded JSON for agents

Equivalent to \`runlist context --json --compact\`. Returns counts,
validation totals, pending prompt next item, and bounded plan action lists.`,

  stats: `runlist stats — doc health dashboard

Shows aggregated metrics: status counts, staleness, errors/warnings,
freshness, completeness, checklist progress, and audit coverage.

Options:
  --json                 Machine-readable JSON output`,

  graph: `runlist graph — visualize document relationships

Output formats:
  (default)              Text adjacency list
  --dot                  Graphviz DOT format (pipe to dot -Tpng)
  --json                 Machine-readable JSON

Filters:
  --status <s1,s2>       Show only docs with these statuses
  --module <name>        Show only docs with this module
  --surface <name>       Show only docs with this surface`,

  deps: `runlist deps [file] — dependency tree or overview

Without a file, shows a flat overview: most blocking docs, most blocked
docs, docs with blockers, and orphans.

With a file, shows a tree: what the doc depends on (recursive) and what
depends on it.

Options:
  --depth <n>            Max tree depth (default: 5)
  --json                 Machine-readable JSON output`,

  modules: `runlist modules — module dashboard (plans grouped by module)

One row per module discovered in plan frontmatter. Dynamic status columns
(only statuses with ≥1 plan render). Defaults to --type plan; pass --type
to scope to docs/prompts.

Sort modes:
  --sort total           Plan count, desc (default)
  --sort stale           Stale-plan count, desc
  --sort age             Average age in days, desc
  --sort nextstep        % of plans with a next_step set, desc
  --sort cleanup         Triage score: (stale × avgAge) / max(total, 1)

Options:
  --limit <n>            Cap rows (default: 20)
  --all                  Show every module
  --json                 Machine-readable shape (includes _totalUnique to
                         detect modules: [a, b] double-counting)

A plan with \`modules: [a, b]\` counts in both rows — intentional, so
multi-module plans surface in every relevant triage view. \`(none)\` is a
literal row for plans with no module tag.`,

  module: `runlist module <name> — plans for one module, grouped by status

Status groups follow config.statusOrder. Stale plans are flagged inline.

Sort modes (within each status group):
  --sort status          By config.statusOrder, then age (default)
  --sort updated         Most-recently-updated first
  --sort age             Oldest first

Options:
  --json                 Machine-readable shape

Unknown module name suggests close matches (or lists what's available).`,

  surfaces: `runlist surfaces — list configured surface taxonomy

Prints the values accepted in \`surfaces:\` frontmatter, one per line.
Source: \`config.taxonomy.surfaces\` in runlist.config.mjs.

Options:
  --json                 Machine-readable shape: { surfaces: [...] }

When the project has no taxonomy configured, any surface value is accepted —
the command says so instead of printing an empty list.`,

  doctor: `runlist doctor — auto-fix everything in one pass

Runs in sequence: fix broken references, repair unambiguous membership
back-references, lint --fix, move over-cap frontmatter prose into body sections,
sync hub status rows, sync dates from git, regenerate the index, then show
remaining issues.

Modes:
  (default)              Auto-fix pass — previews by default since 0.37.0
                         (F4). Use --apply (alias --yes) to actually write;
                         explicit --dry-run still wins over --apply if both
                         are passed (safety prevails).
  --transactions         Report pending mutation transactions. A transaction
                         abandoned mid-flight can reach \`failed-manual\`, and
                         recovery sweeps the whole repo on every mutation —
                         so ONE wedged transaction makes \`set\`, \`archive\`,
                         \`use\`, \`baton\`, and \`rename\` refuse repo-wide,
                         naming a file the failing command never touched.
                         Run this first when that happens. Add --apply to
                         clear the transactions whose files already agree on
                         one generation (no document content is touched);
                         the rest are reported for manual review.
  --claims               Report which plans are claimed by which session, how
                         old each claim is, and whether the owning session's
                         process is still alive. A claim is what makes \`set\`,
                         \`archive\`, \`baton\`, and \`rename\` refuse a single
                         plan ("Plan is busy in another session"); nothing
                         expires one, so a session that died holds its plan
                         until someone takes it back. Add --apply to release
                         the claims whose owning process is provably gone
                         (their plans return to \`active\`).
  --claims --apply --older-than <24h|3d>
                         Also release claims runlist cannot judge — ones written
                         before it recorded the owning process, or held on
                         another machine — that are older than the duration.
                         That threshold is your judgement, not runlist's: it
                         cannot tell a dead session from a slow one.
  --session              Read-only: what session identity runlist resolved, from
                         which environment variable, and whether it names THIS
                         session or something coarser that its siblings share
                         (a host process, a terminal) — sessions sharing an id
                         can release each other's plans. Also reports whether
                         the current host's integration is installed. Run this
                         when a verb says "No authoritative session identity",
                         or on any host runlist has never been tried on.
  --session --json       Machine-readable identity + host-integration state.
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
                         history, runlist_version, context, related_plans).
                         Skips files that already have frontmatter.
  --migrate-template <file>  Migrate just one plan.
  --migrate-template --include-archived
                         Also touch plans in the archive directory.
                         Default skips archived plans (they're closed
                         history; a "Migrated to v0.21 template" entry
                         in their Version History would be misleading).
  --migrate-template --json  Machine-readable result.
  --frontmatter-fix      Auto-fix the long-frontmatter warnings that
                         \`runlist check\` flags: \`current_state\` >1500 chars
                         or \`next_step\` >800 chars. Truncates the
                         frontmatter field at the nearest sentence
                         boundary under the target (1200 / 600) and
                         appends the remainder to a \`## Current State\`
                         / \`## Next Step\` body section (created above
                         the first H2 if absent, appended otherwise).
                         Plans only; honors --dry-run.
  --project              Report CLI/project version skew, generated command
                         drift, and detectable deprecated command mentions.

--apply (or --yes) opts into writes for the default auto-fix pass.
Sub-modes (--statuses, --migrate-*, --frontmatter-fix, --project) keep their
existing contracts: they write by default and honor --dry-run.`,

  'sync-status': `runlist sync-status — rewrite hub rows whose printed status drifted

A runlist / coordination / roadmap hub rows its children in a table and prints
each child's status by hand. This sweeps every hub, compares each row's status
word against the plan it links to, and rewrites the ones that drifted. Case is
preserved (\`Active\` stays capitalized), and nothing else in the cell is touched.

  runlist sync-status                  every hub in the repo (the normal case)
  runlist sync-status <hub>...         narrow to named hubs
  runlist sync-status --adopt          also wrap managed status words in <!--s-->…<!--/s-->
  runlist sync-status --dry-run --json

The status word is found positionally — comments stripped, cell's leading token,
matched against the vocabulary the CHILD's type declares — so no marker is
needed. A marker pins the span for the rows position can't read (a status sitting
behind a bolded headline). \`runlist check\` warns on positional drift and ERRORS on
marked drift: the marker is the author saying runlist owns that word.

Rows under a status column with no readable status word are reported by
\`runlist check\` and left alone here; rows in a table with no status column at all
are not findings. Not to be confused with \`runlist set <status>\`, which changes a
document's OWN status — this only rewrites what a hub prints about others.`,

  'fix-membership': `runlist fix-membership — repair unambiguous missing parent_plan back-references

A repair is safe only when one live hub has already declared the relationship
in its frontmatter runlist or body execution order and the live child plan has
no parent_plan at all. The command writes the child-relative back-reference and
updated date atomically.

It never creates or edits hub prose, never overwrites another parent, and skips
a parentless child ranked by multiple hubs as ambiguous.

  runlist fix-membership                 every hub in the repo
  runlist fix-membership <hub>...        narrow to named hubs
  runlist fix-membership --dry-run       preview without writing
  runlist fix-membership --dry-run --json`,

  refs: `runlist refs <old> <new> — code-root citations of a moved document
       runlist refs repair          — every archived document still cited at its old path

Reference repair inside the doc roots is what archive and rename already do.
This is the other half: a source comment, docstring or string literal that
cites a document by its repo-relative path, in the roots \`codeRoots\` names.
Absent that key, nothing is scanned and nothing changes.

What it matches:
  - The full repo-relative path only (\`docs/plans/<slug>.md\`). Never a bare
    basename — a corpus cites slugs as words, and matching one is how a rename
    corrupts an unrelated line.
  - A trailing \`§\` or \`#\` anchor is kept as written: only the path is
    replaced, so quotes, backticks and punctuation around it survive.

What it writes:
  - Report is the default. \`--fix\` rewrites citations in comments.
  - A citation inside a string literal (or bare in code) is reported in its own
    group and rewritten only with \`--strings\` — a test or a guard may assert
    on it.
  - A file listed in \`codeRefsUntouched\` is reported and never written.
  - A file that is not writable, or that resolves outside the repository, is
    refused by name.

  runlist refs docs/plans/a.md docs/plans/archived/a.md
  runlist refs docs/plans/a.md docs/plans/archived/a.md --fix
  runlist refs repair                   report every stale archived citation
  runlist refs repair --fix --strings   rewrite them, string literals included

\`repair\` reads each previous path from the archive directory mapping, which is
the one move the tool leaves a readable trace of. A rename records none, so a
renamed document is covered by the two-argument form.`,

  'fix-refs': `runlist fix-refs — auto-fix broken reference paths

Scans all docs for reference fields that point to non-existent files,
then attempts to resolve them by matching the basename against all known
docs. Fixes are applied by rewriting the frontmatter path.

Use --dry-run (-n) to preview changes without writing anything.`,

  touch: `runlist touch <file> — bump updated date
       runlist touch --git [<file>...]  — sync dates from git history

Without --git, updates a single file's frontmatter updated date to today.
With --git, scans all docs (or the specified files) and syncs their updated
date to match the last substantive git commit date, fixing date drift warnings.
Commits that only changed the updated line are ignored so the fix converges.

Use --dry-run (-n) to preview changes without writing anything.`,

  index: `runlist index [--print] — generate/update docs.md index

Updates the configured index file in place (writes by default as of 0.34.0).
Use --print to dump the regenerated content to stdout without writing.

Use --dry-run (-n) to preview without writing.`,

  new: `runlist new <type> <name> [body] — create a new document

Usage (write the draft to a file first):
  runlist new plan <slug> @/tmp/draft.md     # plan from a draft
  runlist new doc <slug> @/tmp/draft.md      # reference doc from a draft
  runlist new prompt <slug> @/tmp/draft.md   # saved prompt (body required)
  runlist new plan <slug>                    # empty scaffold to fill in

What the draft does:
  - Draft with its own \`## \` headings → it IS the body. Only a \`# Title\` is
    added if missing; the template's outline is not appended. This holds for a
    repo's own plan/doc template too.
  - Draft with no \`## \` headings → lands in the template's first section
    (\`## Problem\` for plans).
  - Draft opening with a \`---\` frontmatter block → those keys replace the
    scaffold's (status, surfaces, modules, current_state, next_step, …), so no
    frontmatter edit is needed afterwards. \`type:\` is fixed by <type>.
  To change status later, use \`runlist set <status> <file>\`.

The repo's own types, starting statuses and folders are listed at the end of
this help when it runs inside a runlist repo.

Body input (required for prompt, optional for plan/doc):
  @path                  Read body from a file (preferred)
  -                      Read stdin explicitly (heredoc: \`runlist new … - <<'EOF'\`)
  piped stdin            Read when something is piped or redirected in
  --body "<text>"        Inline body (alias: --message), one-liners only
  <text>                 Inline body as 3rd positional, one-liners only

Inline bodies put the whole content on the command line, which breaks on
backticks and dollar signs and trips hooks that scan commands; use @path.

\`<type>\` can be omitted; defaults to \`doc\`. \`<name>\` is slugified for the
filename; a name with a \`/\` is read relative to the repo (or to --root).

Examples:
  runlist new plan auth-revamp @/tmp/auth-revamp.md
  runlist new prompt resume-foo @/tmp/draft.md
  runlist new plan full-spec - <<'EOF'
  ---
  status: planned
  next_step: Phase 1, extract the token store.
  ---
  ## Problem
  …
  ## Phases
  …
  EOF
  runlist new prompt cleanup-tomorrow "look at remaining lint warnings"

Hubs and decisions:
  runlist new hub <slug>                     # coordination hub (a plan)
  runlist new hub <slug> --runlist a,b,c     # sprint hub plus child plans
  runlist new hub <slug> --roadmap           # roadmap hub
  runlist new decision <plan> --question "<question>" [--answers "<…>"] @record.md
                       Adds the next numbered entry to the plan's top-level
                       decisions section with a \`Disposition: OPEN.\` line (or
                       \`--disposition held\`) and the record, which is required;
                       a plan with no such section gets \`## Decisions\`. With a
                       register in config, the id is numbered across the corpus
                       and the register gets its row, question plus --answers
                       (required then), in the same locked write. Config:
                       \`export const decisions = { section, prefix,
                       register: { file, statusLine } }\`.

Scaffolding runlists (plans only):
  --runlist <a,b,c>    Create a sprint runlist hub plus one child plan per slug.
                       The hub carries \`runlist: [<hub>-01-a.md, <hub>-02-b.md, …]\`
                       and an \`## Order of operations\` list; each child is a
                       \`planned\` stub with a \`parent_plan:\` back-ref. Children
                       are named by the documented \`<hub>-NN-<slug>\` convention.
  --coordination       Create a prose-first coordination hub: \`execution_mode:
                       coordination\` + a \`## Ranked queue\` skeleton (no children).
                       Surfaces in \`runlist runlists\`, held out of the active count.
  --roadmap            Create a tier-3 roadmap hub: \`execution_mode: roadmap\` + a
                       \`## Runlists\` skeleton. A roadmap composes *runlists* (not
                       leaf plans) and rolls their done/total up — see
                       \`runlist roadmap\`. Wire child runlists via \`related_plans:\`.
  (\`--runlist\`, \`--coordination\`, \`--roadmap\` are mutually exclusive.)

  runlist new plan auth-revamp --runlist extract,rewrite,cleanup
  runlist new plan platform --coordination
  runlist new plan q3 --roadmap

Plan body variants (plans only — pick one body shape):
  --lite / --minimal   Trimmed plan: Problem → Phases → Version History. Drops
                       the full build-up scaffold (Goals / Non-Goals / What
                       Exists Today / Constraints / Decisions / Deferred /
                       Closeout) for a quick plan that doesn't need it.
  --audit / --findings Audit plan: Problem → Findings (ranked) → Suggested order
                       → Open Questions. The "investigated X, here's what I
                       found" shape, instead of build-up phases.
  (The body variants and \`--runlist\`/\`--coordination\`/\`--roadmap\` are all
  mutually exclusive — a plan has exactly one body shape.)

  runlist new plan quick-fix --lite
  runlist new plan perf-audit --audit

Other options:
  --status <s>         Set initial status (defaults to first valid status for the type)
  --title <t>          Override the auto-derived title
  --root <name>        Create in a specific docs root. Applies to a nested name
                       too: \`new doc prospects/kim --root docs\` writes
                       docs/prospects/kim.md. Without it, a name containing a
                       \`/\` is read relative to the repo.
  --show-files         Append \`files: …\` line to stderr listing what was touched
                       (the new doc + the index file). See \`runlist archive --help\`.
  --list-types         Show registered types (alias: --list-templates)

For plans, the default status vocabulary is: in-session, active, planned,
blocked, partial, paused, awaiting, queued-after, archived.
For prompts: pending (default), archived.

Use --dry-run (-n) to preview without creating the file.`,

  watch: `runlist watch [command] — re-run a command on file changes

Watches the docs root for .md file changes and re-runs the specified
command. Defaults to 'list' if no command given.

Examples:
  runlist watch              # re-run list on changes
  runlist watch check        # re-run check on changes
  runlist watch context      # live briefing`,

  export: `runlist export — export docs as markdown, HTML, or JSON

Without a file, exports all docs (with optional filters).
With a file, exports that doc plus all its dependencies.

Options:
  --format <md|html|json>  Output format (default: md)
  --output <path>          Write to file/directory (default: stdout for md/json)
  --status <s1,s2>         Filter by status
  --type <t1,t2>           Filter by type (plan, doc, prompt)
  --module <name>          Filter by module
  --root <name>            Filter by root
  --dry-run, -n            Preview without writing`,

  summary: `runlist summary <file> — AI summary of a document

Generates an AI-powered summary using a local model.

Options:
  --model <name>         Model to use (default: the one \`runlist model\` shows)
  --max-tokens <n>       Max tokens for generation (default: 200)
  --json                 Output as JSON`,

  diff: `runlist diff [file] — show changes since last updated date

Shows git diffs for docs that changed after their frontmatter updated date.
Without a file argument, shows all drifted docs.

Options:
  --stat                 Summary only (files changed, insertions/deletions)
  --since <date>         Override: diff since this date instead of frontmatter
  --summarize            Generate AI summary using local model
  --model <name>         Model to use (default: the one \`runlist model\` shows)`,

  lint: `runlist lint [--fix] — check and auto-fix frontmatter issues

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

  rename: `runlist rename <old> <new> — rename doc and update references

Renames a document using git mv and updates all frontmatter references
in other docs that point to the old filename.

Body markdown links are warned about but not auto-fixed.
Use --dry-run (-n) to preview changes without writing anything.`,

  migrate: `runlist migrate <field> <old-value> <new-value> [files...] — batch update a frontmatter field

Finds all docs where the given field equals old-value and updates it
to new-value. With no file args, every matching doc in the project is
rewritten (whole-bucket rename).

Pass one or more file args to scope the rewrite — only those files
are considered. This is how you split one overloaded status into
several distinct ones (e.g. moving some \`backlog\` plans to
\`paused\` and others to \`partial\`). File args use the same matching
as \`bulk archive\`: exact path, then substring fallback.

Examples:
  runlist migrate status research scoping
  runlist migrate module auth identity
  runlist migrate status backlog paused docs/plans/foo.md docs/plans/bar.md

Use --dry-run (-n) to preview changes without writing anything.`,

  init: `runlist init — create starter config and docs directory

Creates runlist.config.mjs, docs/, and docs/docs.md in the current
directory. Skips any files that already exist.

If docs/ already contains .md files, auto-detects statuses, surfaces,
modules, and reference fields to pre-populate the config.`,

  plans: `runlist plans — list live plans (excludes archived by default)

Shows documents with type: plan, excluding terminal/archive statuses,
sorted by status. Supports all query flags (--status, --module, --json,
--sort, --group, etc.).

Default plan statuses: in-session, active, planned, blocked, partial,
paused, awaiting, queued-after, archived. Run \`runlist help statuses\` for
the unstuck-action behind each one and canonical transitions.

Examples:
  runlist plans                          # live plans (default)
  runlist plans --include-archived       # all plans including archived
  runlist plans --status active          # active plans only
  runlist plans --status awaiting        # plans waiting on a human decision
  runlist plans --status partial,paused  # shipped-tail and parked plans
  runlist plans --module auth            # plans for the auth module
  runlist plans --group module           # plans grouped by module
  runlist plans --json                   # JSON output`,

  prompts: `runlist prompts — manage saved prompts (subcommand namespace)

Prompts are documents with \`type: prompt\`, typically saved under
docs/prompts/. They seed future Claude sessions; consuming a prompt
prints its body to stdout and atomically archives it (one-shot).

\`runlist prompt\` (singular) is an alias for \`runlist prompts\` — every
subcommand below works under either spelling.

Subcommands:
  list                       List pending prompts (default)
  next                       Consume the oldest pending prompt:
                             print body to stdout, flip status to archived
  use <file-or-slug>         Consume a specific prompt (same as next, but
                             targets the named prompt instead of picking oldest)
  resume <file-or-slug>      Alias for \`use\` — same behavior, easier name
                             when continuing a session
  show <file-or-slug>        Read-only peek: print the body WITHOUT consuming
                             (triage). \`peek\` is an alias.
  archive <file-or-slug>     Archive a prompt without printing its body
  new <slug> [body]          Create a new prompt (alias for
                             \`runlist new prompt <slug> [body]\`)

\`<file-or-slug>\` accepts: an exact path (with or without .md), a bare
slug matching a prompt basename, or a unique substring of a prompt
path. Ambiguous substrings error with the candidate list.

A prompt saved by \`runlist baton\` links its plan; consuming it (\`use\`,
\`next\`, or top-level \`runlist use\`) also claims that plan for this session.
Pass \`--no-claim\` to read and archive the prompt without starting the plan.

Default prompt statuses: pending, archived.

Examples:
  runlist prompts                        # pending prompts (default)
  runlist prompts list --verbose         # one row per prompt + target plan ref
                                       # (from related_plans, parent_plan,
                                       #  or the first body .md link)
  runlist prompts list --include-archived # all prompts including archived
  runlist prompts list --status claimed   # already-consumed prompts
  runlist prompts --json                 # JSON output

  claude "$(runlist prompts next)"       # consume oldest pending + run claude
  claude "$(runlist prompts use resume-foo)"           # by slug
  claude "$(runlist prompts use docs/prompts/foo.md)"  # by path
  claude "$(runlist prompts resume resume-foo)"        # \`resume\` is an alias for \`use\`
  runlist prompt list                    # singular alias for \`runlist prompts list\`

  runlist prompts show resume-foo        # peek without consuming (triage)
  runlist prompts show --all             # peek the WHOLE pending queue in one call
  runlist prompts show --all --limit 10  # ...capped
  runlist prompts show a b c             # peek several by name
  runlist prompts next --dry-run         # preview without consuming
  runlist prompts archive old-thing
  runlist prompts new my-prompt "Body text here"`,

  baton: `runlist baton — save a resume prompt for whatever you're doing (and release the plan, if there is one)

Usage (write the resume to a file first, then pick the form that matches):
  runlist baton @/tmp/draft.md               # a plan is in-session: save resume-<plan-slug>, release the plan
  runlist baton <plan-file> @/tmp/draft.md   # hand off a named plan
  runlist baton <slug> @/tmp/draft.md        # no plan: save resume-<slug>, change nothing else
  The resume can also come from stdin (\`-\`, or a pipe) or --message "..." for one-liners.
  Baton prints the prompt name it saved and, in plan mode, the git commit to run.

The resume (10–20 lines): the next concrete decision plus any gotchas, and the
paths of the plans/docs it concerns — not a recap of the plan body.

Options:
  --status <s>           Target status for the plan (default: active; plan mode only)
  --note "why"           Append the reason to ## Version History (plan mode only)
  --message / --body     Inline body (one-liners; prefer @path or stdin)
  --force                Recover another session's plan (explicit path required)
  --replace              Replace exactly one pending handoff; archive its prior text
  --json                 Structured repository/session/generated file result
  --dry-run, -n          Preview without writing

Repo-specific commit hint (dotmd.config.mjs):
  export function batonCommitCommand(message, paths) {
    return ['just', 'commit', message, ...paths];
  }
The function returns argv; baton shell-quotes each argument before printing.

Examples:
  runlist baton @/tmp/draft.md
  runlist baton checkout-fixes @/tmp/draft.md
  runlist baton docs/plans/auth.md @/tmp/draft.md
  runlist baton docs/plans/auth.md @/tmp/new-draft.md --replace
  runlist baton --status paused --note "blocked on review" @/tmp/d.md
  cat /tmp/draft.md | runlist baton

Plan mode (a plan is in-session, or you pass one) publishes in one atomic
cooperating transaction:
  1. A resume prompt named resume-<plan-slug>, stamped with a plan: link so
     consuming it re-claims the plan (see \`runlist use\`). The prompt is
     session-local — the next session's hud surfaces it; never paste resume text
     into chat.
  2. Releases the plan: one status flip, in-session → active by default.
  3. Defers the shared generated index and prints exact repository-only commit
     guidance. Prompt and ownership records stay session-local and OUT of the
     pathspec.
  Which plan? Pass it explicitly, or baton resolves exactly one plan owned by
  this authoritative session. Journal entries and global in-session counts never
  grant ownership. A live pickup-hook delivery lease blocks release and force
  takeover; hooks are at-least-once and deduplicate the stable operationId.

Slug mode (no plan involved) saves resume-<slug> without a status change or
commit. A bare word that names a plan is treated as that plan.

Baton saves nothing while a handoff for the same work is pending (resume-<name>,
or a pending prompt linked to the plan): inspect it with \`runlist prompts show\`.
Keep it if current; use \`--replace\` with a new draft if stale. Replacement
preserves the prior text under archived/ and refuses multiple matches.
With no @file, \`-\` or --message, baton reads stdin only when something is piped
in; an open pipe that sends nothing is given up on after a moment.`,

  stale: `runlist stale — list stale documents

Shows docs that haven't been updated within their staleness threshold.
Supports all query flags (--status, --json, --sort, etc.)

Examples:
  runlist stale --group module       Stale plans grouped by module (triage view)`,

  actionable: `runlist actionable — list docs with next steps

Shows active/ready docs that have a next_step defined.
Supports all query flags (--status, --json, --sort, etc.)`,

  unblocks: `runlist unblocks <file> — show what completes when this doc ships

Shows documents that reference or depend on the given file.
Useful for impact analysis before archiving or changing a plan.

The dependency edge is read from each plan's \`blockers:\` frontmatter
(a YAML list of plan slugs or paths). \`blocked_by:\` is accepted as
an alias since 0.39.3 — both populate the same index field, so use
whichever name reads better.

Frontmatter shape:

    ---
    type: plan
    status: blocked
    blockers:
      - foo-plan.md
      - docs/plans/bar-plan.md
    ---

Options:
  --json                 Output as JSON`,

  health: `runlist health — plan velocity, aging, and pipeline health

Shows plan pipeline status, active plan aging, recently archived
plans, and checklist progress. Plans-only view.

Options:
  --json                 Output as JSON`,

  decisions: `runlist decisions — the open and held decisions, read from the corpus

  runlist decisions             every open and held decision, one line each
  runlist decisions <doc>       one document, by path, filename or slug
  runlist decisions <ID>        one record, whole, as it is written
  runlist decisions --all       every disposition, not only the pending ones
  runlist decisions --json      the same rows as data, each with its question, its
                                document's title and what it blocks
  runlist decisions --check     every item it could not read or that is incomplete; exit 1 if any

A decision is an item in a decisions section (a heading naming the section word
in its first 4 words): a heading, bold lead, bullet or table row whose first
token is an id. A register is a fenced block whose first line carries
decisions.register.statusLine; its rows are \`ID  text\`. A disposition is read
from a \`Disposition:\` line or a row's opening word, then from prose when
decisions.prose is on, then from the block or bold lead above it. Configure it
with \`export const decisions = { ... }\` (see src/decisions.mjs).

What a decision blocks, in --json as \`blocks: [{ doc, line, kind, section, text }]\`:
what its record says it blocks or gates (kind "stated"), and every unticked
checklist item (kind "item") or frontmatter blocker (kind "blocker") that
names its id, alone or inside a written range such as \`A2 to A12\`. In
another document the id has to sit beside a link to the decision's document.`,

  show: `runlist show <file...> — one document's card, read-only

  runlist show <file>           title, status, next step, blockers, checklist,
                                related plans and docs, documents linked from the body
  runlist show <a> <b> --json   [{ path, type, title, status, summary, currentState,
                                   nextStep, blockers, checklist, updated,
                                   related: [{ field, ref, path, exists, title, status, type }],
                                   links: [{ path, title, status, type }] }]

A file is a path, filename or slug, as for \`use\`. Nothing is claimed or
written. With --json a file that is not found is { path, error } rather than
an exit.`,

  model: `runlist model — the local model behind summaries and lint

One local server (Ollama by default) holds one model, serves one request at a
time and unloads it after it sits idle. runlist never starts the server or
pulls a model on its own.

Subcommands:
  status [--json]        Default. Server, model, cap, what is loaded and its memory
  start [--force]        Start \`ollama serve\` (one model, one request at a time);
                         refused where no model fits unless forced
  stop [--all]           Unload runlist's model now; --all unloads every loaded model
  measure [name...]      Load each pulled candidate (or the named ones) in turn,
                         summarise the corpus's largest documents at lower
                         priority, and record peak memory and speed for this
                         machine; a model is picked only once measured here
  use <name|auto>        Name the model; auto takes the first measured candidate
                         under the cap
  cap <gb|auto>          The most memory a model may take; auto (the default) is a
                         quarter of this machine's memory, at most 12 GB

Before a model loads here, the memory free now must hold it plus 1.5 GB and
memory pressure must be normal; otherwise the command goes on without it.

Settings live in ~/.runlist/model.json. RUNLIST_MODEL, RUNLIST_MODEL_CAP_GB and
RUNLIST_MODEL_ENDPOINT override them; \`runtime: "openai"\` there points at any
OpenAI-compatible server (mlx_lm.server, llama-server, LM Studio).`,

  glossary: `runlist glossary <term> — look up domain terms and related docs

Searches the glossary table in your docs for matching terms.
Shows definition, related docs, and see-also entries.

Options:
  --list                 List all glossary terms
  --json                 Output as JSON`,

  statuses: `runlist statuses — manage per-project status taxonomy

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
                                        (lists offenders, suggests \`runlist migrate\`). Warns if an
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
  runlist statuses                                                  # list everything
  runlist statuses add paused --type plan --like blocked --quiet
  runlist statuses set archived --type plan --no-quiet
  runlist statuses remove obsolete --type plan
  runlist statuses migrate plan                                     # array → rich

Lifecycle-override gotcha: if your config has both rich-form types and an explicit
\`export const lifecycle\`, the runtime ignores per-status flags. The CLI refuses
to write in that case unless you pass --ignore-lifecycle-override; the recommended
fix is to delete the explicit \`lifecycle\` block so flags take effect.`,

  bulk: `runlist bulk archive <f1> <f2> ... — archive multiple files at once

Archives each file in an independent per-item transaction: sets status to
archived, moves to archive directory, and updates references. This is explicitly
not all-or-none; --json reports archived/failed for every item. The index is
regenerated once after all item attempts.

Use --dry-run (-n) to preview changes without writing anything.`,

  runlist: `runlist runlist <hub> [next|add|remove|reorder] — work with an ordered group of plans

A "runlist" is just a plan with a \`runlist:\` array of child plan paths in its
frontmatter — there is no separate doc type. The hub plan can have any status;
the order of the children comes from the array.

Usage:
  runlist runlist <hub>          Show children + their statuses, in order. The
                               first pickup-able child (active / planned /
                               in-session) is marked \`→\`. Archived (done) and
                               parked children (blocked / partial / paused /
                               awaiting / queued-after) are skipped — \`→\`
                               advances to the first child you can actually
                               start. Parked ≠ done: they don't count toward
                               done/total.
  runlist runlist next <hub>     Open the first pickup-able child (marks it
                               in-session + prints it), advancing past archived
                               and parked children. If every remaining child is
                               parked, stops and lists them + the unstick verbs
                               so you resolve a blocker first.
  runlist runlist add <hub> <child...>
                               Append children to the hub's \`runlist:\` array
                               (no more hand-editing the YAML). Each child can be:
                                 • a bare slug (\`cleanup\`) → scaffolds a
                                   \`planned\` stub \`<hub>-NN-<slug>.md\` next to
                                   the hub (mirrors \`new plan --runlist\`), or
                                 • a path/slug of an existing plan → wired in by a
                                   hub-relative ref, with its \`parent_plan:\` set
                                   back at the hub.
                               A plain plan gains a \`runlist:\` (becomes a hub).
                               Coordination hubs (body-order) aren't handled here.
  runlist runlist remove <hub> <child...>
                               Drop children from the \`runlist:\` array. Children
                               match by full path or short slug (\`cleanup\` finds
                               \`<hub>-03-cleanup.md\`). \`--clear-parent\` also blanks
                               each removed child's \`parent_plan:\` back-ref.
  runlist runlist reorder <hub> <child> --before|--after <other>
  runlist runlist reorder <hub> <c1> <c2> <c3...>
                               Move one child relative to another, or pass every
                               child to set a full new order.
                               All three mutators take \`--dry-run\` / \`--json\` and
                               keep any body \`## Order of operations\` link list in
                               sync (preserving per-item ⬜/✅ markers).

Flags (only meaningful with \`next\`):
  --full             Print full plan body instead of the card.
  --no-index         Skip index regeneration.
  --show-files       Emit \`files: …\` footer.

Common shape:
  ---
  type: plan
  status: active
  title: Auth Revamp
  runlist:
    - auth-revamp-01-extract.md
    - auth-revamp-02-rewrite.md
    - auth-revamp-03-cleanup.md
  ---

Child plans should set \`parent_plan:\` back at the hub — \`runlist check\` warns
when they don't.

In \`runlist plans\`, a hub is tagged \`[RUNLIST]\` (not \`[ACTIVE]\`) and its
children fold underneath it — progress (\`done/total\`) and the next pickup
\`→\` show on the hub row, so a sprint reads as one runlist instead of N loose
plans. Children whose hub is filtered out of the view (e.g. \`--status active\`
when the hub is \`planned\`) still render on their own.

Larger, prose-first "coordination" runlists (a domain map pointing at many
plans, marked \`execution_mode: coordination\` or named \`*-runlist\`) aren't
folded — they're lifted into a separate \`Runlists\` section in \`runlist plans\`
and out of the active count. \`runlist runlists\` shows that dashboard on its own.
For these, \`runlist\`/\`runlist next\` also read order from the body when there's
no \`runlist:\` array — a \`## Ranked queue\` table or \`## Order of operations\`
list of markdown links (the first \`.md\` link per row/item, in order).`,

  runlists: `runlist runlists — the coordination-hub dashboard

Lists every *coordination runlist*: a prose-first plan that sits above a
cluster of others (a domain map), detected by \`execution_mode: coordination\`
or a \`*-runlist\` / \`runlist\` slug. Each row shows the hub, its age, the rough
size of its \`related_plans:\` cluster, a \`next → <child>\` when the hub's body
encodes order as markdown links (\`## Ranked queue\` table / \`## Order of
operations\` list), and a one-line descriptor.

This is the standalone form of the \`Runlists\` section that \`runlist plans\`
pins beneath the leaf-plan triage list.

  runlist runlists               All runlists (a small bounded set), most stale first.
  runlist runlists --sort recent Order by recency instead (age|recent|related|title|status).
  runlist runlists --limit N     Cap the list at N.
  runlist runlists --json        Structured rows (path, status, childCount, nextPickup, …).`,

  'bulk-tag': `runlist bulk-tag [files...] — fill in type/status frontmatter on pre-existing markdown

Scans the docs tree for files that are missing either \`type:\` or \`status:\`
(or have no frontmatter block at all) and writes minimal frontmatter so they
appear in \`runlist list\`, \`query\`, and \`briefing\`.

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

const GLOBAL_VALUE_OPTIONS = new Set(['--config', '--root', '--type']);
const GLOBAL_BOOLEAN_OPTIONS = new Set(['--dry-run', '-n', '--verbose']);

function splitGlobalArgs(args) {
  let commandIndex = -1;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (GLOBAL_VALUE_OPTIONS.has(arg)) {
      if (args[i + 1] === undefined || args[i + 1].startsWith('-')) die(`Missing value for global option \`${arg}\`.`);
      i += 1;
      continue;
    }
    if (GLOBAL_BOOLEAN_OPTIONS.has(arg)) continue;
    commandIndex = i;
    break;
  }

  const command = canonicalCommand(commandIndex === -1 ? 'list' : args[commandIndex]);
  const rest = [];
  let explicitConfig = null;
  let rootArg = null;
  let typeArg = null;
  let dryRun = false;
  let verbose = false;

  for (let i = 0; i < args.length; i += 1) {
    if (i === commandIndex) continue;
    const arg = args[i];
    const beforeCommand = commandIndex === -1 || i < commandIndex;
    if (GLOBAL_VALUE_OPTIONS.has(arg)) {
      const local = !beforeCommand && commandOwnsOption(command, arg);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) die(`Missing value for \`${arg}\`.`);
      if (local) rest.push(arg, next);
      else if (arg === '--config') explicitConfig = next;
      else if (arg === '--root') rootArg = next;
      else typeArg = next;
      i += 1;
      continue;
    }
    if (arg === '--dry-run' || arg === '-n') { dryRun = true; continue; }
    if (arg === '--verbose') {
      if (!beforeCommand && commandOwnsOption(command, arg)) rest.push(arg);
      else verbose = true;
      continue;
    }
    rest.push(arg);
  }

  return { command, rest, explicitConfig, rootArg, typeArg, dryRun, verbose };
}

async function main() {
  const args = process.argv.slice(2);

  // Pre-config flags
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  // Before-command options are global. After the command, a schema-declared
  // local option wins; otherwise the historical anywhere-global form remains.
  const parsed = splitGlobalArgs(args);
  let { command, explicitConfig, rootArg, typeArg, dryRun, verbose } = parsed;
  let restArgs = parsed.rest;

  // Tolerate accidentally pasting the command prefix twice, while leaving all
  // remaining arguments to the normal `use` grammar and path validation.
  if (command === 'use') {
    while ((restArgs[0] === 'runlist' || restArgs[0] === 'dotmd') && restArgs[1] === 'use') restArgs = restArgs.slice(2);
  }

  // Reconstruct the active global flags for proxy commands (e.g. `watch`) that
  // re-invoke the CLI in a child process and must propagate them through.
  const globalFlagArgs = () => {
    const out = [];
    if (explicitConfig) out.push('--config', explicitConfig);
    if (rootArg) out.push('--root', rootArg);
    if (typeArg) out.push('--type', typeArg);
    if (dryRun) out.push('--dry-run');
    if (verbose) out.push('--verbose');
    return out;
  };

  // Apply global --root / --type filters to an index in place. Shared by the
  // common index path below AND the early-dispatched commands (plans, runlists,
  // presets) that build their own index, so filtering is consistent everywhere.
  // Recomputes BOTH countsByStatus and countsByType so filtered JSON never
  // reports corpus-wide tallies.
  function applyIndexFilters(idx) {
    if (rootArg) {
      idx.docs = idx.docs.filter(d => d.root === rootArg || d.root.endsWith('/' + rootArg) || d.root.split('/').pop() === rootArg);
    }
    if (typeArg) {
      const types = typeArg.split(',').map(t => t.trim()).filter(Boolean);
      idx.docs = idx.docs.filter(d => types.includes(d.type));
    }
    if (rootArg || typeArg) {
      idx.errors = idx.errors.filter(e => idx.docs.some(d => d.path === e.path));
      idx.warnings = idx.warnings.filter(w => idx.docs.some(d => d.path === w.path));
      idx.countsByStatus = {};
      idx.countsByType = {};
      for (const doc of idx.docs) {
        const status = doc.status ?? 'unknown';
        idx.countsByStatus[status] = (idx.countsByStatus[status] ?? 0) + 1;
        const type = doc.type || 'unknown';
        if (!idx.countsByType[type]) idx.countsByType[type] = {};
        idx.countsByType[type][status] = (idx.countsByType[type][status] ?? 0) + 1;
      }
    }
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    const topic = restArgs[0];
    if (topic) {
      const key = `help:${topic}`;
      if (HELP[key]) { process.stdout.write(`${HELP[key]}\n`); return; }
      if (HELP[topic]) { process.stdout.write(`${HELP[topic]}\n`); return; }
      process.stderr.write(`Unknown help topic: ${topic}\n\nAvailable topics: all, statuses\nPer-command help: runlist <cmd> --help\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${HELP._main}\n`);
    return;
  }

  const dispatchPolicy = commandPolicy(command);
  _resolvedCommand = command;
  const doctorSubMode = command === 'doctor' && (
    args.includes('--statuses') || args.includes('--migrate-template')
    || args.includes('--migrate-prompts') || args.includes('--frontmatter-fix')
    || args.includes('--project')
  );
  const doctorExplicitApply = args.includes('--apply') || args.includes('--yes');
  const effectiveDryRun = dryRun || (command === 'doctor' && !doctorSubMode && !doctorExplicitApply);
  const passiveMachineContext = command === 'agent-context'
    || (command === 'context' && args.includes('--json') && args.includes('--compact'));
  // Git/frontmatter drift is validation work, not index construction. Keep the
  // bounded history scan on commands that report or repair that drift; ordinary
  // reads still run schema/reference validation without walking 10k commits.
  const gitStaleness = command === 'check' || command === 'doctor';
  _suppressObservability = effectiveDryRun || command === 'hud' || passiveMachineContext;

  // Per-command help
  if (args.includes('--help') || args.includes('-h')) {
    requireCommandPolicy(command, dispatchPolicy);
    process.stdout.write(`${HELP[command] ?? commandUsage(command)}\n`);
    if (command === 'new') {
      // Best effort: outside a runlist repo, or with a broken config, the
      // static help above is the whole answer.
      try {
        const repoConfig = await resolveConfig(process.cwd(), explicitConfig);
        if (repoConfig?.configFound !== false) {
          const { newHelpForRepo } = await import('../src/new.mjs');
          process.stdout.write(`\n${newHelpForRepo(repoConfig)}\n`);
        }
      } catch { /* static help already printed */ }
    }
    return;
  }

  if (command === 'completions') {
    requireCommandPolicy(command, dispatchPolicy);
    try { restArgs = validateCommandArgs(command, restArgs); } catch (err) { die(err.message); }
    const { runCompletions } = await import('../src/completions.mjs');
    runCompletions(restArgs);
    return;
  }

  let config;
  try {
    config = await resolveConfig(process.cwd(), explicitConfig);
  } catch (err) {
    if (command === 'guard') {
      process.stdout.write('{}\n');
      return;
    }
    // A prompt hook runs on every user message; a broken config must not
    // turn each one into an error.
    if (command === 'hud' && restArgs.includes('--prompt-submit')) return;
    throw err;
  }
  _resolvedConfig = config;
  // The one place that reaches an OpenCode session running without the
  // integration — whatever verb it reaches for first. stderr, so `--json`
  // consumers are untouched, and once per session so it informs rather than
  // nags. `install`/`doctor`/`update` are skipped: they report this themselves,
  // and telling `dotmd install opencode` to run `dotmd install opencode` is
  // noise.
  if (!['install', 'doctor', 'update', 'hud', 'guard'].includes(command)) {
    const { degradedIdentityNotice } = await import('../src/host-integration.mjs');
    const notice = degradedIdentityNotice(config?.repoRoot, { version: pkg.version });
    if (notice) process.stderr.write(`${notice}\n`);
  }

  const suppressSideEffects = effectiveDryRun || command === 'hud' || command === 'guard' || passiveMachineContext;
  Object.defineProperty(config, '_execution', {
    value: { dryRun, passive: command === 'hud' || passiveMachineContext, suppressSideEffects, gitStaleness },
    enumerable: false,
  });
  if (!suppressSideEffects) {
    const { migrateStateDirectory } = await import('../src/state-migration.mjs');
    const { LEGACY_STATE_DIR, STATE_DIR } = await import('../src/naming.mjs');
    const migration = migrateStateDirectory(config.repoRoot);
    if (migration.status === 'migrated') {
      process.stderr.write(`[runlist] migrated ${LEGACY_STATE_DIR}/ → ${STATE_DIR}/ (session state moved; repository files unchanged)\n`);
    } else if (migration.status === 'refused') {
      warn(migration.message);
    }
  }
  // Unknown names may still be user-defined query presets. Every built-in
  // dispatcher branch, including mutators above the shared index path, must be
  // present in the centralized command policy registry.
  if (!config.presets[command]) requireCommandPolicy(command, dispatchPolicy);

  try {
    restArgs = validateCommandArgs(command, restArgs, { preset: Boolean(config.presets[command]) });
  } catch (err) {
    die(err.message);
  }

  // Init — runInit re-resolves the config from disk internally (after any
  // starter-config write), so we don't need to pre-pass it.
  if (command === 'init') {
    const { runInit } = await import('../src/init.mjs');
    await runInit(process.cwd(), config, { dryRun });
    return;
  }

  // Watch is a proxy — re-inject the active globals so the child re-resolves
  // the same config/filters.
  if (command === 'watch') { const { runWatch } = await import('../src/watch.mjs'); runWatch([...globalFlagArgs(), ...restArgs], config); return; }

  // Hook commands (`hud`, `guard`) fire in EVERY repo via the globally-enabled
  // plugin — `guard` runs on every Bash/Read/Edit. They must stay silent where
  // dotmd isn't used, so don't nag them about a missing config (they no-op
  // cleanly on their own). The warning is still useful for interactive commands.
  const HOOK_COMMANDS = new Set(['hud', 'guard']);
  if (!config.configFound && command !== 'init' && !HOOK_COMMANDS.has(command)) {
    warn('No runlist config found — using defaults. Run `runlist init` to create one.');
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

  // A printed list shows status, title, age and next step, none of which the
  // validating passes produce, so it reads the index the way `prompts` and
  // `hud` do. `--json` emits each document's warnings and errors, so it still
  // pays for the full pass.
  const listIndexOptions = listArgs => (listArgs.includes('--json') ? {} : { fast: true });

  // Preset aliases (user config can override built-in commands below)
  if ((command === 'stale' || command === 'actionable') && !config.configuredPresetNames.has(command)) {
    const { buildIndex } = await import('../src/index.mjs');
    const { runQuery } = await import('../src/query.mjs');
    const { statusMetadataFor } = await import('../src/status-metadata.mjs');
    const index = buildIndex(config, listIndexOptions(restArgs));
    applyIndexFilters(index);
    const docs = index.docs.filter(doc => {
      const metadata = statusMetadataFor(config, doc.type, doc.status);
      if (command === 'stale') return doc.isStale && !metadata?.skipStale;
      return metadata?.context === 'expanded'
        && doc.hasNextStep
        && !metadata.terminal
        && !metadata.archive
        && !isArchivedPath(doc.path, config);
    });
    runQuery({ ...index, docs }, ['--sort', 'updated', '--all', ...restArgs], config, { preset: command, type: typeArg, root: rootArg });
    return;
  }
  if (config.presets[command]) {
    const { buildIndex } = await import('../src/index.mjs');
    const { runQuery } = await import('../src/query.mjs');
    const index = buildIndex(config, listIndexOptions([...config.presets[command], ...restArgs]));
    applyIndexFilters(index);
    runQuery(index, [...config.presets[command], ...restArgs], config, { preset: command, type: typeArg, root: rootArg });
    return;
  }

  // Built-in list commands — stable across projects regardless of preset config.
  // Two views per type:
  //   `dotmd plans`         triage — top 10 by recency, flat with right-aligned [TAG]
  //   `dotmd plans status`  pipeline — grouped by status, no per-row tag, all plans
  if (command === 'plans') {
    const { buildIndex } = await import('../src/index.mjs');
    const { runQuery } = await import('../src/query.mjs');
    const index = buildIndex(config, listIndexOptions(restArgs));
    applyIndexFilters(index);
    const sub = restArgs[0];
    let defaults;
    let extras = restArgs;
    if (sub === 'status') {
      defaults = ['--type', 'plan', '--exclude-archived', '--sort', 'status', '--all'];
      extras = restArgs.slice(1);
    } else {
      defaults = ['--type', 'plan', '--exclude-archived', '--sort', 'updated', '--limit', '10'];
    }
    runQuery(index, [...defaults, ...extras], config, { preset: 'plans', type: typeArg, root: rootArg });
    return;
  }
  // `dotmd runlists` (plural) — the coordination-hub dashboard (the `Runlists`
  // section of `dotmd plans`, standalone). Distinct from `dotmd runlist <hub>`
  // (singular), which walks one hub's children.
  if (command === 'runlists') {
    const { buildIndex } = await import('../src/index.mjs');
    const { runRunlists } = await import('../src/query.mjs');
    const index = buildIndex(config, listIndexOptions(restArgs));
    applyIndexFilters(index);
    runRunlists(index, restArgs, config);
    return;
  }
  // `dotmd roadmaps` (dashboard over every roadmap hub) and `dotmd roadmap
  // [<hub>] [next]` (one roadmap, or pick up the next action across its
  // runlists). The tier-3 layer above `runlists`.
  if (command === 'roadmaps') {
    const { buildIndex } = await import('../src/index.mjs');
    const { runRoadmaps } = await import('../src/roadmap.mjs');
    const index = buildIndex(config, listIndexOptions(restArgs));
    applyIndexFilters(index);
    runRoadmaps(index, restArgs, config);
    return;
  }
  if (command === 'roadmap') {
    const { buildIndex } = await import('../src/index.mjs');
    const index = buildIndex(config);
    applyIndexFilters(index);
    if (restArgs[0] === 'next') {
      const { runRoadmapNext } = await import('../src/roadmap.mjs');
      await runRoadmapNext(index, restArgs.slice(1), config, { dryRun });
      return;
    }
    const { runRoadmap } = await import('../src/roadmap.mjs');
    runRoadmap(index, restArgs, config);
    return;
  }
  if (command === 'prompts') {
    const { runPrompts } = await import('../src/prompts.mjs');
    await runPrompts(restArgs, config, { dryRun, verbose });
    return;
  }
  // Top-level `dotmd use [file]` — the single "start engaging with this doc"
  // verb. Dispatches by the target doc's type: prompt → consume + archive,
  // plan → mark in-session + print, doc → print. With no file: consume oldest
  // pending prompt. See src/use.mjs for the dispatch table.
  if (command === 'use') {
    const { runUse } = await import('../src/use.mjs');
    await runUse(restArgs, config, { dryRun });
    return;
  }
  // `dotmd baton [plan] <@draft|->` — the one-command handoff: save the resume
  // prompt, release the plan (one status flip), print the exact commit. See
  // src/baton.mjs for why this is a single verb and not a skill choreography.
  if (command === 'baton') {
    const { runBaton } = await import('../src/baton.mjs');
    await runBaton(restArgs, config, { dryRun });
    return;
  }
  // `dotmd next` is a top-level alias for `dotmd use` with no arg — consume
  // the oldest pending prompt. Wired separately so agents who reach for the
  // literal verb "next" don't bounce off an Unknown-command. Any positional
  // arg is ignored (a named file goes through `use`).
  if (command === 'next') {
    const { runUse } = await import('../src/use.mjs');
    await runUse(restArgs.filter(a => a.startsWith('-')), config, { dryRun });
    return;
  }

  // Commands that handle their own index building
  if (command === 'diff') { const { runDiff } = await import('../src/diff.mjs'); runDiff(restArgs, config); return; }
  if (command === 'summary') { const { runSummary } = await import('../src/summary.mjs'); runSummary(restArgs, config); return; }
  if (command === 'deps') { const { runDeps } = await import('../src/deps.mjs'); runDeps(restArgs, config); return; }
  if (command === 'unblocks') { const { runUnblocks } = await import('../src/deps.mjs'); runUnblocks(restArgs, config); return; }
  if (command === 'health') { const { runHealth } = await import('../src/health.mjs'); runHealth(restArgs, config); return; }
  if (command === 'flags') { const { runFlags } = await import('../src/flags.mjs'); runFlags(restArgs, config); return; }
  if (command === 'flag') { const { runFlag } = await import('../src/flags.mjs'); runFlag(restArgs, config); return; }
  if (command === 'glossary') { const { runGlossary } = await import('../src/glossary.mjs'); runGlossary(restArgs, config); return; }
  if (command === 'model') { const { runModel } = await import('../src/model.mjs'); await runModel(restArgs, config); return; }
  if (command === 'show') { const { runShow } = await import('../src/show.mjs'); runShow(restArgs, config); return; }
  if (command === 'decisions') {
    const { runDecisions } = await import('../src/decisions.mjs');
    const result = runDecisions(restArgs, config);
    if (result?.defects?.length) {
      const first = result.defects[0];
      _exitFailureMessage = `${result.defects.length} decision defect(s); first: ${first.doc}:${first.line} ${first.message}`;
    }
    return;
  }
  if (command === 'export') { const { runExport } = await import('../src/export.mjs'); runExport(restArgs, config, { dryRun, root: rootArg, type: typeArg }); return; }

  // Lifecycle commands
  if (command === 'hud' && restArgs.includes('--prompt-submit')) {
    const { runPromptSubmitHud } = await import('../src/hud.mjs');
    const { readHookStdin } = await import('../src/guard.mjs');
    await runPromptSubmitHud(config, { readStdin: readHookStdin });
    return;
  }
  if (command === 'hud') { const { runHud } = await import('../src/hud.mjs'); runHud(restArgs, config); return; }
  if (command === 'guard') { const { runGuard } = await import('../src/guard.mjs'); await runGuard(restArgs, config, { dryRun }); return; }
  if (command === 'update') { const { runUpdate } = await import('../src/update.mjs'); runUpdate(restArgs, config, { dryRun }); return; }
  if (command === 'install') { const { runInstall } = await import('../src/install.mjs'); runInstall(restArgs, config, { dryRun }); return; }
  if (command === 'errors') { const { runErrors } = await import('../src/errors-read.mjs'); runErrors(restArgs); return; }
  if (command === 'misuse') { const { runMisuse } = await import('../src/misuse-read.mjs'); runMisuse(restArgs, config); return; }
  if (command === 'journal') { const { runJournal } = await import('../src/journal-read.mjs'); runJournal(restArgs, config); return; }
  if (command === 'pickup' || command === 'unpickup' || command === 'release' || command === 'finish') {
    die(`\`runlist ${command}\` was removed — use the ownership-aware lifecycle verbs:\n  runlist use <file>          # atomically claim + mark in-session + print the plan\n  runlist set <status> <file> # transition and release ownership when leaving in-session\n  runlist archive <file>      # close out atomically`);
  }
  if (command === 'runlist') { const { runRunlist } = await import('../src/runlist.mjs'); await runRunlist(restArgs, config, { dryRun }); return; }
  if (command === 'handoff') { die('`runlist handoff` was removed in 0.31.0. Use `runlist prompts new <name>` to create a saved prompt instead. The .dotmd/handoffs/ sidecar mechanism no longer exists; see CHANGELOG.'); }
  if (command === 'status') { const { runStatus } = await import('../src/lifecycle.mjs'); await runStatus(restArgs, config, { dryRun }); return; }
  if (command === 'set') { const { runSet } = await import('../src/lifecycle.mjs'); await runSet(restArgs, config, { dryRun }); return; }
  if (command === 'ship') { const { runShip } = await import('../src/ship.mjs'); await runShip(restArgs, config, { dryRun }); return; }
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
  if (command === 'refs') { const { runRefs } = await import('../src/code-refs.mjs'); runRefs(restArgs, config, { dryRun }); return; }
  if (command === 'fix-membership') { const { runFixMembership } = await import('../src/fix-membership.mjs'); await runFixMembership(restArgs, config, { dryRun }); return; }
  if (command === 'sync-status') { const { runSyncStatus } = await import('../src/sync-status.mjs'); await runSyncStatus(restArgs, config, { dryRun }); return; }
  if (command === 'self-check') {
    const { runDoctor } = await import('../src/doctor.mjs');
    runDoctor(['--project', ...restArgs], config, { dryRun });
    return;
  }
  if (command === 'doctor') {
    // 0.37.0 (F4): the default auto-fix loop previews by default; --apply
    // (alias --yes) writes. Explicit --dry-run still works and wins over
    // --apply (safety prevails). The F4 flip applies ONLY to the default
    // auto-fix path — sub-modes (--statuses, --migrate-template,
    // --migrate-prompts) keep their existing "write unless --dry-run"
    // contract because they're explicit one-shots the user opted into.
    const doctorDryRun = doctorSubMode ? dryRun : (dryRun || !doctorExplicitApply);
    const filtered = restArgs.filter(a => a !== '--apply' && a !== '--yes');
    const { runDoctor } = await import('../src/doctor.mjs');
    // Awaited because --claims releases through `runSet`, which is async; the
    // other modes return undefined and are unaffected.
    await runDoctor(filtered, config, { dryRun: doctorDryRun });
    return;
  }
  if (command === 'statuses') { const { runStatuses } = await import('../src/statuses.mjs'); await runStatuses(restArgs, config, { dryRun, type: typeArg }); return; }

  // All remaining commands need the index + render modules
  const { buildIndex } = await import('../src/index.mjs');
  const { renderCompactList, renderVerboseList, renderContext, renderBriefing, renderCheck, renderCoverage, buildCoverage, buildReferenceValidationCoverage } = await import('../src/render.mjs');
  const { runFocus, runQuery } = await import('../src/query.mjs');
  // `dotmd check` is the one shared-buildIndex command that should auto-heal a
  // drifted index block (frontmatter edits by direct Edit/Write, `lint --fix`,
  // etc. leave the README out of sync; demanding the user run `dotmd index`
  // each time was pure noise). Print/dry-run/read-only callers (`json`, `list`,
  // `query`, `index --print`, ...) stay opt-out so they never mutate disk.
  const checkHasPathScope = command === 'check' && restArgs.some(arg => !arg.startsWith('-'));
  const AUTO_HEAL_INDEX_COMMANDS = new Set(['check']);
  const index = buildIndex(config, {
    autoHealIndex: AUTO_HEAL_INDEX_COMMANDS.has(command) && !checkHasPathScope && !dryRun,
    invokeHooks: !suppressSideEffects,
  });

  applyIndexFilters(index);

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
    const noCollapse = args.includes('--no-collapse');
    const verbose = args.includes('--verbose');
    // `--min-docs N` overrides the configured floor for this run (CI passes it
    // without editing config). Its value is not a path target.
    const minDocsFlagIdx = restArgs.indexOf('--min-docs');
    const minDocsRaw = minDocsFlagIdx === -1 ? null : restArgs[minDocsFlagIdx + 1];
    if (minDocsFlagIdx !== -1 && !/^\d+$/.test(minDocsRaw ?? '')) {
      die('`--min-docs` needs a positive integer, e.g. `runlist check --min-docs 500`.');
    }
    const minDocsOverride = minDocsRaw == null ? null : Number(minDocsRaw);
    const minDocsValueIdx = minDocsFlagIdx === -1 ? -1 : minDocsFlagIdx + 1;
    const checkTargets = restArgs.filter((arg, i) => !arg.startsWith('-') && i !== minDocsValueIdx);
    const { applyScanFloor } = await import('../src/validate.mjs');
    const scanFloorConfig = minDocsOverride == null ? config : { ...config, minDocs: minDocsOverride };
    const applyFloor = (idx) => applyScanFloor(idx, scanFloorConfig, { scoped: checkTargets.length > 0 });
    const skippedCheckHooks = config._execution?.suppressSideEffects
      ? ['validate', 'transformDoc', 'formatSnapshot', 'renderCheck']
          .filter(name => typeof config.hooks?.[name] === 'function')
      : [];
    // `--flag` puts each error on the flags list, attributed to this check, and
    // resolves the check's earlier flags it no longer reports. Whole-repo runs
    // only: a scoped run cannot tell a fixed error from one outside its scope.
    const flagCheckErrors = async (checkIndex) => {
      if (!args.includes('--flag') || dryRun) return;
      if (checkTargets.length > 0) die('`--flag` runs on the whole repository; drop the path arguments.');
      const { syncCheckFlags } = await import('../src/flags.mjs');
      const findings = checkIndex.errors.filter(e => e.path).map(e => ({ file: e.path, text: e.message }));
      const { added, resolved } = syncCheckFlags(config, 'runlist check', findings);
      process.stderr.write(`flags: ${added} added, ${resolved} resolved\n`);
    };
    const checkJson = (checkIndex) => {
      const builtInPassed = checkIndex.errors.length === 0;
      const complete = skippedCheckHooks.length === 0;
      return {
        docsScanned: checkIndex.docs.length,
        errors: checkIndex.errors,
        warnings: errorsOnly ? [] : checkIndex.warnings,
        errorCount: checkIndex.errors.length,
        warningCount: checkIndex.warnings.length,
        referenceValidation: buildReferenceValidationCoverage(checkIndex, config),
        passed: complete ? builtInPassed : null,
        ...(complete ? {} : {
          builtInPassed,
          validationPreview: { status: 'built-in-only', skippedHooks: skippedCheckHooks },
        }),
      };
    };
    const writeCheckPreviewNote = () => {
      if (skippedCheckHooks.length > 0) {
        process.stdout.write(`[preview] Custom ${skippedCheckHooks.join(', ')} hook${skippedCheckHooks.length === 1 ? '' : 's'} skipped; results below cover built-in behavior only.\n`);
      }
    };

    if (fix && checkTargets.length > 0) {
      die('`runlist check --fix` does not support path-scoped checks yet. Run `runlist check <path>` to validate a subset, or `runlist check --fix` to fix the whole docs tree.');
    }

    if (fix) {
      // Auto-fix: broken refs, mechanical membership back-references, lint,
      // hub status tokens, then rebuild the index.
      const { fixBrokenRefs } = await import('../src/fix-refs.mjs');
      const { fixMembershipBackrefs } = await import('../src/fix-membership.mjs');
      const { runLint } = await import('../src/lint.mjs');
      const { syncHubStatuses } = await import('../src/sync-status.mjs');
      fixBrokenRefs(config, { dryRun, quiet: false });
      fixMembershipBackrefs(config, { docs: buildIndex(config).docs, dryRun, quiet: false });
      runLint(['--fix'], config, { dryRun });
      // Rewrites drifted status TOKENS only. Adding markers is a content edit to
      // prose the user wrote, so it stays opt-in behind `sync-status --adopt`.
      syncHubStatuses(config, { docs: buildIndex(config).docs, dryRun, quiet: false });
      if (config.indexPath) {
        if (!dryRun) {
          const { writeRenderedIndex } = await import('../src/index-file.mjs');
          writeRenderedIndex(() => buildIndex(config, { fast: true }), config);
          process.stdout.write('Index regenerated.\n');
        } else {
          process.stdout.write('[dry-run] Would regenerate index.\n');
        }
      }
      // Show remaining issues
      const freshIndex = buildIndex(config);
      applyIndexFilters(freshIndex);
      applyPathScopeToIndex(freshIndex, config, checkTargets);
      applyFloor(freshIndex);
      await flagCheckErrors(freshIndex);
      if (args.includes('--json')) {
        process.stdout.write(JSON.stringify(checkJson(freshIndex), null, 2) + '\n');
      } else {
        writeCheckPreviewNote();
        process.stdout.write('\n' + renderCheck(freshIndex, config, { errorsOnly, noCollapse, verbose }));
      }
      if (freshIndex.errors.length > 0) {
        process.exitCode = 1;
        _exitFailureMessage = checkFailureSummary(freshIndex.errors);
      }
      return;
    }

    applyPathScopeToIndex(index, config, checkTargets);
    applyFloor(index);
    await flagCheckErrors(index);

    if (args.includes('--json')) {
      process.stdout.write(JSON.stringify(checkJson(index), null, 2) + '\n');
      if (index.errors.length > 0) {
        process.exitCode = 1;
        _exitFailureMessage = checkFailureSummary(index.errors);
      }
      return;
    }

    writeCheckPreviewNote();
    process.stdout.write(renderCheck(index, config, { errorsOnly, noCollapse, verbose }));
    if (index.errors.length > 0) {
      process.exitCode = 1;
      _exitFailureMessage = checkFailureSummary(index.errors);
    }
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
      die('Index generation is not configured. Add an `index` section to your runlist.config.mjs.');
    }
    const print = args.includes('--print');
    const { renderIndexFile, writeRenderedIndex } = await import('../src/index-file.mjs');
    if (!print) {
      const { authorizeRepoGeneratedPath } = await import('../src/managed-path.mjs');
      authorizeRepoGeneratedPath(config.indexPath, config, { kind: 'Generated index destination' });
    }
    const rendered = renderIndexFile(index, config);
    if (print) {
      process.stdout.write(rendered);
    } else if (dryRun) {
      process.stdout.write(`[dry-run] Would update ${config.indexPath}\n`);
    } else {
      writeRenderedIndex(() => buildIndex(config, { fast: true }), config);
      process.stdout.write(`Updated ${config.indexPath}\n`);
    }
    return;
  }

  if (command === 'focus') { runFocus(index, restArgs, config); return; }
  if (command === 'query') { runQuery(index, restArgs, config, { type: typeArg, root: rootArg }); return; }
  // `dotmd grep <term>` — ergonomic alias for `query --keyword <term> --body`.
  // Unlimited by default (grep semantics) unless the caller bounds it themselves.
  if (command === 'grep') {
    let term = null;
    const passthrough = [];
    for (let i = 0; i < restArgs.length; i++) {
      const arg = restArgs[i];
      if (QUERY_VALUE_FLAGS.has(arg)) { passthrough.push(arg, restArgs[i + 1]); i += 1; continue; }
      if (arg.startsWith('-') || term !== null) { passthrough.push(arg); continue; }
      term = arg;
    }
    if (!term) die('Usage: runlist grep <term> [query flags]\n\nSearches frontmatter fields AND document bodies; alias for `runlist query --keyword <term> --body --all`.');
    const defaults = ['--keyword', term, '--body'];
    if (!passthrough.includes('--limit') && !passthrough.includes('--all')) defaults.push('--all');
    runQuery(index, [...defaults, ...passthrough], config);
    return;
  }
  if (command === 'modules' || command === 'module') {
    // D3: default `--type plan` when the user didn't pass --type explicitly.
    // applyIndexFilters already narrowed by typeArg if it was set; if not, the
    // index still spans all types, and the dashboard would mix plans/docs/prompts
    // into the same module rows. Narrow here so the docs/prompts case stays a
    // deliberate `--type doc` opt-in (deferred per plan).
    const scoped = typeArg ? index : { ...index, docs: index.docs.filter(d => d.type === 'plan') };
    if (command === 'modules') {
      const { runModulesDashboard } = await import('../src/modules.mjs');
      runModulesDashboard(scoped, restArgs, config);
    } else {
      const { runModuleDetail } = await import('../src/modules.mjs');
      runModuleDetail(scoped, restArgs, config);
    }
    return;
  }
  if (command === 'surfaces') {
    const { runSurfaces } = await import('../src/surfaces.mjs');
    runSurfaces(restArgs, config);
    return;
  }

  if (command === 'agent-context') {
    const { buildAgentContext } = await import('../src/agent-context.mjs');
    const skippedHooks = ['validate', 'transformDoc', 'formatSnapshot'].filter(name => typeof config.hooks?.[name] === 'function');
    process.stdout.write(JSON.stringify(buildAgentContext(index, config, {
      roots: rootArg ? [rootArg] : null,
      types: typeArg ? typeArg.split(',').map(value => value.trim()).filter(Boolean) : null,
      skippedHooks,
    }), null, 2) + '\n');
    return;
  }

  if (command === 'briefing') {
    if (args.includes('--json')) {
      const { statusMetadataFor } = await import('../src/status-metadata.mjs');
      const plans = index.docs.filter(d => d.type === 'plan');
      const docs = index.docs.filter(d => d.type === 'doc');
      const research = index.docs.filter(d => d.type === 'research');
      const stale = index.docs.filter(d => d.isStale && !statusMetadataFor(config, d.type, d.status)?.skipStale).length;
      // Coordination hubs are runlists, not actionable plans — split them out of
      // inSession/active into their own `runlists` array so the JSON mirrors the
      // rendered briefing. Empty on repos with no coordination hubs.
      const { buildCoordinationIndex } = await import('../src/runlist.mjs');
      const coordination = buildCoordinationIndex(index, config);
      const isHub = (d) => coordination.has(d.path);
      const closedStatuses = new Set([...config.lifecycle.archiveStatuses, ...config.lifecycle.terminalStatuses]);
      const isLiveHub = (d) => isHub(d) && !closedStatuses.has(d.status) && !isArchivedPath(d.path, config);
      process.stdout.write(JSON.stringify({
        plans: { total: plans.length, inSession: plans.filter(d => d.status === 'in-session' && !isHub(d)).map(d => ({ path: d.path, title: d.title, nextStep: d.nextStep })), active: plans.filter(d => d.status === 'active' && !isHub(d)).map(d => ({ path: d.path, title: d.title, nextStep: d.nextStep })), focus: plans.filter(d => statusMetadataFor(config, 'plan', d.status)?.context === 'expanded' && !isHub(d)).map(d => ({ path: d.path, title: d.title, status: d.status, nextStep: d.nextStep })), runlists: plans.filter(isLiveHub).map(d => ({ path: d.path, title: d.title, status: d.status, childCount: coordination.get(d.path)?.childCount ?? 0 })) },
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
    const compact = args.includes('--compact');
    const modelIdx = args.indexOf('--model');
    const model = modelIdx !== -1 && args[modelIdx + 1] ? args[modelIdx + 1] : undefined;

    if (args.includes('--json')) {
      if (compact) {
        const { buildAgentContext } = await import('../src/agent-context.mjs');
        const skippedHooks = ['validate', 'transformDoc', 'formatSnapshot'].filter(name => typeof config.hooks?.[name] === 'function');
        process.stdout.write(JSON.stringify(buildAgentContext(index, config, {
          roots: rootArg ? [rootArg] : null,
          types: typeArg ? typeArg.split(',').map(value => value.trim()).filter(Boolean) : null,
          skippedHooks,
        }), null, 2) + '\n');
        return;
      }
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
      if (summarize && !config._execution?.suppressSideEffects) {
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
      const { statusMetadataFor } = await import('../src/status-metadata.mjs');
      const stale = index.docs.filter(d => d.isStale && !statusMetadataFor(config, d.type, d.status)?.skipStale);
      process.stdout.write(JSON.stringify({
        generatedAt: new Date().toISOString(),
        ...(summarize && config._execution?.suppressSideEffects
          ? { summaryPreview: { status: 'skipped-preview', reason: 'side-effect-free preview' } }
          : {}),
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

  requireCommandPolicy(command, null);
}

// F17a: opt-in JSONL journal of every CLI invocation. The dispatch tail
// records argv / exit / elapsed-ms / err once main() either returns or
// throws — config is captured into the module-level _resolvedConfig the
// moment it's loaded, so even early dispatcher errors (after config) get
// journaled.
let _resolvedConfig = null;
let _resolvedCommand = null;
let _suppressObservability = false;
let _exitFailureMessage = null;
const _startMs = Date.now();
const _invocationArgs = process.argv.slice(2);

function checkFailureSummary(errors) {
  const first = errors[0];
  return `${errors.length} check error(s); first: ${first.path ? `${first.path}: ` : ''}${first.message}`;
}

function _journalExit(err) {
  if (_suppressObservability || _resolvedCommand === 'hud' || _invocationArgs.includes('--dry-run') || _invocationArgs.includes('-n')) return;
  try {
    recordCliInvocation({
      config: _resolvedConfig,
      startMs: _startMs,
      args: _invocationArgs,
      err,
      version: pkg.version,
    });
  } catch { /* never break exit on journal failure */ }
  // A command that reports its own failure through the exit code (check with
  // errors, a failed update step) is a failure too.
  const code = Number(process.exitCode ?? 0);
  const failure = err ?? (code !== 0 ? { name: 'ExitStatus', message: _exitFailureMessage ?? `exited with status ${code}` } : null);
  if (failure) {
    try {
      recordGlobalError({
        config: _resolvedConfig,
        startMs: _startMs,
        args: _invocationArgs,
        err: failure,
        version: pkg.version,
      });
    } catch { /* never break exit on error-log failure */ }
  }
}

// A reader that stops early (`runlist flags | head`) closes the pipe; the rest
// of the output has nowhere to go, which is not a failure.
process.stdout.on('error', err => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

main()
  .then(() => { _journalExit(null); })
  .catch(err => {
    let out = err.message;
    // F17c: append a repeat-failure tip when the journal shows this same shape
    // has already failed in this session within the lookup window. Lookup is
    // a no-op when the journal is disabled or RUNLIST_NO_HINTS=1.
    try {
      const hint = findRepeatFailureHint(sanitizeTelemetryArgv(_invocationArgs), _resolvedConfig);
      if (hint) out = `${out}\n\nTip: ${hint}`;
    } catch { /* hint must never break error reporting */ }
    process.stderr.write(`${out}\n`);
    process.exitCode = 1;
    _journalExit(err);
  });
