import { parseSimpleFrontmatter } from './frontmatter.mjs';

/** Repository-defined delivery stages. Status remains a separate lifecycle field. */
function configuredMilestones(config) {
  return (config?.raw ?? config)?.taxonomy?.milestones;
}

/** Missing and blank ships values are unset; never coerce other YAML values. */
export function readPlanStage(value) {
  if (value == null) return { word: null, invalid: false };
  if (typeof value !== 'string') return { word: null, invalid: true };
  const word = value.trim() || null;
  if (word && /[\r\n\0]/.test(value)) return { word: null, invalid: true };
  return { word, invalid: false };
}

/** The YAML subset parser represents bare blank fields as empty lists.
 * Distinguish a blank ships scalar from an explicitly authored empty list.
 */
export function readShipsFrontmatter(frontmatter) {
  const value = parseSimpleFrontmatter(frontmatter).ships;
  if (Array.isArray(value) && value.length === 0) {
    const firstShips = frontmatter.split(/\r?\n/).find(line => /^ships:/.test(line));
    if (/^ships:[ \t]*$/.test(firstShips ?? '')) return null;
  }
  return value ?? null;
}

/** Accept the legacy string vocabulary and richer { word, meaning } entries. */
export function getStageDefinitions(config) {
  const milestones = configuredMilestones(config);
  if (!Array.isArray(milestones)) return [];
  const definitions = [];
  const seen = new Set();
  for (const entry of milestones) {
    const value = typeof entry === 'string' ? entry
      : entry && typeof entry === 'object' && !Array.isArray(entry) ? entry.word : null;
    const { word, invalid } = readPlanStage(value);
    if (invalid) continue;
    if (!word || seen.has(word)) continue;
    seen.add(word);
    definitions.push({ word, meaning: typeof entry?.meaning === 'string' ? entry.meaning.trim() : '' });
  }
  return definitions;
}

/** Configuration diagnostics use the same warning convention as other taxonomies. */
export function validateStageDefinitions(config) {
  const milestones = configuredMilestones(config);
  if (milestones == null) return [];
  if (!Array.isArray(milestones)) return ['Config: taxonomy.milestones must be null or an array.'];
  const warnings = [];
  const seen = new Set();
  for (const [index, entry] of milestones.entries()) {
    const objectEntry = entry && typeof entry === 'object' && !Array.isArray(entry);
    const value = typeof entry === 'string' ? entry : objectEntry ? entry.word : entry;
    if (typeof value === 'string' && /[\r\n\0]/.test(value)) {
      warnings.push(`Config: taxonomy.milestones[${index}] stage word must be a single line without NUL characters.`);
      continue;
    }
    const { word, invalid } = readPlanStage(value);
    if (invalid || !word) {
      warnings.push(`Config: taxonomy.milestones[${index}] must be a nonempty string or an object with a nonempty string word.`);
      continue;
    }
    if (objectEntry && typeof entry.meaning !== 'string') {
      warnings.push(`Config: taxonomy.milestones[${index}].meaning must be a string.`);
    }
    if (seen.has(word)) warnings.push(`Config: taxonomy.milestones contains duplicate stage '${word}'.`);
    seen.add(word);
  }
  return warnings;
}
