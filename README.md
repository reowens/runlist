# dotmd

CLI for managing markdown documents with YAML frontmatter.

Index, query, validate, and lifecycle-manage any collection of `.md` files — plans, ADRs, RFCs, design docs, meeting notes. Built for AI-assisted development workflows where structured docs need to stay current.

## Install

```bash
npm install -g dotmd-cli    # global — use `dotmd` anywhere
npm install -D dotmd-cli    # project devDep — use via npm scripts
npx dotmd-cli init          # try it without installing — scaffold a repo first
# requires Node.js >= 20
```

### Claude Code plugin (recommended)

If you drive dotmd from Claude Code, install the **dotmd plugin**. It teaches every session and subagent the dotmd workflow and guards the wrong-moves agents keep making (committing session-local prompts, `cat`-ing prompts instead of consuming them, hand-editing `status:`):

```
/plugin marketplace add reowens/dotmd
/plugin install dotmd@dotmd
```

The plugin bundles the hooks (`SessionStart`/`SubagentStart` priming, a `PreToolUse` guard) and a canonical workflow skill, so guidance travels to **every** repo automatically — no per-repo setup. (Source: `plugins/dotmd/` in this repo.)

> **The plugin requires a _global_ CLI install.** Its hooks resolve `dotmd` from your `PATH`, so run `npm install -g dotmd-cli`. A project devDependency (`npm install -D dotmd-cli`) lives at `./node_modules/.bin/dotmd` — off `PATH` — so the hooks silently no-op (no errors, just no priming/guarding). Use the devDep for `npm run` scripts; use the global install for the plugin.

> **Upgrading to 0.57.0+:** per-repo `.claude/commands/{plans,docs,baton}.md` scaffolding is retired — that guidance now ships via the plugin's workflow skill and `/plans`, `/docs`, `/prompts`, `/baton` commands. On the next `dotmd hud` (SessionStart), dotmd removes those generated files (only banner-stamped `<!-- dotmd-generated -->` ones — your hand-authored command files are never touched). If you'd committed them, you'll see deletions to commit — that's expected. Run `claude plugin update dotmd@dotmd` to pick up `/baton`.

### Updating

The CLI and the Claude Code plugin are versioned in lockstep but ship as separate artifacts, so upgrading one can leave the other behind. `dotmd update` keeps them aligned:

```bash
dotmd update                 # update both: npm CLI + the plugin
dotmd update --check         # report CLI vs plugin versions, change nothing (no network)
dotmd update --cli-only      # just the npm CLI
dotmd update --plugin-only   # just the plugin (what to run after a plain npm upgrade)
```

`--plugin-only` is the usual fixup: after `npm i -g dotmd-cli@latest` the CLI is fresh but the plugin is stale, so run `dotmd update --plugin-only`, then restart the session (or `/reload-plugins`).

## Quick Start

```bash
dotmd init                  # creates dotmd.config.mjs, docs/, docs/docs.md
dotmd new my-feature        # scaffold a new doc with frontmatter
dotmd list                  # index all docs grouped by status
dotmd check                 # validate frontmatter and references
dotmd context               # compact briefing (great for LLM context)
dotmd doctor                # preview fixes for everything (--apply to write)
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
- **Query** — filter by status, keyword, module, surface, owner, staleness; `dotmd grep` searches document bodies too
- **Resume handoff** — `dotmd baton` saves a resume prompt for the next session and releases the in-session plan in one verb
- **Runlists** — group plans into an ordered sequence on a hub plan; `dotmd runlist next` picks up the next one
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
modules:
  - auth
surfaces:
  - backend
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

The only required field is `status`. Everything else is optional but unlocks more features. The `type` field (`plan`, `doc`, or `prompt`) enables type-specific statuses and smarter context briefings.

> **Note:** `module:` and `surface:` (singular) are deprecated as of 0.36.3 — use the plural array forms (`modules:`, `surfaces:`). Run `dotmd lint --fix` to migrate existing docs.

## Document Types

Every document can have a `type` field in its frontmatter. Types determine which statuses are valid and how the document appears in context briefings.

| Type | Purpose | Valid Statuses |
|------|---------|----------------|
| `plan` | Execution plans | `in-session`, `active`, `planned`, `blocked`, `partial`, `paused`, `awaiting`, `queued-after`, `archived` |
| `doc` | Design docs, specs, ADRs, RFCs, reference material | `draft`, `active`, `review`, `reference`, `deprecated`, `archived` |
| `prompt` | Saved prompts that seed future Claude sessions | `pending`, `held`, `shelved`, `claimed`, `archived` |

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

### Runlists: ordered groups of plans

When several plans must ship in a known order (an "auth revamp" sprint with extract → rewrite → cleanup phases), declare a `runlist:` array on a hub plan instead of chaining `queued-after` per pair or keeping the order in prose:

```yaml
---
type: plan
status: active
title: Auth Revamp
runlist:
  - auth-revamp-01-extract.md
  - auth-revamp-02-rewrite.md
  - auth-revamp-03-cleanup.md
