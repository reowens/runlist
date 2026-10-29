import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { locateConfig, resolveConfig } from './config.mjs';
import { createFileExclusive, MutationConflictError, withPathLocks } from './atomic-mutation.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { collectDocFiles } from './index.mjs';
import { authorizeRepoGeneratedPath } from './managed-path.mjs';
import { CONFIG_FILENAMES, LEGACY_PROMPT_DIR, PROMPT_DIR } from './naming.mjs';
import { dim } from './color.mjs';
import { die } from './util.mjs';

// Handoffs-only mode: most people who try runlist want "save where we are" and
// "pick up where we left off", not a planning system. So the first prompt saved
// in a repository with no config creates the smallest config that makes every
// existing verb work — a root that IS the prompt folder, docs/prompts/ (the
// scan never sees the project's own docs, no generated index, no plan
// vocabulary to nag about) and `mode: 'handoffs'` so wording and plan verbs
// know planning is off. Inside that folder runlist manages only `type: prompt`
// files (src/handoffs-scope.mjs). `runlist setup` later rewrites those two
// lines to turn planning on, widening the root to docs/.
//
// Creating the config is split in two so a refused save leaves nothing behind:
// `planHandoffsConfig` decides everything and writes nothing (the caller runs
// its own checks against the proposed layout, and dry-run stops there), then
// `publishHandoffsConfig` writes the folder and the config. Prompts an older
// build saved in a root prompts/ are carried into docs/prompts/ between the two
// (`carryLegacyPrompts`), so the new config hides none of them.

export const HANDOFFS_CONFIG_FILE = 'runlist.config.mjs';
// The planning-off wording and the gate that prints it live with the scope
// rules (src/handoffs-scope.mjs), which the resolver and dispatcher import.
export { outsideHandoffsLine, PLANNING_OFF, planningRefusal, requirePlanning } from './handoffs-scope.mjs';

export function isHandoffsMode(config) {
  return config?.mode === 'handoffs';
}

