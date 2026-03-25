# dotmd

CLI for managing markdown documents with YAML frontmatter.

Index, query, validate, and lifecycle-manage any collection of `.md` files — plans, ADRs, RFCs, design docs, meeting notes. Built for AI-assisted development workflows where structured docs need to stay current.

## Install

```bash
npm install -g dotmd-cli    # global — use `dotmd` anywhere
npm install -D dotmd-cli    # project devDep — use via npm scripts
# requires Node.js >= 20
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

- **Index** — group docs by status, show progress bars, next steps
- **Query** — filter by status, keyword, module, surface, owner, staleness
- **Validate** — check for missing fields, broken references, broken body links, stale dates
- **Stats** — health dashboard with staleness, completeness, audit coverage
- **Graph** — visualize document relationships as text, Graphviz DOT, or JSON
- **Deps** — dependency tree or overview of what blocks what
- **Unblocks** — impact analysis: what depends on a doc
- **Health** — plan velocity, aging, pipeline status
- **Glossary** — domain term lookup with related docs
- **Lifecycle** — transition statuses, auto-archive with `git mv` and reference updates
- **Doctor** — auto-fix broken refs, lint issues, date drift, and stale indexes in one pass
- **Scaffold** — create new docs from templates (plan, ADR, RFC, audit, design)
- **AI summaries** — summarize docs via local MLX model or custom hook
- **Export** — generate concatenated markdown, static HTML site, or JSON bundle
- **Notion** — import from, export to, and bidirectionally sync with Notion databases
- **Multi-root** — manage docs across multiple directories with a single config
- **Context briefing** — compact summary designed for AI/LLM consumption
- **Dry-run** — preview any mutation with `--dry-run` before committing

## Document Format

Any `.md` file with YAML frontmatter:

```markdown
---
type: doc
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

The only required field is `status`. Everything else is optional but unlocks more features. The `type` field (`plan`, `doc`, or `research`) enables type-specific statuses and smarter context briefings.

## Document Types

Every document can have a `type` field in its frontmatter. Types determine which statuses are valid and how the document appears in context briefings.

| Type | Purpose | Valid Statuses |
|------|---------|----------------|
| `plan` | Execution plans | `in-session`, `active`, `planned`, `blocked`, `done`, `archived` |
| `doc` | Design docs, specs, ADRs, RFCs | `draft`, `active`, `review`, `reference`, `deprecated`, `archived` |
| `research` | Investigations, audits, analysis | `active`, `reference`, `archived` |

Documents without a `type` field use the global `statuses.order` from config.

Templates auto-set the type: `--template plan` sets `type: plan`, `--template adr` sets `type: doc`, `--template audit` sets `type: research`.

Filter by type with `--type`:

```bash
dotmd query --type plan --status active   # active plans
dotmd list --type doc                     # all docs
dotmd export --type research              # export research only
```

Customize types and their statuses in config with the `types` key. See [`dotmd.config.example.mjs`](dotmd.config.example.mjs).

## Commands

```
dotmd list [--verbose]       List docs grouped by status (default)
dotmd json                   Full index as JSON
dotmd check [flags]          Validate frontmatter and references
dotmd coverage [--json]      Metadata coverage report
dotmd stats [--json]         Doc health dashboard
dotmd graph [--dot|--json]   Visualize document relationships
dotmd deps [file]            Dependency tree or overview
dotmd unblocks <file>        Show what depends on this doc
dotmd health [--json]        Plan velocity, aging, and pipeline
dotmd briefing               Compact summary for session start
dotmd context [--summarize]  Full briefing (LLM-oriented)
dotmd focus [status]         Detailed view for one status group
dotmd query [filters]        Filtered search
dotmd plans                  List all plans
dotmd stale                  List stale docs
dotmd actionable             List docs with next steps
dotmd index [--write]        Generate/update docs.md index block
dotmd pickup <file>          Pick up a plan (in-session + print)
dotmd finish <file>          Finish a plan (done or active)
dotmd status <file> <status> Transition document status
dotmd archive <file>         Archive (status + move + update refs)
dotmd bulk archive <files>   Archive multiple files at once
dotmd touch <file>           Bump updated date
dotmd touch --git            Bulk-sync dates from git history
dotmd doctor                 Auto-fix everything in one pass
dotmd fix-refs               Auto-fix broken reference paths
dotmd lint [--fix]           Check and auto-fix frontmatter issues
dotmd rename <old> <new>     Rename doc and update references
dotmd migrate <f> <old> <new>  Batch update a frontmatter field
dotmd notion <sub> [db-id]   Notion import/export/sync
dotmd export [file]          Export docs as md, html, or json
dotmd summary <file>         AI summary of a document
dotmd glossary <term>        Look up domain terms + related docs
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
--root <name>          Filter to a specific docs root
--type <t1,t2>         Filter by document type (plan, doc, research)
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
dotmd query --status active --summarize             # AI summaries
dotmd query --status active --summarize --summarize-limit 3
```

