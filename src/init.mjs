import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { green, dim, yellow } from './color.mjs';
import { die, warn } from './util.mjs';
import { catchAllRoot, promptDirectory } from './new.mjs';
import { authorizeRepoGeneratedPath } from './managed-path.mjs';

// Subdirectories scaffolded under docsRoot and tracked separately during scans.
// Each maps to a builtin type (plan, prompt). New types added here should also
// have a matching builtin template so `runlist new <type>` lands files correctly.
const TYPE_SUBDIRS = ['plans', 'prompts'];

// Look for a `runlist hud` SessionStart hook already wired in either the project
// (.claude/settings{,.local}.json) or the user-global config (~/.claude/
// settings.json). User-global counts because Claude Code merges global hooks
// into every project — if the user has it wired globally, this project gets it
// for free and the init snippet would be noise. We only inspect — we do NOT
// mutate any file. Settings-merge logic is hostile to do silently (clobbering
// an existing SessionStart entry would surprise the user), so init just prints
// a paste-ready snippet when the hook isn't found.
function detectSessionStartHook(cwd) {
  const candidates = [
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let parsed;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
    catch { continue; }
    const sessionStart = parsed?.hooks?.SessionStart;
    if (!Array.isArray(sessionStart)) continue;
    for (const entry of sessionStart) {
      const inner = Array.isArray(entry?.hooks) ? entry.hooks : [];
      for (const hook of inner) {
        if (typeof hook?.command === 'string' && /\b(?:runlist|dotmd)\s+hud\b/.test(hook.command)) {
          const rel = file.startsWith(cwd) ? path.relative(cwd, file) : file;
          return { wired: true, file: rel };
        }
      }
    }
  }
  return { wired: false };
}

const STARTER_CONFIG = `// runlist.config.mjs — document management configuration
// All exports are optional. See runlist.config.example.mjs for full reference.

export const root = 'docs';
export const promptTracking = 'untracked';

export const index = {
  path: 'docs/docs.md',
  startMarker: '<!-- GENERATED:runlist:start -->',
  endMarker: '<!-- GENERATED:runlist:end -->',
  archivedLimit: 8,
};

// Frontmatter fields graph / deps / unblocks / pickup's Related: resolver
// traverse. Defaults match what the built-in plan/doc/prompt templates scaffold.
// Add field names here (and to your templates) to track more relationships.
export const referenceFields = {
  bidirectional: ['related_plans', 'related_docs'],
  unidirectional: ['parent_plan', 'runlist'],
};
`;

// A git repository cannot hold an empty directory, so scaffolding `docs/plans/`
// and `docs/prompts/` and stopping there means both vanish for the next clone —
// `runlist init` produced three committable files and two directories that existed
// only on the machine that ran it.
//
// plans/ gets a real sample rather than a keepfile: it is the one place a new user
// benefits from seeing the frontmatter shape before running `runlist new`. It is
// written `status: planned` so it sits quietly in the pipeline instead of posing
// as live work, and it says how to delete itself.
//
// prompts/ gets a keepfile instead of a live sample, which could otherwise be
// consumed by the next no-arg `runlist use`. Ignore rules are opt-in.
const SAMPLE_PLAN_NAME = 'example-plan.md';
const samplePlan = (today, planPath) => `---
type: plan
status: planned
created: ${today}
updated: ${today}
title: Example Plan
summary: A scaffolded sample showing what a runlist plan looks like — safe to delete.
current_state: "Scaffolded by \`runlist init\` as a shape reference. Nothing here is real work."
next_step: "Delete this file, or edit it into your first real plan."
---

# Example Plan

> A scaffolded sample showing what a runlist plan looks like — safe to delete.

## Problem

\`runlist init\` leaves this file behind so \`${path.posix.dirname(planPath)}/\` survives a clone (git cannot
track an empty directory) and so the frontmatter above has something to point at.

The fields that matter: \`status\` drives every listing, \`current_state\` and
\`next_step\` are what \`runlist briefing\` reads out, and \`updated\` drives staleness.
Never hand-edit \`status:\` — \`runlist set <status> <file>\` writes it, validates it
against the type, and runs the lifecycle hooks.

## Phases

- [ ] Delete this file: \`runlist archive ${planPath}\`
- [ ] Write a real one: \`runlist new plan <name>\`

## Version History

- Scaffolded by \`runlist init\`.
`;

