import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { locateConfig, resolveConfig } from './config.mjs';
import { createFileExclusive, inspectTransactions, MutationConflictError, recoverAbandonedTransactions, withPathLocks } from './atomic-mutation.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { authorizeRepoGeneratedPath, inLegacyPromptFolder, legacyPromptFolderPlace } from './managed-path.mjs';
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
export { isHandoffsMode, outsideHandoffsLine, PLANNING_OFF, planningRefusal, requirePlanning } from './handoffs-scope.mjs';


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
  return `// runlist.config.mjs — created by the first saved prompt here, for session handoffs.
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
  if (home && (path.resolve(top) === path.resolve(home) || samePath(top, home))) {
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

// The unconfigured default folders only (and their archives), one level deep,
// plus the root prompts/ older builds saved in, at any depth: cheap enough for
// any working directory, including a home folder. That root prompts/ counts as
// evidence of earlier handoffs, not as a place to write.
function hasDefaultFolderDocuments(config) {
  const folders = ['plans', 'docs/plans', PROMPT_DIR].flatMap(folder => {
    const directory = path.join(config.docsRoot, ...folder.split('/'));
    return [directory, path.join(directory, config.archiveDir)];
  });
  const holdsDocument = (directory, recursive) => {
    if (!isDirectory(directory)) return false;
    try {
      return readdirSync(directory, { withFileTypes: true }).some(entry => {
        const file = path.join(directory, entry.name);
        if (recursive && entry.isDirectory()) return holdsDocument(file, true);
        return entry.isFile() && entry.name.endsWith('.md') && ['plan', 'prompt'].includes(readsType(file));
      });
    } catch { return true; }
  };
  return folders.some(directory => holdsDocument(directory, false))
    || holdsDocument(path.join(config.docsRoot, ...LEGACY_PROMPT_DIR.split('/')), true);
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

function carryRefusal(outstanding, nothing = 'Nothing saved') {
  return `${nothing}: runlist keeps prompts in ${PROMPT_DIR}/, and moves the ones an older version saved in ${LEGACY_PROMPT_DIR}/ there first, but cannot move these:\n${outstanding.map(item => `  ${item.description}`).join('\n')}\nRename or remove one file of each pair, then rerun.`;
}

const promptCount = n => `${n} prompt${n === 1 ? '' : 's'}`;

function setupLine(created, dryRun) {
  const where = `${created.config}, prompts in ${created.promptDirectory}/`;
  return dryRun
    ? `[dry-run] Would set up runlist for handoffs here (${where}). Planning stays off; \`runlist setup\` turns it on.`
    : `Set up runlist for handoffs here (${where}). Planning is off; \`runlist setup\` turns it on.\nCommit runlist.config.mjs so everyone gets handoffs mode; leave prompts out of commits when promptTracking calls for it.`;
}

/**
 * Decide, without writing anything new, how a prompt saved from `cwd` in a
 * repository with no config gets one. Returns null when a config exists.
 * Otherwise the plan: `config` is the layout the save is checked against and
 * `carry` moves the prompts an older version saved in the root prompts/ into
 * docs/prompts/. Plans and other runlist documents saved before setup do not
 * stop it: they stay where they are, and the planning-off line counts the ones
 * `runlist setup` brings in. `legacy` marks a save outside Git, where no config
 * is created; a folder an older version saved handoffs or plans in keeps
 * working as it did. Dies when there is no project to anchor a config to, when
 * docs/prompts/ leads into the root prompts/, when such a prompt cannot be
 * carried (a file of the same name is already in docs/prompts/), or when a
 * move an earlier command left unfinished cannot be completed.
 *
 * That last step is the one write: a carry killed part-way leaves a
 * transaction recorded under the unconfigured roots, and it is finished or
 * undone under those same roots (as setup does) before anything else, so no
 * config is ever written over it. Dry-run reports it and stops there
 * (`previewStopped`): what the save would then do depends on that move.
 */
export async function planHandoffsConfig(cwd, config, { home, dryRun = false, out = process.stderr } = {}) {
  if (config.configFound) return null;
  const anchor = handoffsAnchor(cwd, { home });
  if (anchor.refusal) {
    // No config is created outside Git, so nothing can be hidden; a folder an
    // older version saved handoffs or plans in keeps working as it did.
    if (hasDefaultFolderDocuments(config)) return legacySave(withScanExclusions(config), { dryRun, out });
    die(anchor.refusal);
  }
  const top = anchor.top;
  const verified = verifyGitWorktree(cwd, top);
  if (verified.refusal) die(verified.refusal);
  const before = withScanExclusions(path.resolve(config.docsRoot) === path.resolve(top) ? config : await resolveConfig(top));
  if (await finishPreConfigMoves(before, { dryRun, out })) return { previewStopped: true };
  const configPath = path.join(top, HANDOFFS_CONFIG_FILE);
  const promptDir = path.join(top, ...PROMPT_DIR.split('/'));
  assertPromptFolderOutsideLegacy(promptDir, top);
  const guardConfig = { repoRoot: top };
  authorizeRepoGeneratedPath(promptDir, guardConfig, { kind: 'Handoffs prompt folder' });
  authorizeRepoGeneratedPath(configPath, guardConfig, { kind: 'Handoffs config' });
  const proposed = await resolveConfig(cwd, configPath, { exports: { mode: 'handoffs', root: PROMPT_DIR, promptTracking: 'untracked' } });
  proposed.configWarnings = [];
  // The root prompts/ older builds saved in, at any depth: its prompts are
  // carried with setup's transactional carry. Anything else saved before
  // setup stays put for `runlist setup`.
  const carry = await planCarry(before, proposed);
  if (carry.outstanding.length) die(carryRefusal(carry.outstanding));
  const moved = carry.moves.map(({ from, to }) => ({ from, to }));
  const created = { config: HANDOFFS_CONFIG_FILE, promptDirectory: PROMPT_DIR, moved, created: false };
  return { top, cwd, promptRoot: PROMPT_DIR, promptDir, configPath, source: handoffsConfigSource(), config: proposed,
    carry, created, promptDirExists: isDirectory(promptDir), dryRunLine: setupLine(created, true) };
}

