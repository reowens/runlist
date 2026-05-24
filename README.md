# dotmd

CLI for managing markdown documents with YAML frontmatter.

Index, query, validate, and lifecycle-manage any collection of `.md` files — plans, ADRs, RFCs, design docs, meeting notes. Built for AI-assisted development workflows where structured docs need to stay current.

## Install

```bash
npm install -g dotmd-cli    # global — use `dotmd` anywhere
npm install -D dotmd-cli    # project devDep — use via npm scripts
# requires Node.js >= 20
```

## Quick Start

```bash
dotmd init                  # creates dotmd.config.mjs, docs/, docs/docs.md
dotmd new my-feature        # scaffold a new doc with frontmatter
dotmd list                  # index all docs grouped by status
dotmd check                 # validate frontmatter and references
dotmd context               # compact briefing (great for LLM context)
dotmd doctor                # auto-fix everything in one pass
```

### Shell Completion

```bash
# bash
eval "$(dotmd completions bash)"    # add to ~/.bashrc

# zsh
eval "$(dotmd completions zsh)"     # add to ~/.zshrc
```

## Auto-Detected From Your Markdown

dotmd reads what's already in your `.md` files — you don't have to migrate everything into frontmatter to get useful output.

Add `- [ ]` checkboxes anywhere in the body:

```markdown
## Polish

- [x] Index regen on every mutation
- [x] Auto-checklist progress bars
- [x] Untagged docs surfaced in `list`
- [ ] SessionStart hook auto-wired by init
- [ ] Bulk-tag prompt for brownfield repos
```

`dotmd list` picks them up — zero config, no extra field:

```
Polish-Pass                   2d  ██████░░░░ 3/5
```

Same story for these signals, each picked up from body text when the matching frontmatter field is missing:

| Field | Falls back to | Example body |
|-------|---------------|--------------|
| `title` | first `# H1` heading | `# Auth Token Refresh` |
| `summary` | first `> blockquote` line (skipping `Status note` lines) | `> One-line summary of what this doc covers.` |
| `current_state` | `**Status:** ...`, `- Status: ...`, or `> Status note (...): ...` lines (skipped on terminal docs to avoid stale claims) | `**Status:** Phase 2 underway` |
| `next_step` | first bullet under a `## Next Step` (or `## Suggested Next Step`) H2 section | `## Next Step`<br>`- wire token refresh into middleware` |
| Body links | inline `[text](path.md)` references | validated as ref edges by `check` |

Explicit frontmatter always wins. Body extraction is a cushion for partially-tagged docs, not a replacement for it.

## What It Does

- **Index** — group docs by status, with auto-detected progress bars (from `- [ ]` checklists) and next steps
- **Query** — filter by status, keyword, module, surface, owner, staleness
- **Validate** — check for missing fields, broken references, broken body links, stale dates
- **Stats** — health dashboard with staleness, completeness, audit coverage
- **Graph** — visualize document relationships as text, Graphviz DOT, or JSON
- **Deps** — dependency tree or overview of what blocks what
- **Unblocks** — impact analysis: what depends on a doc
- **Health** — plan velocity, aging, pipeline status
- **Glossary** — domain term lookup with related docs
- **Lifecycle** — transition statuses, auto-archive with `git mv` and reference updates
- **Doctor** — auto-fix broken refs, lint issues, date drift, and stale indexes in one pass
- **Scaffold** — create new docs from templates (plan, ADR, RFC, audit, design)
- **AI summaries** — summarize docs via local MLX model or custom hook
- **Export** — generate concatenated markdown, static HTML site, or JSON bundle
- **Notion** — import from, export to, and bidirectionally sync with Notion databases
- **Multi-root** — manage docs across multiple directories with a single config
- **Context briefing** — compact summary designed for AI/LLM consumption
- **Dry-run** — preview any mutation with `--dry-run` before committing

## Document Format

Any `.md` file with YAML frontmatter:

