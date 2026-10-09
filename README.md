# runlist

CLI for managing Markdown documents with YAML frontmatter.

runlist (formerly dotmd) indexes, queries, validates, graphs, exports, and lifecycle-manages plans,
ADRs, RFCs, design docs, and other structured Markdown. It is built for
AI-assisted development workflows where documents need to remain current and
safe to mutate.

- Zero runtime dependencies
- Node.js 20 or newer
- Runtime support for Linux, macOS, and Windows
- Type-aware lifecycle rules for plans, docs, and saved prompts

## Install

```bash
npm install -g runlist      # global CLI and agent-host hooks
npm install -D runlist      # project scripts via node_modules/.bin
npx runlist init            # try it without installing
```

`runlist` is the canonical executable, `rl` is its short convenience alias, and
`dotmd` remains supported during the compatibility window. All three invoke the
same CLI. The npm package is `runlist`; existing `dotmd-cli` installs should be
replaced with `runlist`. The Claude Code plugin is `runlist@runlist`. Legacy
`dotmd.config.*` files, `DOTMD_*` variables and `.dotmd/` state keep working.

If you installed the old package globally, remove it before installing the new
one because both packages provide the same executable names:

```bash
npm uninstall -g dotmd-cli
npm install -g runlist
```

Maintainer release automation is POSIX-only because it uses Bash and POSIX
command-line tools. The published Node.js CLI remains cross-platform.

### Optional desktop GUI

The CLI works on its own. To install the optional GUI on an Apple Silicon Mac
(macOS 13.5 or newer), run:

```bash
runlist desktop install
runlist desktop
```

The installer downloads the GUI from Runlist's public GitHub Releases, checks
its SHA-256 digest, developer signature and Apple approval, then installs it
without opening it. The app bundles its runtime and reads local files through
private pipes, with no listening server. Choose your checkout folder in the app.
No checkout configuration is loaded by these CLI commands.