// docs/prompts/ must not lead into the root prompts/ (a docs/ symlinked
// there, say): checked before anything is carried, published or created.
function assertPromptFolderOutsideLegacy(promptDir, top) {
  if (!inLegacyPromptFolder(promptDir, top)) return;
  die(`Nothing saved: ${PROMPT_DIR}/ here ${legacyPromptFolderPlace(promptDir, top)}, and runlist no longer writes prompts there. Change the link that leads there, then rerun.`);
}

function withScanExclusions(config) {
  return { ...config, excludeDirs: new Set([...(config.excludeDirs ?? []), '.git', 'node_modules']) };
}

async function planCarry(before, after) {
  const { planSetupCarry, unmanagedCarryReferences } = await import('./setup-carry.mjs');
  const carry = planSetupCarry(before, after, true, { types: ['prompt'] });
  return { before, moves: carry.moves, outstanding: carry.outstanding, references: unmanagedCarryReferences(before, carry.moves) };
}

// A new project `runlist init` starts at `top`: the prompts an older runlist
// saved in the root prompts/ move into `after`'s prompt folder before its
// config is written, with the first save's steps (finish, plan, refuse on a
// collision with nothing written) under the roots the project had before.
// `carryLegacyPrompts` then makes the moves, or lists them on a dry-run.
export async function planInitCarry(top, config, after, { dryRun = false, out = process.stdout } = {}) {
  const before = withScanExclusions(path.resolve(config.docsRoot) === path.resolve(top) ? config : await resolveConfig(top));
  if (await finishPreConfigMoves(before, { dryRun, out, nothing: 'Nothing initialized' })) return { previewStopped: true };
  const carry = await planCarry(before, after);
  if (carry.outstanding.length) die(carryRefusal(carry.outstanding, 'Nothing initialized'));
  return { carry };
}

// The unconfigured save outside Git: prompts go to docs/prompts/ in the
// working folder, and the root prompts/ is carried there first like any save.
async function legacySave(before, { dryRun, out }) {
  if (await finishPreConfigMoves(before, { dryRun, out })) return { previewStopped: true };
  const { promptDirectory } = await import('./new.mjs');
  const promptDir = promptDirectory(before);
  assertPromptFolderOutsideLegacy(promptDir, before.repoRoot);
  const carry = await planCarry(before, before);
  if (carry.outstanding.length) die(carryRefusal(carry.outstanding));
  return { legacy: true, top: before.repoRoot, promptRoot: path.relative(before.repoRoot, promptDir).split(path.sep).join('/'), promptDir,
    config: before, carry, created: null, promptDirExists: isDirectory(promptDir), dryRunLine: null };
}

// Moves an earlier command left unfinished in a repository with no config.
// Recovered under the unconfigured roots that authorized them; anything that
// cannot be stops the save before a config could strand it.
// `strict` is for a config about to be written: a move still recorded then
// (one needing `runlist doctor --transactions`, say) could be stranded outside
// the new root, so it stops the save. Otherwise only a recovery that fails
// stops the command, as it would stop any change.
export async function finishPreConfigMoves(before, { dryRun = false, out = process.stderr, nothing = 'Nothing saved', strict = true } = {}) {
  const pending = inspectTransactions(before.repoRoot, { config: before });
  if (!pending.length) return false;
  if (dryRun) {
    out.write(`${dim('[dry-run]')} Would first finish ${pending.length === 1 ? 'a move' : `${pending.length} moves`} an earlier runlist command left unfinished; nothing else is previewed until ${pending.length === 1 ? 'it is' : 'they are'} finished. Run the command without --dry-run to finish ${pending.length === 1 ? 'it' : 'them'} first.\n`);
    return true;
  }
  const sources = pending.flatMap(item => {
    try { return JSON.parse(readFileSync(item.manifestPath, 'utf8')).participants.filter(participant => participant.label === 'source').map(participant => participant.path); }
    catch { return []; }
  });
  let failure = null;
  try { recoverAbandonedTransactions(before.repoRoot, { config: before }); }
  catch (err) { failure = err; }
  const remaining = strict ? inspectTransactions(before.repoRoot, { config: before }) : [];
  if (remaining.length || failure) {
    const reason = remaining.map(item => `  ${item.id}: ${item.reason ?? (item.ownerLiveness === 'live' || item.lockHeld ? 'another runlist process is still running it' : 'not resolvable automatically')}`).join('\n') || `  ${failure.message}`;
    die(`${nothing}: a move an earlier runlist command left unfinished could not be completed:\n${reason}\n\`runlist doctor --transactions\` shows it; rerun once it is resolved.`);
  }
  // A move finished forward leaves its source folder as a completed carry
  // would, so emptied folders go the same way.
  const { cleanupSetupSourceDirectories } = await import('./setup-carry.mjs');
  cleanupSetupSourceDirectories(before, sources.filter(source => !existsSync(source)));
  return false;
}

