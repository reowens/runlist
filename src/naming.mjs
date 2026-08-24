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
