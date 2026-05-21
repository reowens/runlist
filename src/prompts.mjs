import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, die, resolveDocPath } from './util.mjs';
import { buildIndex } from './index.mjs';
import { runQuery } from './query.mjs';
import { runArchive } from './lifecycle.mjs';
import { runNew } from './new.mjs';
import { green, dim } from './color.mjs';

const SUBCOMMANDS = new Set(['list', 'next', 'use', 'archive', 'new']);

export async function runPrompts(argv, config, opts = {}) {
  const sub = argv[0];

  if (!sub || !SUBCOMMANDS.has(sub)) {
    return runPromptsList(argv, config, opts);
  }

  const rest = argv.slice(1);
  switch (sub) {
    case 'list':   return runPromptsList(rest, config, opts);
    case 'next':   return runPromptsNext(rest, config, opts);
    case 'use':    return runPromptsUse(rest, config, opts);
    case 'archive': return runPromptsArchive(rest, config, opts);
    case 'new':    return runPromptsNew(rest, config, opts);
  }
}

function runPromptsList(argv, config) {
  const index = buildIndex(config);
  const hasStatusFlag = argv.includes('--status');
  const includeArchived = argv.includes('--include-archived');
  const sub = argv[0];

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

function pendingPromptsOldestFirst(config) {
  const index = buildIndex(config);
  const prompts = index.docs.filter(d => d.type === 'prompt' && d.status === 'pending');

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
  const filePath = resolvePromptInput(input, config);
  consumePrompt(filePath, config, opts);
}

function consumePrompt(filePath, config, opts) {
  const { dryRun } = opts;
  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter, body } = extractFrontmatter(raw);
  const parsed = parseSimpleFrontmatter(frontmatter);
  const docType = asString(parsed.type);
  const status = asString(parsed.status);
  const repoPath = toRepoPath(filePath, config.repoRoot);

  if (docType !== 'prompt') {
    die(`Not a prompt (type: ${docType ?? 'unknown'}): ${repoPath}`);
  }
  if (status === 'archived') {
    die(`Already consumed: ${repoPath}`);
  }

  if (dryRun) {
    process.stderr.write(`${dim('[dry-run]')} Would emit body and archive: ${repoPath} (${status ?? 'unknown'} → archived)\n`);
    runArchive([filePath], config, { dryRun: true, out: process.stderr });
    return;
  }

  process.stdout.write(body);
  if (!body.endsWith('\n')) process.stdout.write('\n');

  runArchive([filePath], config, { out: process.stderr });
  process.stderr.write(`${green('✓ Consumed')}: ${repoPath}\n`);
}

function runPromptsArchive(argv, config, opts = {}) {
  const input = argv.find(a => !a.startsWith('-'));
  if (!input) die('Usage: dotmd prompts archive <file-or-slug>');
  const filePath = resolvePromptInput(input, config);

  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter } = extractFrontmatter(raw);
  const parsed = parseSimpleFrontmatter(frontmatter);
  if (asString(parsed.type) !== 'prompt') {
    die(`Not a prompt: ${toRepoPath(filePath, config.repoRoot)}`);
  }

  runArchive([filePath], config, opts);
}

async function runPromptsNew(argv, config, opts = {}) {
  if (!argv[0] || argv[0].startsWith('-')) {
    die('Usage: dotmd prompts new <slug> [body]\n       body: inline text | "-" (stdin) | "@path" (file) | --message "..."');
  }
  return runNew(['prompt', ...argv], config, opts);
}
