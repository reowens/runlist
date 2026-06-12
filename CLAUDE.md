# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

dotmd is a CLI (`dotmd-cli` on npm) for managing markdown documents with YAML frontmatter. It indexes, queries, validates, graphs, exports, and lifecycle-manages collections of `.md` files (plans, ADRs, RFCs, design docs). Built as ESM with two npm dependencies (`@notionhq/client`, `notion-to-md` for Notion integration).

**Claude Code plugin.** dotmd also ships as a Claude Code plugin under `plugins/dotmd/` (marketplace manifest at `.claude-plugin/marketplace.json`). The plugin bundles the hooks (`SessionStart`/`SubagentStart` priming via `dotmd hud`, a `PreToolUse` guard via `dotmd guard`) and the canonical agent-facing workflow in `plugins/dotmd/skills/dotmd/SKILL.md`. That SKILL.md is the source of truth for how *other* repos' sessions learn the workflow — keep it in sync with the "Working with plans" guidance below. The user-typed slash commands (`/plans`, `/docs`, `/prompts`, `/baton`) ship from `plugins/dotmd/commands/`. The legacy per-repo `.claude/commands` scaffolding has been **retired** (see `docs/plans/package-dotmd-as-plugin.md`, Phase 4): `src/claude-commands.mjs` no longer generates anything — it only *removes* stale dotmd-generated command files (banner-gated, so hand-authored ones survive). `dotmd hud`/`doctor` sweep them; `dotmd init` recommends installing the plugin instead of scaffolding.

## Document Types

Every document has a `type:` field in its frontmatter. Types determine which statuses are valid and how the document appears in briefings.

| type | purpose | statuses |
|------|---------|----------|
| `plan` | Execution plans that Claude sessions work on | `in-session`, `active`, `planned`, `blocked`, `partial`, `paused`, `awaiting`, `queued-after`, `archived` |
| `doc` | Reference material, design docs, specs, ADRs, RFCs, investigations | `draft`, `active`, `review`, `reference`, `deprecated`, `archived` |
| `prompt` | Saved prompts that seed future sessions (body required) | `pending`, `held`, `shelved`, `claimed`, `archived` |

### Plan statuses explained

Each stop-status maps to a distinct **unstuck-action** — that's the test for whether the status earns its keep.

- **`in-session`** — A Claude instance is actively working on this plan right now. When you start working on a plan, set it to `in-session`. It's just a frontmatter status — there's no checkout, lock, or lease.
- **`active`** — Ready for a Claude session to pick up and work on.
- **`planned`** — Queued for future work, not yet ready to execute.
- **`blocked`** — *Unstuck-action: monitor.* External arrival on its own schedule (hardware, vendor delivery, third-party rollout). You can't speed it up.
- **`partial`** — *Unstuck-action: spawn successors.* Shipped most of the plan; tail work deferred. The plan body should reference the successor plan(s) tracking the tail. Visible but quiet (no nagging stale warnings).
- **`paused`** — *Unstuck-action: re-evaluate.* Started but stopped mid-work; needs near-term review. NOT quiet — short (3-day) stale threshold so resume-decisions don't decay.
- **`awaiting`** — *Unstuck-action: ask.* Needs a human decision or input. NOT quiet — pings get forgotten, so this status generates stale pressure to chase the answer.
- **`queued-after`** — *Unstuck-action: check predecessor.* Sequenced behind another plan; can start once that one ships. Quiet.
- **`archived`** — No longer relevant, moved to archive directory.

To finish work, archive directly: `dotmd archive <plan-file>`. The legacy `done` status was dropped from defaults — `archived` is the closure state.

### Working with plans (for Claude instances)

`dotmd set <status> [<file>]` is the single status verb. It handles starting, transitioning, and closing a plan based on the target status.

1. Get oriented: `dotmd briefing`
2. Start work on a plan: `dotmd use <plan-file>` (marks in-session + prints the plan card). To set the status without printing, `dotmd set in-session <plan-file>`.
3. When done — pick the closure status that matches reality:
   - Fully shipped → `dotmd set archived <plan-file>` (also: `dotmd archive <plan-file>`)
   - Shipped + tail deferred → `dotmd set partial <plan-file>` (reference the successor plan in the body)
   - Need more work later → `dotmd set active <plan-file>`
   - Stuck on a human decision → `dotmd set awaiting <plan-file>`
   `set <status> <file>` just writes the new status to frontmatter — no checkout to release, no lock to clear.
   Add `--note "why"` to any `set`/`archive` to append the reason to `## Version History` in the same call (creates the section if missing) — prefer it over a separate body edit. `set partial` without a note or successor link prints a reminder.
4. To see plans: `dotmd plans` (live), `dotmd plans --status active`, `dotmd plans --status in-session`

### Resume prompts (saved for future sessions)

