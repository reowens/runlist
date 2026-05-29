import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, die, resolveDocPath, isArchivedPath } from './util.mjs';
import { buildIndex } from './index.mjs';
import { runQuery } from './query.mjs';
import { runArchive, runStatus } from './lifecycle.mjs';
import { runNew } from './new.mjs';
import { green, dim } from './color.mjs';

// `resume` is an alias for `use` — agents reach for "resume" when continuing a
// session; `use` reads as internal mechanics. Both names stay valid; the
// canonical output ("Consumed: …") is unchanged.
const SUBCOMMANDS = new Set(['list', 'next', 'use', 'resume', 'archive', 'new', 'shelve', 'unshelve']);

export async function runPrompts(argv, config, opts = {}) {
  const sub = argv[0];

  if (!sub || !SUBCOMMANDS.has(sub)) {
    return runPromptsList(argv, config, opts);
  }

  const rest = argv.slice(1);
  switch (sub) {
    case 'list':     return runPromptsList(rest, config, opts);
    case 'next':     return runPromptsNext(rest, config, opts);
    case 'use':      return runPromptsUse(rest, config, opts);
    case 'resume':   return runPromptsUse(rest, config, opts);
    case 'archive':  return runPromptsArchive(rest, config, opts);
    case 'new':      return runPromptsNew(rest, config, opts);
    case 'shelve':   return runPromptsShelve(rest, config, opts);
    case 'unshelve': return runPromptsUnshelve(rest, config, opts);
  }
}

function runPromptsList(argv, config, opts = {}) {
  const index = buildIndex(config);
  const hasStatusFlag = argv.includes('--status');
  const includeArchived = argv.includes('--include-archived');
  const sub = argv[0];
  const json = argv.includes('--json');

  if (opts.verbose && !json) {
    renderPromptsVerbose(index, config, { hasStatusFlag, includeArchived });
    return;
  }

  const hasPositionalFilter = argv.some(a => !a.startsWith('-') && a !== 'list');
  if (!json && !hasStatusFlag && !includeArchived && !hasPositionalFilter && sub !== 'status' && !argv.some(a => a.startsWith('--sort') || a.startsWith('--limit') || a === '--all')) {
    renderPromptQueueList(index, config);
    return;
  }

  let defaults;
  let extras = argv;
  if (sub === 'status') {
    defaults = ['--type', 'prompt', '--exclude-archived', '--sort', 'status', '--all'];
    extras = argv.slice(1);
  } else if (hasStatusFlag || includeArchived) {
    defaults = ['--type', 'prompt', '--sort', 'updated', '--limit', '10'];
  } else {
    defaults = ['--type', 'prompt', '--exclude-archived', '--sort', 'updated', '--limit', '10'];
  }
  runQuery(index, [...defaults, ...extras], config, { preset: 'prompts' });
}

function renderPromptQueueList(index, config) {
  const queue = pendingPromptsOldestFirst(config);
  const queuedPaths = new Set(queue.map(q => q.doc.path));
  const others = index.docs
    .filter(d => d.type === 'prompt' && !queuedPaths.has(d.path) && !isArchivedPath(d.path, config) && d.status !== 'archived')
    .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '') || (a.title ?? a.path).localeCompare(b.title ?? b.path));
  const prompts = [...queue.map(q => q.doc), ...others];

  if (prompts.length === 0) {
    process.stdout.write('No prompts.\n');
    return;
  }

  const counts = {};
  for (const p of prompts) counts[p.status ?? 'unknown'] = (counts[p.status ?? 'unknown'] ?? 0) + 1;
  const summary = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(' · ');
  process.stdout.write(dim(`${prompts.length} prompts · ${summary}`) + '\n\n');

  const maxSlug = Math.min(36, Math.max(...prompts.map(p => path.basename(p.path, '.md').length)));
  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    const slug = path.basename(p.path, '.md').padEnd(maxSlug);
    const marker = i === 0 && p.status === 'pending' ? green('[NEXT]') : '      ';
    const status = `[${(p.status ?? 'unknown').toUpperCase()}]`;
    process.stdout.write(`  ${marker} ${slug} ${status}\n`);
  }
}