Flags: `--type`, `--status`, `--keyword`, `--module`, `--surface`, `--domain`, `--owner`, `--updated-since`, `--stale`, `--has-next-step`, `--has-blockers`, `--checklist-open`, `--sort`, `--limit`, `--all`, `--git`, `--json`, `--summarize`, `--summarize-limit`, `--model`.

### Scaffold with Templates

```bash
dotmd new my-feature                                  # default (status + title)
dotmd new my-plan --template plan                     # plan with module, surface, refs
dotmd new my-decision --template adr                  # ADR: Context, Decision, Consequences
dotmd new my-proposal --template rfc                  # RFC: Summary, Motivation, Design
dotmd new my-audit --template audit                   # Audit: Scope, Findings, Recommendations
dotmd new my-design --template design                 # Design: Goals, Non-Goals, Design
dotmd new my-feature --status planned --title "Title" # custom status and title
dotmd new my-doc --root modules                       # create in a specific root
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

### Stats

```bash
dotmd stats                  # health dashboard
dotmd stats --json           # machine-readable
```

Shows: status counts, staleness, errors/warnings, freshness (today/week/month), completeness (owner/surface/module/next_step), checklist progress, audit coverage.

### Doctor

```bash
dotmd doctor                 # fix refs → lint → sync git dates → regen index
dotmd doctor --dry-run       # preview all changes
```

### Graph

```bash
dotmd graph                              # text adjacency list
dotmd graph --dot | dot -Tpng -o g.png   # Graphviz PNG
dotmd graph --json                       # machine-readable
dotmd graph --status active,ready        # filter by status
dotmd graph --module auth                # filter by module
```

### Deps

```bash
dotmd deps                               # overview: most blocking, most blocked
dotmd deps docs/plan-a.md                # tree: depends-on + depended-on-by
dotmd deps docs/plan-a.md --depth 2      # limit tree depth
dotmd deps --json                        # machine-readable
```

### Unblocks

```bash
dotmd unblocks docs/plan-a.md            # what depends on this plan
dotmd unblocks docs/plan-a.md --json     # machine-readable
```

### Health

```bash
dotmd health                             # plan pipeline and aging
dotmd health --json                      # machine-readable
```

### Briefing

```bash
dotmd briefing                           # compact 5-10 line summary
dotmd briefing --json                    # machine-readable
```

### AI Summaries

```bash
dotmd summary docs/plan-a.md             # AI summary of a single doc
dotmd summary docs/plan-a.md --json      # JSON output
dotmd query --status active --summarize  # AI summaries in query results
dotmd context --summarize                # AI-enhanced briefing
```

Uses a local model by default. Override with `--model <name>` or the `summarizeDoc` hook.

### Glossary

```bash
dotmd glossary "auth token"              # look up a term
dotmd glossary --list                    # list all terms
dotmd glossary --json                    # machine-readable
```

### Export

```bash
dotmd export                             # all docs as concatenated markdown
dotmd export --format html --output site # static HTML site
dotmd export --format json > bundle.json # JSON bundle with bodies
dotmd export docs/plan-a.md              # single doc + dependencies
dotmd export --status active             # filtered export
dotmd export --type plan                 # export only plans
```

### Notion Integration

```bash
dotmd notion import <database-id>        # pull Notion database → local .md files
dotmd notion export <database-id>        # push local docs → Notion database
dotmd notion sync <database-id>          # bidirectional sync (newer wins)
dotmd notion import <db-id> --force      # overwrite existing files
dotmd notion sync <db-id> --dry-run      # preview sync actions
```

Requires `NOTION_TOKEN` env var or `notion.token` in config. Maps Notion properties (select, multi_select, date, status, people, etc.) to YAML frontmatter fields. Configure property mapping in config:

```js
export const notion = {
  token: process.env.NOTION_TOKEN,
  database: 'your-database-id',
  propertyMap: {
    'Status': 'status',
    'Last Updated': 'updated',
    'Tags': 'surfaces',
  },
};
```

### Multi-Root

Manage docs across multiple directories:

```js
export const root = ['docs/plans', 'docs/modules', 'docs/app'];
```

All commands work across all roots. Filter with `--root`:

```bash
dotmd list --root plans                  # only docs from docs/plans
dotmd stats --root modules               # stats for modules only
dotmd new my-doc --root modules          # create in docs/modules
```

Archive stays within the source file's root. Cross-root references validate correctly.

### Archive

```bash
dotmd archive docs/old-plan.md           # move + update refs + regen index
dotmd archive docs/old-plan.md -n        # preview
```

### Bulk Archive

```bash
dotmd bulk archive docs/old-a.md docs/old-b.md   # archive multiple
dotmd bulk archive docs/old-*.md -n               # preview
```

### Pickup & Finish

```bash
dotmd pickup docs/plans/my-plan.md       # set in-session + print content
dotmd finish docs/plans/my-plan.md       # set done + bump date
dotmd finish docs/plans/my-plan.md active  # back to active for more work
```

### Touch

```bash
dotmd touch docs/my-doc.md              # set updated to today
dotmd touch --git                        # bulk-sync all docs from git history
```

### Fix References

```bash
dotmd fix-refs                           # fix broken frontmatter refs + body links
dotmd fix-refs --dry-run                 # preview fixes
```

### Lint

```bash
dotmd lint                   # report issues
dotmd lint --fix             # fix all issues
```

### Rename

```bash
dotmd rename old-name.md new-name        # renames + updates refs
```

### Migrate

```bash
dotmd migrate status research exploration   # rename a status
dotmd migrate module auth identity          # rename a module
```

### Preset Aliases

Built-in presets: `plans`, `stale`, `actionable`. Add your own in config:

```js
export const presets = {
  mine: ['--owner', 'robert', '--status', 'active', '--all'],
  blocked: ['--status', 'blocked', '--all'],
};
```

Then run `dotmd mine` or `dotmd blocked` as shorthand. All presets support query flags (`--json`, `--sort`, etc.).

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

### Init Auto-Detect

When `dotmd init` runs in a directory with existing `.md` files, it scans them and pre-populates the config with discovered statuses, surfaces, modules, and reference fields.

## Configuration

Create `dotmd.config.mjs` at your project root (or run `dotmd init`).

### Rich status definitions (recommended)

Define each status as an object that co-locates all behavioral properties. Adding a new status is one line in one place — no need to update separate `lifecycle`, `staleDays`, `context`, or `taxonomy` sections.

```js
export const root = 'docs/plans';
export const archiveDir = 'archived';

