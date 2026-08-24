import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { commitRename } from './durable-rename.mjs';
import { ARTIFACT_PREFIX, isOwnedArtifact } from './naming.mjs';

// Best-effort `git check-ignore` for a path. Returns true only when git
// definitively reports the path is ignored; any failure (not a repo, git
// missing, path outside the tree) returns false so callers never block on a
// false positive. Used by the guard hook and `dotmd new` to warn that a
// freshly-created doc lives under a gitignored path (the "agent tries to
// commit a session-local prompt" confusion).
export function isGitIgnored(absPath, repoRoot) {
  try {
    const result = spawnSync('git', ['check-ignore', '-q', '--', absPath], {
      cwd: repoRoot || process.cwd(),
      encoding: 'utf8',
    });
    // exit 0 → ignored, 1 → not ignored, 128 → not a git repo / other error.
    return result.status === 0;
  } catch {
    return false;
  }
}

let gitChecked = false;
function assertSafeGitPaths(paths) {
  for (const filePath of paths) {
    if (!filePath || /[\0\r\n]/.test(filePath) || path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes('..')) {
      throw new Error(`Unsafe repository-relative Git path: ${filePath}`);
    }
  }
}
function ensureGit() {
  if (gitChecked) return;
  const result = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (result.error) {
    throw new Error('git is not installed or not found in PATH. dotmd requires git for this operation.');
  }
  gitChecked = true;
}

function literalGitPathspec(filePath) {
  return filePath === '.' ? ':(top,literal)' : `:(top,literal)${filePath}`;
}

export function getGitLastModified(relPath, repoRoot) {
  const result = spawnSync('git', ['log', '-1', '--format=%aI', '--', relPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
  return result.stdout.trim();
}

export function getGitFirstAdded(relPath, repoRoot) {
  const result = spawnSync('git', ['log', '--diff-filter=A', '--follow', '--format=%aI', '--', relPath], {
    cwd: repoRoot, encoding: 'utf8',
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
  // `git log` returns newest-first; the file's add commit is the LAST entry.
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  return lines[lines.length - 1] ?? null;
}

const DEFAULT_GIT_METADATA_MAX_COMMITS = 10_000;
const DEFAULT_GIT_METADATA_MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_GIT_METADATA_PATH_BATCH = 256;
const GIT_METADATA_HISTORY_PER_PATH = 16;

function boundedPositiveInteger(value, fallback, name) {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function unavailableGitHistory(result) {
  if (result.error?.code === 'ENOENT') return true;
  const detail = `${result.stderr ?? ''}\n${result.error?.message ?? ''}`;
  return /not a git repository|does not have any commits yet|bad revision|unknown revision|ambiguous argument/i.test(detail);
}

function parseGitMetadataOutput(stdout, dates, commits, history, expectedPaths) {
  const fields = String(stdout ?? '').split('\0');
  let currentDate = null;
  let currentCommit = null;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field === 'dotmd:git-metadata:commit'
      && /^[0-9a-f]{40,64}$/i.test(fields[i + 1] ?? '')
      && /^\d{4}-\d{2}-\d{2}T/.test(fields[i + 2] ?? '')) {
      currentCommit = fields[++i];
      currentDate = fields[++i];
      continue;
    }
    const filePath = field.startsWith('\n') ? field.slice(1) : field;
    if (filePath && currentDate && expectedPaths.has(filePath)) {
      if (!history.has(filePath)) history.set(filePath, []);
      const entries = history.get(filePath);
      if (entries.length < GIT_METADATA_HISTORY_PER_PATH && entries.at(-1)?.commit !== currentCommit) {
        entries.push({ date: currentDate, commit: currentCommit });
      }
      if (!dates.has(filePath)) {
        dates.set(filePath, currentDate);
        commits.set(filePath, currentCommit);
      }
    }
  }
}

// Read latest Git dates only for the current managed paths. Every subprocess
// has explicit history, output, and path-count bounds. Callers must inspect
// `complete` before using missing dates as evidence that no history exists.
export function getGitLastModifiedBatch(repoRoot, relPaths, options = {}) {
  const maxCommits = boundedPositiveInteger(options.maxCommits, DEFAULT_GIT_METADATA_MAX_COMMITS, 'maxCommits');
  const maxBuffer = boundedPositiveInteger(options.maxBuffer, DEFAULT_GIT_METADATA_MAX_BUFFER, 'maxBuffer');
  const maxPathsPerBatch = boundedPositiveInteger(options.maxPathsPerBatch, DEFAULT_GIT_METADATA_PATH_BATCH, 'maxPathsPerBatch');
  const paths = [...new Set(relPaths ?? [])];
  assertSafeGitPaths(paths);
  if (paths.length === 0) return { dates: new Map(), commits: new Map(), history: new Map(), complete: true, reason: null };
  // Full-tree callers can supply a small set of configured root pathspecs for
  // diff extraction. Revision selection still uses the exact requested paths,
  // so excluded or unrelated documents cannot consume the commit bound.
  const scanPaths = options.pathspecs?.length ? [...new Set(options.pathspecs)] : paths;
  assertSafeGitPaths(scanPaths);
  const expectedPaths = new Set(paths);
  const revision = options.revision ?? 'HEAD';

  const dates = new Map();
  const commitsByPath = new Map();
  const history = new Map();
  let reason = null;
  const revisions = spawnSync('git', ['rev-list', '--stdin', `--max-count=${maxCommits + 1}`, revision], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: `--\n${paths.map(literalGitPathspec).join('\n')}\n`,
    maxBuffer,
  });
  if (revisions.error?.code === 'ENOBUFS') {
    reason = 'output-limit';
  } else if (revisions.error || revisions.status !== 0) {
    if (unavailableGitHistory(revisions)) return { dates, commits: commitsByPath, history, complete: true, reason: null };
    return { dates, commits: commitsByPath, history, complete: false, reason: 'git-error' };
  }
  const revisionList = String(revisions.stdout ?? '')
    .split('\n')
    .filter(line => /^[0-9a-f]{40,64}$/i.test(line))
    .slice(0, maxCommits);
  if (revisionList.length === 0) return { dates, commits: commitsByPath, history, complete: reason === null, reason };
  if (!reason && String(revisions.stdout ?? '').trim().split('\n').length > maxCommits) {
    reason = 'commit-limit';
  }

  for (let offset = 0; offset < scanPaths.length; offset += maxPathsPerBatch) {
    const batch = scanPaths.slice(offset, offset + maxPathsPerBatch);
    const result = spawnSync('git', [
      'diff-tree', '--stdin', '--root', '-r', '-z', '--format=%x00dotmd:git-metadata:commit%x00%H%x00%aI%x00', '--name-only', '--diff-filter=ACDMR', '--', ...batch.map(literalGitPathspec),
    ], { cwd: repoRoot, encoding: 'utf8', input: revisionList.join('\n') + '\n', maxBuffer });
    parseGitMetadataOutput(result.stdout, dates, commitsByPath, history, expectedPaths);

    if (result.error?.code === 'ENOBUFS') {
      reason = 'output-limit';
    } else if (result.error || result.status !== 0) {
      reason = reason ?? 'git-error';
    }
  }

  // Reaching the history window is harmless when every requested tracked path
  // already received a latest date. Only unresolved tracked paths require
  // older history; untracked files legitimately have no Git date.
  if (reason === 'commit-limit') {
    const missing = paths.filter(filePath => !dates.has(filePath));
    let unresolvedTracked = false;
    let trackingCheckFailed = false;
    for (let offset = 0; offset < missing.length; offset += maxPathsPerBatch) {
      const batch = missing.slice(offset, offset + maxPathsPerBatch);
      const result = spawnSync('git', ['ls-files', '-z', '--', ...batch.map(literalGitPathspec)], {
        cwd: repoRoot, encoding: 'utf8', maxBuffer,
      });
      if (result.error || result.status !== 0) {
        trackingCheckFailed = true;
        break;
      }
      if (String(result.stdout ?? '').split('\0').some(Boolean)) {
        unresolvedTracked = true;
        break;
      }
    }
    if (!trackingCheckFailed && !unresolvedTracked) reason = null;
  }

  return { dates, commits: commitsByPath, history, complete: reason === null, reason };
}

function parseBatchObjects(stdout, count) {
  const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
  const objects = [];
  let offset = 0;
  while (objects.length < count && offset < output.length) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) return null;
    const header = output.subarray(offset, newline).toString('utf8');
    offset = newline + 1;
    if (header.endsWith(' missing')) {
      objects.push(null);
      continue;
    }
    const size = Number(header.match(/\s(\d+)$/)?.[1]);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > output.length) return null;
    objects.push(output.subarray(offset, offset + size).toString('utf8'));
    offset += size;
    if (output[offset] === 0x0a) offset++;
  }
  return objects.length === count ? objects : null;
}

