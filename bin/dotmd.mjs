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
import { die, warn } from '../src/util.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const HELP = {
  _main: `dotmd v${pkg.version} — frontmatter markdown document manager

Commands:
  list [--verbose]       List docs grouped by status (default)
  json                   Full index as JSON
  check                  Validate frontmatter and references
  coverage [--json]      Metadata coverage report
  context                Compact briefing (LLM-oriented)
  focus [status]         Detailed view for one status group
  query [filters]        Filtered search
  index [--write]        Generate/update docs.md index block
  status <file> <status> Transition document status
  archive <file>         Archive (status + move + index regen)
  touch <file>           Bump updated date
  watch [command]       Re-run a command on file changes
  diff [file]           Show changes since last updated date
  new <name>             Create a new document with frontmatter
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
  --json                 Output as JSON`,

  status: `dotmd status <file> <new-status> — transition document status

Moves the document to the new status. If transitioning to an archive
status, automatically moves the file to the archive directory and
regenerates the index (if configured).

Use --dry-run (-n) to preview changes without writing anything.`,

  archive: `dotmd archive <file> — archive a document

Sets status to 'archived', moves to the archive directory, regenerates
the index, and scans for stale references.

Use --dry-run (-n) to preview changes without writing anything.`,

  index: `dotmd index [--write] — generate/update docs.md index

Without --write, prints the generated content to stdout.
With --write, updates the configured index file in place.

Use --dry-run (-n) with --write to preview without writing.`,

  new: `dotmd new <name> — create a new document

Creates a new markdown document with frontmatter in the docs root.

Options:
  --status <s>         Set initial status (default: active)
  --title <t>          Override the document title

The filename is derived from <name> by slugifying it.
Use --dry-run (-n) to preview without creating the file.`,

  watch: `dotmd watch [command] — re-run a command on file changes

Watches the docs root for .md file changes and re-runs the specified
command. Defaults to 'list' if no command given.

Examples:
  dotmd watch              # re-run list on changes
  dotmd watch check        # re-run check on changes
  dotmd watch context      # live briefing`,

  diff: `dotmd diff [file] — show changes since last updated date

Shows git diffs for docs that changed after their frontmatter updated date.
Without a file argument, shows all drifted docs.

Options:
  --stat                 Summary only (files changed, insertions/deletions)
  --since <date>         Override: diff since this date instead of frontmatter
  --summarize            Generate AI summary using local MLX model
  --model <name>         MLX model to use (default: mlx-community/Llama-3.2-3B-Instruct-4bit)`,

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
  const restArgs = args.slice(1);

  if (!config.configFound && command !== 'init') {
    warn('No dotmd config found — using defaults. Run `dotmd init` to create one.');
  }

  if (verbose) {
    process.stderr.write(`Config: ${config.configPath ?? 'none'}\n`);
    process.stderr.write(`Docs root: ${config.docsRoot}\n`);
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

  // Lifecycle commands
  if (command === 'status') { runStatus(restArgs, config, { dryRun }); return; }
  if (command === 'archive') { runArchive(restArgs, config, { dryRun }); return; }
  if (command === 'touch') { runTouch(restArgs, config, { dryRun }); return; }
  if (command === 'new') { runNew(restArgs, config, { dryRun }); return; }

  const index = buildIndex(config);

  if (verbose) {
    process.stderr.write(`Docs found: ${index.docs.length}\n`);
  }

  if (command === 'json') {
    process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
    return;
  }

  if (command === 'list') {
    if (args.includes('--verbose')) {
      process.stdout.write(renderVerboseList(index, config));
    } else {
      process.stdout.write(renderCompactList(index, config));
    }
    return;
  }

  if (command === 'check') {
    process.stdout.write(renderCheck(index, config));
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

  if (command === 'index') {
    if (!config.indexPath) {
      die('Index generation is not configured. Add an `index` section to your dotmd.config.mjs.');
      return;
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
  if (command === 'context') { process.stdout.write(renderContext(index, config)); return; }

  // Unknown command — show help
  die(`Unknown command: ${command}\n\n${HELP._main}`);
}

main().catch(err => {
  die(err.message);
});
