# dotmd

CLI for managing markdown documents with YAML frontmatter.

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
dotmd doctor                # auto-fix everything in one pass
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
- **Validate** — check for missing fields, broken references, stale dates, broken body links
- **Graph** — visualize document relationships as text, Graphviz DOT, or JSON
- **Lifecycle** — transition statuses, auto-archive with `git mv` and reference updates
- **Doctor** — auto-fix broken refs, lint issues, date drift, and stale indexes in one pass
- **Scaffold** — create new docs from templates (plan, ADR, RFC, audit, design)
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
related_plans:
  - ./design-doc.md
---

# Auth Token Refresh

Design doc content here...

- [x] Research existing patterns
- [ ] Implement refresh logic
- [ ] Add tests
```

The only required field is `status`. Everything else is optional but unlocks more features (staleness detection, filtering, coverage reports, graph visualization).

## Commands

```
dotmd list [--verbose]       List docs grouped by status (default)
dotmd json                   Full index as JSON
dotmd check [--errors-only] [--fix]  Validate frontmatter and references
dotmd coverage [--json]      Metadata coverage report
dotmd graph [--dot|--json]   Visualize document relationships
dotmd context                Compact briefing (LLM-oriented)
dotmd focus [status]         Detailed view for one status group
dotmd query [filters]        Filtered search
dotmd index [--write]        Generate/update docs.md index block
dotmd status <file> <status> Transition document status
dotmd archive <file>         Archive (status + move + update refs)
dotmd touch <file>           Bump updated date
dotmd touch --git            Bulk-sync dates from git history
dotmd doctor                 Auto-fix everything in one pass
dotmd fix-refs               Auto-fix broken reference paths
dotmd lint [--fix]           Check and auto-fix frontmatter issues
dotmd rename <old> <new>     Rename doc and update references
dotmd migrate <f> <old> <new>  Batch update a frontmatter field
dotmd watch [command]        Re-run a command on file changes
dotmd diff [file]            Show changes since last updated date
dotmd new <name>             Create a new document from template
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

### Scaffold with Templates

```bash
dotmd new my-feature                                  # default (status + title)
dotmd new my-plan --template plan                     # plan with module, surface, refs
dotmd new my-decision --template adr                  # ADR: Context, Decision, Consequences
dotmd new my-proposal --template rfc                  # RFC: Summary, Motivation, Design
dotmd new my-audit --template audit                   # Audit: Scope, Findings, Recommendations
dotmd new my-design --template design                 # Design: Goals, Non-Goals, Design
dotmd new my-feature --status planned --title "Title" # custom status and title
dotmd new --list-templates                            # show all available templates
```

Built-in templates: `default`, `plan`, `adr`, `rfc`, `audit`, `design`. Add custom templates in your config:

```js
export const templates = {
  spike: {
    description: 'Timeboxed investigation',
    frontmatter: (status, today) => `status: ${status}\nupdated: ${today}\ntimebox: 2d`,
    body: (title) => `\n# ${title}\n\n## Hypothesis\n\n\n\n## Findings\n\n\n`,
  },
};
```

### Check & Fix

```bash
dotmd check                  # validate everything
dotmd check --errors-only    # suppress warnings, show only errors
dotmd check --fix            # auto-fix broken refs + lint + regen index
```

Validates: required fields, status values, broken reference paths, broken body links (`[text](path.md)`), bidirectional reference symmetry, git date drift, taxonomy mismatches.

### Doctor

One command to fix everything fixable:

```bash
dotmd doctor                 # fix refs → lint → sync git dates → regen index
dotmd doctor --dry-run       # preview all changes
```

Runs in sequence: `fix-refs` → `lint --fix` → `touch --git` → `index --write` → shows remaining issues.

### Graph

Visualize how documents reference each other:

```bash
dotmd graph                              # text adjacency list
dotmd graph --dot | dot -Tpng -o g.png   # Graphviz PNG
dotmd graph --json                       # machine-readable
dotmd graph --status active,ready        # filter by status
dotmd graph --module auth                # filter by module
```

### Archive

```bash
dotmd archive docs/old-plan.md           # move + update refs + regen index
dotmd archive docs/old-plan.md -n        # preview
```

Archives a document: sets status to `archived`, moves to archive directory via `git mv`, auto-updates references in other docs, and regenerates the index.

### Touch

```bash
dotmd touch docs/my-doc.md              # set updated to today
dotmd touch --git                        # bulk-sync all docs from git history
dotmd touch --git docs/my-doc.md         # sync one file from git
```

### Fix References

```bash
dotmd fix-refs                           # find and fix broken ref paths
dotmd fix-refs --dry-run                 # preview fixes
```

Scans all reference fields for broken paths, resolves by basename matching, and rewrites frontmatter.

### Lint

```bash
dotmd lint                   # report issues
dotmd lint --fix             # fix all issues
dotmd lint --fix --dry-run   # preview fixes without writing
```

Detected issues: missing `updated`, status casing, camelCase keys, trailing whitespace, missing EOF newline.

### Rename

```bash
dotmd rename old-name.md new-name        # renames + updates refs
dotmd rename old-name.md new-name -n     # preview without writing
```

Uses `git mv` and updates all frontmatter references. Body markdown links are warned about but not auto-fixed.

### Migrate

```bash
dotmd migrate status research exploration   # rename a status
dotmd migrate module auth identity          # rename a module
```

### Preset Aliases

```js
export const presets = {
  stale: ['--status', 'active,ready', '--stale', '--sort', 'updated', '--all'],
  mine: ['--owner', 'robert', '--status', 'active', '--all'],
};
```

Then run `dotmd stale` or `dotmd mine` as shorthand.

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

export const taxonomy = {
  surfaces: ['web', 'ios', 'backend', 'api', 'platform'],
  moduleRequiredFor: ['active', 'ready', 'planned', 'blocked'],
};

export const referenceFields = {
  bidirectional: ['related_plans'],       // warn if A→B but B↛A
  unidirectional: ['supports_plans'],     // one-way, no symmetry check
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

Available: `renderContext`, `renderCompactList`, `renderCheck`, `renderGraph`, `formatSnapshot`.

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
- **Configurable everything** — statuses, taxonomy, lifecycle, validation rules, display, templates
- **Hook system** — extend with JS functions, no plugin framework to learn
- **LLM-friendly** — `dotmd context` generates compact briefings for AI assistants
- **Shell completion** — bash and zsh via `dotmd completions`

## License

MIT
