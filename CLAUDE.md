# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

dotmd is a CLI (`dotmd-cli` on npm) for managing markdown documents with YAML frontmatter. It indexes, queries, validates, graphs, exports, and lifecycle-manages collections of `.md` files (plans, ADRs, RFCs, design docs). Built as ESM with two npm dependencies (`@notionhq/client`, `notion-to-md` for Notion integration).

**Claude Code plugin.** dotmd also ships as a Claude Code plugin under `plugins/dotmd/` (marketplace manifest at `.claude-plugin/marketplace.json`). The plugin bundles the hooks (`SessionStart`/`SubagentStart` priming via `dotmd hud`, a `PreToolUse` guard via `dotmd guard`) and the canonical agent-facing workflow in `plugins/dotmd/skills/dotmd/SKILL.md`. That SKILL.md is the source of truth for how *other* repos' sessions learn the workflow — keep it in sync with the "Working with plans" guidance below. The irreducible verb contract lives in a marked `dotmd:canonical-workflow` block duplicated in both surfaces; `dotmd check` fails (via `src/skill-drift.mjs`) the moment the two copies drift, so that lockstep is mechanical, not manual. The user-typed slash commands (`/plans`, `/docs`, `/prompts`, `/baton`) ship from `plugins/dotmd/commands/`. The legacy per-repo `.claude/commands` scaffolding has been **retired** (see `docs/plans/package-dotmd-as-plugin.md`, Phase 4): `src/claude-commands.mjs` no longer generates anything — it only *removes* stale dotmd-generated command files (banner-gated, so hand-authored ones survive). `dotmd hud`/`doctor` sweep them; `dotmd init` recommends installing the plugin instead of scaffolding.

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

**Workflow contract.** The bullets between the markers below are kept byte-identical across this `CLAUDE.md` and the plugin `SKILL.md`; `dotmd check` guards the lockstep (`src/skill-drift.mjs`). Edit them in one surface and you must mirror them in the other — only the marked block is compared, so this framing line can differ per file.

