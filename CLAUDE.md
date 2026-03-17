# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

dotmd is a CLI (`dotmd-cli` on npm) for managing markdown documents with YAML frontmatter. It indexes, queries, validates, graphs, exports, and lifecycle-manages collections of `.md` files (plans, ADRs, RFCs, design docs). Built as ESM with two npm dependencies (`@notionhq/client`, `notion-to-md` for Notion integration).

## Commands

```bash
npm test                           # run all tests (node:test, 338 tests)
node --test test/frontmatter.test.mjs  # run a single test file
node bin/dotmd.mjs <command>       # run CLI locally without installing
just deploy                        # publish to npm (requires tagged commit)
```

## Full Command List

```
dotmd list [--verbose] [--json]     List docs grouped by status
dotmd json                          Full index as JSON
dotmd check [--errors-only] [--fix] [--json]  Validate frontmatter and references
dotmd coverage [--json]             Metadata coverage report
dotmd stats [--json]                Doc health dashboard
dotmd graph [--dot|--json]          Visualize document relationships
dotmd deps [file] [--json]          Dependency tree or overview
dotmd context [--summarize] [--json]  Compact briefing (LLM-oriented)
dotmd focus [status] [--json]       Detailed view for one status group
dotmd query [filters]               Filtered search (supports --summarize)
dotmd index [--write]               Generate/update docs.md index block
dotmd status <file> <status>        Transition document status (interactive prompt)
dotmd archive <file>                Archive (status + move + update refs)
dotmd touch <file>                  Bump updated date
dotmd touch --git                   Bulk-sync dates from git history
dotmd doctor                        Auto-fix everything in one pass
dotmd fix-refs                      Auto-fix broken reference paths + body links
dotmd lint [--fix]                  Check and auto-fix frontmatter issues
dotmd rename <old> <new>            Rename doc and update references
dotmd migrate <f> <old> <new>       Batch update a frontmatter field
dotmd notion import|export|sync     Notion database integration
dotmd export [--format md|html|json]  Export docs
dotmd summary <file> [--json]       AI summary of a document
dotmd diff [file] [--summarize]     Show changes since last updated date
dotmd new <name> [--template t]     Create new doc from template (adr, rfc, plan, audit, design)
dotmd watch [command]               Re-run a command on file changes
dotmd init                          Create starter config (auto-detects existing docs)
dotmd completions <shell>           Shell completion script (bash, zsh)
```

## Architecture

**Entry point:** `bin/dotmd.mjs` — CLI arg parser and command dispatcher. No framework; manual arg parsing with `process.argv`. Each command delegates to a module in `src/`. Global flags (`--config`, `--dry-run`, `--verbose`) are stripped from `restArgs` at the dispatcher level.

**Core pipeline:**
1. `config.mjs` — walks up from cwd to find `dotmd.config.mjs`, deep-merges user config with defaults, extracts function exports as hooks. Supports multi-root (`root` as string or array).
2. `frontmatter.mjs` — custom YAML frontmatter parser (no yaml library; handles key-value pairs and simple arrays only)
3. `index.mjs` — `buildIndex(config)` scans all docs roots, parses every `.md` file via `parseDocFile()`, runs validation, and returns `{ docs, countsByStatus, warnings, errors }`. Each doc is tagged with its `root`.
4. `render.mjs` — display rendering (list, context, check, coverage, stats). Each renderer supports hook override via `config.hooks.renderX(data, defaultRenderer)`

