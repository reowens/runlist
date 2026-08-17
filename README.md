# dotmd

CLI for managing Markdown documents with YAML frontmatter.

dotmd indexes, queries, validates, graphs, exports, and lifecycle-manages plans,
ADRs, RFCs, design docs, and other structured Markdown. It is built for
AI-assisted development workflows where documents need to remain current and
safe to mutate.

- Zero runtime dependencies
- Node.js 20 or newer
- Runtime support for Linux, macOS, and Windows
- Type-aware lifecycle rules for plans, docs, and saved prompts

## Install

```bash
npm install -g dotmd-cli    # global CLI and Claude Code plugin hooks
npm install -D dotmd-cli    # project scripts via node_modules/.bin
npx dotmd-cli init          # try it without installing
```

Maintainer release automation is POSIX-only because it uses Bash and POSIX
command-line tools. The published Node.js CLI remains cross-platform.

### Agent host setup

The CLI alone gives an agent no orientation and no session identity. Install the
integration for whichever host you run:

```bash
dotmd install             # what's installed for each host
dotmd install claude      # Claude Code plugin (marketplace + plugin)
dotmd install opencode    # OpenCode plugin (one auto-discovered file)
dotmd doctor --session    # what identity dotmd sees here, and from where
```

Both are one-time and global; `dotmd update` keeps them in step with the CLI.

### Claude Code Plugin

`dotmd install claude` runs the two steps below for you. From inside a session:

```text
/plugin marketplace add reowens/dotmd
/plugin install dotmd@dotmd
```

The plugin provides SessionStart and SubagentStart orientation, a PreToolUse
guard, the canonical workflow skill, and `/plans`, `/docs`, `/prompts`, and
`/baton` commands.

### OpenCode Plugin

`dotmd install opencode` writes one plugin file into OpenCode's global config
directory, where OpenCode auto-discovers it — no `opencode.json` edit. It
supplies the two things the CLI cannot get on its own:

- **Per-session plan ownership.** OpenCode exports no session id to a tool
  shell. Without the plugin, dotmd falls back to `OPENCODE_PID`, which names the
  OpenCode *process* — so every session in one OpenCode instance shares an
  identity and can release the others' in-session plans.
- **A session-start briefing**, the equivalent of Claude Code's SessionStart
  hook. OpenCode's Claude Code compatibility covers skills and the system
  prompt, not hooks, so nothing else runs `dotmd hud`.

Restart OpenCode after installing. The file is version-stamped; a `dotmd.js`
without that stamp is treated as hand-authored and is never overwritten.

The plugin requires a global CLI install because its hooks resolve `dotmd` from
`PATH`. A project devDependency is useful for npm scripts but does not put the
CLI on the hook's `PATH`.

Keep the CLI and plugin aligned with:

```bash
dotmd update
dotmd update --check
dotmd update --cli-only
dotmd update --plugin-only
```

Restart Claude Code, or run `/reload-plugins`, after a plugin update.

## Quick Start

```bash
dotmd init                    # create config, docs/, and the generated index
dotmd new plan auth-refresh  # scaffold a typed document
dotmd briefing               # compact active-work orientation
dotmd plans                  # live plan dashboard
dotmd check                  # validate schema, references, and lifecycle shape
dotmd doctor                 # preview repairs; add --apply to write
```

`dotmd briefing` is the compact orientation view. `dotmd context` is the fuller
human/LLM briefing, while `dotmd agent-context` emits bounded structured JSON for
agent integrations.

## Core Workflow

```bash
dotmd briefing
dotmd use docs/plans/auth-refresh.md
dotmd set awaiting docs/plans/auth-refresh.md --note "Need API owner decision"
dotmd set active docs/plans/auth-refresh.md --note "Decision received"
dotmd archive docs/plans/auth-refresh.md --note "Shipped and verified"
```

Use `dotmd set <status> [<file>]` for lifecycle changes rather than editing a
`status:` line. It validates the status for the document type, updates history,
runs lifecycle hooks, repairs references after moves, and synchronizes the
index.

For unfinished session work, save the handoff and release the owned plan in one
operation:

```bash
dotmd baton @/tmp/resume.md
```

Saved prompts are local session state. Consume them with `dotmd use`; inspect
without consuming via `dotmd prompts show`.

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
wins, but dotmd can also derive titles, summaries, state, next steps, checklist
progress, and Markdown links from the body.

Use plural `modules:` and `surfaces:` arrays. The old singular keys remain
readable for compatibility and can be migrated with `dotmd lint --fix`.

### Built-In Types

| Type | Purpose | Default statuses |
|---|---|---|
| `plan` | Executable work | `in-session`, `active`, `planned`, `blocked`, `partial`, `paused`, `awaiting`, `queued-after`, `archived` |
| `doc` | Specs, ADRs, audits, and reference material | `draft`, `active`, `review`, `reference`, `deprecated`, `archived` |
| `prompt` | Saved future-session instructions | `pending`, `held`, `shelved`, `claimed`, `archived` |

Status definitions can be customized per type. Rich status objects co-locate
display, staleness, validation, terminal, and archive behavior in one place.

## Runlists And Roadmaps

A sprint runlist is an ordered `runlist:` array on a hub plan. Scaffold a hub
and children together:

```bash
dotmd new plan auth-revamp --runlist extract,rewrite,cleanup
dotmd runlist auth-revamp
dotmd runlist next auth-revamp
```

Mutate the structure through the CLI so the array, child `parent_plan` refs, and
body order list remain synchronized:

```bash
dotmd runlist add auth-revamp docs/plans/existing-plan.md
dotmd runlist add auth-revamp follow-up
dotmd runlist reorder auth-revamp follow-up --before cleanup
dotmd runlist remove auth-revamp extract --clear-parent
```

Archived children count as complete. Parked children (`blocked`, `partial`,
`paused`, `awaiting`, and `queued-after`) are skipped when choosing the next
pickup but do not count as done.

For a larger prose-first domain map, create a coordination runlist:

```bash
dotmd new plan platform-work --coordination
dotmd runlists
```

For progress across several runlists, create a roadmap:

```bash
dotmd new plan platform-roadmap --roadmap
dotmd roadmap platform-roadmap
dotmd roadmap platform-roadmap next
```

Roadmaps roll up progress recursively and choose the first startable plan across
their child runlists. Runlists and roadmaps are held out of actionable plan
counts so dashboards do not double-count their children.

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
dotmd --help
dotmd help all
dotmd help statuses
dotmd <command> --help
```

Shell completion is generated from the same command registry:

```bash
eval "$(dotmd completions bash)"
eval "$(dotmd completions zsh)"
```

This README intentionally documents onboarding and concepts instead of
duplicating the complete command catalog.

## Configuration

Run `dotmd init` to create `dotmd.config.mjs`. A minimal typed configuration:

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

Configuration supports multiple roots, custom types and templates, taxonomy,
reference fields, presets, rendering, lifecycle hooks, validation hooks, and
AI summarization hooks. See [`dotmd.config.example.mjs`](dotmd.config.example.mjs)
for the complete annotated reference.

## Hooks

Functions exported from `dotmd.config.mjs` are detected as hooks. They can add
validation, customize rendering and summaries, or react to lifecycle events.
Hooks receive the resolved config and command context; mutation hooks participate
in the command's dry-run and failure contracts.

## License

MIT