<!-- dotmd:canonical-workflow:start -->
- **Orient:** `dotmd briefing` — active / paused / ready work, with ages and next steps.
- **Start a plan:** `dotmd use <plan-file>` — marks it `in-session` and prints the plan card.
- **Single status verb:** `dotmd set <status> [<file>]` writes the status, validates it against the doc's type, runs lifecycle hooks, fixes refs, and syncs the index. **Never hand-edit a `status:` line.** Add `--note "why"` to record the reason in `## Version History` in the same call.
- **Close to match reality:** `archived` (shipped) · `partial` (tail deferred — link the successor) · `active` (more work later) · `awaiting` (needs a human decision) · `blocked` (external arrival you can't speed up).
- **Hand off / save a resume prompt:** `dotmd baton [<slug>] <@draft|->` — saves the resume prompt and releases the in-session plan. Never paste a "here's how to resume" block into chat.
- **Saved prompts are session-local:** consume with `dotmd use` (no arg = oldest pending), peek with `dotmd prompts show`. Never read them with file tools, never commit `docs/prompts/*.md`.
<!-- dotmd:canonical-workflow:end -->

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

Scaffold the whole sprint in one command instead of hand-writing the hub + children:

```bash
dotmd new plan auth-revamp --runlist extract,rewrite,cleanup
# → hub with the runlist: array above + an `## Order of operations` list,
#   plus auth-revamp-0{1,2,3}-*.md child stubs (status planned, parent_plan back-ref)
dotmd new plan platform --coordination   # coordination hub: execution_mode + `## Ranked queue` skeleton
```

Then:

- `dotmd runlist <hub>` — show the children + their statuses in order. The first **pickup-able** child (`active` / `planned` / `in-session`) is marked `→` (the next pickup target). Archived children are done; **parked** children (`blocked` / `partial` / `paused` / `awaiting` / `queued-after`) are skipped — the `→` advances past them, since each needs its own unstuck action before work resumes. Skipping ≠ done: a parked child never counts toward the `done/total` progress (that tracks archived only).
- `dotmd runlist next <hub>` — pick up the first pickup-able child, advancing past archived and parked children alike. If *every* remaining child is parked, the command stops with a runlist-aware error that lists them with their statuses + the unstick verbs (`dotmd set active <child>`), so you resolve a blocker before continuing.
- In `dotmd plans`, a hub is tagged `[RUNLIST]` rather than `[ACTIVE]` and its children fold underneath it (with `done/total` progress and the next-pickup `→` on the hub row), so a sprint reads as one runlist instead of N loose plans. A child whose hub is filtered out of the current view still renders standalone.

**Mutate the runlist through the CLI — never hand-edit the `runlist:` YAML.** Three verbs keep the frontmatter array, each child's `parent_plan:` back-ref, and any body `## Order of operations` link list (incl. per-item ⬜/✅ markers) in sync:

- `dotmd runlist add <hub> <child...>` — append children. A bare slug (`cleanup`) scaffolds a `planned` stub `<hub>-NN-<slug>.md` next to the hub (mirrors `new plan --runlist`); a path/slug of an existing plan wires it in by a hub-relative ref and sets its `parent_plan:`. A plain plan with no `runlist:` becomes a hub. (Coordination/body-order hubs aren't handled by `add` — keep their `## Ranked queue` order by hand.)
- `dotmd runlist remove <hub> <child...>` — drop children (match by full path or short slug). `--clear-parent` also blanks each removed child's back-ref.
- `dotmd runlist reorder <hub> <child> --before|--after <other>` — move one child; or `dotmd runlist reorder <hub> <c1> <c2> <c3...>` to set a full new order (a permutation of the children).

All three take `--dry-run` / `--json`.

Each child should set `parent_plan:` pointing back at the hub — `dotmd doctor` warns when it doesn't (the mutation verbs set it for you). Order is authoritative from `runlist:`; `parent_plan` keeps the existing reverse-link semantics (pickup-card Related:, graph).

#### Coordination runlists (prose-first domain maps)

A `runlist:` array suits a small, strictly-ordered *sprint*. For a large, prose-first *coordination map* — a domain hub that points at many plans, carries gating/sequence rationale, and is sometimes unordered — set `execution_mode: coordination` instead (a `*-runlist` slug is the fallback signal). These hubs aren't folded: in `dotmd plans` they're lifted out of the leaf-plan flow into a pinned `Runlists` section and pulled out of the active count (so they read as runlists, not active plans). `dotmd briefing` and `dotmd health` apply the same reclassification — coordination hubs are pulled out of the live/active count into a `runlists` bucket (briefing) or a held-out `Runlists:` tally + section (health), so they never inflate the actionable-plan numbers or aging stats. `dotmd runlists` shows that dashboard on its own (`--json`, `--limit N`, `--sort age|recent|related|title|status` — default `age` = most stale first). The per-hub **`done/total` rollup** counts archived vs. resolved `related_plans:` children — the same progress signal sprint `runlist:` hubs show, now extended to coordination hubs (a hint, not a contract: `related_plans` is a *related* cluster that can include peer/parent runlists). `--json` also carries `doneCount`/`total`/`parkedCount`. When a hub encodes its order as **markdown links** — a `## Ranked queue` table or a `## Order of operations` link list — `dotmd runlists`/`dotmd health` surface a `next → <child>` (first **pickup-able** ranked plan — archived and parked ranks are skipped, resolved to its live status), and `dotmd runlist <hub>`/`runlist next <hub>` work on it like a sprint hub. Order encoded only as prose (backtick slugs, narrative priorities) is deliberately *not* guessed at — those hubs show no arrow, like a blank rollup. `dotmd check` nudges a `*-runlist` hub that's missing `execution_mode: coordination`.

#### Roadmaps (tier-3: composing runlists)

A roadmap is the tier *above* runlists: `execution_mode: roadmap` on a hub whose `related_plans:` point at other hubs (runlists / coordination hubs). It exists for the one thing a coordination hub can't do — **roll progress up across runlists**. Where a runlist shows its own `done/total`, a roadmap *sums* its children into a grand total (`master 280/520`), recursively (a child runlist contributes its own rollup; a leaf-plan child counts as one unit). Scaffold with `dotmd new plan <hub> --roadmap`.

- `dotmd roadmap [<hub>]` — one roadmap: each child runlist's `done/total` + that runlist's next-pickup `→`, with the recursive grand total in the header. No arg shows the sole roadmap (or the dashboard when there are several).
- `dotmd roadmaps` — the dashboard over all roadmap hubs (mirrors `dotmd runlists`).
- `dotmd roadmap [<hub>] next` — the cross-runlist next-pickup: walks the child runlists in `related_plans` (priority) order and opens the FIRST startable plan found in any of them — "what do I do next across the whole roadmap?". Skips a child runlist whose only candidates are parked/done, the same pickup gate `runlist next` uses.

Roadmaps are held out of the active-plan count like coordination hubs, and lifted into their own pinned tier ABOVE the Runlists section in `dotmd plans` / `briefing` / `health` (so they never double-count their own child runlists). `dotmd check` nudges a coordination hub whose `related_plans:` children are themselves runlists to set `execution_mode: roadmap`. The three-tier picture:

```
roadmap   → runlists, progress rolled up         ← execution_mode: roadmap
  runlist → ordered / clustered plans, done/total ← runlist: array OR execution_mode: coordination
    plan  → unit of work
```

Time horizons (now/next/later/icebox) are an *optional* body-section flavor, not the organizing axis — the tier composes by domain. (A horizon-grouped `dotmd roadmap` view is deliberately deferred until a horizon-organized roadmap actually exists; building it speculatively would repeat the prematurity the roadmap-layer plan's Phase 0 ruled against.)

### Creating documents

Signature: `dotmd new <type> <name> [body]`. `<type>` is required (defaults to `doc` if omitted).

```bash
dotmd new plan auth-revamp                       # type: plan → docs/plans/auth-revamp.md
dotmd new doc token-refresh-design               # type: doc → docs/token-refresh-design.md
dotmd new prompt cleanup-tomorrow "..."          # type: prompt → docs/prompts/cleanup-tomorrow.md
dotmd new my-doc                                 # implicit type: doc
dotmd new plan quick-fix --lite                  # trimmed plan: Problem → Phases → Version History
dotmd new plan perf-audit --audit                # findings plan: Problem → Findings (ranked) → Suggested order → Open Questions
```

Built-in types: `plan`, `doc`, `prompt`. Add more via `templates` in config.

**Plan body variants (plans only).** The default `plan` template is the full build-up shape (Problem → Goals → … → Phases → Closeout). Pass one body-variant flag for a different shape: `--lite`/`--minimal` (quick plan) or `--audit`/`--findings` (audit shape). They're mutually exclusive with each other and with the `--runlist`/`--coordination` hub flags — a plan has exactly one body shape.

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
- **Document types.** Every doc should have `type: plan|doc|prompt` (or a custom type from config). Each type has its own valid statuses. Status validation is type-aware (type > root > global).
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
