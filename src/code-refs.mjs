// Reference repair outside the doc roots.
//
// Every sweep the lifecycle runs is pushed through `authorizeManagedSweep` →
// `authorizeManagedSource`, which refuses anything that is not a `.md` file
// inside a configured docs root. That chokepoint is what makes a move's write
// set provable, so it is deliberately NOT widened here: this module walks the
// configured code roots on its own, outside the move transaction, and archive
// and rename call it after their own doc-root repair has committed.
//
// Two rules separate it from the document rewriter:
//   1. It matches the full repo-relative path only, never a bare basename. A
//      corpus cites slugs as words in prose comments, so a basename match is
//      how a rename corrupts an unrelated line.
//   2. It replaces the path segment and nothing else, so a `§`/`#` anchor, a
//      closing backtick, a quote or a trailing comma all survive untouched.
//      That also means the rendering is repo-relative, which is the spelling a
//      reader of a source comment can paste; the doc rewriter's doc-relative
//      rendering is not reused.

import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { escapeRegex, toRepoPath } from './util.mjs';
import { collectDocFiles } from './index.mjs';
import { bold, dim, green, yellow } from './color.mjs';

// Supported source kinds include TypeScript, Swift, SQL, ESM scripts, TSX,
// shell, Python, GraphQL and Dockerfiles.
// An entry without a leading dot is an exact basename, which is how a file
// with no extension opts in.
export const DEFAULT_CODE_EXTENSIONS = Object.freeze([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.swift', '.kt', '.sql', '.py', '.sh', '.rb', '.go', '.rs',
  '.graphql', '.gql', '.yml', '.yaml', '.css', '.scss', '.toml',
  'Dockerfile', 'Justfile', 'Makefile',
]);

// Generated output is excluded rather than reported: rewriting an artifact is
// undone by the next codegen run, and the citation lives in the schema
// description upstream.
export const DEFAULT_CODE_EXCLUDES = Object.freeze([
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/*.generated.*',
  '**/__generated__/**',
  '**/generated/**',
]);

// Comment openers by file kind. The classifier only asks whether an opener
// precedes the match on the same line, so a table this small is enough — and
// getting it wrong is safe in one direction only, which is why `#` is not
// handed to every language.
const COMMENT_OPENERS = {
  c: ['//', '/*', '*'],
  hash: ['#'],
  sql: ['--', '/*', '*'],
  all: ['//', '/*', '*', '#', '--'],
};

const OPENERS_BY_EXTENSION = new Map([
  ['.ts', 'c'], ['.tsx', 'c'], ['.js', 'c'], ['.jsx', 'c'], ['.mjs', 'c'], ['.cjs', 'c'],
  ['.swift', 'c'], ['.kt', 'c'], ['.css', 'c'], ['.scss', 'c'], ['.go', 'c'], ['.rs', 'c'],
  ['.sql', 'sql'],
  ['.py', 'hash'], ['.sh', 'hash'], ['.rb', 'hash'], ['.yml', 'hash'], ['.yaml', 'hash'],
  ['.toml', 'hash'], ['.graphql', 'hash'], ['.gql', 'hash'],
]);

export function codeRefsConfig(config) {
  const roots = config?.codeRefs?.roots ?? [];
  return {
    roots,
    extensions: config?.codeRefs?.extensions ?? [...DEFAULT_CODE_EXTENSIONS],
    excludes: config?.codeRefs?.excludes ?? [...DEFAULT_CODE_EXCLUDES],
    untouched: new Set(config?.codeRefs?.untouched ?? []),
    enabled: roots.length > 0,
  };
}

// ── Globs ────────────────────────────────────────────────────────────────

// A deliberately small subset: `**` spans segments, `*` stays inside one, `?`
// is one character. Enough for the exclude shapes a code root needs, and it
// refuses to grow into a dependency.
export function globToRegex(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; out += '(?:.*/)?'; }
        else out += '.*';
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeRegex(ch);
    }
  }
  return new RegExp(out + '$');
}

export function matchesAnyGlob(repoPath, patterns) {
  return patterns.some(pattern => globToRegex(pattern).test(repoPath));
}

// ── Walking the code roots ───────────────────────────────────────────────

function extensionAllowed(basename, extensions) {
  const ext = path.extname(basename);
  if (ext && extensions.includes(ext)) return true;
  return extensions.includes(basename);
}

