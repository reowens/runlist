import { existsSync } from 'node:fs';
import path from 'node:path';

// Canonical product-owned names and the spellings accepted during migration.
// Writers use the current names. Readers accept both so a new build can safely
// recover work left by an older build. Migration is intentionally one-way.
export const PRODUCT_NAME = 'runlist';
export const LEGACY_PRODUCT_NAME = 'dotmd';

export const STATE_DIR = '.runlist';
export const LEGACY_STATE_DIR = '.dotmd';

export const ARTIFACT_PREFIX = '.runlist-';
export const LEGACY_ARTIFACT_PREFIX = '.dotmd-';

export const CONFIG_FILENAMES = [
  'runlist.config.mjs',
  '.runlist.config.mjs',
  'runlist.config.js',
  'dotmd.config.mjs',
  '.dotmd.config.mjs',
  'dotmd.config.js',
];

// Where runlist writes prompts before any config, in a handoffs-only project
// and in a project `runlist init` starts. Builds before that saved them in a
// root prompts/ when there was no config; that folder is now only a source to
// carry them from (src/setup-carry.mjs), never a place anything new is
// written. A configured planning project keeps the prompt folder it chose.
export const PROMPT_DIR = 'docs/prompts';
export const LEGACY_PROMPT_DIR = 'prompts';

// Prompt statuses older builds wrote and later dropped: a prompt saved with
// one is still one runlist saved (carried like any other), and `check` names
// the verb that settles it rather than calling the status unknown.
export const RETIRED_PROMPT_STATUSES = new Set(['held', 'shelved', 'claimed']);

// The prompt routing a config written by `runlist setup` spells out, so its
// prompts go to <docs root>/prompts/ whatever the root is called. Without it
// the built-in routing reads a root whose name ends in "prompts" (notes/prompts,
// review-prompts) as the prompt folder itself, as configured projects rely on.
export const SETUP_PROMPT_ROUTING = Object.freeze({ dir: 'prompts', targetRoot: null });

// Before any config the docs root is the working folder itself, so prompts sit
// two levels down in it. A layout projected for a config about to be written
// (init, setup) has a docs root of its own and keeps the usual prompts/ in it.
export function rootIsWorkingFolder(config) {
  return !config.configFound && Boolean(config.configDir) && path.resolve(config.docsRoot) === path.resolve(config.configDir);
}

export const ENV_PREFIX = 'RUNLIST_';
export const LEGACY_ENV_PREFIX = 'DOTMD_';

// Prefer current state, but let an explicitly refused migration keep operating
// against the untouched legacy directory.
export function stateDir(repoRoot) {
  const root = path.resolve(repoRoot);
  const current = path.join(root, STATE_DIR);
  if (existsSync(current)) return current;
  const legacy = path.join(root, LEGACY_STATE_DIR);
  if (existsSync(legacy)) return legacy;
  return current;
}

export function isOwnedArtifact(basename, kind = '') {
  const suffix = kind ? `${kind}-` : '';
  return basename.startsWith(`${ARTIFACT_PREFIX}${suffix}`)
    || basename.startsWith(`${LEGACY_ARTIFACT_PREFIX}${suffix}`);
}

export function isSidecarArtifact(basename, kind = '') {
  const suffix = kind ? `${kind}-` : '';
  return basename.includes(`${ARTIFACT_PREFIX}${suffix}`)
    || basename.includes(`${LEGACY_ARTIFACT_PREFIX}${suffix}`);
}

export function readEnv(name, env = process.env) {
  const current = env[`${ENV_PREFIX}${name}`];
  if (current !== undefined) return current;
  return env[`${LEGACY_ENV_PREFIX}${name}`];
}
