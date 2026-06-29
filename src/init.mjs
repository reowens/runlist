import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { green, dim, yellow } from './color.mjs';
import { warn } from './util.mjs';
import { removeGeneratedSlashCommands } from './claude-commands.mjs';

// Subdirectories scaffolded under docsRoot and tracked separately during scans.
// Each maps to a builtin type (plan, prompt). New types added here should also
// have a matching builtin template so `dotmd new <type>` lands files correctly.
const TYPE_SUBDIRS = ['plans', 'prompts'];

// Look for a `dotmd hud` SessionStart hook already wired in either the project
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
        if (typeof hook?.command === 'string' && /\bdotmd\s+hud\b/.test(hook.command)) {
          const rel = file.startsWith(cwd) ? path.relative(cwd, file) : file;
          return { wired: true, file: rel };
        }
      }
    }
  }
  return { wired: false };
}

const STARTER_CONFIG = `// dotmd.config.mjs — document management configuration
// All exports are optional. See dotmd.config.example.mjs for full reference.

export const root = 'docs';

export const index = {
  path: 'docs/docs.md',
  startMarker: '<!-- GENERATED:dotmd:start -->',
  endMarker: '<!-- GENERATED:dotmd:end -->',
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

const STARTER_INDEX = `# Docs

<!-- GENERATED:dotmd:start -->

_No docs yet. Run \`dotmd list\` after creating your first document._

<!-- GENERATED:dotmd:end -->
`;

