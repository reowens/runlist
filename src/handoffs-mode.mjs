import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from './config.mjs';
import { createFileExclusive, MutationConflictError } from './atomic-mutation.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { authorizeRepoGeneratedPath } from './managed-path.mjs';
import { CONFIG_FILENAMES } from './naming.mjs';
import { die } from './util.mjs';

// Handoffs-only mode: most people who try runlist want "save where we are" and
// "pick up where we left off", not a planning system. So the first prompt saved
// in a repository with no config creates the smallest config that makes every
// existing verb work — a root that IS the prompt folder (the scan never sees the
// project's own docs, no generated index, no plan vocabulary to nag about) and
// `mode: 'handoffs'` so wording and plan verbs know planning is off.
// `runlist setup` later rewrites those two lines to turn planning on.

export const HANDOFFS_CONFIG_FILE = 'runlist.config.mjs';
export const PLANNING_OFF = 'Planning is off in this project; `runlist setup` turns it on (your prompts stay where they are).';

export function isHandoffsMode(config) {
  return config?.mode === 'handoffs';
}

export function handoffsConfigSource(promptRoot, promptTracking = 'untracked') {
  return `// runlist.config.mjs — created by the first \`runlist baton\` here, for session handoffs.
// Planning is off: runlist only manages the prompts in ${promptRoot}/.
// \`runlist setup\` turns planning on (adds plans and an index; prompts stay put).
export const mode = 'handoffs';
export const root = '${promptRoot}';
export const promptTracking = '${promptTracking}';
`;
}

// The Git toplevel, found the same way config discovery finds a repo root (a
// `.git` entry, file or directory), without spawning git on a hook path.
export function gitToplevel(cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    if (dir === path.parse(dir).root) return null;
  }
}

// Where an unconfigured repository may get a handoffs config, or why not.
// Outside Git there is no project boundary to anchor a config to (the working
// directory may be a home or scratch folder), and a home directory that is
// itself a Git repository (dotfiles) is never a project.
export function handoffsAnchor(cwd, { home = os.homedir() } = {}) {
  const top = gitToplevel(cwd);
  if (!top) return { refusal: 'Not in a Git repository, so there is no project to save a handoff in. Run this inside your project (`git init` first if it has none), or run `runlist setup` to configure this folder.' };
  if (home && path.resolve(top) === path.resolve(home)) {
    return { refusal: 'Your home directory is a Git repository; runlist will not set up handoffs there. Run this inside a project, or create runlist.config.mjs yourself.' };
  }
  return { top };
}

function isDirectory(file) {
  try { return lstatSync(file).isDirectory(); } catch { return false; }
}