const STARTER_INDEX = `# Docs

<!-- GENERATED:runlist:start -->

_No docs yet. Run \`runlist list\` after creating your first document._

<!-- GENERATED:runlist:end -->
`;

function scanExistingDocs(roots, indexPath, excludeDirs = new Set()) {
  const seen = new Set();
  const statuses = new Set();
  const surfaces = new Set();
  const modules = new Set();
  const refFieldNames = new Set();
  let docCount = 0;
  // Files without a frontmatter block, OR with a block that's missing `type:`
  // or `status:`. Surfaced by the init "bulk-tag hint" to point users at the
  // command that can fix them all in one shot.
  let untaggedCount = 0;
  // Track files per top-level subdir under `dir` (e.g. plans/, prompts/, "")
  // so callers can report what's already there — including files without frontmatter,
  // which are otherwise invisible to detection.
  const subdirCounts = {};

  function bump(subdir, hasFrontmatter) {
    if (!subdirCounts[subdir]) subdirCounts[subdir] = { withFrontmatter: 0, withoutFrontmatter: 0 };
    if (hasFrontmatter) subdirCounts[subdir].withFrontmatter++;
    else subdirCounts[subdir].withoutFrontmatter++;
  }

  function walk(d, topSubdir) {
    if (seen.has(d)) return;
    seen.add(d);
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch (err) { warn(`Could not read ${d}: ${err.message}`); return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (['.git', 'node_modules'].includes(entry.name) || excludeDirs.has(entry.name)) continue;
        const nextTop = topSubdir === null ? entry.name : topSubdir;
        walk(path.join(d, entry.name), nextTop);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md') || path.join(d, entry.name) === indexPath) continue;
      let raw;
      try { raw = readFileSync(path.join(d, entry.name), 'utf8'); } catch (err) { warn(`Could not read ${entry.name}: ${err.message}`); continue; }
      const { frontmatter } = extractFrontmatter(raw);
      const subdir = topSubdir ?? '';
      if (!frontmatter) { bump(subdir, false); untaggedCount++; continue; }
      bump(subdir, true);
      const parsed = parseSimpleFrontmatter(frontmatter);
      docCount++;
      const hasType = typeof parsed.type === 'string' && parsed.type.length > 0;
      const hasStatus = typeof parsed.status === 'string' && parsed.status.length > 0;
      if (!hasType || !hasStatus) untaggedCount++;
      if (parsed.status) statuses.add(String(parsed.status).toLowerCase());
      if (parsed.surface) surfaces.add(String(parsed.surface));
      if (Array.isArray(parsed.surfaces)) parsed.surfaces.forEach(s => surfaces.add(String(s)));
      if (parsed.module) modules.add(String(parsed.module));
      if (Array.isArray(parsed.modules)) parsed.modules.forEach(m => modules.add(String(m)));
      for (const [key, val] of Object.entries(parsed)) {
        if (Array.isArray(val) && val.some(v => String(v).endsWith('.md'))) {
          refFieldNames.add(key);
        }
      }
    }
  }

  for (const dir of roots) if (existsSync(dir)) walk(dir, null);
  return { docCount, statuses, surfaces, modules, refFieldNames, subdirCounts, untaggedCount };
}

// Count .md files (regardless of frontmatter) directly inside a single directory.
// Used to detect root-level plans/ or prompts/ siblings that aren't under docsRoot.
function countMarkdownFiles(dir) {
  let withFrontmatter = 0;
  let withoutFrontmatter = 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return { withFrontmatter, withoutFrontmatter }; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    let raw;
    try { raw = readFileSync(path.join(dir, entry.name), 'utf8'); } catch { continue; }
    const { frontmatter } = extractFrontmatter(raw);
    if (frontmatter) withFrontmatter++; else withoutFrontmatter++;
  }
  return { withFrontmatter, withoutFrontmatter };
}

