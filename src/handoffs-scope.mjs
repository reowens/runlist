import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { die, resolveDocPath } from './util.mjs';

// In a handoffs-only project (src/handoffs-mode.mjs) runlist owns the prompts
// in its prompt folder and nothing else there. That folder is often one the
// project already had (a `docs/prompts/` of reference notes, say), so any
// other Markdown in it is the user's: never indexed, checked, searched,
// repaired or moved. Kept apart from handoffs-mode.mjs so the document
// collector, the file-argument resolver and the mutation gate can ask without
// importing the config writer.

export const PLANNING_OFF = 'Planning is off in this project; `runlist setup` turns it on (your prompts stay where they are).';

export function isHandoffsMode(config) {
  return config?.mode === 'handoffs';
}

export function readsAsPrompt(file) {
  try {
    return parseSimpleFrontmatter(extractFrontmatter(readFileSync(file, 'utf8')).frontmatter ?? '').type === 'prompt';
  } catch { return false; }
}

// A prompt in the prompt folder: the folder alone is not enough (the user's
// own notes may sit there), and neither is the type (a `type: prompt` file
// elsewhere in the project is not one of its handoffs).
export function managesFile(file, config) {
  if (config?.mode !== 'handoffs') return true;
  const target = path.resolve(file);
  return (config.docsRoots || [config.docsRoot]).some(root => within(root, target) || within(canonical(root), target)) && readsAsPrompt(file);
}

// Callers pass lexical and canonical paths alike (/var and /private/var).
function canonical(directory) {
  try { return realpathSync(directory); } catch { return directory; }
}

// The planning-off line, with the documents saved before setup that
// `runlist setup` brings in (`documentsWaitingForSetup` in
// src/setup-waiting.mjs counts them; never on a hook path).
export function planningOffLine(waiting = 0) {
  if (!waiting) return PLANNING_OFF;
  return `${PLANNING_OFF} ${waiting === 1 ? '1 runlist document saved before setup is' : `${waiting} runlist documents saved before setup are`} waiting for it.`;
}

export function planningRefusal(what, waiting = 0) {
  return `${what} needs planning. ${planningOffLine(waiting)}`;
}

export function outsideHandoffsLine(input) {
  return `\`${input}\` is outside this project's handoffs: ${PLANNING_OFF[0].toLowerCase()}${PLANNING_OFF.slice(1)}`;
}

// The one gate every planning command passes through (the `planning` entries
// in src/commands.mjs, read by the dispatcher). A view says planning is off and
// succeeds, as an empty dashboard would; an action refuses, so a script never
// mistakes a skipped change for a made one. Returns true when the caller must
// stop. Planning projects pass straight through.
export function requirePlanning(config, what, requirement, { json = false, out = process.stdout, waiting = 0 } = {}) {
  if (config?.mode !== 'handoffs' || !requirement) return false;
  if (requirement === 'action') die(planningRefusal(what, waiting));
  const message = planningOffLine(waiting);
  out.write(json ? `${JSON.stringify({ planning: false, message, ...(waiting ? { waitingForSetup: waiting } : {}) }, null, 2)}\n` : `${message}\n`);
  return true;
}

function within(directory, file) {
  const rel = path.relative(directory, file);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isDirectory(file) {
  try { return statSync(file).isDirectory(); } catch { return false; }
}

// Whether a file argument names something a handoffs-only project does not
// manage: an existing file that is not a prompt (the project's own Markdown,
// inside the prompt folder or not), or a path that points outside the prompt
// folder (`docs/plans/x.md`). A bare name, or a path into the prompt folder,
// is a prompt name that may just be mistyped, so it keeps the plain
// not-found answer with its suggestions.
export function outsideHandoffs(input, config) {
  if (config?.mode !== 'handoffs' || !input) return false;
  const roots = config.docsRoots || [config.docsRoot];
  const existing = resolveDocPath(input, config) ?? (String(input).endsWith('.md') ? null : resolveDocPath(`${input}.md`, config));
  if (existing) return isDirectory(existing) ? !roots.some(root => within(root, existing)) : !managesFile(existing, config);
  if (!path.isAbsolute(input) && !/[\\/]/.test(input)) return false;
  if (roots.some(root => within(root, path.resolve(config.repoRoot, input)))) return false;
  if (path.isAbsolute(input)) return true;
  return !roots.some(root => isDirectory(path.dirname(path.resolve(root, input))));
}

// For resolvers that find a file before asking whether runlist manages it.
export function assertInsideHandoffs(input, config) {
  if (outsideHandoffs(input, config)) die(outsideHandoffsLine(input));
}