---
```

Scaffold the whole sprint in one command instead of hand-writing the hub + children:

```bash
$ dotmd new plan auth-revamp --runlist extract,rewrite,cleanup
Created: plans/auth-revamp.md (plan (runlist hub))
Created: plans/auth-revamp-01-extract.md (plan · runlist child, planned)
Created: plans/auth-revamp-02-rewrite.md (plan · runlist child, planned)
Created: plans/auth-revamp-03-cleanup.md (plan · runlist child, planned)
```

That writes the hub above (the `runlist:` array + an `## Order of operations` link list) plus one `planned` child stub per slug, each carrying a `parent_plan: auth-revamp.md` back-ref. Then walk the sequence:

```bash
$ dotmd runlist auth-revamp          # the sequence + statuses; → marks the next pickup
runlist: plans/auth-revamp.md
  →  1. [planned] plans/auth-revamp-01-extract.md
     2. [planned] plans/auth-revamp-02-rewrite.md
     3. [planned] plans/auth-revamp-03-cleanup.md

$ dotmd runlist next auth-revamp     # pick up the → child (planned → in-session) + print its card
▶ Started: plans/auth-revamp-01-extract.md (planned → in-session)

$ dotmd runlists                     # dashboard of coordination-hub runlists (--json, --limit N)
```

`runlist next` stops with a runlist-aware error if the next child isn't in a workable status (`active` / `planned` / `in-session`), so you resolve the blocker before continuing. Each child should set `parent_plan:` pointing back at the hub — `dotmd check` warns when it doesn't. There's no separate doc type: a runlist hub is just a plan with the array.

In `dotmd plans`, the hub folds its children under one tagged row — `auth-revamp  runlist · 0/3 · next → 01-extract  [RUNLIST]` — so a multi-plan sprint reads as one runlist instead of cluttering the triage list. A child whose hub is filtered out of the view (e.g. `--status active` when the hub is `planned`) still renders on its own.

**Coordination runlists.** A `runlist:` array fits a small ordered *sprint*. For a large, prose-first *coordination map* (a domain hub pointing at many plans, with gating/sequence rationale, sometimes unordered), set `execution_mode: coordination` instead — or just name it `*-runlist`. These aren't folded: `dotmd plans` lifts them into a pinned `Runlists` section and out of the active count, and `dotmd runlists` shows that dashboard standalone. `dotmd briefing` and `dotmd health` do the same — coordination hubs are pulled out of the live/active counts into a `runlists` bucket (briefing) and a held-out `Runlists:` tally (health), so they don't inflate the actionable-plan or aging numbers. The per-hub "N related" count comes from `related_plans:`. `dotmd check` nudges a `*-runlist` hub missing `execution_mode: coordination`.

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
dotmd agent-context          Compact bounded JSON context for agents
dotmd focus [status]         Detailed view for one status group
dotmd query [filters]        Filtered search (--body scans document bodies)
dotmd grep <term>            Keyword search incl. bodies — "which doc discussed X?"
dotmd plans                  List live plans (excludes archived)
dotmd modules                Module dashboard (plans grouped by module)
dotmd module <name>          Plans for one module, grouped by status
dotmd surfaces               List configured surface taxonomy
dotmd stale                  List stale docs
dotmd actionable             List docs with next steps
dotmd index [--print]        Generate/update docs.md index block
dotmd hud                    Actionable triage (silent when clean — ideal SessionStart hook)
dotmd use [<file-or-slug>]   Open by type: prompt → consume, plan → start, doc → read
                             (no arg: consume the oldest pending prompt)
