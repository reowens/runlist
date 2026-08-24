import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dim } from './color.mjs';

// The one list of environment variables that can name the session dotmd is
// running inside. It lives here, in a leaf module, because both consumers must
// read the same list: `currentSessionId` below (journal attribution, which falls
// back to the shell) and `authoritativeSessionId` in pickup.mjs (plan ownership,
// which fails closed). Two hand-maintained copies is how the OpenCode entries
// drifted into naming variables OpenCode does not set.
//
// Order is most-specific-first. `OPENCODE_PID` is a real fallback, not a guess:
// OpenCode's CLI middleware sets it on the process every tool shell inherits,
// and it is per-OpenCode-process rather than per-session, so it sits below the
// session-scoped names above it and above `TERM_SESSION_ID` — a terminal id is
// shared by every agent run in that window and outlives all of them.
// `scope: 'session'` means the variable names one agent session; `'process'`
// and `'terminal'` are coarser — several sessions can share one, so they cannot
// tell two of them apart. `dotmd doctor --session` reports that distinction, and
// it is the whole reason `dotmd install opencode` exists.
const SESSION_ID_SOURCES = [
  { variable: 'RUNLIST_SESSION_ID', prefix: null, scope: 'session', host: 'explicit override' },
  { variable: 'DOTMD_SESSION_ID', prefix: null, scope: 'session', host: 'explicit override' },
  { variable: 'CLAUDE_CODE_SESSION_ID', prefix: null, scope: 'session', host: 'Claude Code' },
  { variable: 'CLAUDE_SESSION_ID', prefix: null, scope: 'session', host: 'Claude Code' },
  { variable: 'OPENCODE_SESSION_ID', prefix: null, scope: 'session', host: 'OpenCode' },
  { variable: 'OPENCODE_SESSION', prefix: null, scope: 'session', host: 'OpenCode' },
  { variable: 'OPENCODE_PID', prefix: 'opencode', scope: 'process', host: 'OpenCode' },
  { variable: 'TERM_SESSION_ID', prefix: 'term', scope: 'terminal', host: 'terminal' },
];

// Which source named the session, with the id it produced — or null when the
// environment names none.
export function hostSessionSource(env = process.env) {
  for (const source of SESSION_ID_SOURCES) {
    const value = env[source.variable]?.trim();
    if (!value) continue;
    return { ...source, id: source.prefix ? `${source.prefix}:${value}` : value };
  }
  return null;
}

// The session id the environment names, or null when it names none.
export function hostSessionId(env = process.env) {
  return hostSessionSource(env)?.id ?? null;
}

// Stable identifier for the current shell/agent session. Used for journal
// attribution and hint de-duplication — not for any plan locking.
export function currentSessionId() {
  return hostSessionId() ?? `shell:${os.userInfo().username}@${os.hostname()}`;
}

// The running CLI's version, read once and memoized — several surfaces compare
// it against what a host integration was generated from.
let cachedVersion;
export function dotmdVersion() {
  if (cachedVersion === undefined) {
    try {
      const pkgPath = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'package.json');
      cachedVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? null;
    } catch {
      cachedVersion = null;
    }
  }
  return cachedVersion;
}

// Is `bin` runnable from PATH? Used to decide whether dotmd can drive a host's
// own CLI or must print the in-session commands for the user to run instead.
export function which(bin) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    return spawnSync(cmd, [bin], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

// Windows resolves `foo` to `foo.cmd` only through a shell; spawn needs the
// real name.
export function executableName(bin) {
  return process.platform === 'win32' && !bin.endsWith('.cmd') ? `${bin}.cmd` : bin;
}

export function escapeTable(value) {
  return String(value).replace(/\|/g, '\\|');
}

export function asString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function toSlug(plan) {
  return path.basename(plan.path, '.md');
}

export function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

export function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [];
}

export function normalizeBlockers(blockers) {
  if (Array.isArray(blockers)) {
    return blockers.map(item => String(item));
  }
  if (typeof blockers === 'string' && blockers.trim()) {
    return [blockers.trim()];
  }
  return [];
}