function withoutUpdatedLine(raw) {
  if (raw == null) return null;
  const eol = raw.startsWith('---\r\n') ? '\r\n' : raw.startsWith('---\n') ? '\n' : null;
  if (!eol) return null;
  const marker = `${eol}---${eol}`;
  const end = raw.indexOf(marker, 3 + eol.length);
  if (end < 0) return null;
  const frontmatter = raw.slice(3 + eol.length, end).split(eol);
  const index = frontmatter.findIndex(line => line.startsWith('updated:'));
  if (index < 0) return { line: null, content: raw };
  const [line] = frontmatter.splice(index, 1);
  return { line, content: `---${eol}${frontmatter.join(eol)}${marker}${raw.slice(end + marker.length)}` };
}

function updatedOnlyPathsByCommit(repoRoot, byCommit, maxBuffer, maxPathsPerBatch) {
  const entries = [...byCommit].flatMap(([commit, commitPaths]) => commitPaths.map(filePath => ({ commit, filePath })));
  const paths = new Set();
  // Blob contents are much larger than path metadata, so keep each bounded
  // cat-file response comfortably below the shared output cap.
  const batchSize = Math.min(maxPathsPerBatch, 32);
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    const batch = entries.slice(offset, offset + batchSize);
    if (batch.some(item => item.filePath.includes('\n'))) return { paths: new Set(), complete: false };
    const specs = batch.flatMap(item => [`${item.commit}:${item.filePath}`, `${item.commit}^:${item.filePath}`]);
    const result = spawnSync('git', ['cat-file', '--batch'], {
      cwd: repoRoot, input: specs.join('\n') + '\n', maxBuffer,
    });
    if (result.error || result.status !== 0) {
      return { paths: new Set(), complete: false };
    }
    const objects = parseBatchObjects(result.stdout, specs.length);
    if (!objects) return { paths: new Set(), complete: false };
    for (let i = 0; i < batch.length; i++) {
      const current = withoutUpdatedLine(objects[i * 2]);
      const parent = withoutUpdatedLine(objects[i * 2 + 1]);
      if (!current || !parent || current.line === parent.line) continue;
      if (current.content === parent.content) paths.add(`${batch[i].commit}\0${batch[i].filePath}`);
    }
  }
  return { paths, complete: true };
}

