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

// A record's header is the first lines after any frontmatter, where it names
// its plan. A lifecycle move repoints links there only: the rest of a record
// stays byte for byte, because some records are verbatim copies or have their
// sha256 pinned by evidence beside them.
export const RECORD_HEADER_LINES = 8;

/** Apply `rewrite` to a record's frontmatter and header lines, and keep the
 * rest of the file as it is. */
export function rewriteRecordHeader(raw, rewrite) {
  const lines = raw.split('\n');
  let from = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) from = end + 1;
  }
  const cut = Math.min(lines.length, from + RECORD_HEADER_LINES);
  const head = lines.slice(0, cut).join('\n');
  const rest = lines.slice(cut);
  const rewritten = rewrite(head);
  return rest.length ? `${rewritten}\n${rest.join('\n')}` : rewritten;
}

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
  // As loose as the reference rewriter's own prefilter: case-folded, and any
  // file with an escape or an encoded character is passed to it whole.
  const name = path.basename(file).toLowerCase();
  return filesWithRecords(config).filter(f => {
    if (!toRepoPath(f, config.repoRoot).split('/').some(p => excluded.includes(p))) return false;
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { return false; }
    return text.includes('%') || text.includes('\\') || text.toLowerCase().includes(name);
  });
}