// The carried prompt that would land on `file`, if any: the save there is a
// duplicate of a prompt saved before, though it has not moved yet.
export function carriedOnto(plan, file) {
  return plan.carry.moves.find(move => path.resolve(move.target) === path.resolve(file)) ?? null;
}

// Before the config: move the prompts planned above into docs/prompts/, one
// transactional move each, and say so in one line (dry-run lists the moves). A
// carry that stops leaves no config, so the next run finishes the move it was
// making and carries what is left in prompts/. Markdown runlist does not
// manage (no frontmatter) is never rewritten: a link there to a carried prompt
// is listed for the user to update.
export async function carryLegacyPrompts(plan, { dryRun = false, out = process.stderr, nothing = 'Nothing saved' } = {}) {
  const moves = plan.carry.moves;
  if (!moves.length) return;
  const what = `${promptCount(moves.length)} an older runlist saved in ${LEGACY_PROMPT_DIR}/ to ${PROMPT_DIR}/`;
  const references = plan.carry.references ?? [];
  const referenceLines = references.map(item => `  ${item.file} links to ${item.from}; update it to ${item.to}`).join('\n');
  if (dryRun) {
    out.write(`${dim('[dry-run]')} Would move ${what}:\n${moves.map(move => `  ${move.from} → ${move.to}`).join('\n')}\n`);
    if (references.length) out.write(`${dim('[dry-run]')} Would leave links in files runlist does not manage as they are:\n${referenceLines}\n`);
    return;
  }
  const { applySetupCarry } = await import('./setup-carry.mjs');
  const result = applySetupCarry(moves, plan.carry.before);
  if (result.error) {
    die(`${nothing}: moving ${what} stopped after ${result.completed.length} of ${moves.length} (${result.error}), and nothing else was done. Rerun the command to carry the rest; \`runlist doctor --transactions\` reports a move left unfinished.`);
  }
  plan.promptDirExists = true;
  out.write(`Moved ${what}.\n`);
  if (references.length) out.write(`Links in files runlist does not manage were left as they are:\n${referenceLines}\n`);
}

// Before a command changes documents in a repository with no config, the
// prompts an older runlist saved in the root prompts/ move to docs/prompts/,
// so nothing is consumed, archived or rewritten where runlist no longer writes
// (src/naming.mjs). Same transactional carry and refusals as a first save;
// files there that are not runlist prompts stay. Returns the moves made, for
// file arguments that named a moved prompt. Dry-run lists them and reports
// `preview: true`: what the command would then do depends on the move.
export async function carryBeforeChange(config, { dryRun = false, out = process.stderr } = {}) {
  if (config.configFound) return null;
  const legacy = path.join(config.repoRoot, ...LEGACY_PROMPT_DIR.split('/'));
  if (!holdsMarkdown(legacy)) return null;
  const before = withScanExclusions(path.resolve(config.docsRoot) === path.resolve(config.repoRoot) ? config : await resolveConfig(config.repoRoot));
  if (await finishPreConfigMoves(before, { dryRun, out, nothing: 'Nothing changed', strict: false })) return { moves: [], preview: true };
  const carry = await planCarry(before, before);
  if (carry.outstanding.length) die(carryRefusal(carry.outstanding, 'Nothing changed'));
  if (!carry.moves.length) return null;
  await carryLegacyPrompts({ carry }, { dryRun, out, nothing: 'Nothing changed' });
  return { moves: carry.moves, preview: dryRun };
}

function holdsMarkdown(directory) {
  if (!isDirectory(directory)) return false;
  try {
    return readdirSync(directory, { withFileTypes: true }).some(entry =>
      (entry.isFile() && entry.name.endsWith('.md')) || (entry.isDirectory() && holdsMarkdown(path.join(directory, entry.name))));
  } catch { return true; }
}

// Whether `file` exists once the carry above is made: already there, or a
// carried prompt lands on it.
export function existsAfterCarry(plan, file) {
  return existsSync(file) || Boolean(plan && carriedOnto(plan, file));
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
    .replace(/^\/\/ runlist\.config\.mjs — created by the first (?:`runlist baton`|saved prompt) here[^\n]*\n\/\/ Planning is off[^\n]*\n\/\/ `runlist setup` turns planning on[^\n]*\n/m,
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
