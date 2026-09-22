import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitRename } from './durable-rename.mjs';
import { readEnv, stateDir } from './naming.mjs';

// What every build of the index used to redo from scratch: read each document
// and pull its frontmatter, links, checklist and summary out of the body. None
// of that depends on the config or the clock, so it is kept per file under the
// state directory and reused while the file's size, times and inode are
// unchanged. Everything that does depend on them (terminal statuses, staleness,
// reference fields, validation) is still computed on every run.
//
// One line per document, `path \t stamp \t json`, so a hit parses only its own
// line and hands back fresh objects: nothing a caller does to a document can
// leak into what is saved. The cache is an optimisation and never an input:
// a missing, unreadable or foreign-version file is treated as empty, a failed
// write is dropped, and `RUNLIST_NO_PARSE_CACHE=1` turns it off.

const SCHEMA = 1;
const FILE_NAME = 'parse-cache';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = (() => {
  try { return JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; }
  catch { return 'unknown'; }
})();
const HEADER = JSON.stringify({ schema: SCHEMA, version: VERSION });

export function fileStamp(filePath) {
  try {
    const s = statSync(filePath, { bigint: true });
    return `${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.ino}`;
  } catch {
    return null;
  }
}

export function stampSize(stamp) {
  return Number(stamp.slice(0, stamp.indexOf(':')));
}

export function openParseCache(config) {
  if (readEnv('NO_PARSE_CACHE') === '1') return null;
  const dir = stateDir(config.repoRoot);
  // The state directory is created, and ignored by git, by `init` and the
  // commands that own it; a repo without one gets no cache rather than a new
  // untracked folder from a read-only command.
  if (!existsSync(dir)) return null;
  const cachePath = path.join(dir, FILE_NAME);
  const lines = new Map();
  try {
    const text = readFileSync(cachePath, 'utf8');
    const rows = text.split('\n');
    if (rows[0] === HEADER) {
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const a = row.indexOf('\t');
        const b = row.indexOf('\t', a + 1);
        if (a < 0 || b < 0) continue;
        lines.set(row.slice(0, a), { stamp: row.slice(a + 1, b), row });
      }
    }
  } catch { /* no cache yet */ }

  const seen = new Set();
  let dirty = false;

  return {
    get(key, stamp) {
      seen.add(key);
      const entry = lines.get(key);
      if (!entry || entry.stamp !== stamp) return null;
      try { return JSON.parse(entry.row.slice(entry.row.indexOf('\t', entry.row.indexOf('\t') + 1) + 1)); }
      catch { return null; }
    },
    set(key, stamp, value) {
      seen.add(key);
      if (/[\t\n]/.test(key)) return;
      lines.set(key, { stamp, row: `${key}\t${stamp}\t${JSON.stringify(value)}` });
      dirty = true;
    },
    save({ complete = true } = {}) {
      if (complete) {
        for (const key of lines.keys()) {
          if (!seen.has(key)) { lines.delete(key); dirty = true; }
        }
      }
      if (!dirty) return;
      const temp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        writeFileSync(temp, [HEADER, ...[...lines.values()].map(entry => entry.row)].join('\n'), 'utf8');
        commitRename(temp, cachePath);
        dirty = false;
      } catch {
        try { unlinkSync(temp); } catch { /* already gone */ }
      }
    },
  };
}