```markdown
---
type: doc
status: active
updated: 2026-03-14
module: auth
surface: backend
next_step: implement token refresh
current_state: initial scaffolding complete
related_plans:
  - ./design-doc.md
---

# Auth Token Refresh

Design doc content here...

- [x] Research existing patterns
- [ ] Implement refresh logic
- [ ] Add tests
```

The only required field is `status`. Everything else is optional but unlocks more features. The `type` field (`plan`, `doc`, or `research`) enables type-specific statuses and smarter context briefings.

## Document Types

Every document can have a `type` field in its frontmatter. Types determine which statuses are valid and how the document appears in context briefings.

| Type | Purpose | Valid Statuses |
|------|---------|----------------|
| `plan` | Execution plans | `in-session`, `active`, `planned`, `blocked`, `partial`, `paused`, `awaiting`, `queued-after`, `archived` |
| `doc` | Design docs, specs, ADRs, RFCs, reference material | `draft`, `active`, `review`, `reference`, `deprecated`, `archived` |
| `prompt` | Saved prompts that seed future Claude sessions | `pending`, `claimed`, `archived` |

Documents without a `type` field use the global `statuses.order` from config.

`dotmd new <type> <name>` sets the `type:` field automatically (`plan`, `doc`, or `prompt`).

Filter by type with `--type`:

```bash
dotmd query --type plan --status active   # active plans
dotmd list --type doc                     # all docs
dotmd export --type prompt                # export only saved prompts
```

Customize types and their statuses in config with the `types` key. See [`dotmd.config.example.mjs`](dotmd.config.example.mjs).

### What each plan status means

The default plan vocabulary is shaped around the **unstuck-action test**: every stop-status should map to a distinct next move. If two statuses have the same unstuck-action, one is dead weight; if a single status covers several different actions, it's overloaded.

| Status | Unstuck-action | When to use |
|--------|----------------|-------------|
| `in-session` | — | A Claude session is working on it right now. Don't pick up. |
| `active` | Pick up | Ready to be worked on. |
| `planned` | Wait for trigger | Queued; not yet ready to execute. |
| `blocked` | **Monitor** | External arrival on its own schedule (hardware, vendor, third-party rollout). You can't speed it up. |
| `partial` | **Spawn successors** | Shipped most of the plan; tail deferred. Body should reference successor plans tracking the tail. Visible but quiet (no nagging). |
| `paused` | **Re-evaluate** | Started but stopped mid-work; needs near-term review. NOT quiet — short (3-day) stale threshold so resume-decisions don't decay. |
| `awaiting` | **Ask** | Needs a human decision or input. NOT quiet — pings get forgotten, so this status generates stale pressure to chase the answer. |
| `queued-after` | **Check predecessor** | Sequenced behind another plan; can start once that one ships. Quiet. |
| `archived` | — | No longer relevant; auto-moved to the archive directory on transition. |

Each *quiet* status (`partial`, `queued-after`, `archived`) is exempt from stale-warning pressure but still appears in active scope and metrics — quietness is a presentation flag, not a closure flag. `awaiting` and `paused` deliberately stay loud so unanswered questions and stalled mid-flight work don't decay into invisible backlog.

> **Heads-up:** versions before 0.15 included a `done` plan status in the defaults. It saw effectively zero real-world use (plans went `in-session`/`active` → `archived` directly), so it was dropped from the built-in vocabulary. To finish a plan, run `dotmd archive <plan-file>` — or, if you preferred the previous behavior, add `done` back via the `types.plan.statuses` key in your config.

## Commands

