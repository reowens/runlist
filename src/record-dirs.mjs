import { readFileSync } from 'node:fs';
import path from 'node:path';
import { collectDocFiles } from './index.mjs';
import { normalizeStringList, toRepoPath } from './util.mjs';

// Records are Markdown files a plan keeps beside it under a folder named in
// `history.recordDirs` (default `assets`), as `<dir>/assets/<slug>/`. A
// repository usually lists that folder in excludeDirs so the index skips it.
// `runlist history` reads it, and a lifecycle move repoints the links in it,
// without changing what any other command skips.

export const recordDirsOf = config => [...new Set(normalizeStringList(config.raw?.history?.recordDirs ?? ['assets']).map(String))];

export const inRecordDir = (repoPath, config) => repoPath.split('/').some(p => recordDirsOf(config).includes(p));

/** Markdown under the roots with the record folders read too. Other
 * excluded folders stay excluded, and the shared config is not changed. */
export function filesWithRecords(config) {
  const keep = new Set(recordDirsOf(config));
  const excludeDirs = new Set([...(config.excludeDirs ?? [])].filter(d => !keep.has(d)));
  return collectDocFiles({ ...config, excludeDirs });
}

/** Record files the index does not read (their folder is excluded) whose
 * text names `file` by its basename: the ones a move of `file` may leave
 * pointing at a path that no longer exists. */
export function excludedRecordsNaming(file, config) {
  const excluded = recordDirsOf(config).filter(d => config.excludeDirs?.has(d));
  if (!excluded.length) return [];
  const name = Buffer.from(path.basename(file), 'utf8');
  return filesWithRecords(config).filter(f => {
    if (!toRepoPath(f, config.repoRoot).split('/').some(p => excluded.includes(p))) return false;
    try { return readFileSync(f).includes(name); } catch { return false; }
  });
}
