# dotmd

Zero-dependency CLI for managing markdown documents with YAML frontmatter.

Index, query, validate, and lifecycle-manage any collection of `.md` files — plans, ADRs, RFCs, design docs, meeting notes. Built for AI-assisted development workflows where structured docs need to stay current.

## Install

```bash
npm install -g dotmd-cli    # global — use `dotmd` anywhere
npm install -D dotmd-cli    # project devDep — use via npm scripts
```

## Quick Start

```bash
dotmd init                  # creates dotmd.config.mjs, docs/, docs/docs.md
dotmd new my-feature        # scaffold a new doc with frontmatter
dotmd list                  # index all docs grouped by status
dotmd check                 # validate frontmatter and references
dotmd context               # compact briefing (great for LLM context)
```

### Shell Completion

```bash
# bash
eval "$(dotmd completions bash)"    # add to ~/.bashrc

# zsh
eval "$(dotmd completions zsh)"     # add to ~/.zshrc
```

## What It Does

dotmd scans a directory of markdown files, parses their YAML frontmatter, and gives you tools to work with them:

- **Index** — group docs by status, show progress bars, next steps
- **Query** — filter by status, keyword, module, surface, owner, staleness
- **Validate** — check for missing fields, broken references, stale dates
- **Lifecycle** — transition statuses, auto-archive with `git mv`, bump dates
- **Scaffold** — create new docs with frontmatter from the command line
- **Index generation** — auto-generate a `docs.md` index block
- **Context briefing** — compact summary designed for AI/LLM consumption
- **Dry-run** — preview any mutation with `--dry-run` before committing

## Document Format

Any `.md` file with YAML frontmatter:

```markdown
---
status: active
updated: 2026-03-14
module: auth
surface: backend
next_step: implement token refresh
current_state: initial scaffolding complete
---

# Auth Token Refresh

Design doc content here...

- [x] Research existing patterns
- [ ] Implement refresh logic
- [ ] Add tests
```

The only required field is `status`. Everything else is optional but unlocks more features (staleness detection, filtering, coverage reports).

## Commands

```
dotmd list [--verbose]       List docs grouped by status (default)
dotmd json                   Full index as JSON
dotmd check                  Validate frontmatter and references
dotmd coverage [--json]      Metadata coverage report
dotmd context                Compact briefing (LLM-oriented)
dotmd focus [status]         Detailed view for one status group
dotmd query [filters]        Filtered search
dotmd index [--write]        Generate/update docs.md index block
dotmd status <file> <status> Transition document status
dotmd archive <file>         Archive (status + move + index regen)
dotmd touch <file>           Bump updated date
dotmd lint [--fix]           Check and auto-fix frontmatter issues
dotmd rename <old> <new>     Rename doc and update references
dotmd migrate <f> <old> <new>  Batch update a frontmatter field
dotmd watch [command]        Re-run a command on file changes
dotmd diff [file]            Show changes since last updated date
dotmd new <name>             Create a new document with frontmatter
dotmd init                   Create starter config + docs directory
dotmd completions <shell>    Output shell completion script (bash, zsh)
```

### Global Flags

```
--config <path>        Explicit config file path
--dry-run, -n          Preview changes without writing anything
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
```

Flags: `--status`, `--keyword`, `--module`, `--surface`, `--domain`, `--owner`, `--updated-since`, `--stale`, `--has-next-step`, `--has-blockers`, `--checklist-open`, `--sort`, `--limit`, `--all`, `--git`, `--json`.

### Scaffold a Document

```bash
dotmd new my-feature                          # creates docs/my-feature.md (status: active)
dotmd new "API Redesign" --status planned     # custom status
dotmd new auth-refresh --title "Auth Refresh" # custom title
dotmd new something --dry-run                 # preview without creating
```

### Preset Aliases

Define custom query presets in your config:

```js
export const presets = {
  stale: ['--status', 'active,ready', '--stale', '--sort', 'updated', '--all'],
  mine: ['--owner', 'robert', '--status', 'active', '--all'],
};
```

Then run `dotmd stale` or `dotmd mine` as shorthand.

### Lint

Check docs for fixable frontmatter issues and optionally auto-fix them:

