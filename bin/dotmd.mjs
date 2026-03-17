#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { buildIndex } from '../src/index.mjs';
import { renderCompactList, renderVerboseList, renderContext, renderCheck, renderCoverage, buildCoverage } from '../src/render.mjs';
import { renderIndexFile, writeIndex } from '../src/index-file.mjs';
import { runFocus, runQuery } from '../src/query.mjs';
import { runStatus, runArchive, runTouch } from '../src/lifecycle.mjs';
import { runInit } from '../src/init.mjs';
import { runNew } from '../src/new.mjs';
import { runCompletions } from '../src/completions.mjs';
import { runWatch } from '../src/watch.mjs';
import { runDiff } from '../src/diff.mjs';
import { runLint } from '../src/lint.mjs';
import { runRename } from '../src/rename.mjs';
import { runMigrate } from '../src/migrate.mjs';
import { runFixRefs, fixBrokenRefs } from '../src/fix-refs.mjs';
import { buildGraph, renderGraphText, renderGraphDot, renderGraphJson } from '../src/graph.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { buildStats, renderStats, renderStatsJson } from '../src/stats.mjs';
import { runSummary } from '../src/summary.mjs';
import { runDeps } from '../src/deps.mjs';
import { runExport } from '../src/export.mjs';
import { runNotion } from '../src/notion.mjs';
import { die, warn, levenshtein } from '../src/util.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const HELP = {
  _main: `dotmd v${pkg.version} — frontmatter markdown document manager

Commands:
  list [--verbose]       List docs grouped by status (default)
  json                   Full index as JSON
  check [flags]          Validate frontmatter and references
  coverage [--json]      Metadata coverage report
  stats [--json]         Doc health dashboard
  graph [--dot|--json]   Visualize document relationships
  deps [file]            Dependency tree or overview
  context                Compact briefing (LLM-oriented)
  focus [status]         Detailed view for one status group
  query [filters]        Filtered search
  index [--write]        Generate/update docs.md index block
  status <file> <status> Transition document status
  archive <file>         Archive (status + move + update refs)
  touch <file>           Bump updated date
  doctor                 Auto-fix everything: refs, lint, dates, index
  fix-refs               Auto-fix broken reference paths
  lint [--fix]           Check and auto-fix frontmatter issues
  rename <old> <new>     Rename doc and update references
  migrate <f> <old> <new>  Batch update a frontmatter field
  watch [command]       Re-run a command on file changes
  notion <sub> [db-id]   Notion import/export/sync
  export [file]          Export docs as md, html, or json
  summary <file>        AI summary of a document
  diff [file]           Show changes since last updated date
  new <name>             Create a new document from template
  init                   Create starter config + docs directory
  completions <shell>    Output shell completion script (bash, zsh)

Options:
  --config <path>        Explicit config file path
  --dry-run, -n          Preview changes without writing anything
  --verbose              Show config details and doc count
  --help, -h             Show help
  --version, -v          Show version`,

  query: `dotmd query — filtered document search

Filters:
  --status <s1,s2>       Filter by status (comma-separated)
  --keyword <term>       Search title, summary, state, path
  --module <name>        Filter by module
  --surface <name>       Filter by surface
  --domain <name>        Filter by domain
  --owner <name>         Filter by owner
  --updated-since <date> Only docs updated after date
  --stale                Only stale docs
  --has-next-step        Only docs with a next step
  --has-blockers         Only docs with blockers
  --checklist-open       Only docs with open checklist items
  --sort <field>         Sort by: updated (default), title, status
  --limit <n>            Max results (default: 20)
  --all                  Show all results (no limit)
  --git                  Use git dates instead of frontmatter
  --json                 Output as JSON
  --summarize            Add AI summaries to results
  --summarize-limit <n>  Max docs to summarize (default: 5)
  --model <name>         MLX model for AI summaries`,

  status: `dotmd status <file> <new-status> — transition document status

Moves the document to the new status. If transitioning to an archive
status, automatically moves the file to the archive directory and
regenerates the index (if configured).

Use --dry-run (-n) to preview changes without writing anything.`,

  check: `dotmd check — validate frontmatter and references

Options:
  --errors-only          Show only errors, suppress warnings
  --fix                  Auto-fix broken references and regenerate index`,

  archive: `dotmd archive <file> — archive a document

Sets status to 'archived', moves to the archive directory, auto-updates
references in other docs, and regenerates the index.

Use --dry-run (-n) to preview changes without writing anything.`,

  coverage: `dotmd coverage — metadata coverage report

Shows which docs are missing surface, module, or audit metadata.

Options:
  --json                 Machine-readable JSON output`,

  focus: `dotmd focus [status] — detailed view for one status group

Shows detailed info for all docs matching the given status (default: active).`,

  context: `dotmd context — compact briefing (LLM-oriented)

Generates a compact status briefing designed for AI/LLM consumption.

Options:
  --summarize            Add AI summaries for expanded docs
  --model <name>         MLX model for AI summaries`,

  stats: `dotmd stats — doc health dashboard

Shows aggregated metrics: status counts, staleness, errors/warnings,
freshness, completeness, checklist progress, and audit coverage.

Options:
  --json                 Machine-readable JSON output`,

  graph: `dotmd graph — visualize document relationships

Output formats:
  (default)              Text adjacency list
  --dot                  Graphviz DOT format (pipe to dot -Tpng)
  --json                 Machine-readable JSON

Filters:
  --status <s1,s2>       Show only docs with these statuses
  --module <name>        Show only docs with this module
  --surface <name>       Show only docs with this surface`,

  deps: `dotmd deps [file] — dependency tree or overview

Without a file, shows a flat overview: most blocking docs, most blocked
docs, docs with blockers, and orphans.

With a file, shows a tree: what the doc depends on (recursive) and what
depends on it.

Options:
  --depth <n>            Max tree depth (default: 5)
  --json                 Machine-readable JSON output`,

  doctor: `dotmd doctor — auto-fix everything in one pass

Runs in sequence: fix broken references, lint --fix, sync dates from
git, regenerate index, then show remaining issues.

Use --dry-run (-n) to preview all changes without writing anything.`,

  'fix-refs': `dotmd fix-refs — auto-fix broken reference paths

Scans all docs for reference fields that point to non-existent files,
then attempts to resolve them by matching the basename against all known
docs. Fixes are applied by rewriting the frontmatter path.

Use --dry-run (-n) to preview changes without writing anything.`,

  touch: `dotmd touch <file> — bump updated date
       dotmd touch --git  — bulk-sync dates from git history

Without --git, updates a single file's frontmatter updated date to today.
With --git, scans all docs (or a specific file) and syncs their updated
date to match the last git commit date, fixing date drift warnings.

Use --dry-run (-n) to preview changes without writing anything.`,

  index: `dotmd index [--write] — generate/update docs.md index

Without --write, prints the generated content to stdout.
With --write, updates the configured index file in place.

Use --dry-run (-n) with --write to preview without writing.`,

  new: `dotmd new <name> — create a new document

Creates a new markdown document with frontmatter in the docs root.

Options:
  --template <name>    Use a template (default, plan, adr, rfc, audit, design)
  --status <s>         Set initial status (default: active)
  --title <t>          Override the document title
  --list-templates     Show available templates

The filename is derived from <name> by slugifying it.
Use --dry-run (-n) to preview without creating the file.`,

  watch: `dotmd watch [command] — re-run a command on file changes

Watches the docs root for .md file changes and re-runs the specified
command. Defaults to 'list' if no command given.

Examples:
  dotmd watch              # re-run list on changes
  dotmd watch check        # re-run check on changes
  dotmd watch context      # live briefing`,

  notion: `dotmd notion — Notion database integration

Subcommands:
  import <database-id>   Pull Notion database → local .md files
  export <database-id>   Push local docs → Notion database rows
  sync <database-id>     Bidirectional sync (merge by slug)

Options:
  --force                Overwrite existing files on import
  --dry-run, -n          Preview without changes

Requires NOTION_TOKEN env var or notion.token in config.`,

  export: `dotmd export — export docs as markdown, HTML, or JSON

Without a file, exports all docs (with optional filters).
With a file, exports that doc plus all its dependencies.

Options:
  --format <md|html|json>  Output format (default: md)
  --output <path>          Write to file/directory (default: stdout for md/json)
  --status <s1,s2>         Filter by status
  --module <name>          Filter by module
  --root <name>            Filter by root`,

  summary: `dotmd summary <file> — AI summary of a document

Generates an AI-powered summary using a local MLX model via uv.

Options:
  --model <name>         MLX model (default: mlx-community/Llama-3.2-3B-Instruct-4bit)
  --max-tokens <n>       Max tokens for generation (default: 200)
  --json                 Output as JSON`,

  diff: `dotmd diff [file] — show changes since last updated date

Shows git diffs for docs that changed after their frontmatter updated date.
Without a file argument, shows all drifted docs.

Options:
  --stat                 Summary only (files changed, insertions/deletions)
  --since <date>         Override: diff since this date instead of frontmatter
  --summarize            Generate AI summary using local MLX model
  --model <name>         MLX model to use (default: mlx-community/Llama-3.2-3B-Instruct-4bit)`,

  lint: `dotmd lint [--fix] — check and auto-fix frontmatter issues

Scans all docs for fixable problems:
  - Missing status (inferred via local AI model when available)
  - Missing updated date (set to today)
  - Status casing (e.g. Active → active)
  - camelCase key names (e.g. nextStep → next_step)
  - Comma-separated surface values (converted to surfaces: array)
  - Trailing whitespace in frontmatter values
  - Missing newline at end of file

Without --fix, reports all issues. With --fix, applies fixes in place.
Use --dry-run (-n) with --fix to preview without writing anything.`,

  rename: `dotmd rename <old> <new> — rename doc and update references

Renames a document using git mv and updates all frontmatter references
in other docs that point to the old filename.

Body markdown links are warned about but not auto-fixed.
Use --dry-run (-n) to preview changes without writing anything.`,

  migrate: `dotmd migrate <field> <old-value> <new-value> — batch update a frontmatter field

Finds all docs where the given field equals old-value and updates it
to new-value.

Examples:
  dotmd migrate status research exploration
  dotmd migrate module auth identity

Use --dry-run (-n) to preview changes without writing anything.`,

  init: `dotmd init — create starter config and docs directory

Creates dotmd.config.mjs, docs/, and docs/docs.md in the current
directory. Skips any files that already exist.`,
};

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'list';

  // Pre-config flags
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  if (command === '--help' || command === '-h') {
    process.stdout.write(`${HELP._main}\n`);
    return;
  }

  // Per-command help
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${HELP[command] ?? HELP._main}\n`);
    return;
  }

  // Init and completions don't need config
  if (command === 'init') {
    runInit(process.cwd());
    return;
  }

  if (command === 'completions') {
    runCompletions(args.slice(1));
    return;
  }

  // Extract --config flag
  let explicitConfig = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
      explicitConfig = args[i + 1];
      break;
    }
  }

  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const verbose = args.includes('--verbose');

  const config = await resolveConfig(process.cwd(), explicitConfig);

  // Strip global flags from restArgs so commands don't have to filter them
  const restArgs = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--config') { i++; continue; }
    if (args[i] === '--dry-run' || args[i] === '-n' || args[i] === '--verbose') continue;
    restArgs.push(args[i]);
  }

  if (!config.configFound && command !== 'init') {
    warn('No dotmd config found — using defaults. Run `dotmd init` to create one.');
  }

  if (config.configWarnings && config.configWarnings.length > 0) {
    for (const w of config.configWarnings) {
      warn(w);
    }
  }

  if (verbose) {
    process.stderr.write(`Config: ${config.configPath ?? 'none'}\n`);
    const roots = config.docsRoots || [config.docsRoot];
    process.stderr.write(`Docs root${roots.length > 1 ? 's' : ''}: ${roots.join(', ')}\n`);
    process.stderr.write(`Repo root: ${config.repoRoot}\n`);
  }

  // Preset aliases
  if (config.presets[command]) {
    const index = buildIndex(config);
    runQuery(index, [...config.presets[command], ...restArgs], config);
    return;
  }

  // Watch and diff (handle their own index building)
  if (command === 'watch') { runWatch(restArgs, config); return; }
  if (command === 'diff') { runDiff(restArgs, config); return; }
  if (command === 'summary') { runSummary(restArgs, config); return; }
  if (command === 'deps') { runDeps(restArgs, config); return; }
  if (command === 'export') { runExport(restArgs, config, { dryRun }); return; }
  if (command === 'notion') { await runNotion(restArgs, config, { dryRun }); return; }

  // Lifecycle commands
  if (command === 'status') { await runStatus(restArgs, config, { dryRun }); return; }
  if (command === 'archive') { runArchive(restArgs, config, { dryRun }); return; }
  if (command === 'touch') { runTouch(restArgs, config, { dryRun }); return; }
  if (command === 'new') { await runNew(restArgs, config, { dryRun }); return; }
  if (command === 'lint') { runLint(restArgs, config, { dryRun }); return; }
  if (command === 'rename') { await runRename(restArgs, config, { dryRun }); return; }
  if (command === 'migrate') { runMigrate(restArgs, config, { dryRun }); return; }
  if (command === 'fix-refs') { runFixRefs(restArgs, config, { dryRun }); return; }
  if (command === 'doctor') { runDoctor(restArgs, config, { dryRun }); return; }

  const index = buildIndex(config);

  // Apply --root filter
  const rootFilter = (() => { const i = args.indexOf('--root'); return i !== -1 && args[i + 1] ? args[i + 1] : null; })();
  if (rootFilter) {
    index.docs = index.docs.filter(d => d.root === rootFilter || d.root.endsWith('/' + rootFilter) || d.root.split('/').pop() === rootFilter);
    index.errors = index.errors.filter(e => index.docs.some(d => d.path === e.path));
    index.warnings = index.warnings.filter(w => index.docs.some(d => d.path === w.path));
    for (const status of config.statusOrder) {
      index.countsByStatus[status] = index.docs.filter(d => d.status === status).length;
    }
  }

  if (verbose) {
    process.stderr.write(`Docs found: ${index.docs.length}\n`);
  }

  if (command === 'json') {
    process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
    return;
  }

  if (command === 'list') {
    if (args.includes('--json')) {
      process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
    } else if (args.includes('--verbose')) {
      process.stdout.write(renderVerboseList(index, config));
    } else {
      process.stdout.write(renderCompactList(index, config));
    }
    return;
  }

  if (command === 'check') {
    const fix = args.includes('--fix');
    const errorsOnly = args.includes('--errors-only');

    if (fix) {
      // Auto-fix: broken refs, then lint, then rebuild index
      const refResult = fixBrokenRefs(config, { dryRun, quiet: false });
      if (!dryRun) {
        runLint(['--fix'], config, { dryRun });
      }
      if (!dryRun && config.indexPath) {
        const { renderIndexFile: rif, writeIndex: wi } = await import('../src/index-file.mjs');
        const freshIndex = buildIndex(config);
        wi(rif(freshIndex, config), config);
        process.stdout.write('Index regenerated.\n');
      }
      // Show remaining issues
      const freshIndex = buildIndex(config);
      process.stdout.write('\n' + renderCheck(freshIndex, config, { errorsOnly }));
      if (freshIndex.errors.length > 0) process.exitCode = 1;
      return;
    }

    if (args.includes('--json')) {
      process.stdout.write(JSON.stringify({
        docsScanned: index.docs.length,
        errors: index.errors,
        warnings: errorsOnly ? [] : index.warnings,
        errorCount: index.errors.length,
        warningCount: index.warnings.length,
        passed: index.errors.length === 0,
      }, null, 2) + '\n');
      if (index.errors.length > 0) process.exitCode = 1;
      return;
    }

    process.stdout.write(renderCheck(index, config, { errorsOnly }));
    if (index.errors.length > 0) process.exitCode = 1;
    return;
  }

  if (command === 'coverage') {
    if (args.includes('--json')) {
      process.stdout.write(`${JSON.stringify(buildCoverage(index, config), null, 2)}\n`);
    } else {
      process.stdout.write(renderCoverage(index, config));
    }
    return;
  }

  if (command === 'stats') {
    const stats = buildStats(index, config);
    if (args.includes('--json')) {
      process.stdout.write(renderStatsJson(stats));
    } else {
      process.stdout.write(renderStats(stats, config));
    }
    return;
  }

  if (command === 'index') {
    if (!config.indexPath) {
      die('Index generation is not configured. Add an `index` section to your dotmd.config.mjs.');
    }
    const write = args.includes('--write');
    const rendered = renderIndexFile(index, config);
    if (write && !dryRun) {
      writeIndex(rendered, config);
      process.stdout.write(`Updated ${config.indexPath}\n`);
    } else if (write && dryRun) {
      process.stdout.write(`[dry-run] Would update ${config.indexPath}\n`);
    } else {
      process.stdout.write(rendered);
    }
    return;
  }

  if (command === 'focus') { runFocus(index, restArgs, config); return; }
  if (command === 'query') { runQuery(index, restArgs, config); return; }
  if (command === 'context') {
    if (args.includes('--json')) {
      const byStatus = {};
      for (const s of config.statusOrder) {
        const docs = index.docs.filter(d => d.status === s);
        if (docs.length) byStatus[s] = docs;
      }
      const stale = index.docs.filter(d => d.isStale && !config.lifecycle.skipStaleFor.has(d.status));
      process.stdout.write(JSON.stringify({
        generatedAt: new Date().toISOString(),
        docsByStatus: byStatus,
        countsByStatus: index.countsByStatus,
        stale: stale.map(d => ({ path: d.path, title: d.title, daysSinceUpdate: d.daysSinceUpdate })),
        errorCount: index.errors.length,
        warningCount: index.warnings.length,
      }, null, 2) + '\n');
      return;
    }
    const summarize = args.includes('--summarize');
    const modelIdx = args.indexOf('--model');
    const model = modelIdx !== -1 && args[modelIdx + 1] ? args[modelIdx + 1] : undefined;
    process.stdout.write(renderContext(index, config, { summarize, model }));
    return;
  }

  if (command === 'graph') {
    const statusFilter = (() => { const i = args.indexOf('--status'); return i !== -1 && args[i + 1] ? args[i + 1] : null; })();
    const moduleFilter = (() => { const i = args.indexOf('--module'); return i !== -1 && args[i + 1] ? args[i + 1] : null; })();
    const surfaceFilter = (() => { const i = args.indexOf('--surface'); return i !== -1 && args[i + 1] ? args[i + 1] : null; })();
    const graph = buildGraph(index, config, {
      statuses: statusFilter?.split(',') ?? null,
      module: moduleFilter,
      surface: surfaceFilter,
    });
    if (args.includes('--dot')) {
      process.stdout.write(renderGraphDot(graph, config));
    } else if (args.includes('--json')) {
      process.stdout.write(renderGraphJson(graph));
    } else {
      process.stdout.write(renderGraphText(graph, config));
    }
    return;
  }

  // Unknown command — suggest closest match
  const allCommands = [
    'list', 'json', 'check', 'coverage', 'stats', 'graph', 'deps', 'context',
    'focus', 'query', 'index', 'status', 'archive', 'touch', 'doctor',
    'fix-refs', 'lint', 'rename', 'migrate', 'notion', 'export', 'summary',
    'watch', 'diff', 'new', 'init', 'completions',
  ];
  const matches = allCommands
    .map(c => ({ cmd: c, dist: levenshtein(command, c) }))
    .sort((a, b) => a.dist - b.dist);
  if (matches[0] && matches[0].dist <= 3) {
    die(`Unknown command: ${command}\n\nDid you mean \`dotmd ${matches[0].cmd}\`?`);
  }
  die(`Unknown command: ${command}\n\nRun \`dotmd --help\` for available commands.`);
}

main().catch(err => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