```
dotmd list [--verbose]       List docs grouped by status (default)
dotmd json                   Full index as JSON
dotmd check [flags]          Validate frontmatter and references
dotmd coverage [--json]      Metadata coverage report
dotmd stats [--json]         Doc health dashboard
dotmd graph [--dot|--json]   Visualize document relationships
dotmd deps [file]            Dependency tree or overview
dotmd unblocks <file>        Show what depends on this doc
dotmd health [--json]        Plan velocity, aging, and pipeline
dotmd briefing               Compact summary for session start
dotmd context [--summarize]  Full briefing (LLM-oriented)
dotmd focus [status]         Detailed view for one status group
dotmd query [filters]        Filtered search
dotmd plans                  List all plans
dotmd stale                  List stale docs
dotmd actionable             List docs with next steps
dotmd index [--write]        Generate/update docs.md index block
dotmd hud                    Actionable triage (silent when clean — ideal SessionStart hook)
dotmd pickup <file>          Pick up a plan (in-session + print body)
dotmd release [<file>]       Release in-session lease (alias: unpickup)
dotmd status <file> <status> Transition document status
dotmd archive <file>         Archive (status + move + update refs)
dotmd bulk archive <files>   Archive multiple files at once
dotmd touch <file>           Bump updated date
dotmd touch --git            Bulk-sync dates from git history
dotmd doctor                 Auto-fix everything in one pass
dotmd fix-refs               Auto-fix broken reference paths
dotmd lint [--fix]           Check and auto-fix frontmatter issues
dotmd rename <old> <new>     Rename doc and update references
dotmd migrate <f> <old> <new>  Batch update a frontmatter field
dotmd notion <sub> [db-id]   Notion import/export/sync
dotmd export [file]          Export docs as md, html, or json
dotmd summary <file>         AI summary of a document
dotmd glossary <term>        Look up domain terms + related docs
dotmd watch [command]        Re-run a command on file changes
dotmd diff [file]            Show changes since last updated date
dotmd new <type> <name>      Create a new doc (type: doc, plan, or prompt)
dotmd prompts [sub]          List, claim, or archive saved prompts
dotmd init                   Create starter config + docs directory
dotmd completions <shell>    Output shell completion script (bash, zsh)
```

### Global Flags

```
--config <path>        Explicit config file path
--dry-run, -n          Preview changes without writing anything
--root <name>          Filter to a specific docs root
--type <t1,t2>         Filter by document type (plan, doc, research)
--verbose              Show resolved config details
--help, -h             Show help (per-command with: dotmd <cmd> --help)
--version, -v          Show version
```

### Query Filters

```bash
dotmd query --status active,ready --module auth
dotmd query --keyword "token" --has-next-step
dotmd query --stale --sort updated --all
dotmd query --surface backend --checklist-open
dotmd query --status active --summarize             # AI summaries
dotmd query --status active --summarize --summarize-limit 3
```

Flags: `--type`, `--status`, `--keyword`, `--module`, `--surface`, `--domain`, `--owner`, `--updated-since`, `--stale`, `--has-next-step`, `--has-blockers`, `--checklist-open`, `--sort`, `--limit`, `--all`, `--git`, `--json`, `--summarize`, `--summarize-limit`, `--model`.

### Create Documents

The signature is `dotmd new <type> <name> [body]`. `<type>` is one of the built-in types (`doc`, `plan`, `prompt`) or a custom type from your config. If you omit `<type>`, it defaults to `doc`.

```bash
dotmd new plan auth-revamp                    # type: plan → docs/plans/auth-revamp.md
dotmd new doc token-refresh-design            # type: doc → docs/token-refresh-design.md
dotmd new my-feature                          # implicit type: doc
dotmd new plan auth --status planned          # initial status override
dotmd new doc my-doc --title "Custom Title"   # title override
dotmd new doc my-doc --root modules           # create in a specific root
dotmd new --list-types                        # show registered types
```

Each built-in type has a template baked in:

| Type | Default destination | Shape |
|------|---------------------|-------|
| `plan` | `docs/plans/<slug>.md` | Problem → Phases → Closeout, with phase status markers and Version History |
| `doc` | `docs/<slug>.md` | Overview → Version History → Related (build-up shape lite) |
| `prompt` | `docs/prompts/<slug>.md` | Body is required (see [Saved Prompts](#saved-prompts)) |

Add custom types via `templates` in your config:

```js
export const templates = {
  spike: {
    description: 'Timeboxed investigation',
    defaultStatus: 'active',
    targetRoot: 'spikes',  // in flat-array root configs, lands in the matching root
    dir: 'spikes',          // in single-root configs, creates docs/spikes/<slug>.md
    frontmatter: (status, today) => `type: spike\nstatus: ${status}\nupdated: ${today}\ntimebox: 2d`,
    body: (title) => `\n# ${title}\n\n## Hypothesis\n\n\n\n## Findings\n\n\n`,
  },
};
```

Then `dotmd new spike my-spike` creates a doc from your template.

**Routing your custom type to a directory.** Two knobs:

- `targetRoot: '<name>'` — name (basename or suffix) of a root entry. In configs with `root: ['docs/plans', 'docs/spikes', ...]` (flat-array layout), the new doc lands in the matching root.
- `dir: '<subdir>'` — subdirectory under `config.docsRoot`. Used as the fallback when `targetRoot` doesn't match anything (typical single-root layout).

Set both for portability. The `--root` CLI flag overrides both. **Overrides do not inherit builtin properties** — if you override `templates.prompt`, re-declare `targetRoot`, `dir`, `defaultStatus`, `requiresBody`, etc. that you want preserved.

### Saved Prompts

Saved prompts are `.md` files with `type: prompt` that capture a request meant to seed a future Claude session — "look at the remaining lint warnings tomorrow," "resume the payments refactor," "draft the on-call runbook." The body is the prompt; the frontmatter tracks status.

```bash
dotmd new prompt cleanup-tomorrow "look at remaining lint warnings"
dotmd new prompt resume-foo - <<'EOF'
multi-line
prompt body
EOF
dotmd new prompt from-file @/tmp/draft.md
```

Manage them with the `prompts` command family:

```bash
dotmd prompts                     # list pending prompts (default)
dotmd prompts list --all          # all statuses
dotmd prompts next                # show + claim the oldest pending prompt (prints body)
dotmd prompts use <file>          # claim a specific prompt (prints body, flips to claimed)
dotmd prompts archive <file>      # archive a prompt
dotmd prompts new <name> [body]   # alias for `dotmd new prompt`
```

`dotmd hud` surfaces pending prompts on session start (alongside held leases), so a saved prompt acts as a self-addressed reminder: write it now, the next session sees it.

Statuses: `pending` (drafted, awaiting a session), `claimed` (consumed by a session), `archived`.

### Check & Fix

```bash
dotmd check                  # validate everything
dotmd check --errors-only    # suppress warnings, show only errors
dotmd check --fix            # auto-fix broken refs + lint + regen index
```

Validates: required fields, status values, broken reference paths, broken body links (`[text](path.md)`), bidirectional reference symmetry, git date drift, taxonomy mismatches.

### Stats

```bash
dotmd stats                  # health dashboard
dotmd stats --json           # machine-readable
```

Shows: status counts, staleness, errors/warnings, freshness (today/week/month), completeness (owner/surface/module/next_step), checklist progress, audit coverage.

### Doctor

```bash
dotmd doctor                 # fix refs → lint → sync git dates → regen index
dotmd doctor --dry-run       # preview all changes
dotmd doctor --statuses      # detect overloaded status buckets (read-only)
dotmd doctor --statuses --json  # machine-readable suggestions
```

`--statuses` is a read-only diagnostic. It scans each status with at least
10 plans and groups their `current_state` / `next_step` text against cue
keywords for `partial`, `paused`, `awaiting`, `queued-after`, and `blocked`.
When a single bucket lands plans in two or more cue groups (each above 15%
of the bucket), it prints a split suggestion:

```
47 plan/backlog plans cluster across 4 patterns — consider splitting:
  ~22 → partial       (cues: "shipped", "landed", "tail", "deferred")
  ~15 → paused        (cues: "paused", "on hold", "set aside")
  ~ 6 → queued-after  (cues: "after", "once", "depends on", "waiting on <plan>")
  ~ 4 →               (kept in backlog — no clear pattern match)

