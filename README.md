# dotmd

Zero-dependency CLI for managing markdown documents with YAML frontmatter.

Index, query, validate, and lifecycle-manage any collection of `.md` files — plans, ADRs, RFCs, design docs, meeting notes. Built for AI-assisted development workflows where structured docs need to stay current.

## Install

```bash
npm install -g dotmd-cli
```

## Quick Start

```bash
dotmd init              # creates dotmd.config.mjs + docs/ + docs/README.md
dotmd list              # index all docs grouped by status
dotmd check             # validate frontmatter and references
dotmd context           # compact briefing (great for LLM context)
```

## What It Does

dotmd scans a directory of markdown files, parses their YAML frontmatter, and gives you tools to work with them:

- **Index** — group docs by status, show progress bars, next steps
- **Query** — filter by status, keyword, module, surface, owner, staleness
- **Validate** — check for missing fields, broken references, stale dates
- **Lifecycle** — transition statuses, auto-archive with `git mv`, bump dates
- **README generation** — auto-generate an index block in your README
- **Context briefing** — compact summary designed for AI/LLM consumption

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
dotmd list [--verbose]       List docs grouped by status
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
dotmd init                   Create starter config + docs directory
```

### Query Filters

```bash
dotmd query --status active,ready --module auth
dotmd query --keyword "token" --has-next-step
dotmd query --stale --sort updated --all
dotmd query --surface backend --checklist-open
```

Flags: `--status`, `--keyword`, `--module`, `--surface`, `--domain`, `--owner`, `--updated-since`, `--stale`, `--has-next-step`, `--has-blockers`, `--checklist-open`, `--sort`, `--limit`, `--all`, `--git`, `--json`.

### Preset Aliases

Define custom query presets in your config:

```js
export const presets = {
  stale: ['--status', 'active,ready', '--stale', '--sort', 'updated', '--all'],
  mine: ['--owner', 'robert', '--status', 'active', '--all'],
};
```

Then run `dotmd stale` or `dotmd mine` as shorthand.

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

export const readme = {
  path: 'docs/plans/README.md',
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

Available: `onArchive`, `onStatusChange`, `onTouch`.

## Features

- **Zero dependencies** — pure Node.js builtins (`fs`, `path`, `child_process`)
- **No build step** — ships as plain ESM, runs directly
- **Git-aware** — detects frontmatter date drift vs git history, uses `git mv` for archives
- **Configurable everything** — statuses, taxonomy, lifecycle, validation rules, display
- **Hook system** — extend with JS functions, no plugin framework to learn
- **LLM-friendly** — `dotmd context` generates compact briefings for AI assistants

## License

MIT
