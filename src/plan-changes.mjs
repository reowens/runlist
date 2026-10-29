import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { isGitIgnored } from './git.mjs';

// What happened to a plan since a prompt about it was written. A resumed
// prompt is a snapshot: when its plan moved on since, the session needs to
// know which parts may be stale before it acts on them. Read-only; every git
// failure degrades to "unknown" rather than blocking the consume.

const SHOWN_COMMITS = 10;

// List-time hints share one bounded Git window. Consume-time detail below
// keeps its existing next_step comparison and commit messages.
export function summarizePlanChanges(requests, config, { runGit = spawnSync, stat = statSync } = {}) {
  const maxTargets = 64, maxCommits = 256;
  const targets = new Map();
  for (const { plan } of requests) {
    if (!plan || targets.has(plan) || targets.size >= maxTargets || path.isAbsolute(plan)
      || plan.split(/[\\/]/).includes('..') || /[\0\r\n]/.test(plan)) continue;
    try { targets.set(plan, stat(path.resolve(config.repoRoot, plan))); }
    catch { targets.set(plan, null); }
  }
  const paths = [...targets].filter(([, stamp]) => stamp?.isFile()).map(([file]) => file);
  const query = args => {
    if (!paths.length) return null;
    try {
      const result = runGit('git', args, { cwd: config.repoRoot, encoding: 'utf8', timeout: 750, maxBuffer: 256 * 1024 });
      return !result.error && result.status === 0 ? result.stdout : null;
    } catch { return null; }
  };
  const pathspecs = paths.map(file => `:(top,literal)${file}`);
  const trackedOutput = query(['ls-files', '-z', '--', ...pathspecs]);
  const tracked = new Set((trackedOutput ?? '').split('\0'));
  const trackedPaths = paths.filter(file => tracked.has(file));
  const validTimes = requests.map(({ since }) => since ? new Date(since).getTime() : NaN).filter(Number.isFinite);
  const earliest = validTimes.length ? new Date(Math.min(...validTimes)).toISOString() : null;
  const log = trackedPaths.length && earliest
    ? query(['log', `--max-count=${maxCommits + 1}`, `--since=${earliest}`, '--format=%x00runlist:change:%ct%x00', '--name-only', '-z', '--', ...trackedPaths.map(file => `:(top,literal)${file}`)]) : null;
  const dirtyOutput = trackedPaths.length ? query(['diff', '--name-only', '-z', 'HEAD', '--', ...trackedPaths.map(file => `:(top,literal)${file}`)]) : null;
  const dirty = new Set((dirtyOutput ?? '').split('\0'));
  const latest = new Map();
  let date = null, commits = 0;
  for (const field of (log ?? '').split('\0')) {
    const marker = /^runlist:change:(\d+)$/.exec(field);
    if (marker) { date = Number(marker[1]) * 1000; commits++; continue; }
    const file = field.replace(/^\n/, '');
    if (date !== null && tracked.has(file)) latest.set(file, Math.max(latest.get(file) ?? 0, date));
  }
  return requests.map(({ plan, since }) => {
    const when = since ? new Date(since).getTime() : NaN;
    const stamp = targets.get(plan);
    if (!Number.isFinite(when) || !stamp?.isFile() || trackedOutput === null) return 'unknown';
    if (!tracked.has(plan)) return stamp.mtimeMs > when ? 'edited since save (file clock)' : 'no edits since save (file clock)';
    if ((latest.get(plan) ?? 0) > when) return 'changed since save';
    if (dirty.has(plan)) return 'working changes (time unknown)';
    if (log === null || dirtyOutput === null || commits > maxCommits) return 'unknown';
    return 'no commits since save';
  });
}

function git(args, repoRoot) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

function nextStepOf(raw) {
  const { frontmatter } = extractFrontmatter(raw);
  if (!frontmatter) return undefined;
  const fm = parseSimpleFrontmatter(frontmatter);
  return Object.prototype.hasOwnProperty.call(fm, 'next_step') ? JSON.stringify(fm.next_step ?? null) : undefined;
}

export function planChangesSince(planRepoPath, since, config) {
  const when = since ? new Date(since) : null;
  if (!when || Number.isNaN(when.getTime())) return null;
  const abs = path.resolve(config.repoRoot, planRepoPath);
  if (!existsSync(abs)) return null;
  const sinceIso = when.toISOString();

  const tracked = !isGitIgnored(abs, config.repoRoot) && git(['ls-files', '--error-unmatch', '--', planRepoPath], config.repoRoot) !== null;
  if (!tracked) {
    // Not in git (a gitignored planning tree): the file's own clock is all there is.
    return { plan: planRepoPath, since: sinceIso, tracked: false, commits: [], modifiedAfter: statSync(abs).mtime > when, nextStepChanged: null };
  }

  const log = git(['log', '--oneline', `--since=${sinceIso}`, '--', planRepoPath], config.repoRoot);
  const commits = log ? log.split('\n').filter(Boolean) : [];
  const current = nextStepOf(readFileSync(abs, 'utf8'));
  let nextStepChanged = null;
  const base = git(['log', '-1', '--format=%H', `--before=${sinceIso}`, '--', planRepoPath], config.repoRoot)?.trim();
  if (base) {
    const then = git(['show', `${base}:${planRepoPath}`], config.repoRoot);
    if (then !== null) nextStepChanged = nextStepOf(then) !== current;
  }
  return { plan: planRepoPath, since: sinceIso, tracked: true, commits, nextStepChanged };
}

export function formatPlanChanges(changes) {
  if (!changes) return [];
  const lines = [];
  if (!changes.tracked) {
    lines.push(changes.modifiedAfter
      ? `→ ${changes.plan} was edited after this prompt was written (${changes.since}); it is not in git, so read it for what changed before acting on the prompt.`
      : `→ ${changes.plan} has not been edited since this prompt was written (${changes.since}).`);
    return lines;
  }
  if (changes.commits.length === 0) {
    lines.push(`→ ${changes.plan} has no commits since this prompt was written (${changes.since}).`);
  } else {
    const n = changes.commits.length;
    lines.push(`→ ${changes.plan} changed in ${n} commit${n === 1 ? '' : 's'} since this prompt was written (${changes.since}); the prompt may be stale where they touch it:`);
    for (const commit of changes.commits.slice(0, SHOWN_COMMITS)) lines.push(`    ${commit}`);
    if (n > SHOWN_COMMITS) lines.push(`    +${n - SHOWN_COMMITS} more: git log --oneline --since=${changes.since} -- ${changes.plan}`);
  }
  if (changes.nextStepChanged === true) lines.push('  next_step changed since then: where the prompt and the plan disagree, the plan is newer.');
  else if (changes.nextStepChanged === false) lines.push('  next_step is unchanged since then.');
  return lines;
}