// Resolve the latest substantive date for paths whose latest commit may only
// have synchronized the top-level `updated:` line. Callers provide their first
// bounded history scan so normal paths pay no extra Git cost. Metadata-only
// paths are grouped by commit, then resolved from the retained history window
// (with a bounded parent fallback); consecutive sync-only commits are skipped.
export function getGitLastSubstantiveModifiedBatch(repoRoot, relPaths, initialMetadata, options = {}) {
  const maxBuffer = boundedPositiveInteger(options.maxBuffer, DEFAULT_GIT_METADATA_MAX_BUFFER, 'maxBuffer');
  const maxPathsPerBatch = boundedPositiveInteger(options.maxPathsPerBatch, DEFAULT_GIT_METADATA_PATH_BATCH, 'maxPathsPerBatch');
  const paths = [...new Set(relPaths ?? [])];
  assertSafeGitPaths(paths);
  if (paths.length === 0) return { dates: new Map(), commits: new Map(), history: new Map(), complete: true, reason: null };

  const initial = initialMetadata ?? getGitLastModifiedBatch(repoRoot, paths, options);
  const dates = new Map(initial.dates);
  const commits = new Map(initial.commits ?? []);
  const history = new Map(initial.history ?? []);
  let complete = initial.complete;
  let reason = initial.reason;
  const byCommit = new Map();
  for (const filePath of paths) {
    const commit = commits.get(filePath);
    if (!commit) continue;
    if (!byCommit.has(commit)) byCommit.set(commit, []);
    byCommit.get(commit).push(filePath);
  }

  const classification = updatedOnlyPathsByCommit(repoRoot, byCommit, maxBuffer, maxPathsPerBatch);
  if (!classification.complete) {
    complete = false;
    reason = reason ?? 'git-error';
  }

  for (const [commit, commitPaths] of byCommit) {
    const metadataOnly = commitPaths.filter(filePath => classification.paths.has(`${commit}\0${filePath}`));
    if (metadataOnly.length === 0) continue;

    const older = {
      dates: new Map(), commits: new Map(), history: new Map(),
      complete: initial.complete, reason: initial.reason,
    };
    const unresolved = [];
    for (const filePath of metadataOnly) {
      const entries = history.get(filePath) ?? [];
      const currentIndex = entries.findIndex(entry => entry.commit === commit);
      const remaining = currentIndex >= 0 ? entries.slice(currentIndex + 1) : [];
      if (remaining.length === 0) {
        unresolved.push(filePath);
        continue;
      }
      older.dates.set(filePath, remaining[0].date);
      older.commits.set(filePath, remaining[0].commit);
      older.history.set(filePath, remaining);
    }
    if (unresolved.length > 0) {
      older.complete = false;
      older.reason = older.reason ?? 'commit-limit';
    }
    const substantive = getGitLastSubstantiveModifiedBatch(repoRoot, metadataOnly, older, options);
    complete = complete && substantive.complete;
    reason = reason ?? substantive.reason;
    for (const filePath of metadataOnly) {
      if (substantive.dates.has(filePath)) {
        dates.set(filePath, substantive.dates.get(filePath));
        commits.set(filePath, substantive.commits.get(filePath));
        if (substantive.history.has(filePath)) history.set(filePath, substantive.history.get(filePath));
      } else {
        dates.delete(filePath);
        commits.delete(filePath);
        history.delete(filePath);
      }
    }
  }

  return { dates, commits, history, complete, reason };
}

function parseNullPaths(result) {
  if (result.error || result.status !== 0) return [];
  return result.stdout.split('\0').filter(Boolean);
}

function parsePorcelainRecords(result) {
  if (result.error || result.status !== 0) return [];
  const fields = result.stdout.split('\0').filter(Boolean);
  const records = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4 || field[2] !== ' ') continue;
    const status = field.slice(0, 2);
    records.push({ status, path: field.slice(3) });
    // In porcelain v1 -z, rename/copy records put the destination first and
    // the old source path in the following NUL field. The command includes the
    // destination state, not the now-missing live source.
    if (/[RC]/.test(status)) i += 1;
  }
  return records;
}

function parseShortOptions(arg, valueOptions = new Set()) {
  const parsed = { options: new Set(), consumesNext: false };
  if (!/^-[^-]/.test(arg)) return parsed;
  const chars = arg.slice(1);
  for (let i = 0; i < chars.length; i++) {
    const option = chars[i];
    parsed.options.add(option);
    if (valueOptions.has(option)) {
      parsed.consumesNext = i === chars.length - 1;
      break; // remaining characters are this option's attached value
    }
  }
  return parsed;
}

function hasShortOption(args, option, valueOptions = new Set()) {
  return args.some(arg => parseShortOptions(arg, valueOptions).options.has(option));
}