Heuristic — verify before migrating.
```

The heuristic is intentionally conservative: small buckets are skipped, plans
that match no cues stay in the original bucket, and the output is always a
suggestion — never a verdict.

### Graph

```bash
dotmd graph                              # text adjacency list
dotmd graph --dot | dot -Tpng -o g.png   # Graphviz PNG
dotmd graph --json                       # machine-readable
dotmd graph --status active,ready        # filter by status
dotmd graph --module auth                # filter by module
```

### Deps

```bash
dotmd deps                               # overview: most blocking, most blocked
dotmd deps docs/plan-a.md                # tree: depends-on + depended-on-by
dotmd deps docs/plan-a.md --depth 2      # limit tree depth
dotmd deps --json                        # machine-readable
```

### Unblocks

```bash
dotmd unblocks docs/plan-a.md            # what depends on this plan
dotmd unblocks docs/plan-a.md --json     # machine-readable
```

### Health

```bash
dotmd health                             # plan pipeline and aging
dotmd health --json                      # machine-readable
```

### Briefing

```bash
dotmd briefing                           # compact 5-10 line summary
dotmd briefing --json                    # machine-readable
```

### AI Summaries

```bash
dotmd summary docs/plan-a.md             # AI summary of a single doc
dotmd summary docs/plan-a.md --json      # JSON output
dotmd query --status active --summarize  # AI summaries in query results
dotmd context --summarize                # AI-enhanced briefing
```

Uses a local model by default. Override with `--model <name>` or the `summarizeDoc` hook.

### Glossary

```bash
dotmd glossary "auth token"              # look up a term
dotmd glossary --list                    # list all terms
dotmd glossary --json                    # machine-readable
```

### Export

```bash
dotmd export                             # all docs as concatenated markdown
dotmd export --format html --output site # static HTML site
dotmd export --format json > bundle.json # JSON bundle with bodies
dotmd export docs/plan-a.md              # single doc + dependencies
dotmd export --status active             # filtered export
dotmd export --type plan                 # export only plans
```

### Notion Integration

```bash
dotmd notion import <database-id>        # pull Notion database → local .md files
dotmd notion export <database-id>        # push local docs → Notion database
dotmd notion sync <database-id>          # bidirectional sync (newer wins)
dotmd notion import <db-id> --force      # overwrite existing files
dotmd notion sync <db-id> --dry-run      # preview sync actions
```

Requires `NOTION_TOKEN` env var or `notion.token` in config. Maps Notion properties (select, multi_select, date, status, people, etc.) to YAML frontmatter fields. Configure property mapping in config:

```js
export const notion = {
  token: process.env.NOTION_TOKEN,
  database: 'your-database-id',
  propertyMap: {
    'Status': 'status',
    'Last Updated': 'updated',
    'Tags': 'surfaces',
  },
};
```

### Multi-Root

Manage docs across multiple directories:

```js
export const root = ['docs/plans', 'docs/modules', 'docs/app'];
```

All commands work across all roots. Filter with `--root`:

```bash
dotmd list --root plans                  # only docs from docs/plans
dotmd stats --root modules               # stats for modules only
dotmd new my-doc --root modules          # create in docs/modules
```

Archive stays within the source file's root. Cross-root references validate correctly.

### Archive

```bash
dotmd archive docs/old-plan.md           # move + update refs + regen index
dotmd archive docs/old-plan.md -n        # preview
```

### Bulk Archive

```bash
dotmd bulk archive docs/old-a.md docs/old-b.md   # archive multiple
dotmd bulk archive docs/old-*.md -n               # preview
```

### Pickup & Closeout

```bash
dotmd pickup docs/plans/my-plan.md       # set in-session + print body
dotmd archive docs/plans/my-plan.md      # fully shipped: archive + auto-release lease
dotmd release docs/plans/my-plan.md      # need more work: release lease, flip to prior status
dotmd status docs/plans/my-plan.md partial   # shipped + tail deferred (reference successors in body)
dotmd status docs/plans/my-plan.md awaiting  # stuck on a human decision
```

`finish` is a legacy command that defaults to `status: done`, which is no longer in the default plan vocabulary as of 0.16. Use `archive` (fully shipped) or `release` + `status` (anything else). If you need it back, add `done` to `types.plan.statuses` in your config.

### Session leases & release

`dotmd pickup` records a lease at `<repoRoot>/.dotmd/in-session.json` that
identifies which Claude session owns the plan. The lease enables three
distinct outcomes when a plan is already `in-session`:

- **Same session re-attach.** A fresh `dotmd pickup` of a plan you already
  hold (e.g., after `/clear` or auto-compaction) silently re-attaches and
  re-prints the body. No conflict.
- **Cross-session conflict.** If another live session holds the plan,
  pickup refuses with `Held by <host>/<session> (pid <pid>) since <time>`.
- **Stale lease.** If the holder's pid is dead (or the lease is >24h old),
  pickup refuses but suggests `--takeover`.

Releasing leases (both names work; `release` is the recommended verb):

```bash
dotmd release                     # release every lease owned by current session
dotmd release docs/plans/foo.md   # release that one (refuses cross-session)
dotmd release --to planned        # override target status (default: lease.oldStatus)
dotmd release --stale             # release leases with dead pid or >24h old
dotmd release --all               # release every lease (administrative)
dotmd release --json              # { released: [...], skipped: [...] }
```

`finish`, `archive`, and `rename` auto-release / migrate the lease, so the
common closeout paths are covered without ceremony.

**Session id resolution** (in order, first wins):

1. `$CLAUDE_CODE_SESSION_ID` (set by Claude Code in Bash subprocess env)
2. `$CLAUDE_SESSION_ID` (legacy alias)
3. `$TERM_SESSION_ID` (macOS Terminal/iTerm — stable per window)
4. `shell:<user>@<host>` (last-resort coarse fallback)

The session id survives `/clear` and auto-compaction, so a re-attach after
either is silent.

**Recommended Claude Code hooks** — add both to `~/.claude/settings.json`
(or your project's `.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "dotmd hud", "timeout": 5 }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "dotmd release", "timeout": 10 }
        ]
      }
    ]
  }
}
```

- **SessionStart** runs `dotmd hud`, which prints up to three actionable
  lines (held leases, pending prompts, stale leases) and stays silent when
  nothing is queued. Use this instead of `dotmd briefing` for the hook role
  — `briefing` dumps per-plan next_step prose that can run to many kilobytes
  on large repos. `hud` is the zero-pollution surface.
- **SessionEnd** runs `dotmd release` (the new name for `dotmd unpickup`;
  both still work), which releases every lease owned by the ending session
  and flips plans back to their prior status.

> The double-`hooks` nesting is correct: `hooks.<Event>[*].hooks[*]` is the
> schema Claude Code requires. `Bash(dotmd:*)` should be in your
> `permissions.allow` list as well, otherwise the hooks will be blocked.

`dotmd hud` (and `dotmd briefing` for the verbose case) surface a
`⚠ N stuck leases` line when stale leases exist, with a
`dotmd release --stale` suggestion.

### Touch

```bash
dotmd touch docs/my-doc.md              # set updated to today
dotmd touch --git                        # bulk-sync all docs from git history
```

### Fix References

```bash
dotmd fix-refs                           # fix broken frontmatter refs + body links
dotmd fix-refs --dry-run                 # preview fixes
```

### Lint

```bash
dotmd lint                   # report issues
dotmd lint --fix             # fix all issues
```

### Manage Statuses

```bash
dotmd statuses                                              # table view, all types
dotmd statuses --type plan                                  # one type
dotmd statuses --json                                       # machine-readable