When the user asks for a resume prompt — or when context is getting tight and you're about to stop mid-work — DO NOT print the resume text into chat for them to copy-paste. If a plan is in-session, hand it off with the single verb:

```bash
dotmd baton @/tmp/draft.md        # saves resume-<plan-slug>, flips the plan
                                  # in-session → active, prints the exact git commit
```

`--status paused|awaiting|partial|blocked` overrides the release status; `--note "why"` records the reason. Baton resolves *your* plan via the journal (or takes it explicitly: `dotmd baton <plan-file> @draft`). It is the whole closeout — no extra status changes, no `dotmd use`, no repo triage on the way out.

No plan involved? Same verb, slug mode — saves `resume-<slug>` and touches nothing else:

```bash
dotmd baton <slug> @/tmp/draft.md
```

Either way the prompt lands under `docs/prompts/<name>.md` with `status: pending`. The next session runs `dotmd hud` (the SessionStart hook), sees the pending prompt, and consumes it with `dotmd use <file>` (or `dotmd use` with no arg for the oldest). That command atomically prints the body and archives the prompt so it can't be double-consumed. To peek at a prompt without consuming it, `dotmd prompts show <file>`.

Use this whenever you'd otherwise print a multi-line "here's how to resume" block.

### Grouping plans into runlists

When several plans need to ship in a known order (e.g. an "auth revamp" sprint with extract → rewrite → cleanup phases), declare a `runlist:` on a hub plan instead of chaining `queued-after` per pair or maintaining the order in prose:

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

Then:

- `dotmd runlist <hub>` — show the children + their statuses in order. First non-archived child is marked `→` (that's the next pickup target).
- `dotmd runlist next <hub>` — pick up the first non-archived child. If it's not in a pickup-able status (`active` / `planned` / `in-session`), the command stops with a runlist-aware error so you resolve the blocker before continuing.

Each child should set `parent_plan:` pointing back at the hub — `dotmd doctor` warns when it doesn't. Order is authoritative from `runlist:`; `parent_plan` keeps the existing reverse-link semantics (pickup-card Related:, graph).

### Creating documents

Signature: `dotmd new <type> <name> [body]`. `<type>` is required (defaults to `doc` if omitted).

```bash
dotmd new plan auth-revamp                       # type: plan → docs/plans/auth-revamp.md
dotmd new doc token-refresh-design               # type: doc → docs/token-refresh-design.md
dotmd new prompt cleanup-tomorrow "..."          # type: prompt → docs/prompts/cleanup-tomorrow.md
dotmd new my-doc                                 # implicit type: doc
```

Built-in types: `plan`, `doc`, `prompt`. Add more via `templates` in config.

### Queuing prompts for future sessions

When you want to leave a self-addressed reminder ("look at X tomorrow," "resume payments refactor"), write a saved prompt instead of dropping a note in chat. `dotmd hud` surfaces pending prompts at session start, so the next session sees it without copy-paste:

```bash
dotmd new prompt resume-foo @/tmp/draft.md                   # @path reads from file (preferred for multi-line)
dotmd new prompt resume-foo - <<'EOF'                        # `-` reads stdin
multi-line body
EOF
dotmd new prompt cleanup --message "look at remaining lint warnings"  # --message flag
dotmd new prompt cleanup "look at remaining lint warnings"   # inline body (one-liners only)
```

All four body-input modes (`@path`, stdin, `--message`, inline) work for every body-accepting type (`plan`, `doc`, `prompt`). **Default to `@path` or `-` for multi-line bodies.** Inline puts the entire body on the bash command line — heredoc is brittle for content with backticks, and PreToolUse hooks that scan commands for forbidden literals (e.g. destructive-git patterns) will fire on prose that just *describes* the rule. `@/tmp/foo.md` sidesteps both.

Saved prompts have their own status vocab (`pending`, `held`, `shelved`, `claimed`, `archived`). Consume one with `dotmd use [<file-or-slug>]` (no arg = oldest pending). Admin verbs live under `dotmd prompts list|archive|hold|unhold`. `held` is the "saved but not next" bucket: visible in `dotmd prompts list`, but hidden from `hud`/`briefing` and skipped by no-arg `dotmd use`. Use `dotmd prompts hold <file>` / `unhold <file>` to flip; `shelve` / `unshelve` remain legacy aliases.

### Querying by type

```bash
dotmd plans                                # all plans
dotmd plans --status active                # plans ready to pick up
dotmd stale                                # stale docs across all types
dotmd actionable                           # docs with next steps
dotmd health                               # plan pipeline and aging
dotmd unblocks docs/plan-a.md              # impact analysis
dotmd glossary "term"                      # domain term lookup
dotmd bulk archive <files>                 # archive multiple at once
dotmd query --type doc --status active     # active docs
dotmd query --type prompt                  # all saved prompts
dotmd grep "term"                          # "which doc discussed X?" — searches frontmatter
                                           #   AND bodies, doc cards + line-numbered excerpts
dotmd query --keyword x --body             # same body scan composed with other query filters
dotmd context --type plan                  # briefing filtered to plans
```

The `--type` flag works as a global filter on most commands: `list`, `json`, `check`, `context`, `focus`, `query`, `coverage`, `stats`, `graph`, `index`, `export`.

When `dotmd query` / `dotmd plans` truncates to the default `--limit`, the output now shows `results: N of M (use --all to see all)` (since 0.36.2). The "N more plans" footer also renders for grouped views (`--sort status`, `--group module/surface/owner`), not just the flat triage view.

### Triaging plans at scale (>50 plans)

When a flat `dotmd plans` list stops being useful, use the module dashboard to triage systematically (shipped 0.36.0):

```bash
dotmd modules                              # one row per module, dynamic status columns
dotmd modules --sort cleanup               # rank by (stale × avgAge) / total — "rotting hardest"
dotmd module <name>                        # deep view of one module, plans grouped by status
dotmd stale --group module                 # same staleness, bucketed by module
```

Workflow: `dotmd modules --sort cleanup` → pick the top row → `dotmd module <name>` → archive or update the rotting plans → move on. The dashboard composes existing primitives — no new config knobs to set up.

## Commands

```bash
npm test                           # run all tests (node:test)
node --test test/frontmatter.test.mjs  # run a single test file
node bin/dotmd.mjs <command>       # run CLI locally without installing
npm version patch                  # release: test → bump → tag → push → publish
```

Run `dotmd --help` or `dotmd <command> --help` for the full command list and options.

## Releasing

**One command. That's it.**

```bash
npm version patch    # bug fixes, small tweaks
npm version minor    # new features
npm version major    # breaking changes
```

Everything is automated — do NOT manually `git push`, `git tag`, `npm publish`, or anything else. The single `npm version` command does all of this:

1. Runs tests (blocks release if they fail)
2. Bumps `package.json` + `package-lock.json`, commits, creates git tag
3. Pushes to `origin main --tags`
4. Creates GitHub Release with auto-generated notes
5. Waits for GitHub Actions `publish.yml` to `npm publish`
6. Installs the new version locally via `npm install -g`

**If it fails partway through:** Check if the tag was pushed (`git log --oneline -1`). If yes, the GitHub Actions publish workflow is probably already running — check GitHub Actions. If not, run `git push origin main --tags` manually and the rest will follow.

## Architecture

**Entry point:** `bin/dotmd.mjs` — CLI arg parser and command dispatcher. Each command delegates to a module in `src/`.

**Core modules:** `config.mjs` (config discovery + defaults), `frontmatter.mjs` (YAML parser), `index.mjs` (doc scanner + validator), `render.mjs` (display output).

**Feature modules** in `src/` each export a `runX()` function called from the CLI dispatcher. See `bin/dotmd.mjs` imports for the full list.

**Supporting modules:** `extractors.mjs`, `validate.mjs`, `prompt.mjs`, `git.mjs`, `color.mjs`, `util.mjs`, `ai.mjs`.

## Key Conventions

- **Pure ESM.** All files use `.mjs` extension and `import`/`export`.
- **Minimal dependencies.** Everything beyond Notion integration uses Node.js builtins.
- **Document types.** Every doc should have `type: plan|doc|research`. Each type has its own valid statuses. Status validation is type-aware (type > root > global).
- **Rich status definitions.** `types.<type>.statuses` accepts an object form where each status co-locates all behavior (`context`, `staleDays`, `requiresModule`, `terminal`, `archive`, `skipStale`, `skipWarnings`). This eliminates the need for separate `lifecycle`, `statuses.staleDays`, `taxonomy.moduleRequiredFor`, and `context` sections. Array form remains backwards compatible.
- **Hook pattern.** Config functions are automatically detected as hooks. See `dotmd.config.example.mjs` for the full hook API.
- **`--dry-run` / `-n`** is supported by all mutation commands. Pass `{ dryRun }` options object to `runX()` functions.
- **`--json`** is supported by most read commands.
- **Multi-root.** `config.root` accepts string or array. Each doc is tagged with its `root`.
- **Interactive prompts.** `status`, `new`, `rename` prompt for missing args when stdin is a TTY.
- **Tests** use `node:test` + `node:assert`. Test files mirror source: `src/foo.mjs` → `test/foo.test.mjs`.
- **Help text** in `bin/dotmd.mjs` HELP object must stay in sync with command capabilities.
- **Global arg stripping** happens in the CLI dispatcher — `--config <path>`, `--type <t>`, `--root <name>`, `--dry-run`, `-n`, `--verbose` are removed from `restArgs` before passing to commands.
- Preset aliases in config expand to query filter args and are dispatched as if they were built-in commands.
