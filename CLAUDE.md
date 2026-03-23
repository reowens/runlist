# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

dotmd is a CLI (`dotmd-cli` on npm) for managing markdown documents with YAML frontmatter. It indexes, queries, validates, graphs, exports, and lifecycle-manages collections of `.md` files (plans, ADRs, RFCs, design docs). Built as ESM with two npm dependencies (`@notionhq/client`, `notion-to-md` for Notion integration).

## Document Types

Every document has a `type:` field in its frontmatter. Types determine which statuses are valid and how the document appears in briefings.

| type | purpose | statuses |
|------|---------|----------|
| `plan` | Execution plans that Claude sessions work on | `in-session`, `active`, `planned`, `blocked`, `done`, `archived` |
| `doc` | Reference material, design docs, specs, ADRs, RFCs | `draft`, `active`, `review`, `reference`, `deprecated`, `archived` |
| `research` | Investigations, audits, analysis | `active`, `reference`, `archived` |

### Plan statuses explained

- **`in-session`** — A Claude instance is actively working on this plan right now. Do not pick up `in-session` plans. When you start working on a plan, set it to `in-session`. When you finish, set it to `done` or back to `active`.
- **`active`** — Ready for a Claude session to pick up and work on.
- **`planned`** — Queued for future work, not yet ready to execute.
- **`blocked`** — Cannot proceed, has blockers listed in frontmatter.
- **`done`** — Work is complete.
- **`archived`** — No longer relevant, moved to archive directory.

### Working with plans (for Claude instances)

1. Get oriented: `dotmd briefing` (compact 5-10 line summary)
2. Pick up a plan: `dotmd pickup <plan-file>` (sets in-session + prints content)
3. When done: `dotmd finish <plan-file>` (or `dotmd finish <plan-file> active` if more work needed)
4. To see all plans: `dotmd plans`
5. To see available plans: `dotmd plans --status active`
6. To see what's in flight: `dotmd plans --status in-session`
7. Never pick up a plan that is `in-session` — another session is working on it.

### Creating documents

Templates automatically set the `type:` field:

```bash
dotmd new my-plan --template plan          # type: plan
dotmd new my-doc                           # type: doc (default template)
dotmd new my-doc --template design         # type: doc
dotmd new my-doc --template adr            # type: doc
dotmd new my-doc --template rfc            # type: doc
dotmd new my-investigation --template audit # type: research
```

### Querying by type

```bash
dotmd plans                                # all plans
dotmd plans --status active                # plans ready to pick up
dotmd stale                                # stale docs across all types
dotmd actionable                           # docs with next steps
dotmd query --type doc --status active     # active docs
dotmd query --type research                # all research
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
- **Hook pattern.** Config functions are automatically detected as hooks. See `dotmd.config.example.mjs` for the full hook API.
- **`--dry-run` / `-n`** is supported by all mutation commands. Pass `{ dryRun }` options object to `runX()` functions.
- **`--json`** is supported by most read commands.
- **Multi-root.** `config.root` accepts string or array. Each doc is tagged with its `root`.
- **Interactive prompts.** `status`, `new`, `rename` prompt for missing args when stdin is a TTY.
- **Tests** use `node:test` + `node:assert`. Test files mirror source: `src/foo.mjs` → `test/foo.test.mjs`.
- **Help text** in `bin/dotmd.mjs` HELP object must stay in sync with command capabilities.
- **Global arg stripping** happens in the CLI dispatcher — `--config <path>`, `--type <t>`, `--root <name>`, `--dry-run`, `-n`, `--verbose` are removed from `restArgs` before passing to commands.
- Preset aliases in config expand to query filter args and are dispatched as if they were built-in commands.