dotmd statuses add paused --type plan --like blocked --quiet  # clone blocked, then quiet
dotmd statuses set archived --type plan --no-quiet            # tweak a flag
dotmd statuses remove obsolete --type plan                    # refuses if any docs use it

dotmd statuses migrate plan                                 # array-form → rich-form
```

`--like <existing>` is the affordance for "kinda like X but…" — clones every
flag from another status, then user flags override. Write commands print a flag
diff and prompt for confirmation; pass `--yes` to skip the prompt or
`--dry-run` to preview without writing. Edits are atomic: the rewrite lands in
a sibling temp file, is validated by re-importing it and running
`resolveConfig`, then renamed into place — a syntax error or new warning
leaves the original untouched.

**Lifecycle-override gotcha.** If your config has both rich-form `types` and an
explicit `export const lifecycle = {...}`, the explicit lifecycle silently
overrides per-status flags at runtime. `dotmd statuses` write commands refuse
to write into that state and recommend deleting the explicit `lifecycle` block;
pass `--ignore-lifecycle-override` to write anyway.

### Rename

```bash
dotmd rename old-name.md new-name        # renames + updates refs
```

### Migrate

```bash
dotmd migrate status research scoping       # rename a status (e.g. for the 0.15 default-vocab change)
dotmd migrate module auth identity           # rename a module

