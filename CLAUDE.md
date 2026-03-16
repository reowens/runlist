# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

dotmd is a zero-dependency CLI (`dotmd-cli` on npm) for managing markdown documents with YAML frontmatter. It indexes, queries, validates, and lifecycle-manages collections of `.md` files (plans, ADRs, RFCs, design docs). Built as pure ESM using only Node.js builtins (`fs`, `path`, `child_process`).

## Commands

```bash
npm test                           # run all tests (node:test)
node --test test/frontmatter.test.mjs  # run a single test file
node bin/dotmd.mjs <command>       # run CLI locally without installing
```

## Architecture

**Entry point:** `bin/dotmd.mjs` — CLI arg parser and command dispatcher. No framework; manual arg parsing with `process.argv`. Each command delegates to a module in `src/`.

**Core pipeline:**
1. `config.mjs` — walks up from cwd to find `dotmd.config.mjs`, deep-merges user config with defaults, extracts function exports as hooks
2. `frontmatter.mjs` — custom YAML frontmatter parser (no yaml library; handles key-value pairs and simple arrays only)
3. `index.mjs` — `buildIndex(config)` scans the docs directory, parses every `.md` file via `parseDocFile()`, runs validation, and returns `{ docs, countsByStatus, warnings, errors }`
4. `render.mjs` — all display rendering (list, context, check, coverage). Each renderer supports hook override via `config.hooks.renderX(index, defaultRenderer)`

**Feature modules** (each exports a `runX()` function called from the CLI dispatcher):
- `query.mjs` — filter/sort docs by status, keyword, module, staleness, etc.
- `lifecycle.mjs` — status transitions, archive (with `git mv`), touch
- `lint.mjs` — detect/fix frontmatter issues (casing, camelCase keys, whitespace, missing dates)
- `rename.mjs` — rename doc + update cross-references in other docs' frontmatter
- `migrate.mjs` — batch update a frontmatter field value across all docs
- `diff.mjs` — git diff since frontmatter `updated` date, optional AI summarization via local MLX
- `watch.mjs` — `fs.watch` loop that re-runs a command on `.md` changes
- `new.mjs` / `init.mjs` — scaffolding

**Supporting modules:**
- `extractors.mjs` — pull heading, summary, checklist counts, next step from markdown body
- `validate.mjs` — per-doc validation, bidirectional reference checking, git staleness
- `git.mjs` — git subprocess helpers
- `color.mjs` — ANSI color output
- `util.mjs` — slug, truncate, normalize helpers, `die()`/`warn()`

## Key Conventions

- **Zero dependencies.** Do not add npm packages. All functionality uses Node.js builtins.
- **Pure ESM.** All files use `.mjs` extension and `import`/`export`.
- **Hook pattern.** Config functions are automatically detected as hooks. Renderers accept `(data, defaultRenderer)` so users can wrap or replace output.
- **`--dry-run` / `-n`** is supported by all mutation commands. Pass `{ dryRun }` options object to `runX()` functions.
- **Tests** use `node:test` + `node:assert` (no test framework). Test files mirror source files: `src/foo.mjs` → `test/foo.test.mjs`.
- **Config discovery** walks up the directory tree looking for `dotmd.config.mjs` or `.dotmd.config.mjs`.
- Preset aliases in config expand to query filter args and are dispatched as if they were built-in commands.
