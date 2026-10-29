import { readFileSync, statSync } from 'node:fs';
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

export function readsAsPrompt(file) {
  try {
    return parseSimpleFrontmatter(extractFrontmatter(readFileSync(file, 'utf8')).frontmatter ?? '').type === 'prompt';
  } catch { return false; }
}

export function managesFile(file, config) {
  return config?.mode !== 'handoffs' || readsAsPrompt(file);
}

export function planningRefusal(what) {
  return `${what} needs planning. ${PLANNING_OFF}`;
}

export function outsideHandoffsLine(input) {
  return `\`${input}\` is outside this project's handoffs: ${PLANNING_OFF[0].toLowerCase()}${PLANNING_OFF.slice(1)}`;
}

// The one gate every planning command passes through (the `planning` entries
// in src/commands.mjs, read by the dispatcher). A view says planning is off and
// succeeds, as an empty dashboard would; an action refuses, so a script never
// mistakes a skipped change for a made one. Returns true when the caller must
// stop. Planning projects pass straight through.
export function requirePlanning(config, what, requirement, { json = false, out = process.stdout } = {}) {
  if (config?.mode !== 'handoffs' || !requirement) return false;
  if (requirement === 'action') die(planningRefusal(what));
  out.write(json ? `${JSON.stringify({ planning: false, message: PLANNING_OFF }, null, 2)}\n` : `${PLANNING_OFF}\n`);
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