# Per-file form: split one overloaded status into several distinct ones.
# Only the listed files are rewritten; every other doc with the old value is left alone.
dotmd migrate status backlog paused docs/plans/foo.md docs/plans/bar.md
dotmd migrate status backlog partial docs/plans/payments-future.md  # one at a time also works
```

With no file args, `migrate` rewrites every doc whose field matches
`<old-value>` (whole-bucket rename). Pass file args to scope the
rewrite — useful when one status has been doing several jobs and you
want to split it across the new vocabulary. File args match the same
way as `bulk archive`: exact path first, then substring fallback
against full path or basename.

### Preset Aliases

Built-in presets: `plans`, `stale`, `actionable`. Add your own in config:

```js
export const presets = {
  mine: ['--owner', 'robert', '--status', 'active', '--all'],
  blocked: ['--status', 'blocked', '--all'],
};
```

Then run `dotmd mine` or `dotmd blocked` as shorthand. All presets support query flags (`--json`, `--sort`, etc.).

### Watch Mode

```bash
dotmd watch              # re-run list on every .md change
dotmd watch check        # live validation
dotmd watch context      # live briefing
```

### Diff & Summarize

```bash
dotmd diff                           # all drifted docs
dotmd diff docs/plans/auth.md        # single file
dotmd diff --stat                    # summary stats only
dotmd diff --summarize               # AI summary via local MLX model
```

### Init Auto-Detect

When `dotmd init` runs in a directory with existing `.md` files, it scans them and pre-populates the config with discovered statuses, surfaces, modules, and reference fields.

## Configuration

Create `dotmd.config.mjs` at your project root (or run `dotmd init`).

### Rich status definitions (recommended)

Define each status as an object that co-locates all behavioral properties. Adding a new status is one line in one place — no need to update separate `lifecycle`, `staleDays`, `context`, or `taxonomy` sections.

```js
export const root = 'docs/plans';
export const archiveDir = 'archived';

export const types = {
  plan: {
    statuses: {
      'active':   { context: 'expanded', staleDays: 14, requiresModule: true },
      'planned':  { context: 'listed', staleDays: 30, requiresModule: true },
      'blocked':  { context: 'listed', staleDays: 30, skipStale: true },
      'archived': { context: 'counted', archive: true, terminal: true, skipStale: true, skipWarnings: true },
    },
  },
};
```

**Status properties:**

| Property | Type | Default | Effect |
|---|---|---|---|
| `context` | `'expanded'` \| `'listed'` \| `'counted'` | `'counted'` | Display mode in `dotmd context` |
| `staleDays` | `number` \| `null` | `null` | Days before doc is stale (`null` = never) |
| `requiresModule` | `boolean` | `false` | Require `module` in frontmatter |
| `terminal` | `boolean` | `false` | Skip `current_state`/`next_step` warnings |
| `archive` | `boolean` | `false` | Auto-move to `archiveDir` on transition |
| `skipStale` | `boolean` | `false` | Exempt from stale checks |
| `skipWarnings` | `boolean` | `false` | Exempt from validation warnings |

Object key order determines display order. The config resolver derives `statuses.order`, `lifecycle.*`, `taxonomy.moduleRequiredFor`, and `context.*` from these definitions. Explicit global sections still win when provided.

### Array form (also supported)

The traditional array form remains fully backwards compatible:

```js
export const types = {
  plan: {
    statuses: ['active', 'planned', 'blocked', 'archived'],
    context: { expanded: ['active'], listed: ['planned', 'blocked'], counted: ['archived'] },
    staleDays: { active: 14, planned: 30, blocked: 30 },
  },
};

