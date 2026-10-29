import { readFileSync } from 'node:fs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';

// In a handoffs-only project (src/handoffs-mode.mjs) runlist owns the prompts
// in its prompt folder and nothing else there. That folder is often one the
// project already had — `prompts/` holding someone's prompt library, or a
// `docs/prompts/` of reference notes — so any other Markdown in it is the
// user's: never indexed, checked, searched, repaired or moved. Kept apart from
// handoffs-mode.mjs so the document collector and the mutation gate can ask
// without importing the config writer.

export function readsAsPrompt(file) {
  try {
    return parseSimpleFrontmatter(extractFrontmatter(readFileSync(file, 'utf8')).frontmatter ?? '').type === 'prompt';
  } catch { return false; }
}

export function managesFile(file, config) {
  return config?.mode !== 'handoffs' || readsAsPrompt(file);
}