export const types = {
  plan: {
    statuses: {
      'active':   { context: 'expanded', staleDays: 14, requiresModule: true },
      'planned':  { context: 'listed', staleDays: 30, requiresModule: true },
      'blocked':  { context: 'listed', staleDays: 30, skipStale: true },
      'archived': { context: 'counted', archive: true, terminal: true, skipStale: true, skipWarnings: true },
    },
  },
};
```

**Status properties:**

| Property | Type | Default | Effect |
|---|---|---|---|
| `context` | `'expanded'` \| `'listed'` \| `'counted'` | `'counted'` | Display mode in `dotmd context` |
| `staleDays` | `number` \| `null` | `null` | Days before doc is stale (`null` = never) |
| `requiresModule` | `boolean` | `false` | Require `module` in frontmatter |
| `terminal` | `boolean` | `false` | Skip `current_state`/`next_step` warnings |
| `archive` | `boolean` | `false` | Auto-move to `archiveDir` on transition |
| `skipStale` | `boolean` | `false` | Exempt from stale checks |
| `skipWarnings` | `boolean` | `false` | Exempt from validation warnings |

Object key order determines display order. The config resolver derives `statuses.order`, `lifecycle.*`, `taxonomy.moduleRequiredFor`, and `context.*` from these definitions. Explicit global sections still win when provided.

### Array form (also supported)

The traditional array form remains fully backwards compatible:

```js
export const types = {
  plan: {
    statuses: ['active', 'planned', 'blocked', 'archived'],
    context: { expanded: ['active'], listed: ['planned', 'blocked'], counted: ['archived'] },
    staleDays: { active: 14, planned: 30, blocked: 30 },
  },
};

