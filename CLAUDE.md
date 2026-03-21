# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

dotmd is a CLI (`dotmd-cli` on npm) for managing markdown documents with YAML frontmatter. It indexes, queries, validates, graphs, exports, and lifecycle-manages collections of `.md` files (plans, ADRs, RFCs, design docs). Built as ESM with two npm dependencies (`@notionhq/client`, `notion-to-md` for Notion integration).

## Commands

```bash
npm test                           # run all tests (node:test)
node --test test/frontmatter.test.mjs  # run a single test file
node bin/dotmd.mjs <command>       # run CLI locally without installing
```

Run `dotmd --help` or `dotmd <command> --help` for the full command list and options.

## Architecture

**Entry point:** `bin/dotmd.mjs` — CLI arg parser and command dispatcher. Each command delegates to a module in `src/`.

**Core modules:** `config.mjs` (config discovery + defaults), `frontmatter.mjs` (YAML parser), `index.mjs` (doc scanner + validator), `render.mjs` (display output).

**Feature modules** in `src/` each export a `runX()` function called from the CLI dispatcher. See `bin/dotmd.mjs` imports for the full list.

**Supporting modules:** `extractors.mjs`, `validate.mjs`, `prompt.mjs`, `git.mjs`, `color.mjs`, `util.mjs`, `ai.mjs`.

## Key Conventions

- **Pure ESM.** All files use `.mjs` extension and `import`/`export`.
- **Minimal dependencies.** Everything beyond Notion integration uses Node.js builtins.
- **Hook pattern.** Config functions are automatically detected as hooks. See `dotmd.config.example.mjs` for the full hook API.
- **`--dry-run` / `-n`** is supported by all mutation commands. Pass `{ dryRun }` options object to `runX()` functions.
- **`--json`** is supported by most read commands.
- **Multi-root.** `config.root` accepts string or array. Each doc is tagged with its `root`.
- **Interactive prompts.** `status`, `new`, `rename` prompt for missing args when stdin is a TTY.
- **Tests** use `node:test` + `node:assert`. Test files mirror source: `src/foo.mjs` → `test/foo.test.mjs`.
- **Help text** in `bin/dotmd.mjs` HELP object must stay in sync with command capabilities.
- **Global arg stripping** happens in the CLI dispatcher — `--config <path>`, `--dry-run`, `-n`, `--verbose` are removed from `restArgs` before passing to commands.
- Preset aliases in config expand to query filter args and are dispatched as if they were built-in commands.