export function collectCodeFiles(config) {
  const settings = codeRefsConfig(config);
  if (!settings.enabled) return [];
  const files = [];
  const seen = new Set();

  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const repoPath = toRepoPath(abs, config.repoRoot);
      if (matchesAnyGlob(repoPath, settings.excludes)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!entry.isFile()) continue;
      if (!extensionAllowed(entry.name, settings.extensions)) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);
      files.push(abs);
    }
  };

  for (const root of settings.roots) {
    const abs = path.resolve(config.repoRoot, root);
    let stat;
    try { stat = statSync(abs); } catch { continue; }
    if (!stat.isDirectory()) continue;
    walk(abs);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

// ── The matcher ──────────────────────────────────────────────────────────

// The path may not continue in either direction: a preceding path character
// means this is a longer path that merely ends with ours, and a following one
// means the citation names something below it. Everything else — a quote, a
// backtick, a bracket, a space, a line start, a trailing `§` or `#` anchor —
// is a boundary, and is left exactly as it was found.
export function referenceRegex(repoPath) {
  return new RegExp(`(?<![A-Za-z0-9_\\-/.])${escapeRegex(repoPath)}(?![A-Za-z0-9_\\-/])`, 'g');
}

const ANCHOR = /^\s*(?:§|#[A-Za-z0-9])/;

function commentOpenerIndex(line, kind) {
  const openers = COMMENT_OPENERS[kind] ?? COMMENT_OPENERS.all;
  let best = -1;
  for (const opener of openers) {
    let from = 0;
    for (;;) {
      const at = line.indexOf(opener, from);
      if (at === -1) break;
      from = at + 1;
      // `https://` is not a comment. A lone `*` only opens a continuation
      // line when it is the first thing on the line.
      if (opener === '//' && line[at - 1] === ':') continue;
      if (opener === '*' && line.slice(0, at).trim() !== '') continue;
      if (best === -1 || at < best) best = at;
      break;
    }
  }
  return best;
}

function insideQuotes(line, index) {
  let quote = null;
  for (let i = 0; i < index; i++) {
    const ch = line[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
  }
  return quote;
}

// `comment` is written by `--fix`; `string` and `code` wait for `--strings`,
// because a path inside a quoted string can be data a test or a guard asserts
// on rather than prose a reader follows.
export function classifyMatch(line, index, fileKind) {
  const opener = commentOpenerIndex(line, fileKind);
  if (opener !== -1 && opener < index) return 'comment';
  return insideQuotes(line, index) ? 'string' : 'code';
}

function fileKindFor(filePath) {
  return OPENERS_BY_EXTENSION.get(path.extname(filePath)) ?? 'all';
}

export function findCodeReferences(content, repoPath, filePath) {
  const kind = fileKindFor(filePath);
  const lines = content.split('\n');
  const hits = [];
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const regex = referenceRegex(repoPath);
    let match;
    while ((match = regex.exec(line)) !== null) {
      hits.push({
        line: n + 1,
        column: match.index + 1,
        text: line.trim(),
        form: classifyMatch(line, match.index, kind),
        anchored: ANCHOR.test(line.slice(match.index + repoPath.length)),
      });
    }
  }
  return hits;
}

export function rewriteCodeReferences(content, oldRepoPath, newRepoPath, filePath, { strings = false } = {}) {
  const kind = fileKindFor(filePath);
  const lines = content.split('\n');
  let changed = 0;
  const out = lines.map(line => {
    const regex = referenceRegex(oldRepoPath);
    return line.replace(regex, (found, offset) => {
      const form = classifyMatch(line, offset, kind);
      if (form !== 'comment' && !strings) return found;
      changed++;
      return newRepoPath;
    });
  });
  return { content: out.join('\n'), changed };
}

// ── Scanning ─────────────────────────────────────────────────────────────

function writability(absPath, repoRoot) {
  let canonical;
  try { canonical = realpathSync(absPath); } catch (err) { return `cannot be resolved (${err.code ?? err.message})`; }
  const repoCanonical = realpathSync(repoRoot);
  const relative = path.relative(repoCanonical, canonical);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return 'resolves outside the repository';
  try { accessSync(canonical, constants.W_OK); } catch { return 'is not writable'; }
  return null;
}

/**
 * Report every code-root citation of `oldRepoPath`. Pure read: `runlist refs`
 * and the archive / rename count line share it, the same way `fixBrokenRefs`
 * is shared by `fix-refs` and `check --fix`.
 */
export function scanCodeRefs(config, oldRepoPath, { files = null } = {}) {
  const settings = codeRefsConfig(config);
  const result = { enabled: settings.enabled, files: [], total: 0, byForm: { comment: 0, string: 0, code: 0 }, untouchedCount: 0, refused: [] };
  if (!settings.enabled) return result;

  for (const absPath of files ?? collectCodeFiles(config)) {
    let content;
    try { content = readFileSync(absPath, 'utf8'); } catch { continue; }
    if (!content.includes(oldRepoPath)) continue;
    const repoPath = toRepoPath(absPath, config.repoRoot);
    const hits = findCodeReferences(content, oldRepoPath, absPath);
    if (!hits.length) continue;
    const untouched = settings.untouched.has(repoPath);
    result.files.push({ path: repoPath, absPath, untouched, hits });
    result.total += hits.length;
    if (untouched) result.untouchedCount += hits.length;
    for (const hit of hits) result.byForm[hit.form]++;
  }
  return result;
}

/** Writable citations only: what `--fix` (or `--fix --strings`) would change. */
export function fixableCount(scan, { strings = false } = {}) {
  let count = 0;
  for (const file of scan.files) {
    if (file.untouched) continue;
    for (const hit of file.hits) {
      if (hit.form === 'comment' || strings) count++;
    }
  }
  return count;
}

export function applyCodeRefs(config, scan, oldRepoPath, newRepoPath, { strings = false, dryRun = false } = {}) {
  const written = [];
  const refused = [];
  let changed = 0;
  for (const file of scan.files) {
    if (file.untouched) continue;
    const reason = writability(file.absPath, config.repoRoot);
    if (reason) { refused.push({ path: file.path, reason }); continue; }
    const content = readFileSync(file.absPath, 'utf8');
    const result = rewriteCodeReferences(content, oldRepoPath, newRepoPath, file.absPath, { strings });
    if (!result.changed || result.content === content) continue;
    if (!dryRun) writeFileSync(file.absPath, result.content, 'utf8');
    written.push({ path: file.path, changed: result.changed });
    changed += result.changed;
  }
  return { written, refused, changed };
}

// ── The work list for `refs repair` ──────────────────────────────────────

// Nothing in the tool records where a document used to live: a rename moves
// the file and rewrites the doc-root references, and neither writes the old
// path anywhere. The one move that leaves a readable trace is the archive,
// whose destination is the source path with the archive directory inserted,
// so the previous path is that segment removed. A hand-moved or renamed
// document is out of reach here and `refs <old> <new>` covers it by hand.
export function archivedPreviousPaths(config) {
  const docs = collectDocFiles(config).map(file => toRepoPath(file, config.repoRoot));
  const live = new Set(docs);
  const pairs = [];
  for (const current of docs) {
    const segments = current.split('/');
    const at = segments.lastIndexOf(config.archiveDir);
    if (at === -1) continue;
    const previous = [...segments.slice(0, at), ...segments.slice(at + 1)].join('/');
    if (previous === current) continue;
    // A live document at that path means the citation is not stale.
    if (live.has(previous)) continue;
    pairs.push({ previous, current });
  }
  return pairs;
}

// ── Output ───────────────────────────────────────────────────────────────

const FORM_LABELS = { comment: 'In a comment', string: 'In a string literal', code: 'In code' };

function writeGroup(out, label, entries, { prefix = '' } = {}) {
  if (!entries.length) return;
  const lines = entries.reduce((sum, entry) => sum + entry.hits.length, 0);
  out.write(`${prefix}${bold(label)} (${lines} in ${entries.length} file${entries.length === 1 ? '' : 's'}):\n`);
  for (const entry of entries) {
    for (const hit of entry.hits) {
      out.write(`${prefix}  ${entry.path}:${hit.line}  ${dim(hit.text)}\n`);
    }
  }
}

function groupBy(scan, form) {
  return scan.files
    .filter(file => !file.untouched)
    .map(file => ({ path: file.path, hits: file.hits.filter(hit => hit.form === form) }))
    .filter(file => file.hits.length);
}

export function reportScan(scan, oldRepoPath, newRepoPath, out, { prefix = '' } = {}) {
  out.write(`${prefix}${oldRepoPath} → ${newRepoPath}\n\n`);
  for (const form of ['comment', 'string', 'code']) {
    writeGroup(out, FORM_LABELS[form], groupBy(scan, form), { prefix });
  }
  const untouched = scan.files.filter(file => file.untouched);
  if (untouched.length) {
    writeGroup(out, 'Never written (listed in codeRefsUntouched)', untouched, { prefix });
  }
  const anchored = scan.files.reduce((sum, file) => sum + file.hits.filter(hit => hit.anchored).length, 0);
  if (anchored) out.write(`${prefix}${dim(`${anchored} carry a section anchor, which is kept as written.`)}\n`);
}

export function countLine(scan, oldRepoPath, newRepoPath) {
  const files = scan.files.length;
  return `${scan.total} code reference${scan.total === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'} still ${scan.total === 1 ? 'cites' : 'cite'} the old path; run \`runlist refs ${oldRepoPath} ${newRepoPath} --fix\``;
}

// ── The verb ─────────────────────────────────────────────────────────────

function requireConfigured(settings, out) {
  if (settings.enabled) return true;
  out.write(`${yellow('No code roots configured.')} Set \`codeRoots\` in runlist.config.mjs to scan source files for document citations.\n`);
  return false;
}

export function runRefs(argv, config, opts = {}) {
  const out = opts.out ?? process.stdout;
  const fix = argv.includes('--fix');
  const strings = argv.includes('--strings');
  const dryRun = Boolean(opts.dryRun);
  const positional = argv.filter(arg => !arg.startsWith('-'));
  const settings = codeRefsConfig(config);
  if (!requireConfigured(settings, out)) return { enabled: false };

  if (positional[0] === 'repair') return repairAll(config, { fix, strings, dryRun, out });

  const [oldInput, newInput] = positional;
  if (!oldInput || !newInput) {
    out.write('Usage: runlist refs <old> <new> [--fix] [--strings]\n       runlist refs repair [--fix] [--strings]\n');
    return { enabled: true };
  }
  const oldRepoPath = normalizeInput(oldInput, config);
  const newRepoPath = normalizeInput(newInput, config);
  return reportOne(config, oldRepoPath, newRepoPath, { fix, strings, dryRun, out, showEmpty: true });
}

function normalizeInput(input, config) {
  const abs = path.resolve(config.repoRoot, input);
  return toRepoPath(abs, config.repoRoot);
}

function reportOne(config, oldRepoPath, newRepoPath, { fix, strings, dryRun, out, showEmpty = false, files = null }) {
  const scan = scanCodeRefs(config, oldRepoPath, { files });
  if (!scan.total) {
    if (showEmpty) out.write(green(`No code references to ${oldRepoPath}.\n`));
    return { enabled: true, scan, changed: 0 };
  }
  reportScan(scan, oldRepoPath, newRepoPath, out);
  if (!fix) {
    const writable = fixableCount(scan, { strings });
    out.write(`\n${scan.total} reference${scan.total === 1 ? '' : 's'} in ${scan.files.length} file${scan.files.length === 1 ? '' : 's'}. `);
    out.write(`${writable} would be rewritten by --fix${strings ? ' --strings' : ''}.\n`);
    if (!strings && (scan.byForm.string || scan.byForm.code)) {
      out.write(dim('Add --strings to rewrite the ones inside string literals and code.\n'));
    }
    return { enabled: true, scan, changed: 0 };
  }
  const applied = applyCodeRefs(config, scan, oldRepoPath, newRepoPath, { strings, dryRun });
  const prefix = dryRun ? dim('[dry-run] ') : '';
  out.write(`\n${prefix}${green(`Rewrote ${applied.changed} reference(s) in ${applied.written.length} file(s).`)}\n`);
  for (const entry of applied.refused) {
    out.write(`${yellow('Refused')}: ${entry.path} ${entry.reason}.\n`);
  }
  return { enabled: true, scan, changed: applied.changed, refused: applied.refused };
}

function repairAll(config, { fix, strings, dryRun, out }) {
  const pairs = archivedPreviousPaths(config);
  const files = collectCodeFiles(config);
  let total = 0;
  let changed = 0;
  const stale = [];
  for (const pair of pairs) {
    const scan = scanCodeRefs(config, pair.previous, { files });
    if (!scan.total) continue;
    stale.push({ ...pair, scan });
    total += scan.total;
  }
  if (!stale.length) {
    out.write(green(`No stale code references across ${pairs.length} archived document(s).\n`));
    return { enabled: true, total: 0, changed: 0, documents: 0 };
  }
  out.write(`${bold(`${total} stale code reference(s) across ${stale.length} archived document(s).`)}\n\n`);
  for (const entry of stale) {
    const applied = reportOne(config, entry.previous, entry.current, { fix, strings, dryRun, out, files });
    changed += applied.changed ?? 0;
    out.write('\n');
  }
  out.write(dim('Previous paths come from the archive directory mapping — a rename records none, so `refs <old> <new>` covers those by hand.\n'));
  return { enabled: true, total, changed, documents: stale.length };
}

/**
 * The line archive and rename print after their own doc-root repair. Returns
 * null when no code root is configured, which is today's behaviour exactly.
 */
export function reportMovedCodeRefs(config, oldRepoPath, newRepoPath, { fix = false, strings = false, dryRun = false, out = process.stdout, prefix = '' } = {}) {
  const settings = codeRefsConfig(config);
  if (!settings.enabled) return null;
  const scan = scanCodeRefs(config, oldRepoPath);
  if (!scan.total) return { total: 0, changed: 0 };
  if (!fix) {
    out.write(`${prefix}${countLine(scan, oldRepoPath, newRepoPath)}\n`);
    return { total: scan.total, changed: 0 };
  }
  const applied = applyCodeRefs(config, scan, oldRepoPath, newRepoPath, { strings, dryRun });
  out.write(`${prefix}Rewrote ${applied.changed} code reference(s) in ${applied.written.length} file(s).\n`);
  for (const entry of applied.refused) {
    out.write(`${prefix}${yellow('Refused')}: ${entry.path} ${entry.reason}.\n`);
  }
  return { total: scan.total, changed: applied.changed, refused: applied.refused };
}