dotmd set <status> <file>    Change a document's status (--note appends why to Version History)
dotmd baton [<plan>|<slug>] <@draft|->  Save a resume prompt; releases the in-session plan
dotmd runlist <hub> [next]   Show or walk an ordered group of plans
dotmd status <file> <status> Transition document status (deprecated; prefer set)
dotmd archive <file>         Archive (status + move + update refs)
dotmd bulk archive <files>   Archive multiple files at once
dotmd bulk-tag [files]       Tag pre-existing untagged .md files
dotmd touch <file>           Bump updated date
dotmd touch --git            Bulk-sync dates from git history
dotmd doctor [--apply]       Fix refs, lint, dates, index (previews by default)
dotmd self-check             Project/version skew diagnostic
dotmd fix-refs               Auto-fix broken reference paths
dotmd lint [--fix]           Check and auto-fix frontmatter issues
dotmd rename <old> <new>     Rename doc and update references
dotmd migrate <f> <old> <new>  Batch update a frontmatter field
dotmd ship [patch|minor|major] Regen + commit + bump in one step
dotmd notion <sub> [db-id]   Notion import/export/sync
dotmd export [file]          Export docs as md, html, or json
dotmd summary <file>         AI summary of a document
dotmd glossary <term>        Look up domain terms + related docs
dotmd watch [command]        Re-run a command on file changes
dotmd diff [file]            Show changes since last updated date
dotmd new <type> <name>      Create a new doc (type: doc, plan, or prompt)
dotmd prompts [sub]          Manage saved prompts (list, show, hold, archive, new)
dotmd statuses [sub]         Manage per-project status taxonomy
dotmd journal [flags]        View opt-in command-usage journal (DOTMD_JOURNAL=1)
dotmd init                   Create starter config + docs directory
dotmd completions <shell>    Output shell completion script (bash, zsh)
```

Run `dotmd help all` for the always-current version of this list, `dotmd help statuses` for the status vocabulary, and `dotmd <cmd> --help` for per-command details.

### Global Flags

```
--config <path>        Explicit config file path
--dry-run, -n          Preview changes without writing anything
--root <name>          Filter to a specific docs root
--type <t1,t2>         Filter by document type (plan, doc, prompt, or custom)
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
dotmd query --keyword "retries" --body              # scan document bodies too
```

Flags: `--type`, `--status`, `--keyword`, `--body`, `--module`, `--surface`, `--domain`, `--owner`, `--updated-since`, `--stale`, `--has-next-step`, `--has-blockers`, `--checklist-open`, `--sort`, `--limit`, `--all`, `--git`, `--json`, `--summarize`, `--summarize-limit`, `--model`.

`dotmd grep <term>` is the "which doc discussed X?" shorthand — an alias for `dotmd query --keyword <term> --body --all` that prints doc cards plus line-numbered excerpts per body hit. Bodies are read lazily (frontmatter filters run first), and it composes with the usual query flags.

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

**Plan body variants (plans only).** The default `plan` template is the full build-up shape. For a smaller plan, or the recurring audit shape, pass one body-variant flag:

- `--lite` / `--minimal` — Problem → Phases → Version History (drops Goals / Non-Goals / What Exists Today / Constraints / Decisions / Deferred / Closeout).
- `--audit` / `--findings` — Problem → Findings (ranked) → Suggested order → Open Questions, for "I investigated X, here's what I found" plans.

```bash
dotmd new plan quick-fix --lite
dotmd new plan perf-audit --audit
```

To scaffold an ordered sprint or a coordination map instead, see [Runlists](#runlists-ordered-groups-of-plans) (`--runlist a,b,c` / `--coordination`). The body variants and the hub flags are all mutually exclusive — a plan has exactly one body shape.

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

Consume one with `dotmd use` — it atomically prints the body and archives the prompt so it can't be double-consumed:

```bash
dotmd use                         # consume the oldest pending prompt
dotmd use <file-or-slug>          # consume a specific prompt
```

Admin verbs live under the `prompts` namespace:

```bash
dotmd prompts                     # list pending prompts (default)
dotmd prompts list --all          # all statuses
dotmd prompts show <file>         # read-only peek: print the body WITHOUT consuming
dotmd prompts next                # print body of oldest pending + auto-archive (one-shot)
dotmd prompts use <file>          # print body of a specific prompt + auto-archive
dotmd prompts hold <file>         # park a prompt (status → held) under prompts/held/:
                                  # kept in list, hidden from hud/briefing, skipped by `next`