The GUI is versioned separately: the current Mac installer is
[Runlist 0.91.0-rc.3](https://github.com/reowens/runlist/releases/tag/desktop-v0.91.0-rc.3).
Windows, Linux and Intel Mac GUI downloads are not yet available through this
command. An existing app is kept as-is. To replace it using a downloaded signed
DMG, quit Runlist and run:

```bash
runlist desktop install --from /path/to/Runlist.dmg
```

Replacement keeps the previous app as a rollback copy. Add `--dry-run` to preview
an install or launch without network access, file changes or opening the app.
Use `runlist desktop --app /path/to/application` for a custom installation path.

### Agent host setup

The CLI alone gives an agent no orientation and no session identity. Install the
integration for whichever host you run:

```bash
runlist install             # what's installed for each host
runlist install claude      # Claude Code plugin (marketplace + plugin)
runlist install codex       # Codex skill and hooks (personal marketplace)
runlist install opencode    # OpenCode plugin (one auto-discovered file)
runlist doctor --session    # what identity runlist sees here, and from where
```

The integrations are one-time and global. Codex exports `CODEX_THREAD_ID` to
every tool shell, so its identity works without the plugin; the plugin adds a
workflow skill, session orientation, and the tool guard.

### Codex Plugin

`runlist install codex` copies the plugin included in the npm package into the
personal Codex marketplace and runs `codex plugin add runlist-codex@personal`.
Codex asks you to review and trust plugin hooks separately. Start a new thread
after installation so the skill and SessionStart primer load. The hooks use
the globally installed `runlist` CLI; a missing CLI produces one install hint
and otherwise leaves tool calls alone. `CODEX_THREAD_ID` stays the ownership
source. The CLI refuses to overwrite a plugin directory it did not generate.

Direct prompt reads warn by default in Codex and Claude. A repository can set
`export const guard = { promptReads: 'deny' };` to block reads of existing
pending prompts; `runlist prompts show` remains the read-only inspection verb.

### Claude Code Plugin

`runlist install claude` runs the two steps below for you. From inside a session:

```text
/plugin marketplace add reowens/runlist
/plugin install runlist@runlist
```

Existing `dotmd@dotmd` installs can be migrated with `runlist install claude`
or `runlist update --plugin-only`. The command installs `runlist@runlist` and
then uninstalls the old plugin, so its hooks do not run twice.

The plugin provides SessionStart and SubagentStart orientation, a
UserPromptSubmit hint that gives the exact `runlist baton` form when you ask for
a handoff, a PreToolUse guard, the canonical workflow skill, and `/plans`,
`/docs`, `/prompts`, and `/baton` commands.

### OpenCode Plugin

`runlist install opencode` writes one plugin file into OpenCode's global config
directory, where OpenCode auto-discovers it — no `opencode.json` edit. It
supplies the two things the CLI cannot get on its own:

- **Per-session plan ownership.** OpenCode exports no session id to a tool
  shell. Without the plugin, runlist falls back to `OPENCODE_PID`, which names the
  OpenCode *process* — so every session in one OpenCode instance shares an
  identity and can release the others' in-session plans.
- **A session-start briefing**, the equivalent of Claude Code's SessionStart
  hook. OpenCode's Claude Code compatibility covers skills and the system
  prompt, not hooks, so nothing else runs `runlist hud`.
- **Prompt-read guardrails.** Recognized reads are checked before execution so
  the opt-in strict policy can stop them. Default warnings are attached to the
  result because OpenCode's before hook cannot return model context.

Restart OpenCode after installing. The generated file is `runlist.js` and is
version-stamped (`runlist-generated:`). `runlist install opencode` migrates a
generated `dotmd.js` from older releases; an unmarked file is treated as
hand-authored and is never overwritten.

The plugin requires a global CLI install because its hooks resolve `runlist` (or `dotmd`) from
`PATH`. A project devDependency is useful for npm scripts but does not put the
CLI on the hook's `PATH`.

Keep the CLI and plugin aligned with:

```bash
runlist update
runlist update --check
runlist update --cli-only
runlist update --plugin-only
```

Restart Claude Code, or run `/reload-plugins`, after a plugin update.

## Quick Start

```bash
runlist init                    # create config, docs/, and the generated index
runlist new plan auth-refresh  # scaffold a typed document
runlist plans                  # compact live plan dashboard
runlist briefing               # comprehensive active-work view
runlist check                  # validate schema, references, and lifecycle shape
runlist doctor                 # preview repairs; add --apply to write
```

`runlist plans` is the compact orientation view. `runlist briefing` lists live
plans with next steps and grows with the corpus. `runlist context` is the fuller
human/LLM briefing, while `runlist agent-context` emits bounded structured JSON for
agent integrations. Its default response is capped at 16,384 UTF-8 bytes,
including JSON formatting and the final newline. Each collection reports
`total`, `shown`, and `truncated`; `budget` reports emitted bytes. Claims, the
next pending prompt, and the first plan action are retained. If protected
information cannot fit, the command reports the required budget rather than
silently dropping it.

```bash
runlist agent-context --sections plans,prompts,counts --max-bytes 8192
runlist context --json --compact --sections plans,issues
```

Available sections are `statusVocabulary`, `counts`, `prompts`, `plans`, and
`issues`. Section selection is explicit in the response's scope. Passive
context reads continue to skip custom side effects and expensive Git history.

## Core Workflow

```bash
runlist plans
runlist use docs/plans/auth-refresh.md
runlist set awaiting docs/plans/auth-refresh.md --note "Need API owner decision"
runlist set active docs/plans/auth-refresh.md --note "Decision received"
runlist archive docs/plans/auth-refresh.md --note "Shipped and verified"
```

Use `runlist set <status> [<file>]` for lifecycle changes rather than editing a
`status:` line. It validates the status for the document type, updates history,
runs lifecycle hooks, repairs references after moves, and synchronizes the
index.

For unfinished session work, save the handoff and release the owned plan in one
operation:

```bash
runlist baton @/tmp/resume.md
```

Baton refuses when a handoff for the same work is already pending, so one piece
of work never has two resume prompts. Inspect the pending handoff with
`runlist prompts show <slug>`. Keep it if current; if stale, pass `--replace`
with a new draft. Baton archives the previous text and refreshes the pending
prompt in the same operation as any plan release.

Repositories with a commit wrapper can export `batonCommitCommand(message, paths)`
from `runlist.config.mjs` and return an argv array such as
`['just', 'commit', message, ...paths]`. Baton quotes the printed command and
excludes session prompts from `paths`.

Saved prompts are local session state. Consume them with `runlist use`; inspect
without consuming via `runlist prompts show`. Consuming a baton prompt also claims
its plan; `runlist use --no-claim` reads and archives it without starting the plan.

New plans are created `planned`; `runlist use` starts one, and
`runlist new plan <name> --status <status>` sets a different starting status.

## Document Format

```markdown
---
type: plan
status: active
updated: 2026-07-13
modules:
  - auth
surfaces:
  - backend
current_state: Token validation is complete.
next_step: Wire refresh rotation into middleware.
related_docs:
  - ./auth-design.md
---

# Auth Refresh

- [x] Validate tokens
- [ ] Rotate refresh tokens
```

`status` is the only universally required field. A `type` enables type-specific
statuses, validation, templates, and briefing behavior. Explicit frontmatter
wins, but runlist can also derive titles, summaries, state, next steps, checklist
progress, and Markdown links from the body.

Use plural `modules:` and `surfaces:` arrays. The old singular keys remain
readable for compatibility and can be migrated with `runlist lint --fix`.

### Built-In Types

| Type | Purpose | Default statuses |
|---|---|---|
| `plan` | Executable work | `in-session`, `active`, `planned`, `blocked`, `partial`, `paused`, `awaiting`, `queued-after`, `archived` |
| `doc` | Specs, ADRs, audits, and reference material | `draft`, `active`, `review`, `reference`, `deprecated`, `archived` |
| `prompt` | Saved future-session instructions | `pending`, `archived` |

Status definitions can be customized per type. Rich status objects co-locate
display, staleness, validation, terminal, and archive behavior in one place.

## Runlists And Roadmaps

A sprint runlist is an ordered `runlist:` array on a hub plan. Scaffold a hub
and children together:

```bash
runlist new plan auth-revamp --runlist extract,rewrite,cleanup
runlist runlist auth-revamp
runlist runlist next auth-revamp
```

Mutate the structure through the CLI so the array, child `parent_plan` refs, and
body order list remain synchronized:

```bash
runlist runlist add auth-revamp docs/plans/existing-plan.md
runlist runlist add auth-revamp follow-up
runlist runlist reorder auth-revamp follow-up --before cleanup
runlist runlist remove auth-revamp extract --clear-parent
```

Archived children count as complete. Parked children (`blocked`, `partial`,
`paused`, `awaiting`, and `queued-after`) are skipped when choosing the next
pickup but do not count as done.

For a larger prose-first domain map, create a coordination runlist:

```bash
runlist new plan platform-work --coordination
runlist runlists
```

`runlist new hub platform-work` makes the same coordination hub; add
`--runlist a,b,c` or `--roadmap` for the other two shapes.

For progress across several runlists, create a roadmap:

```bash
runlist new plan platform-roadmap --roadmap
runlist roadmap platform-roadmap
runlist roadmap platform-roadmap next
```

Roadmaps roll up progress recursively and choose the first startable plan across
their child runlists. Runlists and roadmaps are held out of actionable plan
counts so dashboards do not double-count their children.

## Decisions

A decision is an entry in its plan, not a document of its own. Write the record
(the situation, what exists today, what each answer leaves in place) to a file
and add it:

```bash
runlist new decision auth-revamp --question "Which token store?" @record.md
```

It takes the next id (`D1`, `D2`, …) that no decision item in that plan uses,
lands at the end of the plan's top-level decisions section (created before
`## Version History` when there is none) with a `Disposition: OPEN.` line, and
refuses an empty record. `--disposition held` parks it instead.