```bash
dotmd lint                   # report issues
dotmd lint --fix             # fix all issues
dotmd lint --fix --dry-run   # preview fixes without writing
```

Detected issues:
- Missing `updated` date on non-archived docs
- Status casing mismatch (e.g., `Active` → `active`)
- camelCase frontmatter keys (e.g., `nextStep` → `next_step`)
- Trailing whitespace in frontmatter values
- Missing newline at end of file

### Rename

Rename a document and update all frontmatter references across your docs:

```bash
dotmd rename old-name.md new-name        # renames + updates refs
dotmd rename old-name.md new-name -n     # preview without writing
```

Uses `git mv` for the rename and scans all reference fields for the old filename. Body markdown links are warned about but not auto-fixed.

### Migrate

Batch update a frontmatter field value across all docs:

```bash
dotmd migrate status research exploration   # rename a status
dotmd migrate module auth identity          # rename a module
dotmd migrate module auth identity -n       # preview
```

### Watch Mode

```bash
dotmd watch              # re-run list on every .md change
dotmd watch check        # live validation
dotmd watch context      # live briefing
```

### Diff & Summarize

Show git changes since each document's `updated` frontmatter date:

```bash
dotmd diff                           # all drifted docs
dotmd diff docs/plans/auth.md        # single file
dotmd diff --stat                    # summary stats only
dotmd diff --since 2026-01-01        # override date
dotmd diff --summarize               # AI summary via local MLX model
dotmd diff --summarize --model mlx-community/Mistral-7B-Instruct-v0.3-4bit
```

The `--summarize` flag requires `uv` and a local MLX-compatible model. No JS dependencies are added.

## Configuration

Create `dotmd.config.mjs` at your project root (or run `dotmd init`):

```js
export const root = 'docs/plans';         // where your .md files live
export const archiveDir = 'archived';     // subdirectory for archived docs

export const statuses = {
  order: ['draft', 'active', 'approved', 'superseded', 'archived'],
  staleDays: { draft: 7, active: 14, approved: 30 },
};

export const lifecycle = {
  archiveStatuses: ['archived'],          // auto-move to archiveDir
  skipStaleFor: ['archived'],
  skipWarningsFor: ['archived'],
};

export const index = {
  path: 'docs/docs.md',
  startMarker: '<!-- GENERATED:dotmd:start -->',
  endMarker: '<!-- GENERATED:dotmd:end -->',
};
```

All exports are optional. See [`dotmd.config.example.mjs`](dotmd.config.example.mjs) for the full reference.

Config discovery walks up from cwd looking for `dotmd.config.mjs` or `.dotmd.config.mjs`.

## Hooks

Hooks are function exports in your config file. They let you extend validation, customize rendering, and react to lifecycle events.

### Custom Validation

```js
export function validate(doc, ctx) {
  const warnings = [];
  if (doc.status === 'active' && !doc.owner) {
    warnings.push({
      path: doc.path,
      level: 'warning',
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

Available: `renderContext`, `renderCompactList`, `renderCheck`, `formatSnapshot`.

### Lifecycle Hooks

```js
export function onArchive(doc, { oldPath, newPath }) {
  console.log(`Archived: ${oldPath} → ${newPath}`);
}

export function onStatusChange(doc, { oldStatus, newStatus }) {
  // notify, log, trigger CI, etc.
}
```

Available: `onArchive`, `onStatusChange`, `onTouch`, `onNew`, `onRename`, `onLint`.

### Summarize Hook

Override the diff summarizer (replaces the default MLX model call):

```js
export function summarizeDiff(diffOutput, filePath) {
  // call your preferred LLM, return a string summary
  return `Changes in ${filePath}: ...`;
}
```

## Features

- **Zero dependencies** — pure Node.js builtins (`fs`, `path`, `child_process`)
- **No build step** — ships as plain ESM, runs directly
- **Git-aware** — detects frontmatter date drift vs git history, uses `git mv` for archives
- **Dry-run everything** — preview any mutation with `--dry-run` / `-n`
- **Configurable everything** — statuses, taxonomy, lifecycle, validation rules, display
- **Hook system** — extend with JS functions, no plugin framework to learn
- **LLM-friendly** — `dotmd context` generates compact briefings for AI assistants
- **Shell completion** — bash and zsh via `dotmd completions`

## License

MIT
