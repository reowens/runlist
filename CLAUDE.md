# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

dotmd is a CLI (`dotmd-cli` on npm) for managing markdown documents with YAML frontmatter. It indexes, queries, validates, graphs, exports, and lifecycle-manages collections of `.md` files (plans, ADRs, RFCs, design docs). Built as ESM with two npm dependencies (`@notionhq/client`, `notion-to-md` for Notion integration).

## Document Types

Every document has a `type:` field in its frontmatter. Types determine which statuses are valid and how the document appears in briefings.

| type | purpose | statuses |
|------|---------|----------|
| `plan` | Execution plans that Claude sessions work on | `in-session`, `active`, `planned`, `blocked`, `partial`, `paused`, `awaiting`, `queued-after`, `archived` |
| `doc` | Reference material, design docs, specs, ADRs, RFCs, investigations | `draft`, `active`, `review`, `reference`, `deprecated`, `archived` |
| `prompt` | Saved prompts that seed future sessions (body required) | `pending`, `claimed`, `archived` |

### Plan statuses explained

Each stop-status maps to a distinct **unstuck-action** — that's the test for whether the status earns its keep.

- **`in-session`** — A Claude instance is actively working on this plan right now. Do not pick up `in-session` plans. When you start working on a plan, set it to `in-session`.
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

1. Get oriented: `dotmd briefing` (compact 5-10 line summary)
2. Pick up a plan: `dotmd pickup <plan-file>` (sets in-session + prints content + writes session lease)
3. When done — pick the right closure status:
   - Fully shipped → `dotmd archive <plan-file>` (auto-releases lease)
   - Shipped + tail deferred (with successor plans referenced) → `dotmd status <plan-file> partial` then `dotmd release`
   - Need more work later → `dotmd release` (flips back to prior status — usually `active`)
   - Stuck on a human decision → `dotmd status <plan-file> awaiting` then `dotmd release`
4. To see all plans: `dotmd plans`
5. To see available plans: `dotmd plans --status active`
6. To see what's in flight: `dotmd plans --status in-session`
7. Picking up an `in-session` plan that you already own (e.g., after `/clear` or auto-compaction) silently re-attaches — no conflict. Picking up one held by another live session refuses; a stale lease (dead pid or >24h) suggests `--takeover`.
8. If your Claude Code `~/.claude/settings.json` has the `SessionEnd` hook configured (`dotmd release`), graceful session-end auto-releases your leases. Otherwise call `dotmd release` before finishing the session.

### Resume prompts (saved for future sessions)

When the user asks for a resume prompt — or when context is getting tight and you're about to stop mid-work — DO NOT print the resume text into chat for them to copy-paste. Save it as a prompt:

```bash
dotmd prompts new resume-<plan-slug> - <<'EOF'
…your resume prompt here: state, what's done, what's next, key files, gotchas…
EOF
```

The prompt lands under `docs/prompts/<name>.md` with `status: pending`. The next session runs `dotmd hud` (the SessionStart hook), sees the pending prompt, and consumes it with `dotmd prompts use <file>` (or `dotmd prompts next` for the oldest). That command atomically prints the body and archives the prompt so it can't be double-consumed.

Use this whenever you'd otherwise print a multi-line "here's how to resume" block.

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
dotmd new prompt cleanup "look at remaining lint warnings"
dotmd new prompt resume-foo - <<'EOF'
multi-line body
EOF
```

Saved prompts have their own status vocab (`pending`, `claimed`, `archived`) and a dedicated command family (`dotmd prompts list|next|use|archive`). `dotmd prompts next` prints + claims the oldest pending prompt — useful when a session boots and needs an instruction.

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
dotmd context --type plan                  # briefing filtered to plans
```

The `--type` flag works as a global filter on most commands: `list`, `json`, `check`, `context`, `focus`, `query`, `coverage`, `stats`, `graph`, `index`, `export`.

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