dotmd prompts unhold <file>       # move a held prompt back to pending
dotmd prompts shelve <file>       # legacy alias for `hold`
dotmd prompts archive <file>      # archive without printing the body
dotmd prompts new <name> [body]   # alias for `dotmd new prompt`
```

`dotmd hud` surfaces pending prompts on session start, so a saved prompt acts as a self-addressed reminder: write it now, the next session sees it. Held prompts are kept out of the SessionStart surface — use them for "saved but not next."

Statuses: `pending` (drafted, awaiting a session), `held` (saved but parked under `prompts/held/` — visible in `prompts list`, hidden from `hud`/`briefing`, skipped by `prompts next`), `archived` (consumed or filed away). `shelved` is a legacy spelling accepted for older files; `claimed` is reserved for a future "in-flight" state but is currently a synonym for archived in practice.

### Baton: resume prompts & session handoff

`dotmd baton` is the "save a resume prompt" verb — the way one session hands work to the next without pasting resume text into chat. Write a short draft (the next concrete decision plus any gotchas, not a recap), then:

```bash
dotmd baton @/tmp/draft.md        # plan mode: a plan is in-session
```

In plan mode, baton does the whole closeout in one call:

1. Saves a resume prompt named `resume-<plan-slug>` (collision-safe: `-2`, `-3`, …) under `docs/prompts/` with `status: pending`.
2. Releases the plan: one status flip, `in-session` → `active` by default (`--status paused|awaiting|partial|blocked` to override, `--note "why"` to record the reason in `## Version History`).
3. Prints the exact `git commit` command for the plan's frontmatter change — the prompt stays out of the pathspec, because saved prompts are session-local.

Baton resolves *your* plan via the command journal (or takes it explicitly: `dotmd baton <plan-file> @draft`), falling back to the only in-session plan.

No plan involved? Slug mode saves the prompt and touches nothing else:

```bash
dotmd baton checkout-fixes @/tmp/draft.md    # saves resume-checkout-fixes; no status changes
cat /tmp/draft.md | dotmd baton              # body from stdin
```

Either way, the next session's `dotmd hud` surfaces the pending prompt, and `dotmd use` consumes it.

### Command Journal (opt-in)

dotmd's primary user is an agent. Every CLI invocation can be journaled
to `.dotmd/journal.jsonl` so agents (and humans) can see what got run,
what failed, and how long things took — observability that turns every
session into data the next design call can use.

Default off. Enable with either:

```bash
export DOTMD_JOURNAL=1                                # env var
# or, in dotmd.config.mjs:
export const journal = true;                          # config flag
```

(`DOTMD_JOURNAL=0` forces off even when the config opts in.)