function gitPathspecs(args, subcommand) {
  const separator = args.indexOf('--');
  if (separator >= 0) return args.slice(separator + 1);
  const valueFlags = subcommand === 'commit'
    ? new Set(['-m', '--message', '-F', '--file', '-C', '-c', '--reuse-message', '--reedit-message', '-t', '--template', '--author', '--date', '--cleanup', '--fixup', '--squash', '--trailer'])
    : new Set(['--chmod', '--pathspec-from-file']);
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valueFlags.has(arg)) { i += 1; continue; }
    if (subcommand === 'commit' && /^-[^-]/.test(arg)) {
      const short = parseShortOptions(arg, new Set(['m', 'F', 'C', 'c', 't', 'S']));
      if (short.consumesNext) i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    paths.push(arg);
  }
  return paths;
}

// Paths a broad `git add`/`git commit` would actually include. Read-only and
// fail-open: any Git error returns an empty list so the PreToolUse guard never
// blocks on an uncertain repository state.
export function inspectGitCommandPaths(subcommand, args, repoRoot) {
  try {
    if ((subcommand === 'add' || subcommand === 'stage')
      && (hasShortOption(args, 'n') || args.includes('--dry-run'))) return [];
    if (subcommand === 'commit' && args.includes('--dry-run')) return [];
    const pathspecs = gitPathspecs(args, subcommand);
    if (subcommand === 'add' || subcommand === 'stage') {
      const cmd = ['status', '--porcelain=v1', '-z', '--untracked-files=all'];
      if (pathspecs.length > 0) cmd.push('--', ...pathspecs);
      const updateOnly = hasShortOption(args, 'u') || args.includes('--update');
      const records = parsePorcelainRecords(spawnSync('git', cmd, { cwd: repoRoot, encoding: 'utf8' }));
      const paths = records
        .filter(record => !updateOnly || record.status !== '??')
        .map(record => record.path)
        .filter(candidate => existsSync(path.resolve(repoRoot, candidate)));
      const forceAll = hasShortOption(args, 'A') || args.includes('--all');
      if ((hasShortOption(args, 'f') || args.includes('--force')) && (pathspecs.length > 0 || forceAll)) {
        const ignoredCmd = ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'];
        if (pathspecs.length > 0) ignoredCmd.push('--', ...pathspecs);
        paths.push(...parseNullPaths(spawnSync('git', ignoredCmd, { cwd: repoRoot, encoding: 'utf8' })));
      }
      return [...new Set(paths)];
    }
    if (subcommand !== 'commit') return [];

    const commands = [];
    const commitValueOptions = new Set(['m', 'F', 'C', 'c', 't', 'S']);
    const commitAll = args.includes('--all') || hasShortOption(args, 'a', commitValueOptions);
    if (pathspecs.length > 0) {
      const hasHead = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).status === 0;
      if (hasHead) commands.push(['diff', 'HEAD', '--name-only', '--diff-filter=ACMR', '-z', '--', ...pathspecs]);
      else commands.push(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z', '--', ...pathspecs]);
      if (args.includes('-i') || args.includes('--include')) {
        commands.push(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
      }
    } else if (commitAll) {
      // commit -a replaces tracked index entries with worktree state. Comparing
      // HEAD directly to the worktree models that final commit and avoids a
      // false deny when a staged prompt change was subsequently reverted.
      commands.push(['diff', 'HEAD', '--name-only', '--diff-filter=ACMR', '-z']);
    } else {
      commands.push(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
    }
    return [...new Set(commands.flatMap(cmd => parseNullPaths(spawnSync('git', cmd, { cwd: repoRoot, encoding: 'utf8' }))))];
  } catch {
    return [];
  }
}

export function listStagedPaths(repoRoot) {
  const result = spawnSync('git', ['diff', '--cached', '--name-only', '--no-renames', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Cannot inspect staged files: ${result.error?.message || result.stderr.trim() || 'git diff failed'}`);
  }
  return result.stdout.split('\0').filter(Boolean);
}

export function assertGitIndex(repoRoot, expectedPaths = []) {
  const actual = [...new Set(listStagedPaths(repoRoot))].sort();
  const expected = [...new Set(expectedPaths)].sort();
  if (actual.length === expected.length && actual.every((item, index) => item === expected[index])) {
    return actual;
  }

  const expectedLabel = expected.length > 0 ? expected.join(', ') : 'empty';
  const actualLabel = actual.length > 0 ? actual.join(', ') : 'empty';
  throw new Error(`Git index mismatch (expected: ${expectedLabel}; staged: ${actualLabel}). Commit or unstage existing work before releasing.`);
}

export function gitMv(source, target, repoRoot) {
  ensureGit();
  // Source is untracked (scaffolded this session, never committed; or repoRoot
  // is not a git repo at all): a plain rename is the only correct move. `git mv`
  // would error with `fatal: not under version control` and the user can't act
  // on that — the file is genuinely a doc, just not yet staged.
  if (!isTracked(source, repoRoot)) {
    const absSource = path.isAbsolute(source) ? source : path.join(repoRoot, source);
    const absTarget = path.isAbsolute(target) ? target : path.join(repoRoot, target);
    try {
      renameSync(absSource, absTarget);
      return { status: 0, stderr: '' };
    } catch (err) {
      return { status: 1, stderr: err.message };
    }
  }
  const result = spawnSync('git', ['mv', source, target], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr };
}

export function isTracked(source, repoRoot) {
  const relSource = path.isAbsolute(source) ? path.relative(repoRoot, source) : source;
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', relSource], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return result.status === 0;
}

export function gitIndexLocations(repoRoot) {
  const result = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`Could not locate Git directory: ${result.error?.message || result.stderr.trim()}`);
  const gitDir = path.resolve(repoRoot, result.stdout.trim());
  const indexPath = process.env.GIT_INDEX_FILE ? path.resolve(repoRoot, process.env.GIT_INDEX_FILE) : path.join(gitDir, 'index');
  return { gitDir, indexPath, indexDir: path.dirname(indexPath), lockPath: `${indexPath}.lock` };
}

function generationFromBytes(bytes, indexPath, mode) {
  return { exists: true, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, content: bytes.toString('base64'), mode, indexPath };
}

function captureIndexPath(indexPath) {
  if (!existsSync(indexPath)) return { exists: false, hash: null, size: 0, content: null, mode: null, indexPath };
  const stat = lstatSync(indexPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Selected Git index is not a regular file: ${indexPath}`);
  return generationFromBytes(readFileSync(indexPath), indexPath, stat.mode & 0o7777);
}

export function captureGitIndexGeneration(repoRoot) {
  return captureIndexPath(gitIndexLocations(repoRoot).indexPath);
}

export function sameGitIndexGeneration(left, right) {
  return Boolean(left && right && left.indexPath === right.indexPath && left.exists === right.exists
    && left.hash === right.hash && left.size === right.size && left.mode === right.mode);
}

function fsyncIndexDirectory(directory, testHooks, reason) {
  testHooks?.beforeGitIndexDirectoryFsync?.({ directory, reason });
  const dirFd = openSync(directory, 'r');
  try { fsyncSync(dirFd); } catch (err) { if (!['EINVAL', 'ENOTSUP', 'EBADF', 'EISDIR', 'EPERM'].includes(err?.code)) throw err; } finally { closeSync(dirFd); }
}

function writeGeneration(filePath, generation, mode = generation.mode ?? (0o666 & ~process.umask())) {
  const bytes = generation.exists ? Buffer.from(generation.content, 'base64') : Buffer.alloc(0);
  if (generation.exists && (bytes.length !== generation.size || createHash('sha256').update(bytes).digest('hex') !== generation.hash)) throw new Error('Invalid captured Git index generation.');
  const fd = openSync(filePath, 'wx', mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

function describePrepared(preparedPath, generation) {
  const stat = lstatSync(preparedPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Prepared Git index is unsafe: ${preparedPath}`);
  const bytes = readFileSync(preparedPath);
  return {
    path: preparedPath,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode & 0o7777,
    size: bytes.length,
    hash: createHash('sha256').update(bytes).digest('hex'),
    generation,
  };
}

function preparedMatches(prepared) {
  try {
    const stat = lstatSync(prepared.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== prepared.dev || stat.ino !== prepared.ino || (stat.mode & 0o7777) !== prepared.mode || stat.size !== prepared.size) return false;
    return createHash('sha256').update(readFileSync(prepared.path)).digest('hex') === prepared.hash;
  } catch { return false; }
}

function unlinkPrepared(prepared, testHooks = null, reason = 'prepared-delete') {
  if (prepared && preparedMatches(prepared)) {
    unlinkSync(prepared.path);
    fsyncIndexDirectory(path.dirname(prepared.path), testHooks, reason);
  }
}

function prepareMoveIndex(source, target, repoRoot, before, options = {}) {
  const testHooks = options.testHooks ?? {};
  const paths = [source, target].map(candidate => path.isAbsolute(candidate) ? path.relative(repoRoot, candidate) : candidate);
  assertSafeGitPaths(paths);
  const { indexDir } = gitIndexLocations(repoRoot);
  const preparedPath = path.join(indexDir, `${ARTIFACT_PREFIX}index-${process.pid}-${randomUUID()}`);
  const artifactPath = options.artifactPath ?? preparedPath;
  writeGeneration(artifactPath, before);
  let seed = { ...describePrepared(artifactPath, before), state: 'preparing', tempPath: preparedPath, work: null };
  testHooks.afterGitIndexArtifact?.({ before, prepared: seed });
  if (artifactPath !== preparedPath && before.exists) {
    try { linkSync(artifactPath, preparedPath); }
    catch (err) {
      if (err?.code !== 'EXDEV') throw err;
      writeGeneration(preparedPath, before);
      seed = { ...seed, work: describePrepared(preparedPath, before) };
      testHooks.afterGitIndexWorkSeed?.({ before, prepared: seed });
    }
    fsyncIndexDirectory(indexDir, testHooks, 'working-index-link');
  }
  testHooks.beforeGitIndexPrepare?.({ preparedPath, before, prepared: seed });
  const env = { ...process.env, GIT_INDEX_FILE: preparedPath };
  // A tracked source relocating into an ignored destination is exactly what
  // `git mv` permits: ignore patterns govern NEW untracked paths, not the
  // relocation of content git already tracks. Bare `git add` doesn't make that
  // distinction and refuses ("paths are ignored by one of your .gitignore
  // files"), which failed the whole transaction and rolled the move back — so
  // `dotmd archive` was unusable in any repo that gitignores its docs root
  // while force-tracking the docs inside it. Force only when the source was
  // tracked; an untracked source stays subject to the ignore.
  const sourceTracked = isTracked(paths[0], repoRoot);
  const addArgs = sourceTracked ? ['add', '-f', '-A', '--', paths[1]] : ['add', '-A', '--', paths[1]];
  const result = spawnSync('git', addArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  });
  let preCheckpointError = null;
  try { testHooks.afterGitIndexSubprocessBeforeCheckpoint?.({ preparedPath, before, prepared: seed, step: 'target-added', result }); }
  catch (err) { preCheckpointError = err; }
  fsyncIndexDirectory(indexDir, testHooks, 'working-index-step');
  const prepareStep = existsSync(preparedPath) ? { ...seed, work: describePrepared(preparedPath, captureIndexPath(preparedPath)) } : seed;
  if (prepareStep.work) prepareStep.work.generation.indexPath = before.indexPath;
  testHooks.afterGitIndexPrepareStep?.({ preparedPath, before, prepared: prepareStep, step: 'target-added' });
  if (preCheckpointError) throw preCheckpointError;
  if (result.error || result.status !== 0) {
    throw new Error(`Could not stage moved document: ${result.error?.message || result.stderr.trim() || 'git add failed'}`);
  }
  testHooks.duringGitIndexPrepare?.({ preparedPath, before, prepared: prepareStep, step: 'target-added' });
  const removed = spawnSync('git', ['update-index', '--remove', '--', paths[0]], { cwd: repoRoot, encoding: 'utf8', env });
  preCheckpointError = null;
  try { testHooks.afterGitIndexSubprocessBeforeCheckpoint?.({ preparedPath, before, prepared: prepareStep, step: 'source-removed', result: removed }); }
  catch (err) { preCheckpointError = err; }
  fsyncIndexDirectory(indexDir, testHooks, 'working-index-step');
  const removedStep = existsSync(preparedPath) ? { ...seed, work: describePrepared(preparedPath, captureIndexPath(preparedPath)) } : prepareStep;
  if (removedStep.work) removedStep.work.generation.indexPath = before.indexPath;
  testHooks.afterGitIndexPrepareStep?.({ preparedPath, before, prepared: removedStep, step: 'source-removed' });
  if (preCheckpointError) throw preCheckpointError;
  if (removed.error || removed.status !== 0) {
    throw new Error(`Could not stage moved document source removal: ${removed.error?.message || removed.stderr.trim() || 'git update-index failed'}`);
  }
  if (before.exists && (lstatSync(preparedPath).mode & 0o7777) !== before.mode) {
    chmodSync(preparedPath, before.mode);
    const fd = openSync(preparedPath, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  const generation = captureIndexPath(preparedPath);
  generation.indexPath = before.indexPath;
  const work = describePrepared(preparedPath, generation);
  if (artifactPath !== preparedPath) {
    writeFileSync(artifactPath, readFileSync(preparedPath));
    chmodSync(artifactPath, generation.mode);
    const artifactFd = openSync(artifactPath, 'r+');
    try { fsyncSync(artifactFd); } finally { closeSync(artifactFd); }
  }
  const prepared = { ...describePrepared(artifactPath, generation), state: 'prepared', tempPath: preparedPath, work };
  testHooks.afterGitIndexPrepared?.({ preparedPath, before, generation, prepared });
  return prepared;
}

// A failure that provably happened before `.git/index` was replaced. Rollback
// has to tell this apart from "we may already have published": in the latter
// case it must restore the index and, failing that, retain the transaction for
// manual repair; in this one there is nothing of ours in the index to undo, so
// insisting on a restore turns someone else's concurrent `git add` into a
// wedged repo. `race` additionally means the failure was contention, not a
// verdict — the same call can succeed on a fresh generation.
function markUnpublishedIndexError(err, { race = false } = {}) {
  if (err && typeof err === 'object') {
    err.gitIndexPublished = false;
    if (race) err.gitIndexRace = true;
  }
  return err;
}

export function gitIndexProvablyUnpublished(err) {
  return err?.gitIndexPublished === false;
}

export function gitIndexPublicationRaced(err) {
  return err?.gitIndexPublished === false && err?.gitIndexRace === true;
}

function publishIndexGeneration(repoRoot, expected, desired, prepared, testHooks = {}) {
  let published = false;
  try {
    return publishIndexGenerationLocked(repoRoot, expected, desired, prepared, testHooks, state => { published = state; });
  } catch (err) {
    if (!published) markUnpublishedIndexError(err, { race: Boolean(err?.gitIndexRace) });
    throw err;
  }
}

function publishIndexGenerationLocked(repoRoot, expected, desired, prepared, testHooks, notePublished) {
  const { indexPath, indexDir, lockPath } = gitIndexLocations(repoRoot);
  if (expected.indexPath !== indexPath || desired.indexPath !== indexPath) throw new Error('Selected Git index changed since the transaction snapshot; recovery refused to target a different index.');
  if (!prepared || prepared.state !== 'prepared' || path.dirname(prepared.tempPath) !== indexDir || !isOwnedArtifact(path.basename(prepared.tempPath), 'index') || !preparedMatches(prepared)) throw new Error('Prepared Git index ownership could not be verified.');
  if ((desired.exists && (prepared.hash !== desired.hash || prepared.size !== desired.size || prepared.mode !== desired.mode)) || (!desired.exists && prepared.size !== 0)) throw new Error('Prepared Git index artifact does not match the desired generation.');
  const publication = prepared.work ?? prepared;
  if (!preparedMatches(publication) || (desired.exists && (publication.hash !== desired.hash || publication.size !== desired.size || publication.mode !== desired.mode)) || (!desired.exists && publication.size !== 0)) throw new Error('Selected-directory Git working index does not match the desired generation.');
  let lockOwned = false;
  try {
    linkSync(publication.path, lockPath);
    lockOwned = true;
    fsyncIndexDirectory(indexDir, testHooks, 'lock-acquisition');
  } catch (err) {
    if (lockOwned) {
      try {
        const lock = lstatSync(lockPath);
        if (lock.dev === publication.dev && lock.ino === publication.ino) {
          unlinkSync(lockPath);
          fsyncIndexDirectory(indexDir, null, 'lock-acquisition-rollback');
        }
      } catch { /* retain original durability error */ }
    }
    if (err?.code === 'EEXIST') throw markUnpublishedIndexError(new Error('Git index is locked by another process; transaction index publication was not attempted.'), { race: true });
    throw err;
  }
  let published = false;
  try {
    testHooks.afterGitIndexLock?.({ lockPath, expected, desired });
    const current = captureIndexPath(indexPath);
    if (!sameGitIndexGeneration(current, expected)) throw markUnpublishedIndexError(new Error('Git index changed before transaction publication; current staging was preserved.'), { race: true });
    testHooks.afterGitIndexCompare?.({ lockPath, current, desired });
    if (desired.exists) {
      // .git/index is routinely held open by concurrent git processes and IDE git
      // extensions, so on Windows this publish needs the retry.
      commitRename(lockPath, indexPath, testHooks);
      lockOwned = false;
    } else {
      if (existsSync(indexPath)) unlinkSync(indexPath);
      const lock = lstatSync(lockPath);
      if (!lock.isFile() || lock.isSymbolicLink() || lock.dev !== publication.dev || lock.ino !== publication.ino) throw new Error('Transaction-owned Git index lock was replaced before deletion.');
      unlinkSync(lockPath);
      lockOwned = false;
    }
    published = true;
    notePublished(true);
    fsyncIndexDirectory(indexDir, testHooks, 'publication');
    testHooks.afterGitIndexPublication?.({ indexPath, desired });
    return desired;
  } finally {
    if (!published && lockOwned) {
      try {
        const lock = lstatSync(lockPath);
        if (lock.dev === publication.dev && lock.ino === publication.ino) {
          unlinkSync(lockPath);
          fsyncIndexDirectory(indexDir, testHooks, 'failed-lock-delete');
        }
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }
  }
}

export function stageMovePathsCas(source, target, repoRoot, before, options = {}) {
  let prepared;
  // Preparation writes only to transaction-owned scratch indexes, so anything
  // that fails here — a refused `git add`, a failing clean filter — leaves the
  // real index untouched by definition.
  try { prepared = prepareMoveIndex(source, target, repoRoot, before, options); }
  catch (err) { throw markUnpublishedIndexError(err); }
  try { return publishIndexGeneration(repoRoot, before, prepared.generation, prepared, options.testHooks); }
  finally {
    if (prepared.work && prepared.work.path !== prepared.path) unlinkPrepared(prepared.work, options.testHooks, 'working-index-delete');
    unlinkPrepared(prepared, options.testHooks);
  }
}

export function restoreGitIndexCas(before, ownedAfter, repoRoot, options = {}) {
  const { indexDir } = gitIndexLocations(repoRoot);
  const preparedPath = options.artifactPath ?? path.join(indexDir, `${ARTIFACT_PREFIX}index-restore-${process.pid}-${randomUUID()}`);
  let artifact = null;
  try {
    writeGeneration(preparedPath, before);
    const prepared = before;
    const tempPath = path.join(indexDir, `${ARTIFACT_PREFIX}index-restore-${process.pid}-${randomUUID()}`);
    artifact = { ...describePrepared(preparedPath, prepared), state: 'preparing', tempPath, work: null };
    options.testHooks?.afterGitRestoreArtifact?.({ before, ownedAfter, prepared: artifact });
    writeGeneration(tempPath, before);
    const work = describePrepared(tempPath, prepared);
    artifact = { ...artifact, state: 'prepared', work };
    options.testHooks?.afterGitRestorePrepared?.({ before, ownedAfter, preparedPath, prepared: artifact });
    return publishIndexGeneration(repoRoot, ownedAfter, prepared, artifact, options.testHooks);
  } finally {
    if (artifact?.work) unlinkPrepared(artifact.work, options.testHooks, 'restore-working-index-delete');
    unlinkPrepared(artifact, options.testHooks, 'restore-prepared-delete');
  }
}

// `.git/index.lock` is only ever ours as a hard link to the prepared index, so
// the recorded publication inode identifies it even after the artifact itself
// is unlinked.
function lockIsOurs(lockPath, prepared) {
  const publication = prepared.work ?? prepared;
  try {
    const lock = lstatSync(lockPath);
    return lock.isFile() && !lock.isSymbolicLink() && lock.dev === publication.dev && lock.ino === publication.ino;
  } catch { return false; }
}

export function reclaimPreparedGitIndex(manifestGitIndex, repoRoot, options = {}) {
  const prepared = manifestGitIndex?.prepared;
  if (!prepared) return { cleaned: false, retainedPaths: [] };
  const retainedPaths = [];
  const { indexPath, indexDir, lockPath } = gitIndexLocations(repoRoot);
  if (manifestGitIndex.before?.indexPath !== indexPath || prepared.generation?.indexPath !== indexPath) throw new Error('Recovery environment selects a different Git index than the abandoned transaction.');
  if (path.dirname(prepared.tempPath) !== indexDir || !isOwnedArtifact(path.basename(prepared.tempPath), 'index')) throw new Error('Abandoned prepared Git index path is unsafe.');
  if (!existsSync(prepared.path)) {
    // The lock is only ever ours as a hard link to the publication inode, so a
    // lock that does not carry that inode cannot be ours — it belongs to a live
    // `git` (a plain `git status` takes index.lock to rewrite its stat cache).
    // Leaving it is right; treating it as damage was not. That throw travelled
    // up as a failed rollback and retained the transaction, so a few hundred
    // milliseconds of ordinary Git activity bricked every later mutation in the
    // repo until `doctor --transactions --apply` ran.
    if (existsSync(lockPath) && lockIsOurs(lockPath, prepared)) throw new Error('A transaction-owned Git index lock outlived its prepared artifact; it was preserved.');
    if (existsSync(prepared.tempPath)) retainedPaths.push(prepared.tempPath);
    return { cleaned: false, retainedPaths };
  }
  if (!preparedMatches(prepared)) throw new Error('Abandoned prepared Git index ownership could not be verified.');
  if (existsSync(prepared.tempPath)) {
    const expectedWork = prepared.work ?? { ...prepared, path: prepared.tempPath };
    if (!preparedMatches(expectedWork)) {
      if (prepared.state !== 'preparing') throw new Error('Abandoned Git working index is foreign or unverified; it was preserved.');
      retainedPaths.push(prepared.tempPath);
    } else {
      unlinkPrepared(expectedWork, options.testHooks, 'recovery-working-index-delete');
    }
  }
  if (existsSync(lockPath)) {
    const lock = lstatSync(lockPath);
    const publication = prepared.work ?? prepared;
    if (!lock.isFile() || lock.isSymbolicLink() || lock.dev !== publication.dev || lock.ino !== publication.ino) throw new Error('Git index lock is foreign; it was preserved.');
    unlinkSync(lockPath);
    fsyncIndexDirectory(indexDir, options.testHooks, 'recovery-lock-delete');
  }
  unlinkPrepared(prepared, options.testHooks, 'recovery-prepared-delete');
  return { cleaned: true, retainedPaths };
}

export function stageMovePaths(source, target, repoRoot) {
  const before = captureGitIndexGeneration(repoRoot);
  return stageMovePathsCas(source, target, repoRoot, before);
}

// Legacy selected-path helpers remain read-only compatibility surfaces.
export function captureGitIndexPaths(paths, repoRoot) {
  const relative = paths.map(candidate => path.isAbsolute(candidate) ? path.relative(repoRoot, candidate) : candidate);
  assertSafeGitPaths(relative);
  const result = spawnSync('git', ['ls-files', '--stage', '-z', '--', ...relative], { cwd: repoRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`Could not snapshot Git index: ${result.error?.message || result.stderr.trim()}`);
  const records = result.stdout.split('\0').filter(Boolean);
  return { paths: relative, records, identity: createHash('sha256').update(result.stdout).digest('hex') };
}

export function restoreGitIndexPathsCas(before, ownedAfter, repoRoot) {
  const current = captureGitIndexPaths(before.paths, repoRoot);
  if (!before || !ownedAfter || current.identity !== ownedAfter.identity) {
    throw new Error(`Git index changed after transaction staging for: ${before.paths.join(', ')}; current staging was preserved.`);
  }
  restoreGitIndexPaths(before, repoRoot);
}

export function restoreGitIndexPaths(snapshot, repoRoot) {
  assertSafeGitPaths(snapshot.paths);
  const firstHash = snapshot.records[0]?.match(/^\d+ ([0-9a-f]+) /)?.[1];
  const removals = snapshot.paths.map(filePath => `0 ${'0'.repeat(firstHash?.length ?? 40)}\t${filePath}\n`);
  const records = snapshot.records.map(record => {
    const match = /^(\d+) ([0-9a-f]+) (\d+)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error(`Unexpected Git index record: ${record}`);
    return `${match[1]} ${match[2]} ${match[3]}\t${match[4]}\n`;
  });
  const restored = spawnSync('git', ['update-index', '--index-info'], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: [...removals, ...records].join(''),
  });
  if (restored.error || restored.status !== 0) {
    throw new Error(`Could not restore Git index: ${restored.error?.message || restored.stderr.trim() || 'git update-index failed'}`);
  }
}

export function gitDiffSince(relPath, sinceDate, repoRoot, opts = {}) {
  ensureGit();
  // Find the last commit at or before sinceDate
  const baseline = spawnSync('git', [
    'log', '-1', '--before=' + sinceDate + 'T23:59:59', '--format=%H', '--', relPath
  ], { cwd: repoRoot, encoding: 'utf8' });

  const baseRef = baseline.stdout.trim();
  if (!baseRef) return null;

  const diffArgs = ['diff', baseRef, 'HEAD'];
  if (opts.stat) diffArgs.push('--stat');
  diffArgs.push('--', relPath);

  const result = spawnSync('git', diffArgs, { cwd: repoRoot, encoding: 'utf8' });
  return result.stdout || null;
}