**Feature modules** (each exports a `runX()` function called from the CLI dispatcher):
- `query.mjs` — filter/sort docs by status, keyword, module, staleness, etc. Supports `--summarize` for AI summaries.
- `lifecycle.mjs` — status transitions (async, interactive prompt), archive (with `git mv` + auto ref updates), touch (single file or `--git` bulk sync)
- `lint.mjs` — detect/fix frontmatter issues: missing status (AI-inferred), missing updated, status casing, camelCase keys, comma-separated surfaces, whitespace, EOF newline
- `fix-refs.mjs` — auto-fix broken frontmatter reference paths AND body markdown links by basename matching
- `rename.mjs` — rename doc + update cross-references (async, interactive prompt for missing args)
- `migrate.mjs` — batch update a frontmatter field value across all docs
- `diff.mjs` — git diff since frontmatter `updated` date, optional AI summarization via local MLX
- `graph.mjs` — build + render document relationship graph (text, DOT, JSON)
- `deps.mjs` — dependency tree (recursive with cycle detection) or flat overview (most blocking/blocked)
- `stats.mjs` — health dashboard: status counts, staleness, freshness, completeness, checklists, audit
- `export.mjs` — export docs as concatenated markdown, static HTML site, or JSON bundle
- `notion.mjs` — Notion database import/export/bidirectional sync with property mapping
- `summary.mjs` — AI summary of a single doc via local MLX model
- `doctor.mjs` — orchestrates fix-refs → lint --fix → touch --git → index regen → check
- `new.mjs` — scaffold new docs with templates (default, plan, adr, rfc, audit, design). Async, interactive prompt.
- `init.mjs` — create starter config; auto-detects statuses, surfaces, modules, ref fields from existing docs
- `watch.mjs` — `fs.watch` loop across all roots that re-runs a command on `.md` changes

**AI module:**
- `ai.mjs` — shared MLX runner: `runMLX()`, `summarizeDocBody()`, `summarizeDiffText()`, `checkUvAvailable()`, `DEFAULT_MODEL`. Shows progress on stderr. Used by summary, query --summarize, context --summarize, lint --fix (infer-status), diff --summarize.

**Supporting modules:**
- `extractors.mjs` — pull heading, summary, checklist counts, next step, body links from markdown body. Strips fenced code blocks and inline code before link extraction.
- `validate.mjs` — per-doc validation, bidirectional reference checking, body link validation, git staleness. Unknown statuses are warnings not errors. Lifecycle enforcement skipped for unknown statuses.
- `prompt.mjs` — interactive prompts (`promptText`, `promptChoice`) for missing args. Only activates when `stdin.isTTY`.
- `git.mjs` — git subprocess helpers
- `color.mjs` — ANSI color output with TTY auto-detect and NO_COLOR support
- `util.mjs` — slug, truncate, normalize helpers, `die()`/`warn()`, `levenshtein()` for typo suggestions, `resolveDocPath()` (searches all roots)

## Key Conventions

- **Pure ESM.** All files use `.mjs` extension and `import`/`export`.
- **Dependencies:** `@notionhq/client` and `notion-to-md` for Notion integration. Everything else uses Node.js builtins.
- **Hook pattern.** Config functions are automatically detected as hooks. Renderers accept `(data, defaultRenderer)` so users can wrap or replace output. AI hooks: `summarizeDoc`, `summarizeDiff`.
- **`--dry-run` / `-n`** is supported by all mutation commands. Pass `{ dryRun }` options object to `runX()` functions.
- **`--json`** is supported by: list, check, coverage, stats, graph, deps, context, focus, query, summary, export.
- **Multi-root.** `config.root` accepts string or array. Each doc tagged with `doc.root`. `--root <name>` filters commands. Archive stays within source root.
- **Interactive prompts.** `status`, `new`, `rename` prompt for missing args when stdin is a TTY. Non-interactive falls back to `die()`.
- **Tests** use `node:test` + `node:assert` (no test framework). Test files mirror source files: `src/foo.mjs` → `test/foo.test.mjs`. 338 tests across 82 suites.
- **Config discovery** walks up the directory tree looking for `dotmd.config.mjs` or `.dotmd.config.mjs`.
- **Help text** in `bin/dotmd.mjs` HELP object must be updated whenever a command's capabilities change. Agents and users rely on `--help` to discover features.
- **Global arg stripping** happens in the CLI dispatcher — `--config <path>`, `--dry-run`, `-n`, `--verbose` are removed from `restArgs` before passing to commands.
- Preset aliases in config expand to query filter args and are dispatched as if they were built-in commands.
- "Did you mean?" typo suggestions on unknown commands using Levenshtein distance.