Each invocation appends one JSON line:
`{ts, sid, pid, argv, exit, ms, v, err?}`. Writes are atomic via
`O_APPEND` (entries are well under `PIPE_BUF`), so concurrent sessions
interleave cleanly without locking. Lazy rotation to
`.dotmd/journal.jsonl.1` on version change, at >5MB, or when the oldest
entry is >30 days; one backup retained and pruned after 30 days.
Version-change rotation keeps agent-facing journal summaries focused on the
currently installed dotmd.

Read it back with `dotmd journal`:

```bash
dotmd journal --tail 20            # last N entries (default)
dotmd journal --errors             # only non-zero exits
dotmd journal --session <id>       # filter by session id
dotmd journal --since 2026-05-01   # filter by ts
dotmd journal --by-command         # group by argv[0]: count, median ms, errors
dotmd journal --json               # raw entries as a JSON array
```

The journal is local-only and gitignored (or should be — `.dotmd/` is
typically already ignored). Default-off keeps the surface clean for
users who don't want the storage / PII tradeoff.

### Check & Fix

```bash
dotmd check                  # validate everything
dotmd check --errors-only    # suppress warnings, show only errors
dotmd check --fix            # auto-fix broken refs + lint + regen index
```

Validates: required fields, status values, broken reference paths, broken body links (`[text](path.md)`), bidirectional reference symmetry, git date drift, taxonomy mismatches.

#### Per-ref one-way opt-out (`>` prefix)

`referenceFields.bidirectional` is per-field — once a field is bidirectional, every ref in it expects a back-ref. For leaf-to-upstream cases (a plan referencing the audit doc that spawned it; many docs pointing at a single hub) that's noise: the parent shouldn't list every child. Prefix the value with `>` to mark a single ref one-way without changing the field:

```yaml
related_docs:
  - docs/sibling-design.md            # bidirectional (default for the field)
  - "> docs/audit-example-project.md" # one-way upstream — no back-ref expected
```