// Sensible default stale thresholds (days) for statuses runlist recognizes, used
// only to scope the generated config's staleDays to detected statuses. Mirrors
// the global + per-type defaults in config.mjs DEFAULTS; the repo's own custom
// statuses are intentionally absent so we don't invent a threshold for vocab we
// don't understand.
const KNOWN_STALE_DAYS = {
  'in-session': 1, active: 14, ready: 14, planned: 30, blocked: 30,
  scoping: 30, paused: 3, awaiting: 14, draft: 30, review: 14, pending: 30,
};

function generateDetectedConfig(scan, rootPath, promptTracking) {
  const lines = [`// runlist.config.mjs — auto-detected from ${scan.docCount} existing docs`, ''];
  lines.push(`export const root = ${rootPath === 'docs' ? "'docs'" : JSON.stringify(rootPath)};`);
  lines.push(`export const promptTracking = '${promptTracking}';`);
  lines.push('');

  const defaultOrder = ['active', 'ready', 'planned', 'scoping', 'blocked', 'reference', 'archived'];
  const ordered = defaultOrder.filter(s => scan.statuses.has(s));
  const extra = [...scan.statuses].filter(s => !defaultOrder.includes(s)).sort();
  const allStatuses = [...ordered, ...extra];
  if (allStatuses.length > 0) {
    lines.push('export const statuses = {');
    lines.push(`  order: [${allStatuses.map(s => `'${s}'`).join(', ')}],`);
    // Scope staleDays to the detected statuses. `statuses.staleDays` is a
    // replace-key, so emitting it here stops the resolver from inheriting the
    // default map (keyed by `ready`/`scoping`/… that this repo may not use) —
    // which otherwise makes every command warn about statuses the user never
    // wrote. Only statuses with a sensible known threshold get an entry;
    // unrecognized ones (the repo's own vocab) are left for the user to tune.
    const staleEntries = allStatuses.filter(s => s in KNOWN_STALE_DAYS);
    if (staleEntries.length > 0) {
      lines.push('  staleDays: {');
      for (const s of staleEntries) lines.push(`    '${s}': ${KNOWN_STALE_DAYS[s]},`);
      lines.push('  },');
    }
    lines.push('};');
    lines.push('');
  }

  if (scan.surfaces.size > 0 || scan.modules.size > 0) {
    lines.push('export const taxonomy = {');
    // Emit the full detected set so every existing doc passes — taxonomy
    // enforcement only flags values outside the list, and the scan collected
    // all of them. New surfaces/modules added later warn until appended here.
    if (scan.surfaces.size > 0)
      lines.push(`  surfaces: [${[...scan.surfaces].sort().map(s => `'${s}'`).join(', ')}],`);
    if (scan.modules.size > 0)
      lines.push(`  modules: [${[...scan.modules].sort().map(m => `'${m}'`).join(', ')}],`);
    lines.push('};');
    lines.push('');
  }

  if (scan.refFieldNames.size > 0) {
    const names = [...scan.refFieldNames].sort();
    lines.push('export const referenceFields = {');
    lines.push(`  bidirectional: [${names.map(n => `'${n}'`).join(', ')}],`);
    lines.push('  unidirectional: [],');
    lines.push('};');
    lines.push('');
  }

  lines.push('export const index = {');
  lines.push(`  path: ${rootPath === 'docs' ? "'docs/docs.md'" : JSON.stringify(path.posix.join(rootPath, 'docs.md'))},`);
  lines.push(`  startMarker: '<!-- GENERATED:runlist:start -->',`);
  lines.push(`  endMarker: '<!-- GENERATED:runlist:end -->',`);
  lines.push(`  snapshot: 'status',`);
  lines.push('};');
  lines.push('');

  return lines.join('\n');
}