function scanExistingDocs(dir) {
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
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch (err) { warn(`Could not read ${d}: ${err.message}`); return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nextTop = topSubdir === null ? entry.name : topSubdir;
        walk(path.join(d, entry.name), nextTop);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
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

  walk(dir, null);
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

// Sensible default stale thresholds (days) for statuses dotmd recognizes, used
// only to scope the generated config's staleDays to detected statuses. Mirrors
// the global + per-type defaults in config.mjs DEFAULTS; the repo's own custom
// statuses are intentionally absent so we don't invent a threshold for vocab we
// don't understand.
const KNOWN_STALE_DAYS = {
  'in-session': 1, active: 14, ready: 14, planned: 30, blocked: 30,
  scoping: 30, paused: 3, awaiting: 14, draft: 30, review: 14, pending: 30,
};

function generateDetectedConfig(scan, rootPath) {
  const lines = [`// dotmd.config.mjs — auto-detected from ${scan.docCount} existing docs`, ''];
  lines.push(`export const root = '${rootPath}';`);
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

  if (scan.surfaces.size > 0) {
    lines.push('export const taxonomy = {');
    lines.push(`  surfaces: [${[...scan.surfaces].sort().map(s => `'${s}'`).join(', ')}],`);
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
  lines.push(`  path: '${rootPath}/docs.md',`);
  lines.push(`  startMarker: '<!-- GENERATED:dotmd:start -->',`);
  lines.push(`  endMarker: '<!-- GENERATED:dotmd:end -->',`);
  lines.push(`  snapshot: 'status',`);
  lines.push('};');
  lines.push('');

  return lines.join('\n');
}

export async function runInit(cwd, config, opts = {}) {
  const { dryRun = false } = opts;
  const configPath = path.join(cwd, 'dotmd.config.mjs');
  const docsDir = path.join(cwd, 'docs');
  const indexPath = path.join(docsDir, 'docs.md');

  // Prefix every reported line during dry-run so the user can't mistake the
  // preview for a real run. Without this, every write below would silently
  // execute — runInit previously ignored the `--dry-run` flag entirely.
  const dryTag = dryRun ? `${dim('[dry-run]')} ` : '';

  process.stdout.write('\n');

  const scan = existsSync(docsDir) ? scanExistingDocs(docsDir) : null;

  if (existsSync(configPath)) {
    process.stdout.write(`  ${dryTag}${dim('exists')}  dotmd.config.mjs\n`);
  } else {
    if (scan && scan.docCount > 0) {
      if (!dryRun) writeFileSync(configPath, generateDetectedConfig(scan, 'docs'), 'utf8');
      process.stdout.write(`  ${dryTag}${green('create')}  dotmd.config.mjs (detected ${scan.docCount} docs)\n`);
    } else {
      if (!dryRun) writeFileSync(configPath, STARTER_CONFIG, 'utf8');
      process.stdout.write(`  ${dryTag}${green('create')}  dotmd.config.mjs\n`);
    }
  }

  if (existsSync(docsDir)) {
    process.stdout.write(`  ${dryTag}${dim('exists')}  docs/\n`);
  } else {
    if (!dryRun) mkdirSync(docsDir, { recursive: true });
    process.stdout.write(`  ${dryTag}${green('create')}  docs/\n`);
  }

  // Inspect root-level siblings (e.g. ./plans/, ./prompts/) before scaffolding.
  // If a sibling already holds content, skip creating the matching docs/<sub>/
  // so we don't quietly create a parallel dir the user has to reconcile.
  const siblingsWithContent = [];
  for (const sub of TYPE_SUBDIRS) {
    const siblingPath = path.join(cwd, sub);
    if (!existsSync(siblingPath)) continue;
    const c = countMarkdownFiles(siblingPath);
    const total = c.withFrontmatter + c.withoutFrontmatter;
    if (total > 0) siblingsWithContent.push({ sub, total });
  }
  const siblingSet = new Set(siblingsWithContent.map(s => s.sub));

  // Scaffold the canonical type subdirs (docs/plans/, docs/prompts/) so the
  // builtin `dotmd new plan` / `dotmd new prompt` templates land somewhere
  // sensible without extra config.
  for (const sub of TYPE_SUBDIRS) {
    const subPath = path.join(docsDir, sub);
    const counts = scan?.subdirCounts?.[sub];
    const total = counts ? counts.withFrontmatter + counts.withoutFrontmatter : 0;
    if (siblingSet.has(sub) && !existsSync(subPath)) {
      process.stdout.write(`  ${dryTag}${yellow('skip')}    docs/${sub}/ (root-level ./${sub}/ already holds content)\n`);
      continue;
    }
    if (existsSync(subPath)) {
      const detail = total > 0
        ? ` (${counts.withFrontmatter} dotmd-tracked, ${counts.withoutFrontmatter} plain .md)`
        : '';
      process.stdout.write(`  ${dryTag}${dim('exists')}  docs/${sub}/${detail}\n`);
    } else {
      if (!dryRun) mkdirSync(subPath, { recursive: true });
      process.stdout.write(`  ${dryTag}${green('create')}  docs/${sub}/\n`);
    }
  }

  if (existsSync(indexPath)) {
    process.stdout.write(`  ${dryTag}${dim('exists')}  docs/docs.md\n`);
  } else {
    if (!dryRun) writeFileSync(indexPath, STARTER_INDEX, 'utf8');
    process.stdout.write(`  ${dryTag}${green('create')}  docs/docs.md\n`);
  }

  if (siblingsWithContent.length > 0) {
    const list = siblingsWithContent
      .map(({ sub, total }) => `${sub}/ (${total} .md file${total === 1 ? '' : 's'})`)
      .join(', ');
    const subs = siblingsWithContent.map(s => s.sub);
    process.stdout.write(`\n  ${yellow('notice')}  found at repo root: ${list}\n`);
    process.stdout.write(`           these are NOT under docs/ and won't be tracked by the default config. Either:\n`);
    for (const sub of subs) {
      process.stdout.write(`             • move into docs/: mv ./${sub}/* docs/${sub}/ && rmdir ./${sub}\n`);
    }
    process.stdout.write(`             • or use a flat layout — set in dotmd.config.mjs:\n`);
    process.stdout.write(`                 export const root = [${subs.map(s => `'${s}'`).join(', ')}];\n`);
  }

  // .gitignore: ensure .dotmd/ is ignored (session leases live there)
  const gitignorePath = path.join(cwd, '.gitignore');
  const ignoreLine = '.dotmd/';
  if (existsSync(gitignorePath)) {
    const current = readFileSync(gitignorePath, 'utf8');
    const has = current.split('\n').some(l => l.trim() === ignoreLine || l.trim() === '.dotmd');
    if (!has) {
      const sep = current.endsWith('\n') ? '' : '\n';
      if (!dryRun) writeFileSync(gitignorePath, `${current}${sep}${ignoreLine}\n`, 'utf8');
      process.stdout.write(`  ${dryTag}${green('update')}  .gitignore (+${ignoreLine})\n`);
    } else {
      process.stdout.write(`  ${dryTag}${dim('exists')}  .gitignore\n`);
    }
  } else {
    if (!dryRun) writeFileSync(gitignorePath, `${ignoreLine}\n`, 'utf8');
    process.stdout.write(`  ${dryTag}${green('create')}  .gitignore\n`);
  }

  // Warn when docs/ is gitignored — silently scaffolding into an ignored dir
  // means every doc we manage falls outside git, which a doc-management tool
  // should not leave the user guessing about. Three of gmax's six docs were
  // force-added; the other three were untracked and the user had no way to
  // know without `git ls-files docs/`.
  if (existsSync(path.join(cwd, '.git'))) {
    const probe = spawnSync('git', ['check-ignore', '-q', 'docs/'], {
      cwd, encoding: 'utf8',
    });
    // Exit 0 → ignored. Exit 1 → not ignored. Exit 128 → not in repo / git error.
    if (probe.status === 0) {
      process.stdout.write(`\n  ${yellow('notice')}  docs/ is gitignored — files dotmd manages will NOT be tracked.\n`);
      process.stdout.write(`           Add an exception to .gitignore so docs/ is tracked:\n`);
      process.stdout.write(`             !docs/\n`);
      process.stdout.write(`           Or run: echo '!docs/' >> .gitignore\n`);
    }
  }

  // Bulk-tag hint — when init found pre-existing .md files without
  // type/status, point at the command that can tag them in one shot. Init's
  // job here is discovery; the per-file detail lives in `bulk-tag --dry-run`.
  if (scan?.untaggedCount > 0) {
    const n = scan.untaggedCount;
    const noun = n === 1 ? 'file' : 'files';
    process.stdout.write(`\n  ${yellow('hint')}    ${n} untagged .md ${noun} found — run \`dotmd bulk-tag --dry-run\` to preview tagging.\n`);
  }

  // Claude Code integration. dotmd no longer scaffolds per-repo
  // `.claude/commands/*.md` slash commands — the dotmd plugin's SKILL.md is the
  // canonical agent-facing workflow now, and `dotmd hud` injects this repo's
  // status vocab at runtime.
  const hasProjectClaude = existsSync(path.join(cwd, '.claude'));
  // A project `.claude/` proves it; a user-global `~/.claude/` means they run
  // Claude Code elsewhere, so the plugin nudge is still relevant before this
  // repo has any `.claude/` of its own (the common greenfield case).
  const likelyClaudeUser = hasProjectClaude || existsSync(path.join(os.homedir(), '.claude'));

  // If a `.claude/` exists, sweep any retired generated command files
  // (banner-gated, so hand-authored ones survive).
  if (hasProjectClaude) {
    const removed = removeGeneratedSlashCommands(cwd, { dryRun });
    for (const r of removed) {
      const verb = dryRun ? 'would remove' : 'removed';
      process.stdout.write(`  ${dryTag}${yellow('clean')}   .claude/commands/${r.name} (retired — ${verb}; guidance ships via the dotmd plugin)\n`);
    }
  }

  if (likelyClaudeUser) {
    const sessionStart = detectSessionStartHook(cwd);
    if (sessionStart.wired) {
      process.stdout.write(`  ${dim('exists')}  ${sessionStart.file} (SessionStart hook for \`dotmd hud\` already wired)\n`);
    } else {
      process.stdout.write(`\n  ${yellow('hint')}    install the dotmd Claude Code plugin so its hooks + workflow skill\n`);
      process.stdout.write(`            travel to every session and subagent automatically:\n\n`);
      process.stdout.write(`              /plugin marketplace add reowens/dotmd\n`);
      process.stdout.write(`              /plugin install dotmd@dotmd\n\n`);
      process.stdout.write(`            The plugin's hooks call \`dotmd\` on your PATH, so install the CLI\n`);
      process.stdout.write(`            globally too — ${green('npm i -g dotmd-cli')} (a project devDependency won't power them).\n\n`);
      process.stdout.write(`            Or, without the plugin, wire \`dotmd hud\` at SessionStart by hand —\n`);
      process.stdout.write(`            add to .claude/settings.json (merge into any existing hooks):\n\n`);
      process.stdout.write(`              "hooks": { "SessionStart": [\n`);
      process.stdout.write(`                { "hooks": [{ "type": "command", "command": "dotmd hud" }] }\n`);
      process.stdout.write(`              ] }\n`);
    }
  }

  process.stdout.write(`\nReady. A few starting points:\n`);
  process.stdout.write(`  dotmd new doc my-doc            # scaffold a reference doc\n`);
  process.stdout.write(`  dotmd new plan my-plan          # scaffold an execution plan\n`);
  process.stdout.write(`  dotmd list                      # see what you've got\n`);
  process.stdout.write(`  dotmd hud                       # session-start triage\n\n`);
}