function markdownIn(directory) {
  if (!isDirectory(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => path.join(directory, entry.name));
}

function isRunlistPrompt(file) {
  try {
    const fm = parseSimpleFrontmatter(extractFrontmatter(readFileSync(file, 'utf8')).frontmatter ?? '');
    return fm.type === 'prompt';
  } catch { return false; }
}

// Prompts live in docs/prompts/ when the project has a docs/ folder, else in
// prompts/. Two exceptions keep existing files where they are: runlist prompts
// an older version saved in prompts/ before any config are adopted in place,
// and a prompts/ folder of someone else's Markdown is left alone.
export function choosePromptRoot(top) {
  const rootPrompts = path.join(top, 'prompts');
  const existing = [...markdownIn(rootPrompts), ...markdownIn(path.join(rootPrompts, 'archived'))].slice(0, 500);
  if (existing.some(isRunlistPrompt)) return 'prompts';
  if (isDirectory(path.join(top, 'docs'))) return 'docs/prompts';
  return existing.length ? 'docs/prompts' : 'prompts';
}

// Runlist plans an older version saved before any config: those belong to a
// planning user, and `runlist setup` (not a handoffs config) is what carries them.
function hasPreConfigPlans(config, top = null) {
  const bases = [...new Set([config.docsRoot, ...(top ? [top] : [])])];
  const roots = bases.flatMap(base => [path.join(base, 'plans'), path.join(base, config.archiveDir)]);
  return roots.some(dir => markdownIn(dir).some(file => {
    try { return parseSimpleFrontmatter(extractFrontmatter(readFileSync(file, 'utf8')).frontmatter ?? '').type === 'plan'; }
    catch { return false; }
  }));
}

// Whether the next prompt saved from `cwd` would create a handoffs config:
// cheap enough for a hook (stat calls and a few frontmatter reads, no index).
export function wouldCreateHandoffsConfig(cwd, config) {
  if (config.configFound) return false;
  const anchor = handoffsAnchor(cwd);
  if (anchor.refusal) return false;
  try { return !hasPreConfigPlans(config, anchor.top); } catch { return false; }
}

function setupLine(created, dryRun) {
  const where = `${created.config}, prompts in ${created.promptDirectory}/`;
  return dryRun
    ? `[dry-run] Would set up runlist for handoffs here (${where}). Planning stays off; \`runlist setup\` turns it on.`
    : `Set up runlist for handoffs here (${where}). Planning is off; \`runlist setup\` turns it on.`;
}

/**
 * Before a prompt is saved in a repository with no config: create the
 * handoffs config at the Git toplevel and return the config to save with.
 * Returns `{ config, created, line }`; `created` is null when nothing was (or,
 * on dry-run, would be) set up. Never overwrites a config: the file is created
 * exclusively, and one that appears concurrently is simply used.
 */
export async function ensureHandoffsConfig(cwd, config, { dryRun = false, home } = {}) {
  if (config.configFound) return { config, created: null, line: null };
  const anchor = handoffsAnchor(cwd, { home });
  if (hasPreConfigPlans(config, anchor.top)) return { config, created: null, line: null, legacy: true };
  if (anchor.refusal) die(anchor.refusal);
  const top = anchor.top;
  const promptRoot = choosePromptRoot(top);
  const configPath = path.join(top, HANDOFFS_CONFIG_FILE);
  const created = { config: HANDOFFS_CONFIG_FILE, promptDirectory: promptRoot, created: !dryRun };
  const exports = { mode: 'handoffs', root: promptRoot, promptTracking: 'untracked' };
  if (dryRun) {
    const planned = await resolveConfig(cwd, configPath, { exports });
    planned.configWarnings = [];
    return { config: planned, created, line: setupLine(created, true) };
  }
  const guardConfig = { repoRoot: top };
  const promptDir = path.join(top, ...promptRoot.split('/'));
  authorizeRepoGeneratedPath(promptDir, guardConfig, { kind: 'Handoffs prompt folder' });
  authorizeRepoGeneratedPath(configPath, guardConfig, { kind: 'Handoffs config' });
  // The folder first: a concurrent reader that finds the config finds its root.
  mkdirSync(promptDir, { recursive: true });
  let line = null;
  if (CONFIG_FILENAMES.every(name => !existsSync(path.join(top, name)))) {
    try {
      createFileExclusive(configPath, handoffsConfigSource(promptRoot), { repoRoot: top });
      line = setupLine(created, false);
    } catch (err) {
      if (!(err instanceof MutationConflictError)) throw err;
    }
  }
  const resolved = await resolveConfig(cwd);
  if (!resolved.configFound) throw new Error(`Could not create ${configPath}.`);
  return { config: resolved, created: line ? created : null, line };
}

// Setup in a handoffs-only repository: the two exports to rewrite and the index
// a planning project gets, so the preview resolves the upgraded layout without
// writing anything first. Prompts keep their folder: a docs/prompts/ root
// becomes its parent docs root; any other prompt folder stays a second root.
export function planHandoffsUpgrade(config, docsRoot = 'docs') {
  const source = readFileSync(config.configPath, 'utf8');
  const promptRoot = path.relative(config.repoRoot, config.docsRoot).split(path.sep).join('/');
  const root = promptRoot === path.posix.join(docsRoot, 'prompts') ? docsRoot : [docsRoot, promptRoot];
  const indexPath = path.posix.join(docsRoot, 'docs.md');
  const modeLine = /^export const mode = (['"])handoffs\1;?[ \t]*$/m;
  const rootLine = /^export const root = (?:'[^'\n]*'|"[^"\n]*"|\[[^\]\n]*\]);?[ \t]*$/m;
  if ((config.docsRoots ?? []).length !== 1 || !modeLine.test(source) || !rootLine.test(source)) {
    throw new Error(`${config.configPath} is not the handoffs config runlist writes, so setup will not rewrite it. Set \`export const mode = 'plans'\` and a docs root yourself (see runlist.config.example.mjs), then rerun setup.`);
  }
  let content = source
    .replace(/^\/\/ runlist\.config\.mjs — created by the first `runlist baton` here[^\n]*\n\/\/ Planning is off[^\n]*\n\/\/ `runlist setup` turns planning on[^\n]*\n/m,
      '// runlist.config.mjs — document management configuration (planning turned on by `runlist setup`).\n')
    .replace(modeLine, "export const mode = 'plans';")
    .replace(rootLine, `export const root = ${Array.isArray(root) ? `[${root.map(item => `'${item}'`).join(', ')}]` : `'${root}'`};`);
  const index = { path: indexPath, startMarker: '<!-- GENERATED:runlist:start -->', endMarker: '<!-- GENERATED:runlist:end -->', archivedLimit: 8 };
  const overrides = { mode: 'plans', root };
  if (!/^export const index\b/m.test(content)) {
    content += `\nexport const index = {\n  path: '${indexPath}',\n  startMarker: '${index.startMarker}',\n  endMarker: '${index.endMarker}',\n  archivedLimit: 8,\n};\n`;
    overrides.index = index;
  }
  return { source, content, overrides, root, promptRoot, indexPath };
}