export async function runInit(cwd, config, opts = {}) {
  const { dryRun = false, argv = [] } = opts;
  let requestedPolicy;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--prompt-tracking' || argv[i].startsWith('--prompt-tracking=')) {
      requestedPolicy = argv[i] === '--prompt-tracking' ? argv[++i] : argv[i].slice('--prompt-tracking='.length);
      if (!['untracked', 'tracked', 'local'].includes(requestedPolicy)) {
        die('--prompt-tracking must be one of: untracked, tracked, local.');
      }
    }
  }
  const existingConfig = Boolean(config.configPath && existsSync(config.configPath));
  // Internal setup input; the public init argv contract stays unchanged.
  const selectedRoot = opts.docsRoot ?? 'docs';
  if (typeof selectedRoot !== 'string' || !selectedRoot.trim() || path.isAbsolute(selectedRoot)
      || /[\r\n\0\\]/.test(selectedRoot)
      || selectedRoot.split('/').includes('..')) {
    die('docsRoot must be a relative project path without traversal.');
  }
  if (existingConfig && opts.docsRoot !== undefined
      && (config.docsRoots ?? [config.docsRoot]).some(root => path.resolve(config.repoRoot, selectedRoot) !== root)) {
    die('Existing configured roots are preserved. Edit the root export manually to change the docs layout.');
  }
  const promptTracking = existingConfig ? (config.promptTracking ?? config.raw?.promptTracking ?? 'local') : (requestedPolicy ?? 'untracked');
  if (!['untracked', 'tracked', 'local'].includes(promptTracking)) {
    die('promptTracking must be one of: untracked, tracked, local.');
  }
  if (existingConfig && requestedPolicy !== undefined && requestedPolicy !== promptTracking) {
    die(`Existing config preserved; requested policy was not applied. Use: runlist config set promptTracking ${requestedPolicy}. For a symlinked or computed config, edit the promptTracking export manually.`);
  }

  // Existing configs own their layout, including flat root arrays and an absent
  // index. A fresh project gets the starter docs/ layout rather than the
  // resolver's config-less root (which is the whole working directory).
  const projectRoot = existingConfig ? config.repoRoot : cwd;
  const configPath = existingConfig ? config.configPath : path.join(cwd, 'runlist.config.mjs');
  const docsRoots = existingConfig ? (config.docsRoots ?? [config.docsRoot]) : [path.resolve(cwd, selectedRoot)];
  const indexPath = existingConfig ? config.indexPath : path.join(docsRoots[0], 'docs.md');
  const layout = existingConfig ? config : { ...config, repoRoot: cwd, docsRoot: docsRoots[0], docsRoots };
  const label = file => path.relative(projectRoot, file).split(path.sep).join('/') || '.';
  const dryTag = dryRun ? `${dim('[dry-run]')} ` : '';
  const planTemplate = { dir: 'plans', targetRoot: 'plans', ...config.raw?.templates?.plan };
  const planRoot = planTemplate.targetRoot && docsRoots.find(root => root.endsWith(planTemplate.targetRoot) || path.basename(root) === planTemplate.targetRoot);
  const plansDir = planRoot || (planTemplate.dir ? path.join(catchAllRoot(layout), planTemplate.dir) : catchAllRoot(layout));
  const promptsDir = promptDirectory(layout);
  const typeDirs = new Map([['plans', plansDir], ['prompts', promptsDir]]);

  // Preflight opt-in ignore writes before ANY scaffolding. Refuse unsafe
  // destinations and ambiguous patterns rather than appending a misleading or
  // broader rule. Never follow a .gitignore symlink, including a dangling one.
  let ignorePlan = null;
  if (argv.includes('--gitignore')) {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    authorizeRepoGeneratedPath(gitignorePath, layout, { kind: 'Init .gitignore destination' });
    const exists = existsSync(gitignorePath);
    if (exists && !lstatSync(gitignorePath).isFile()) die('Init .gitignore destination must be a regular file.');
    const ignoreRules = [
      { line: '.runlist/', accepts: l => l === '.runlist/' || l === '.runlist' },
      { line: '.dotmd/', accepts: l => l === '.dotmd/' || l === '.dotmd' },
    ];
    if (promptTracking !== 'tracked') {
      authorizeRepoGeneratedPath(promptsDir, layout, { kind: 'Prompt ignore directory' });
      const promptsRel = path.relative(projectRoot, promptsDir).split(path.sep).join('/');
      if (/[\r\n\0\\*?\[\]]/.test(promptsRel)) {
        die('Cannot add a prompt ignore rule: the configured prompt path contains a newline or Git pattern characters.');
      }
      const promptsIgnore = `/${promptsRel ? promptsRel + '/' : ''}*.md`;
      ignoreRules.push({ line: promptsIgnore, accepts: l => l === promptsIgnore || l === promptsIgnore.slice(1) });
    }
    const current = exists ? readFileSync(gitignorePath, 'utf8') : '';
    const present = current.split(/\r?\n/).map(l => l.trim());
    const missing = ignoreRules.filter(rule => !present.some(rule.accepts));
    ignorePlan = { gitignorePath, exists, current, missing };
  }
  const scan = scanExistingDocs(docsRoots, indexPath, config.excludeDirs);

  // Detect content outside the selected roots before creating parallel type
  // directories. Offer a config choice; never move or delete anyone's files.
  const siblingsWithContent = [];
  for (const sub of TYPE_SUBDIRS) {
    const siblingPath = path.join(projectRoot, sub);
    if (docsRoots.some(root => siblingPath === root || siblingPath.startsWith(root + path.sep))) continue;
    const counts = countMarkdownFiles(siblingPath);
    const total = counts.withFrontmatter + counts.withoutFrontmatter;
    if (total > 0) siblingsWithContent.push({ sub, total });
  }
  const siblingSet = new Set(siblingsWithContent.map(s => s.sub));

  process.stdout.write('\n');
  if (existingConfig) {
    process.stdout.write(`  ${dryTag}${dim('exists')}  ${label(configPath)}\n`);
  } else {
    const body = scan.docCount > 0
      ? generateDetectedConfig(scan, selectedRoot, promptTracking)
      : STARTER_CONFIG.replace("root = 'docs'", `root = ${opts.docsRoot === undefined ? "'docs'" : JSON.stringify(selectedRoot)}`)
        .replace("path: 'docs/docs.md'", `path: ${opts.docsRoot === undefined ? "'docs/docs.md'" : JSON.stringify(path.posix.join(selectedRoot, 'docs.md'))}`)
        .replace("promptTracking = 'untracked'", `promptTracking = '${promptTracking}'`);
    if (!dryRun) writeFileSync(configPath, body, 'utf8');
    const detail = scan.docCount > 0 ? ` (detected ${scan.docCount} docs)` : '';
    process.stdout.write(`  ${dryTag}${green('create')}  runlist.config.mjs${detail}\n`);
  }

  for (const dir of docsRoots) {
    const exists = existsSync(dir);
    if (!exists && !dryRun) mkdirSync(dir, { recursive: true });
    process.stdout.write(`  ${dryTag}${exists ? dim('exists') : green('create')}  ${label(dir)}/\n`);
  }

  for (const [sub, subPath] of typeDirs) {
    if (siblingSet.has(sub) && !existsSync(subPath)) {
      process.stdout.write(`  ${dryTag}${yellow('skip')}    ${label(subPath)}/ (root-level ./${sub}/ already holds content)\n`);
      continue;
    }
    const exists = existsSync(subPath);
    const counts = countMarkdownFiles(subPath);
    const total = counts.withFrontmatter + counts.withoutFrontmatter;
    const detail = total > 0 ? ` (${counts.withFrontmatter} runlist-tracked, ${counts.withoutFrontmatter} plain .md)` : '';
    if (!exists && !dryRun) mkdirSync(subPath, { recursive: true });
    process.stdout.write(`  ${dryTag}${exists ? dim('exists') : green('create')}  ${label(subPath)}/${detail}\n`);

    const keeper = sub === 'plans' && opts.samplePlan !== false
      ? { file: SAMPLE_PLAN_NAME, body: samplePlan(new Date().toISOString().slice(0, 10), label(path.join(subPath, SAMPLE_PLAN_NAME))) }
      : { file: '.gitkeep', body: '' };
    const keeperPath = path.join(subPath, keeper.file);
    const dirIsEmpty = !existsSync(subPath) || readdirSync(subPath).length === 0;
    if (existsSync(keeperPath)) {
      process.stdout.write(`  ${dryTag}${dim('exists')}  ${label(keeperPath)}\n`);
    } else if (dirIsEmpty) {
      if (!dryRun) writeFileSync(keeperPath, keeper.body, 'utf8');
      process.stdout.write(`  ${dryTag}${green('create')}  ${label(keeperPath)}\n`);
    }
  }

  if (indexPath) {
    if (existsSync(indexPath)) {
      process.stdout.write(`  ${dryTag}${dim('exists')}  ${label(indexPath)}\n`);
    } else {
      const body = STARTER_INDEX
        .replace('<!-- GENERATED:runlist:start -->', config.indexStartMarker ?? '<!-- GENERATED:runlist:start -->')
        .replace('<!-- GENERATED:runlist:end -->', config.indexEndMarker ?? '<!-- GENERATED:runlist:end -->');
      if (!dryRun) {
        mkdirSync(path.dirname(indexPath), { recursive: true });
        writeFileSync(indexPath, body, 'utf8');
      }
      process.stdout.write(`  ${dryTag}${green('create')}  ${label(indexPath)}\n`);
    }
  }

  if (siblingsWithContent.length > 0) {
    const list = siblingsWithContent.map(({ sub, total }) => `${sub}/ (${total} .md file${total === 1 ? '' : 's'})`).join(', ');
    const roots = [...new Set([...docsRoots.map(label), ...siblingsWithContent.map(s => s.sub)])];
    process.stdout.write(`\n  ${yellow('notice')}  found at repo root: ${list}\n`);
    process.stdout.write(`           These are outside the configured roots. To include them without moving files,\n`);
    process.stdout.write(`           choose the roots in ${label(configPath)}, for example:\n`);
    process.stdout.write(`             export const root = ${JSON.stringify(roots)};\n`);
  }

  if (ignorePlan) {
    const { gitignorePath, exists, current, missing } = ignorePlan;
    if (missing.length) {
      const newline = current.includes('\r\n') ? '\r\n' : '\n';
      const sep = current.length === 0 || current.endsWith('\n') ? '' : newline;
      if (!dryRun) {
        authorizeRepoGeneratedPath(gitignorePath, layout, { kind: 'Init .gitignore destination' });
        appendFileSync(gitignorePath, sep + missing.map(rule => rule.line + newline).join(''), 'utf8');
      }
      process.stdout.write(`  ${dryTag}${green(exists ? 'update' : 'create')}  .gitignore (+${missing.map(rule => rule.line).join(', ')})\n`);
    } else {
      process.stdout.write(`  ${dryTag}${dim('exists')}  .gitignore\n`);
    }
  }

  if (existsSync(path.join(projectRoot, '.git'))) {
    for (const dir of docsRoots) {
      const rel = `${label(dir)}/`;
      const probe = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: projectRoot, encoding: 'utf8' });
      if (probe.status === 0) {
        process.stdout.write(`\n  ${yellow('notice')}  ${rel} is gitignored — files runlist manages will NOT be tracked.\n`);
        process.stdout.write(`           Review the existing ignore rules if you want Git to track this root.\n`);
      }
    }
  }

  // Bulk-tag hint — when init found pre-existing .md files without
  // type/status, point at the command that can tag them in one shot. Init's
  // job here is discovery; the per-file detail lives in `bulk-tag --dry-run`.
  if (opts.guidance !== false && scan?.untaggedCount > 0) {
    const n = scan.untaggedCount;
    const noun = n === 1 ? 'file' : 'files';
    process.stdout.write(`\n  ${yellow('hint')}    ${n} untagged .md ${noun} found — run \`runlist bulk-tag --dry-run\` to preview tagging.\n`);
  }

  // Claude Code integration. runlist no longer scaffolds per-repo
  // `.claude/commands/*.md` slash commands — the runlist plugin's SKILL.md is the
  // canonical agent-facing workflow now, and `runlist hud` injects this repo's
  // status vocab at runtime.
  const hasProjectClaude = existsSync(path.join(cwd, '.claude'));
  // A project `.claude/` proves it; a user-global `~/.claude/` means they run
  // Claude Code elsewhere, so the plugin nudge is still relevant before this
  // repo has any `.claude/` of its own (the common greenfield case).
  const likelyClaudeUser = hasProjectClaude || existsSync(path.join(os.homedir(), '.claude'));

  if (opts.guidance !== false && likelyClaudeUser) {
    const sessionStart = detectSessionStartHook(cwd);
    if (sessionStart.wired) {
      process.stdout.write(`  ${dim('exists')}  ${sessionStart.file} (SessionStart hook for \`runlist hud\` already wired)\n`);
    } else {
      process.stdout.write(`\n  ${yellow('hint')}    install the runlist Claude Code plugin so its hooks + workflow skill\n`);
      process.stdout.write(`            travel to every session and subagent automatically:\n\n`);
      process.stdout.write(`              /plugin marketplace add reowens/runlist\n`);
      process.stdout.write(`              /plugin install runlist@runlist\n\n`);
      process.stdout.write(`            The plugin's hooks call \`runlist\` on your PATH, so install the CLI\n`);
      process.stdout.write(`            globally too — ${green('npm i -g runlist')} (a project devDependency won't power them).\n\n`);
      process.stdout.write(`            Or, without the plugin, wire \`runlist hud\` at SessionStart by hand —\n`);
      process.stdout.write(`            add to .claude/settings.json (merge into any existing hooks):\n\n`);
      process.stdout.write(`              "hooks": { "SessionStart": [\n`);
      process.stdout.write(`                { "hooks": [{ "type": "command", "command": "runlist hud" }] }\n`);
      process.stdout.write(`              ] }\n`);
    }
  }

  // Render the index against what we just scaffolded.
  //
  // `docs.md` ships a "no docs yet" placeholder, which stopped being true the
  // moment this command also started writing a sample plan — so a fresh init
  // committed an index that contradicted the tree beside it, and the user's first
  // `runlist check` opened with a stale-index warning. The config passed into
  // runInit predates the file we just wrote, so re-resolve before rendering.
  //
  // Best-effort: a repo that scaffolds correctly but cannot render its index is
  // still a successful init, and the next command regenerates it anyway.
  if (!dryRun) {
    try {
      const { resolveConfig } = await import('./config.mjs');
      const freshConfig = await resolveConfig(cwd, configPath);
      if (freshConfig.indexPath) {
        const { buildIndex } = await import('./index.mjs');
        const { writeRenderedIndex } = await import('./index-file.mjs');
        writeRenderedIndex(() => buildIndex(freshConfig, { fast: true }), freshConfig);
      }
    } catch {
      // Leave the placeholder; `runlist check` self-heals it on first run.
    }
  }

  if (promptTracking === 'tracked') {
    process.stdout.write('\n  Prompt tracking: tracked — prompt Git operations are allowed.\n');
  } else if (promptTracking === 'local') {
    process.stdout.write('\n  Prompt tracking: local — the guard denies prompt Git operations.\n');
    process.stdout.write('  This policy does not itself add ignore rules; git add -A can still stage prompts that are not ignored.\n');
  } else {
    process.stdout.write('\n  Prompt tracking: untracked. Leave pending prompts untracked to reduce commit churn.\n');
    process.stdout.write('  `git add -A` can still stage any pending prompts that are not ignored.\n');
  }
  if (!argv.includes('--gitignore')) {
    process.stdout.write('  Ignore files unchanged: runtime state in .runlist/ (and legacy .dotmd/) may also be staged by git add -A.\n');
    process.stdout.write('  Review selected files, or preview explicit ignore rules with `runlist init --gitignore --dry-run`.\n');
  }
  if (opts.guidance !== false) {
    process.stdout.write(dryRun
      ? '\nReady to initialize the project. Host integration is separate.\n'
      : '\nReady. Project initialized. Host integration is separate.\n');
    process.stdout.write('A few starting points:\n');
    process.stdout.write(`  runlist new doc my-doc            # scaffold a reference doc\n`);
    process.stdout.write(`  runlist new plan my-plan          # scaffold an execution plan\n`);
    process.stdout.write(`  runlist list                      # see what you've got\n`);
    process.stdout.write(`  runlist hud                       # session-start triage\n\n`);
  }
}