// For wording on paths that locate a config without importing it (`baton
// --template`): the mode line as written, and no config at all reads as
// handoffs only, since nothing there plans yet.
export function readsAsHandoffsOnly(located) {
  if (located?.mode) return located.mode === 'handoffs';
  if (!located?.configPath) return true;
  try { return /^export const mode = (['"])handoffs\1;?[ \t]*$/m.test(readFileSync(located.configPath, 'utf8')); }
  catch { return false; }
}

export function handoffsConfigSource(promptTracking = 'untracked') {
  return `// runlist.config.mjs — created by the first \`runlist baton\` here, for session handoffs.
// Planning is off: runlist only manages the prompts in ${PROMPT_DIR}/.
// \`runlist setup\` turns planning on (adds plans and an index; prompts stay put).
export const mode = 'handoffs';
export const root = '${PROMPT_DIR}';
export const promptTracking = '${promptTracking}';
`;
}

// The Git toplevel, found the same way config discovery finds a repo root (a
// `.git` entry, file or directory), without spawning git on a hook path. Only
// a hint: `verifyGitWorktree` is what the writing path trusts.
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

function samePath(a, b) {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

// Git's own answer, which the `.git` walk above can get wrong: a bare
// repository (or a `.git` directory) nested inside a worktree, a `.git` file
// that is not a gitlink, and GIT_DIR / GIT_WORK_TREE pointing somewhere else
// all have a `.git` entry above them that is not the worktree Git would use.
// Only when Git says the working directory is inside a worktree whose top is
// that same folder does the config go there.
export function verifyGitWorktree(cwd, top) {
  const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--absolute-git-dir'], { cwd, encoding: 'utf8' });
  const [inside, gitTop, gitDir] = (result.stdout ?? '').split(/\r?\n/);
  if (result.error) return { refusal: `Could not run git to confirm this is a project (${result.error.message}), so nothing was saved. Run \`runlist setup\` to configure this folder.` };
  if (result.status !== 0 || inside !== 'true') {
    const overridden = process.env.GIT_DIR || process.env.GIT_WORK_TREE ? ' GIT_DIR or GIT_WORK_TREE is set and may point elsewhere.' : '';
    return { refusal: `This is not inside a Git working tree (a bare repository, a \`.git\` folder, or a broken \`.git\` file), so there is no project to save a handoff in.${overridden} Run this from your project's working tree, or run \`runlist setup\` to configure a folder.` };
  }
  if (!gitTop || !samePath(gitTop, top) || !gitDir || !samePath(gitDir, lexicalGitDir(top))) {
    return { refusal: `Git here uses ${gitDir || 'an unknown repository'} with the working tree ${gitTop || 'unknown'}, not the .git in ${top} (GIT_DIR or GIT_WORK_TREE may point elsewhere), so baton will not choose where the config goes. Run it from the project itself without those overrides, or run \`runlist setup\` there.` };
  }
  return {};
}

// The repository the nearest `.git` names: the folder itself, or the target of
// a gitlink file (worktrees and submodules).
function lexicalGitDir(top) {
  const entry = path.join(top, '.git');
  if (isDirectory(entry)) return entry;
  try {
    const target = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(entry, 'utf8'))?.[1];
    return target ? path.resolve(top, target) : null;
  } catch { return null; }
}

function isDirectory(file) {
  try { return lstatSync(file).isDirectory(); } catch { return false; }
}

function inside(directory, file) {
  const rel = path.relative(directory, file);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Everything runlist saved before there was a config, found the way the
// unconfigured commands find it (the recursive document scan), rooted at every
// folder the new config could hide. Dependency and Git folders are skipped:
// nothing there is the project's handoff. Only the explicit save path calls
// this; hooks never do. A scan that could not read a folder or file proves
// nothing about absence, so it reports itself incomplete.
function surveyPreConfig(config, bases) {
  let complete = true;
  const files = new Set();
  for (const base of new Set(bases)) {
    const scan = { ...config, mode: 'plans', docsRoot: base, docsRoots: [base], indexPath: null,
      excludeDirs: new Set([...(config.excludeDirs ?? []), '.git', 'node_modules']) };
    for (const file of collectDocFiles(scan, { onError: () => { complete = false; } })) files.add(file);
  }
  const plans = [];
  const prompts = [];
  for (const file of files) {
    let type;
    try { type = parseSimpleFrontmatter(extractFrontmatter(readFileSync(file, 'utf8')).frontmatter ?? '').type; }
    catch (err) { if (err.code !== 'ENOENT') complete = false; continue; }
    if (type === 'plan') plans.push(file);
    else if (type === 'prompt') prompts.push(file);
  }
  return { complete, files: [...files], plans, prompts };
}

// The unconfigured default folders only (and their archives), one level deep:
// cheap enough for any working directory, including a home folder. The root
// prompts/ older builds saved in counts as evidence of earlier handoffs, not
// as a place to write.
function hasDefaultFolderDocuments(config) {
  const folders = ['plans', LEGACY_PROMPT_DIR, 'docs/plans', PROMPT_DIR].flatMap(folder => {
    const directory = path.join(config.docsRoot, ...folder.split('/'));
    return [directory, path.join(directory, config.archiveDir)];
  });
  return folders.some(directory => {
    if (!isDirectory(directory)) return false;
    try {
      return readdirSync(directory, { withFileTypes: true }).some(entry => entry.isFile() && entry.name.endsWith('.md')
        && ['plan', 'prompt'].includes(readsType(path.join(directory, entry.name))));
    } catch { return true; }
  });
}

function readsType(file) {
  try { return parseSimpleFrontmatter(extractFrontmatter(readFileSync(file, 'utf8')).frontmatter ?? '').type; }
  catch { return null; }
}

// Whether the next prompt saved from `cwd` would create a handoffs config, for
// the hook's wording only: stat calls, no reads. Baton itself decides.
export function wouldCreateHandoffsConfig(cwd, config) {
  return !config.configFound && !handoffsAnchor(cwd).refusal;
}

function carryRefusal(outstanding) {
  return `Nothing saved: runlist keeps prompts in ${PROMPT_DIR}/, and moves the ones an older version saved in ${LEGACY_PROMPT_DIR}/ there before setting up handoffs, but cannot move these:\n${outstanding.map(item => `  ${item.description}`).join('\n')}\nRename or remove one file of each pair, then rerun.`;
}

const promptCount = n => `${n} prompt${n === 1 ? '' : 's'}`;

function setupLine(created, dryRun) {
  const where = `${created.config}, prompts in ${created.promptDirectory}/`;
  return dryRun
    ? `[dry-run] Would set up runlist for handoffs here (${where}). Planning stays off; \`runlist setup\` turns it on.`
    : `Set up runlist for handoffs here (${where}). Planning is off; \`runlist setup\` turns it on.`;
}

/**
 * Decide, without writing anything, how a prompt saved from `cwd` in a
 * repository with no config gets one. Returns null when a config exists;
 * `{ legacy }` when the save should go ahead unconfigured, as it did before
 * handoffs mode (runlist documents saved before setup that the new config would
 * hide, or a scan that could not prove there are none); otherwise the plan,
 * whose `config` is the proposed one for the caller's checks and whose
 * `carry` moves prompts from the root prompts/ an older version saved in. Dies
 * when there is no project to anchor a config to, or when such a prompt cannot
 * be carried (a file of the same name is already in docs/prompts/).
 */
export async function planHandoffsConfig(cwd, config, { home } = {}) {
  if (config.configFound) return null;
  const anchor = handoffsAnchor(cwd, { home });
  if (anchor.refusal) {
    // No config is created outside Git, so nothing can be hidden; a folder an
    // older version saved handoffs or plans in keeps working as it did.
    if (hasDefaultFolderDocuments(config)) return { legacy: true };
    die(anchor.refusal);
  }
  const top = anchor.top;
  const verified = verifyGitWorktree(cwd, top);
  if (verified.refusal) die(verified.refusal);
  const survey = surveyPreConfig(config, [top]);
  if (!survey.complete || survey.plans.length) return { legacy: true };
  const configPath = path.join(top, HANDOFFS_CONFIG_FILE);
  const promptDir = path.join(top, ...PROMPT_DIR.split('/'));
  const guardConfig = { repoRoot: top };
  authorizeRepoGeneratedPath(promptDir, guardConfig, { kind: 'Handoffs prompt folder' });
  authorizeRepoGeneratedPath(configPath, guardConfig, { kind: 'Handoffs config' });
  const proposed = await resolveConfig(cwd, configPath, { exports: { mode: 'handoffs', root: PROMPT_DIR, promptTracking: 'untracked' } });
  proposed.configWarnings = [];
  // The root prompts/ older builds saved in: its prompts and their archive are
  // carried with setup's transactional carry. Prompts anywhere else (nested
  // folders, another directory's prompts/) would be hidden, so the save stays
  // unconfigured, as it did before handoffs mode.
  const unconfigured = config.docsRoot === top ? config : await resolveConfig(top);
  const before = { ...unconfigured, excludeDirs: new Set([...(unconfigured.excludeDirs ?? []), '.git', 'node_modules']) };
  const { planSetupCarry } = await import('./setup-carry.mjs');
  const carry = planSetupCarry(before, proposed, true, { types: ['prompt'] });
  const accounted = new Set([...carry.moves.map(move => move.source), ...carry.outstanding.map(item => item.path)]);
  if (survey.prompts.some(file => !inside(promptDir, file) && !accounted.has(file))) return { legacy: true };
  if (carry.outstanding.length) die(carryRefusal(carry.outstanding));
  const moved = carry.moves.map(({ from, to }) => ({ from, to }));
  const created = { config: HANDOFFS_CONFIG_FILE, promptDirectory: PROMPT_DIR, moved, created: false };
  return { top, cwd, promptRoot: PROMPT_DIR, promptDir, configPath, source: handoffsConfigSource(), config: proposed,
    carry: { before, moves: carry.moves }, created, promptDirExists: isDirectory(promptDir), dryRunLine: setupLine(created, true) };
}

// The carried prompt that would land on `file`, if any: the save there is a
// duplicate of a prompt saved before, though it has not moved yet.
export function carriedOnto(plan, file) {
  return plan.carry.moves.find(move => path.resolve(move.target) === path.resolve(file)) ?? null;
}

// Before the config: move the prompts planned above into docs/prompts/, one
// transactional move each, and say so in one line (dry-run lists the moves). A
// carry that stops leaves no config, so the next run finds what is left in
// prompts/ and carries it.
export async function carryLegacyPrompts(plan, { dryRun = false, out = process.stderr } = {}) {
  const moves = plan.carry.moves;
  if (!moves.length) return;
  const what = `${promptCount(moves.length)} an older runlist saved in ${LEGACY_PROMPT_DIR}/ to ${PROMPT_DIR}/`;
  if (dryRun) {
    out.write(`${dim('[dry-run]')} Would move ${what}:\n${moves.map(move => `  ${move.from} → ${move.to}`).join('\n')}\n`);
    return;
  }
  const { applySetupCarry } = await import('./setup-carry.mjs');
  const result = applySetupCarry(moves, plan.carry.before);
  if (result.error) {
    die(`Nothing saved: moving ${what} stopped after ${result.completed.length} of ${moves.length} (${result.error}), so no config was written. Rerun the command to carry the rest; \`runlist doctor --transactions\` reports a move left unfinished.`);
  }
  plan.promptDirExists = true;
  out.write(`Moved ${what}.\n`);
}

function parentConfig(top) {
  const parent = path.dirname(top);
  return parent === top ? null : locateConfig(parent).configPath;
}

function manualConfig(plan) {
  return `Nothing saved: ${plan.top} cannot take a new file atomically (its filesystem does not support hard links), and a half-written config would stop every runlist command. Create ${plan.configPath} yourself with these lines, then rerun:\n${plan.source}`;
}

/**
 * Write the planned folder and config. Never overwrites or shadows a config:
 * one that appeared here or in a parent folder since planning is used instead
 * (a parent one that appears while ours is published wins, and ours is taken
 * back). Returns `{ config, created, line }`, `created`/`line` null when
 * another process's config is the one in effect; the caller then checks that
 * the save still lands where it was validated.
 */
export async function publishHandoffsConfig(plan, { testHooks } = {}) {
  const resolveNow = async () => ({ config: await resolveConfig(plan.cwd), created: null, line: null });
  if (locateConfig(plan.cwd).configPath) return resolveNow();
  const madeDirectories = [];
  for (let next = plan.promptDir; !existsSync(next); next = path.dirname(next)) madeDirectories.unshift(next);
  const undoDirectories = () => {
    for (const directory of [...madeDirectories].reverse()) try { rmdirSync(directory); } catch { /* not empty, or not ours */ }
  };
  // The folder first: a concurrent reader that finds the config finds its root.
  mkdirSync(plan.promptDir, { recursive: true });
  let published = false;
  try {
    withPathLocks(CONFIG_FILENAMES.map(name => path.join(plan.top, name)), { repoRoot: plan.top }, () => {
      if (locateConfig(plan.cwd).configPath) return;
      try {
        createFileExclusive(plan.configPath, plan.source, { repoRoot: plan.top, locked: true, requireAtomicPublish: true, testHooks });
        published = true;
      } catch (err) {
        if (!(err instanceof MutationConflictError)) throw err;
      }
    });
  } catch (err) {
    undoDirectories();
    if (err?.code === 'ERUNLIST_ATOMIC_PUBLISH_UNSUPPORTED') die(manualConfig(plan));
    throw err;
  }
  if (!published) return resolveNow();
  testHooks?.afterHandoffsConfigPublished?.(plan.configPath);
  if (parentConfig(plan.top)) {
    withPathLocks([plan.configPath], { repoRoot: plan.top }, () => {
      try { if (readFileSync(plan.configPath, 'utf8') === plan.source) unlinkSync(plan.configPath); } catch { /* already gone */ }
    });
    undoDirectories();
    die(`Nothing saved: a runlist config appeared in a parent folder (${parentConfig(plan.top)}) while baton was setting up ${plan.top}, so baton left that one in charge. Rerun the command.`);
  }
  const created = { ...plan.created, created: true };
  return { config: await resolveConfig(plan.cwd), created, line: setupLine(created, false) };
}

// After publishing, the save must still land where the caller validated it; a
// config published concurrently by someone else may put prompts elsewhere.
export function assertPublishedPromptFolder(plan, published, promptFolder) {
  if (path.resolve(promptFolder) === path.resolve(plan.promptDir)) return;
  die(`Nothing saved: another runlist config (${published.config.configPath}) took effect while baton was setting up handoffs. Rerun the command.`);
}

// Setup in a handoffs-only repository: the two exports to rewrite and the index
// a planning project gets, so the preview resolves the upgraded layout without
// writing anything first. The root widens from docs/prompts to docs, so the
// prompts keep their folder. Values are written as JavaScript literals and the
// result is checked to parse and to read back as the intended values before
// anything is replaced.
export function planHandoffsUpgrade(config) {
  const source = readFileSync(config.configPath, 'utf8');
  const promptRoot = path.relative(config.repoRoot, config.docsRoot).split(path.sep).join('/');
  const root = path.posix.dirname(PROMPT_DIR);
  const indexPath = path.posix.join(root, 'docs.md');
  const modeLine = /^export const mode = (['"])handoffs\1;?[ \t]*$/m;
  const rootLine = /^export const root = (?:'[^'\n]*'|"[^"\n]*");?[ \t]*$/m;
  if ((config.docsRoots ?? []).length !== 1 || promptRoot !== PROMPT_DIR || !modeLine.test(source) || !rootLine.test(source)) {
    throw new Error(`${config.configPath} is not the handoffs config runlist writes, so setup will not rewrite it. Set \`export const mode = 'plans'\` and a docs root yourself (see runlist.config.example.mjs), then rerun setup.`);
  }
  const rootSource = jsLiteral(root);
  let content = source
    .replace(/^\/\/ runlist\.config\.mjs — created by the first `runlist baton` here[^\n]*\n\/\/ Planning is off[^\n]*\n\/\/ `runlist setup` turns planning on[^\n]*\n/m,
      () => '// runlist.config.mjs — document management configuration (planning turned on by `runlist setup`).\n')
    .replace(modeLine, () => "export const mode = 'plans';")
    .replace(rootLine, () => `export const root = ${rootSource};`);
  const index = { path: indexPath, startMarker: '<!-- GENERATED:runlist:start -->', endMarker: '<!-- GENERATED:runlist:end -->', archivedLimit: 8 };
  const overrides = { mode: 'plans', root };
  if (!/^export const index\b/m.test(content)) {
    content += `\nexport const index = {\n  path: ${jsLiteral(indexPath)},\n  startMarker: '${index.startMarker}',\n  endMarker: '${index.endMarker}',\n  archivedLimit: 8,\n};\n`;
    overrides.index = index;
  }
  checkUpgradedConfig(content, { root, indexPath: overrides.index ? indexPath : null }, config.configPath);
  return { source, content, overrides, root, promptRoot, indexPath };
}

// Plain path characters stay in the single quotes the rest of the file uses;
// anything else (quotes, `$`, backslashes, non-ASCII) goes through JSON, whose
// string syntax is valid JavaScript.
export function jsLiteral(value) {
  return /^[\w./-]*$/.test(value) ? `'${value}'` : JSON.stringify(value);
}

// The inverse of jsLiteral for exactly what it writes, so the check below reads
// the values back without executing the config.
function readLiteral(text) {
  const trimmed = text.trim();
  if (/^'[\w./-]*'$/.test(trimmed)) return trimmed.slice(1, -1);
  return JSON.parse(trimmed);
}

export function checkUpgradedConfig(content, expected, configPath) {
  const fail = detail => { throw new Error(`Setup did not change ${configPath}: the upgraded config would not load as intended (${detail}). Edit it by hand (see runlist.config.example.mjs), then rerun setup.`); };
  const check = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: content, encoding: 'utf8' });
  if (check.error || check.status !== 0) fail((check.stderr || check.error?.message || 'syntax error').trim().split('\n').find(line => /Error/.test(line)) ?? 'syntax error');
  const roots = [...content.matchAll(/^export const root = (.*);$/gm)];
  if (roots.length !== 1) fail('root is not set exactly once');
  let root;
  try { root = readLiteral(roots[0][1]); } catch (err) { fail(err.message); }
  if (JSON.stringify(root) !== JSON.stringify(expected.root)) fail(`root reads back as ${JSON.stringify(root)}`);
  if (expected.indexPath) {
    const index = /^ {2}path: (.*),$/m.exec(content.slice(content.lastIndexOf('export const index')));
    let indexPath;
    try { indexPath = index && readLiteral(index[1]); } catch (err) { fail(err.message); }
    if (indexPath !== expected.indexPath) fail(`index.path reads back as ${JSON.stringify(indexPath)}`);
  }
}