// Resolve a prompt's "target plan" for `prompts list --verbose`. Order:
//   1. frontmatter `related_plans:` (first entry — assumed plan slug)
//   2. frontmatter `parent_plan:`
//   3. first body markdown link to a .md file
// Returns a repo-relative display path or null.
function findPromptTarget(promptDoc, config) {
  const refs = promptDoc.refFields ?? {};
  const fmTargets = [...(refs.related_plans ?? []), ...(refs.parent_plan ?? [])];
  for (const t of fmTargets) {
    if (typeof t === 'string' && t.trim()) return slugToPlanPath(t.trim(), config);
  }

  const links = promptDoc.bodyLinks ?? [];
  const mdLink = links.find(l => /\.md(?:#|$)/.test(l.href ?? ''));
  if (mdLink) return resolveBodyLink(mdLink.href, promptDoc.path);
  return null;
}

// Plan slugs in frontmatter (e.g. `related_plans: [foo-bar]`) resolve to
// <docs-root>/plans/<slug>.md.
function slugToPlanPath(s, config) {
  const cleaned = s.replace(/#.*$/, '').replace(/^\.\//, '');
  if (cleaned.includes('/') || cleaned.endsWith('.md')) return cleaned;
  return `${config.docsRootPrefix || 'docs/'}plans/${cleaned}.md`;
}

// Resolve a markdown body link relative to the prompt's location so e.g.
// `../plans/foo.md` from docs/prompts/x.md → docs/plans/foo.md.
function resolveBodyLink(link, promptRepoPath) {
  const cleaned = link.replace(/#.*$/, '');
  if (cleaned.startsWith('/')) return cleaned.replace(/^\/+/, '');
  const promptDir = path.dirname(promptRepoPath);
  return path.normalize(path.join(promptDir, cleaned));
}

function renderPromptsVerbose(index, config, { hasStatusFlag, includeArchived }) {
  let prompts = index.docs.filter(d => d.type === 'prompt');
  if (!hasStatusFlag && !includeArchived) {
    prompts = prompts.filter(d => d.status !== 'archived');
  }
  if (prompts.length === 0) {
    process.stdout.write('No prompts.\n');
    return;
  }

  prompts.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));

  const counts = {};
  for (const p of prompts) counts[p.status ?? 'unknown'] = (counts[p.status ?? 'unknown'] ?? 0) + 1;
  const summary = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(' · ');
  process.stdout.write(`${prompts.length} prompt${prompts.length === 1 ? '' : 's'} · ${summary}\n\n`);

  for (const p of prompts) {
    const slug = path.basename(p.path, '.md');
    const target = findPromptTarget(p, config);
    const status = (p.status ?? 'unknown').toUpperCase();
    const arrow = target ? `  ${dim('→')} ${target}` : `  ${dim('→ (no target plan)')}`;
    process.stdout.write(`  ${green(slug)}  [${status}]\n${arrow}\n`);
  }
}

export function pendingPromptsOldestFirst(config) {
  const index = buildIndex(config);
  const prompts = index.docs.filter(d =>
    d.type === 'prompt'
    && d.status === 'pending'
    && !isArchivedPath(d.path, config),
  );

  return prompts
    .map(d => {
      const abs = resolveDocPath(d.path, config);
      let mtime = 0;
      try { mtime = abs ? statSync(abs).mtimeMs : 0; } catch { mtime = 0; }
      return { doc: d, abs, created: d.created ?? '', mtime };
    })
    .sort((a, b) => {
      if (a.created && b.created && a.created !== b.created) return a.created.localeCompare(b.created);
      if (a.created && !b.created) return -1;
      if (!a.created && b.created) return 1;
      return a.mtime - b.mtime;
    });
}

function runPromptsNext(argv, config, opts = {}) {
  const queue = pendingPromptsOldestFirst(config);
  if (queue.length === 0) {
    die('No pending prompts.');
  }
  const head = queue[0];
  if (!head.abs) die(`Could not resolve path: ${head.doc.path}`);
  consumePrompt(head.abs, config, opts);
}

// Resolve user input to a prompt path. Tries (in order): exact path,
// path + '.md', exact basename match across type: prompt docs, substring
// match across type: prompt docs. Returns the absolute path or dies with a
// helpful message (no match / ambiguous match).
function resolvePromptInput(input, config) {
  const direct = resolveDocPath(input, config);
  if (direct) return direct;

  if (!input.endsWith('.md')) {
    const withExt = resolveDocPath(input + '.md', config);
    if (withExt) return withExt;
  }

  const index = buildIndex(config);
  const prompts = index.docs.filter(d => d.type === 'prompt');
  if (prompts.length === 0) die(`No prompts in the index.`);

  const slug = input.replace(/\.md$/, '');

  const byBasename = prompts.filter(d => path.basename(d.path, '.md') === slug);
  if (byBasename.length === 1) return path.resolve(config.repoRoot, byBasename[0].path);
  if (byBasename.length > 1) {
    die(`Multiple prompts match "${input}" by basename:\n${byBasename.map(d => '  ' + d.path).join('\n')}`);
  }

  const bySubstring = prompts.filter(d =>
    d.path.includes(slug) || path.basename(d.path).includes(slug),
  );
  if (bySubstring.length === 1) return path.resolve(config.repoRoot, bySubstring[0].path);
  if (bySubstring.length > 1) {
    die(`Multiple prompts match "${input}":\n${bySubstring.map(d => '  ' + d.path).join('\n')}`);
  }

  die(`No prompt found matching: ${input}`);
}

function runPromptsUse(argv, config, opts = {}) {
  const input = argv.find(a => !a.startsWith('-'));
  if (!input) die('Usage: dotmd prompts use <file-or-slug>');
  const noIndex = argv.includes('--no-index') || opts.noIndex;
  const showFiles = argv.includes('--show-files') || opts.showFiles;
  const filePath = resolvePromptInput(input, config);
  consumePrompt(filePath, config, { ...opts, noIndex, showFiles });
}

export function consumePrompt(filePath, config, opts) {
  const { dryRun, noIndex, showFiles } = opts;
  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter, body } = extractFrontmatter(raw);
  const parsed = parseSimpleFrontmatter(frontmatter);
  const docType = asString(parsed.type);
  const status = asString(parsed.status);
  const repoPath = toRepoPath(filePath, config.repoRoot);

  if (docType !== 'prompt') {
    die(`Not a prompt (type: ${docType ?? 'unknown'}): ${repoPath}`);
  }
  if (status === 'archived' || isArchivedPath(repoPath, config)) {
    die(`Already consumed: ${repoPath}`);
  }

  if (dryRun) {
    const prefix = dim('[dry-run]');
    process.stderr.write(`${prefix} Would emit body and archive: ${repoPath} (${status ?? 'unknown'} → archived)\n`);
    const bytes = Buffer.byteLength(body, 'utf8');
    const lines = body.split('\n').length;
    process.stderr.write(`${prefix} body preview (${bytes}B, ${lines} lines):\n`);
    process.stderr.write(`${dim('---8<---')}\n`);
    process.stderr.write(body);
    if (!body.endsWith('\n')) process.stderr.write('\n');
    process.stderr.write(`${dim('--->8---')}\n`);
    runArchive([filePath], config, { dryRun: true, noIndex, out: process.stderr });
    return;
  }

  // Archive BEFORE emitting the body. If runArchive throws (git mv failure,
  // hook crash, anything), the body must not have already gone to stdout —
  // otherwise `claude "$(dotmd prompts next)"` consumes the prompt without it
  // ever being archived, and the next session sees the same prompt as pending.
  // Body is already in memory from extractFrontmatter, so the source file
  // can move out from under us safely.
  const archiveResult = runArchive([filePath], config, { noIndex, showFiles, out: process.stderr });

  process.stdout.write(body);
  if (!body.endsWith('\n')) process.stdout.write('\n');

  const consumedPath = archiveResult?.newRepoPath ?? repoPath;
  process.stderr.write(`${green('✓ Consumed')}: ${consumedPath}\n`);
}

function runPromptsArchive(argv, config, opts = {}) {
  const input = argv.find(a => !a.startsWith('-'));
  if (!input) die('Usage: dotmd prompts archive <file-or-slug>');
  const noIndex = argv.includes('--no-index') || opts.noIndex;
  const showFiles = argv.includes('--show-files') || opts.showFiles;
  const filePath = resolvePromptInput(input, config);

  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter } = extractFrontmatter(raw);
  const parsed = parseSimpleFrontmatter(frontmatter);
  if (asString(parsed.type) !== 'prompt') {
    die(`Not a prompt: ${toRepoPath(filePath, config.repoRoot)}`);
  }

  runArchive([filePath], config, { ...opts, noIndex, showFiles });
}

async function runPromptsNew(argv, config, opts = {}) {
  if (!argv[0] || argv[0].startsWith('-')) {
    die('Usage: dotmd prompts new <slug> [body]\n       body: inline text | piped stdin (auto) | "@path" (file) | --body "..."');
  }
  return runNew(['prompt', ...argv], config, opts);
}

async function runPromptsShelve(argv, config, opts = {}) {
  const input = argv.find(a => !a.startsWith('-'));
  if (!input) die('Usage: dotmd prompts shelve <file-or-slug>');
  const filePath = resolvePromptInput(input, config);
  return runStatus([filePath, 'shelved'], config, opts);
}

async function runPromptsUnshelve(argv, config, opts = {}) {
  const input = argv.find(a => !a.startsWith('-'));
  if (!input) die('Usage: dotmd prompts unshelve <file-or-slug>');
  const filePath = resolvePromptInput(input, config);
  return runStatus([filePath, 'pending'], config, opts);
}