A corpus that indexes its decisions in one register numbers them in one
sequence. Name the register, and the id follows the highest the register or the
plan uses, and the register gets the entry's row in the same locked write:

```js
export const decisions = {
  section: 'Decisions',
  prefix: 'D',
  register: { file: 'docs/plans/register.md', statusLine: 'waiting on you:' },
};
```

The register block is the fenced block whose first line carries `statusLine`.
The row is the question plus `--answers` (what each answer leaves in place),
which is required when a register is configured.

`runlist decisions --json` gives each open or held decision its `question`,
its document's `docTitle`, and `blocks`: what its record says it blocks or
gates, then every unticked checklist item and frontmatter blocker that names
its id, alone or inside a written range (`A2 to A12`). In another document the
id has to sit beside a link to the decision's document.

## Flags

A flag is something someone found that the person should know about when they
come back: a plan that contradicts another, a decision open in one place and
ruled in another, a citation that no longer says what it claims. Any session,
person or check can add one, and no model is needed:

```bash
runlist flag add docs/plans/auth.md:42 "says tokens expire in 1h; the spec says 24h" --severity problem
runlist flags                 # open flags, problems first, newest first
runlist flag accept F3 --note "real, owner agrees"
runlist flag reject F4        # not a problem; closed
runlist flag resolve F3       # fixed
runlist check --flag          # the check's errors become flags, attributed to it
```