// When using array form, define behavior in separate sections:
export const statuses = {
  order: ['active', 'planned', 'blocked', 'archived'],
  staleDays: { active: 14, planned: 30, blocked: 30 },
};

export const lifecycle = {
  archiveStatuses: ['archived'],
  skipStaleFor: ['archived'],
  skipWarningsFor: ['archived'],
  terminalStatuses: ['archived'],
};

export const taxonomy = {
  moduleRequiredFor: ['active', 'planned', 'blocked'],
};
```

### Other config

```js
export const taxonomy = {
  surfaces: ['web', 'ios', 'backend', 'api', 'platform'],
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

All exports are optional. Additional options: `context`, `display`, `presets`, `templates`, `excludeDirs`, `notion`. See [`dotmd.config.example.mjs`](dotmd.config.example.mjs) for the full reference.

Config discovery walks up from cwd looking for `dotmd.config.mjs` or `.dotmd.config.mjs`.

## Hooks

Hooks are function exports in your config file. They let you extend validation, customize rendering, and react to lifecycle events.

### Custom Validation

```js
export function validate(doc, ctx) {
  const warnings = [];
  if (doc.status === 'active' && !doc.owner) {
    warnings.push({
      path: doc.path, level: 'warning',
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

Available: `renderContext`, `renderCompactList`, `renderCheck`, `renderGraph`, `renderStats`, `formatSnapshot`.

### Lifecycle Hooks

```js
export function onArchive(doc, { oldPath, newPath }) {
  console.log(`Archived: ${oldPath} → ${newPath}`);
}
```

Available: `onArchive`, `onStatusChange`, `onTouch`, `onNew`, `onRename`, `onLint`.

### Transform Hooks

```js
// Add computed fields to every doc after parsing
export function transformDoc(doc) {
  doc.priority = doc.blockers?.length ? 'high' : 'normal';
  return doc;
}
```

### AI Hooks

```js
// Override doc summarization (replaces local MLX model)
export function summarizeDoc(body, meta) {
  return 'Custom summary for ' + meta.title;
}

// Override diff summarization
export function summarizeDiff(diffOutput, filePath) {
  return `Changes in ${filePath}: ...`;
}
```

## Features

- **Git-aware** — detects frontmatter date drift vs git history, uses `git mv` for archives
- **Dry-run everything** — preview any mutation with `--dry-run` / `-n`
- **Multi-root** — manage docs across multiple directories with `--root` filtering
- **Configurable** — statuses, taxonomy, lifecycle, validation rules, display, templates
- **Hook system** — extend with JS functions, no plugin framework to learn
- **AI-powered** — local MLX summaries for docs, queries, diffs, and context briefings
- **Notion sync** — import, export, and bidirectional sync with Notion databases
- **LLM-friendly** — `dotmd context` generates compact briefings for AI assistants
- **Shell completion** — bash and zsh via `dotmd completions`

## License

MIT
