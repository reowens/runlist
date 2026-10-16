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