Each flag keeps the text of the line it points at, so the list says when that
line has moved or changed since. A repeat of an open flag on the same place is
merged. The log is append-only, `.runlist/flags.jsonl` by default
(`export const flags = { file }` moves it), and triage is recorded as events
beside the flag, never over it. Every session start shows a count and the top
open flags.

## Local model

Summaries (`--summarize`, `runlist summary`, `runlist diff --summarize`) and
lint's status inference use one local model server, Ollama by default or any
OpenAI-compatible server. runlist never starts it or pulls a model on its own:

```bash
runlist model                 # server, model, cap, free memory, what is loaded
runlist model start           # ollama serve, one model and one request at a time
runlist model measure         # record each pulled candidate's peak memory and speed here
runlist model use qwen3.5:9b  # name a model; `auto` picks the first measured one under the cap
runlist model cap 8           # most memory a model may take; `auto` is a quarter of the machine
runlist model stop            # unload it now
```

The model unloads after 5 idle minutes. Before it loads, the memory free right
now must hold it plus 1.5 GB with memory pressure normal, or the command goes
on without it. On an 8 GB machine the cap is 2 GB and model features stay off;
point `RUNLIST_MODEL_ENDPOINT` at a server on a bigger machine instead. Settings
are per machine in `~/.runlist/model.json`.

`runlist model status --json` leads with a one-line reading for dashboards,
`running`, `name` (the model loaded now, else the one runlist would load) and
`memoryMb` (what it holds, null when nothing is loaded), followed by the full
detail.

## One document's card

```bash
runlist show docs/plans/shelf.md          # title, status, next step, blockers, checklist, related, links
runlist show shelf bins --json            # [{ path, title, status, nextStep, blockers, checklist,
                                          #    related: [{ field, path, title, status }], links: [...] }]
```

Read-only: nothing is claimed. `related` is what the frontmatter names
(`related_plans`, `related_docs`, `supports_plans`, `parent_plan`, `runlist` and
the configured reference fields), each with its title and status; `links` is
every other document the body links to.

## Failed commands