export function mergeUniqueStrings(...lists) {
  return [...new Set(lists.flat().filter(Boolean))];
}

export function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function toRepoPath(absolutePath, repoRoot) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join('/');
}

// True when any path segment equals `config.archiveDir`. Covers both
// `docs/plans/archived/foo.md` and `docs/prompts/archived/foo.md` regardless
// of whether the layout is single-root or flat-array. Read-side commands use
// this to skip files whose frontmatter `status:` has drifted out of sync with
// their archive location (issue #13).
export function isArchivedPath(repoPath, config) {
  if (!repoPath || !config?.archiveDir) return false;
  return repoPath.split('/').includes(config.archiveDir);
}

// Emit a `files: a b c` line to stderr listing every doc / index path
// the command touched (deduped, sorted, repo-relative). Lets agents do
// `git add` with the exact set instead of guessing. Opt-in via
// `--show-files` on lifecycle commands; default off to keep output stable.
export function emitFilesFooter(paths, config) {
  const rel = [...new Set(paths.filter(Boolean))]
    .map(p => path.isAbsolute(p) ? toRepoPath(p, config.repoRoot) : p)
    .sort();
  if (rel.length === 0) return;
  process.stderr.write(`files: ${rel.join(' ')}\n`);
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Coarse "how long ago", for messages where the exact interval matters less than
// which order of magnitude it is — a claim held 3d is a dead session, one held
// 4m is a colleague mid-edit. Lives here rather than in either caller because
// `hud` and `pickup` both need it and util is a leaf both already import.
export function relTime(ts, now = Date.now()) {
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return '?';
  const delta = Math.max(0, now - t);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function warn(message) {
  process.stderr.write(`${dim(message)}\n`);
}

export class DotmdError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DotmdError';
  }
}

export function die(message) {
  throw new DotmdError(message);
}

export function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[b.length][a.length];
}

// Top-N candidates from a list, ranked for "did you mean" hints. Substring
// match wins (cheap and intent-revealing for typos that share a prefix or
// stem); Levenshtein distance ≤3 catches transpositions and small edits.
// Results are deduped and capped. Empty input or empty candidate list returns
// an empty array — callers should suppress the hint line in that case.
export function suggestCandidates(query, candidates, max = 3) {
  if (!query || !candidates?.length) return [];
  const lower = String(query).toLowerCase();
  const scored = new Map();

  for (const cand of candidates) {
    if (!cand) continue;
    const candLower = String(cand).toLowerCase();
    if (candLower === lower) continue;
    if (candLower.includes(lower) || lower.includes(candLower)) {
      // Substring hits sort first; shorter candidates rank higher within that bucket.
      scored.set(cand, Math.min(scored.get(cand) ?? Infinity, candLower.length));
    }
  }

  if (scored.size < max) {
    for (const cand of candidates) {
      if (!cand || scored.has(cand)) continue;
      const candLower = String(cand).toLowerCase();
      if (candLower === lower) continue;
      const dist = levenshtein(lower, candLower);
      if (dist <= 3) scored.set(cand, 1000 + dist);
    }
  }

  return [...scored.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, max)
    .map(([cand]) => cand);
}

export function resolveDocPath(input, config) {
  if (!input) return null;
  if (path.isAbsolute(input)) return existsSync(input) ? input : null;

  let candidate = path.resolve(config.repoRoot, input);
  if (existsSync(candidate)) return candidate;

  const roots = config.docsRoots || [config.docsRoot];
  for (const root of roots) {
    candidate = path.resolve(root, input);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

// Resolve a reference path written in frontmatter or a body link.
// Tries doc-relative first (the historical convention), then falls back to
// repo-root-relative — so paths like `docs/foo/bar.md` written from any nesting
// level resolve correctly. Returns the absolute path if either form exists,
// else null.
export function resolveRefPath(relPath, docDir, repoRoot) {
  if (!relPath) return null;
  const docRelative = path.resolve(docDir, relPath);
  if (existsSync(docRelative)) return docRelative;
  const repoRelative = path.resolve(repoRoot, relPath);
  if (existsSync(repoRelative)) return repoRelative;
  return null;
}