The prefix is stripped before path resolution — refs still resolve normally. Works on any ref field. Quote the value (it starts with `>`, which is YAML's block-scalar indicator). Shipped 0.35.0 — closed 7 false-positive warnings in this repo's own corpus.

### Stats

```bash
dotmd stats                  # health dashboard
dotmd stats --json           # machine-readable
```

Shows: status counts, staleness, errors/warnings, freshness (today/week/month), completeness (owner/surface/module/next_step), checklist progress, audit coverage.

### Doctor

```bash
dotmd doctor                 # preview: fix refs → lint → sync git dates → regen index
dotmd doctor --apply         # actually write the fixes (previews by default since 0.37.0)
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

### Modules Dashboard

A triage view for codebases with enough plans that a flat list stops being useful (rule-of-thumb: ~50+ plans across many modules). Composes existing primitives (`modules: []`, `isStale`, `daysSinceUpdate`, `hasNextStep`, `statusOrder`) — no new config.

```bash
dotmd modules                            # one row per module, dynamic status columns
dotmd modules --sort cleanup             # rank by (stale × avgAge) / total — "rotting hardest"
dotmd modules --sort stale|age|nextstep|total
dotmd modules --type doc                 # docs instead of plans
dotmd modules --limit 20                 # default 20; --all to disable
dotmd modules --json                     # includes _totalUnique for double-count detection

dotmd module <name>                      # deep view of one module, plans grouped by status
dotmd module <name> --sort updated|age   # default sort is status
dotmd module <name> --json
```

Workflow for systematic cleanup:

```
dotmd modules --sort cleanup → walk the top row → dotmd module <name> → triage/archive → next
```

Notes:

- Status columns are dynamic — only statuses with ≥1 plan render, so default and custom vocabularies both look right.
- A plan with `modules: [a, b]` counts in both rows. This is intentional. `--json` exposes `_totalUnique` so tooling can detect this if needed.
- `(none)` is a literal row for unmoduled plans — surfaces unowned work that would otherwise hide in a flat list.
- Unknown module names exit with `Module 'foo' not found. Did you mean: …?` (substring-first, Levenshtein ≤3 fallback).
- The dashboard auto-falls-back to a stacked render when the table doesn't fit your terminal width.

`dotmd stale --group module` is the canonical "what's rotting per module" companion view (uses the existing `query --group` mechanism, called out here so it's findable).

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

### Open & Closeout

Status is just frontmatter. There's no checkout, lock, or lease — opening a
plan, transitioning it, and closing it are all plain status writes (archive
also moves the file).

```bash
dotmd use docs/plans/my-plan.md          # mark in-session + print the plan card
dotmd set in-session docs/plans/my-plan.md   # set the status without printing
dotmd set active docs/plans/my-plan.md   # need more work: flip back to active
dotmd set partial docs/plans/my-plan.md  # shipped + tail deferred (reference successors in body)
dotmd set awaiting docs/plans/my-plan.md # stuck on a human decision
dotmd archive docs/plans/my-plan.md      # fully shipped: archive + move + update refs
dotmd archive docs/plans/my-plan.md --closeout-template   # also inject ## Closeout skeleton
```

`in-session` is a status like any other — `dotmd set <status> <file>` writes it
to the file's frontmatter and does nothing else.

Add `--note "why"` to any `set` or `archive` to append the reason to the doc's
`## Version History` section in the same call (creates the section if missing) —
it saves the status-change + worklog-edit round-trip. `set partial` without a
note or successor link prints a reminder.

To stop mid-work and hand off to a future session, use `dotmd baton` (see
[Baton](#baton-resume-prompts--session-handoff)) — it saves the resume prompt
and releases the plan in one verb.

**Recommended Claude Code hook** — add to `~/.claude/settings.json`
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
    ]
  }
}
```

- **SessionStart** runs `dotmd hud`, which prints the command primer and stays
  silent when nothing is queued. Use this instead of `dotmd briefing` for the
  hook role — `briefing` dumps per-plan next_step prose that can run to many
  kilobytes on large repos. `hud` is the zero-pollution surface.

> The double-`hooks` nesting is correct: `hooks.<Event>[*].hooks[*]` is the
> schema Claude Code requires. `Bash(dotmd:*)` should be in your
> `permissions.allow` list as well, otherwise the hooks will be blocked.

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
      'blocked':  { context: 'listed', skipStale: true },
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

**Contradiction check.** Combining `skipStale: true` with a `staleDays` value, or `skipWarnings: true` with `requiresModule: true`, makes one of the fields dead config — the boolean wins silently. From 0.36.2, dotmd `warn()`s at config load when it spots either pair, naming the type, status, and conflicting fields. Drop one to silence the warning. The same check runs against the `quiet: true` sugar (which implies both `skipStale` and `skipWarnings` unless explicitly overridden).

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
  // Types that archive into their own <typeDir>/<archiveDir> (e.g.
  // docs/prompts/archived/) instead of the shared <root>/<archiveDir>.
  // Defaults to ['prompt'] so session-local prompt churn doesn't bury
  // plans and docs in the shared archive. Set to [] to disable.
  archiveNestedTypes: ['prompt'],
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
// Per-ref opt-out: prefix any value with `>` to mark that specific ref one-way
// without changing the field's default. Useful for leaf→upstream-parent refs
// (audits, hub docs) where a back-ref would force editing a stable parent.
//   related_docs:
//     - docs/sibling-design.md            # bidirectional (default for the field)
//     - "> docs/audit-example-project.md" # one-way upstream — no back-ref expected

export const index = {
  path: 'docs/docs.md',
  startMarker: '<!-- GENERATED:dotmd:start -->',
  endMarker: '<!-- GENERATED:dotmd:end -->',
  snapshot: 'status', // default; use 'state' to include live current_state text
};
```

Generated indexes default to status-only rows for live sections so README files
do not become stale mirrors of volatile `current_state` text. Set
`snapshot: 'state'` if you want the older `Status Snapshot` table for live
sections too. Archived highlights still include their historical snapshots.

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