Every runlist command that fails, by an error or a non-zero exit, appends one
line to `~/.claude/logs/runlist-errors.log` (`RUNLIST_ERROR_LOG_DIR` moves it)
with the time, the command with secrets redacted, and the error's one-line
message. It rotates at 5 MB, a new runlist version, or 30 days of active
history, retaining up to eight numbered backups for 30 days. Readers include
the retained backups. Dry runs and the session-start `hud` are never logged.

```bash
runlist errors                # the newest 20 failures, newest first
runlist errors --limit 50     # the newest N
runlist errors --json         # [{ at, command, message, repo, exit }]
runlist errors --by-family --json  # validation, unknown-command, conflicts, exceptions
```

Validation findings remain non-zero results and remain in the raw chronological
view. Grouping distinguishes those findings from command errors and unexpected
exceptions. Failed `xref --check` entries include the first finding's file,
line, and message.

The repository invocation journal remains opt-in through
`export const journal = true;` in config or `RUNLIST_JOURNAL=1`. It uses the same retention policy.
Top-level and per-command help calls record their topic and outcome without
authored arguments. Use `runlist journal --help-topics --json` to see topic,
session, version, and retained invocation counts. These denominators cover the
retained opt-in window; passive context, HUD, dry runs, disabled journaling,
and pruned history are excluded. They are not machine-wide usage rates.

## Safety Model

- Mutation commands support `--dry-run` / `-n`.
- Managed writes are confined to configured document roots.
- Lifecycle and multi-file moves use atomic, conflict-aware mutation paths.
- Session ownership is durable local state, not inferred from telemetry.
- Passive orientation commands do not mutate repository state.
- Repository paths in machine and human output use stable slash-normalized
  identities across supported operating systems.

## Command Reference

The CLI is the source of truth for command syntax and options:

```bash
runlist --help
runlist help all
runlist help statuses
runlist <command> --help
```

Shell completion is generated from the same command registry:

```bash
eval "$(runlist completions bash)"
eval "$(runlist completions zsh)"
```

This README intentionally documents onboarding and concepts instead of
duplicating the complete command catalog.

## Configuration

Run `runlist init` to create `runlist.config.mjs` (a legacy `dotmd.config.mjs` is still read). A minimal typed configuration:

```js
export const root = 'docs';
export const archiveDir = 'archived';

export const types = {
  plan: {
    statuses: {
      'in-session': { context: 'expanded', staleDays: 1 },
      active: { context: 'expanded', staleDays: 14 },
      planned: { context: 'listed', staleDays: 30 },
      archived: {
        context: 'counted',
        archive: true,
        terminal: true,
        skipStale: true,
        skipWarnings: true,
      },
    },
  },
};
```

### Code references

Archive and rename repair every reference inside the doc roots. `codeRoots`
extends that to source files that cite a document by its repo-relative path in
a comment, a docstring or a string literal:

```js
export const codeRoots = ['packages', 'scripts', 'services'];
export const codeRefsUntouched = ['scripts/guards/plan-baseline.json'];
```

`runlist refs <old> <new>` reports every citation by file and line and writes
only on `--fix`; `runlist refs repair` does the same for every archived
document still cited at its previous path. Archive and rename print the count
afterwards and take `--fix-refs`. Only the full repo-relative path matches,
never a bare basename, and only that segment is replaced, so a trailing `§` or
`#` anchor survives. A citation inside a string literal waits for `--strings`,
a file in `codeRefsUntouched` is never written, and with no `codeRoots` set
nothing is scanned.

Configuration supports multiple roots, custom types and templates, taxonomy,
reference fields, presets, rendering, lifecycle hooks, validation hooks, and
AI summarization hooks. See [`runlist.config.example.mjs`](runlist.config.example.mjs)
for the complete annotated reference.

## Hooks

Functions exported from `runlist.config.mjs` are detected as hooks. They can add
validation, customize rendering and summaries, or react to lifecycle events.
Hooks receive the resolved config and command context; mutation hooks participate
in the command's dry-run and failure contracts.

## License

MIT