// When using array form, define behavior in separate sections:
export const statuses = {
  order: ['active', 'planned', 'blocked', 'archived'],
  staleDays: { active: 14, planned: 30, blocked: 30 },
};

export const lifecycle = {
  archiveStatuses: ['archived'],
  skipStaleFor: ['archived'],
  skipWarningsFor: ['archived'],
  terminalStatuses: ['archived'],
};

export const taxonomy = {
  moduleRequiredFor: ['active', 'planned', 'blocked'],
};
```

### Other config

```js
export const taxonomy = {
  surfaces: ['web', 'ios', 'backend', 'api', 'platform'],
};

export const referenceFields = {
  bidirectional: ['related_plans'],       // warn if A→B but B↛A
  unidirectional: ['supports_plans'],     // one-way, no symmetry check
};

export const index = {
  path: 'docs/docs.md',
  startMarker: '<!-- GENERATED:dotmd:start -->',
  endMarker: '<!-- GENERATED:dotmd:end -->',
};
```

All exports are optional. Additional options: `context`, `display`, `presets`, `templates`, `excludeDirs`, `notion`. See [`dotmd.config.example.mjs`](dotmd.config.example.mjs) for the full reference.

Config discovery walks up from cwd looking for `dotmd.config.mjs` or `.dotmd.config.mjs`.

## Hooks

Hooks are function exports in your config file. They let you extend validation, customize rendering, and react to lifecycle events.

### Custom Validation

```js
export function validate(doc, ctx) {
  const warnings = [];
  if (doc.status === 'active' && !doc.owner) {
    warnings.push({
      path: doc.path, level: 'warning',
      message: 'Active docs should have an owner.',
    });
  }
  return { errors: [], warnings };
}
```

### Render Hooks

Override any renderer by exporting a function that receives the default:

```js
export function renderContext(index, defaultRenderer) {
  let output = defaultRenderer(index);
  return `# My Project\n\n${output}`;
}
```

Available: `renderContext`, `renderCompactList`, `renderCheck`, `renderGraph`, `renderStats`, `formatSnapshot`.

### Lifecycle Hooks

```js
export function onArchive(doc, { oldPath, newPath }) {
  console.log(`Archived: ${oldPath} → ${newPath}`);
}
```

Available: `onArchive`, `onStatusChange`, `onTouch`, `onNew`, `onRename`, `onLint`.

### Transform Hooks

```js
// Add computed fields to every doc after parsing
export function transformDoc(doc) {
  doc.priority = doc.blockers?.length ? 'high' : 'normal';
  return doc;
}
```

### AI Hooks

```js
// Override doc summarization (replaces local MLX model)
export function summarizeDoc(body, meta) {
  return 'Custom summary for ' + meta.title;
}

// Override diff summarization
export function summarizeDiff(diffOutput, filePath) {
  return `Changes in ${filePath}: ...`;
}
```

## Features

- **Git-aware** — detects frontmatter date drift vs git history, uses `git mv` for archives
- **Dry-run everything** — preview any mutation with `--dry-run` / `-n`
- **Multi-root** — manage docs across multiple directories with `--root` filtering
- **Configurable** — statuses, taxonomy, lifecycle, validation rules, display, templates
- **Hook system** — extend with JS functions, no plugin framework to learn
- **AI-powered** — local MLX summaries for docs, queries, diffs, and context briefings
- **Notion sync** — import, export, and bidirectional sync with Notion databases
- **LLM-friendly** — `dotmd context` generates compact briefings for AI assistants
- **Shell completion** — bash and zsh via `dotmd completions`

## License

MIT
