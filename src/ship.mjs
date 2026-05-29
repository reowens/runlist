import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { die, warn, toRepoPath } from './util.mjs';
import { green, dim, yellow } from './color.mjs';
import { scaffoldClaudeCommands } from './claude-commands.mjs';
import { readLeases, currentSessionId } from './lease.mjs';

// Files dotmd ship will auto-stage when they're dirty. Anything outside this
// allowlist stays in the working tree — user has to `git add` it explicitly,
// so secrets / .env / sibling-session WIP never get bundled into a release.
const ALLOWLIST_PATTERNS = [
  /^src\//,
  /^test\//,
  /^bin\//,
  /^docs\//,
  /^\.claude\/commands\//,
  /^dotmd\.config\.example\.mjs$/,
  /^dotmd\.config\.mjs$/,
  /^package(?:-lock)?\.json$/,
  /^README\.md$/,
  /^CLAUDE\.md$/,
  /^CHANGELOG\.md$/,
  /^\.gitignore$/,
];

export function bumpVersion(current, bump) {
  const parts = current.split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    die(`Cannot parse current version: ${current}`);
  }
  const [maj, min, pat] = parts;
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  if (bump === 'patch') return `${maj}.${min}.${pat + 1}`;
  die(`Invalid bump: ${bump}. Use patch | minor | major.`);
}

export function isAllowed(repoPath) {
  return ALLOWLIST_PATTERNS.some(re => re.test(repoPath));
}

function listDirtyFiles(repoRoot) {
  // -u expands untracked directories into individual file entries; without it,
  // a fresh `docs/` shows up as a single `?? docs/` line and the allowlist
  // check sees no per-file paths to whitelist.
  const result = spawnSync('git', ['status', '--porcelain', '-u'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) die(`git status failed: ${result.stderr}`);
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const status = line.slice(0, 2);
      let rawPath = line.slice(3);
      // Renames/copies render as `R  orig -> new` (and `C  orig -> new`); only
      // the destination is a real file we can `git add`. Without splitting on
      // ` -> `, the literal "orig -> new" string is handed to git, which fails
      // with "did not match any files" and aborts the ship.
      const arrow = rawPath.indexOf(' -> ');
      if (arrow !== -1) rawPath = rawPath.slice(arrow + 4);
      return { status, path: rawPath };
    });
}

function findHeldPlanTitle(config) {
  const leases = readLeases(config);
  const sid = currentSessionId();
  const owned = Object.entries(leases).filter(([_, l]) => l.session === sid);
  if (owned.length !== 1) return null;
  return path.basename(owned[0][0], '.md');
}

export async function runShip(argv, config, opts = {}) {
  const { dryRun } = opts;
  const positional = argv.filter(a => !a.startsWith('-'));
  const bump = positional[0] ?? 'patch';
  if (!['patch', 'minor', 'major'].includes(bump)) {
    die(`Invalid bump: ${bump}. Usage: dotmd ship [patch|minor|major]`);
  }

  const pkgPath = path.join(config.repoRoot, 'package.json');
  if (!existsSync(pkgPath)) die(`No package.json at ${toRepoPath(pkgPath, config.repoRoot)}`);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const current = pkg.version;
  const target = bumpVersion(current, bump);

  process.stdout.write(`${green('→')} Shipping ${current} → ${target} (${bump})\n`);

  // 1. Regen slash commands at the *target* version so the resulting commit
  //    matches the post-bump state and no dirty tree lingers after release.
  const regenResults = scaffoldClaudeCommands(config.repoRoot, config, { version: target, dryRun });
  const refreshed = regenResults.filter(r => r.action === 'updated' || r.action === 'created');
  if (refreshed.length > 0) {
    const verb = dryRun ? 'Would regenerate' : 'Regenerated';
    process.stdout.write(`${green('→')} ${verb} slash commands @ ${target}: ${refreshed.map(r => r.name).join(', ')}\n`);
  }

  // 2. Identify dirty tracked files. Anything matching the allowlist gets
  //    staged; everything else is left dirty so the user can handle it.
  const dirty = listDirtyFiles(config.repoRoot);
  const untracked = dirty.filter(d => d.status === '??');
  const tracked = dirty.filter(d => d.status !== '??');

  const toStage = tracked.filter(d => isAllowed(d.path)).map(d => d.path);
  const skipped = tracked.filter(d => !isAllowed(d.path)).map(d => d.path);

  // Untracked files matching the allowlist (e.g. a fresh new plan) are also
  // safe to add — that's the common case of "scaffolded a plan, now shipping."
  const newAllowed = untracked.filter(d => isAllowed(d.path)).map(d => d.path);
  const newSkipped = untracked.filter(d => !isAllowed(d.path)).map(d => d.path);

  const allToStage = [...toStage, ...newAllowed];
  const allSkipped = [...skipped, ...newSkipped];

  if (allSkipped.length > 0) {
    process.stderr.write(`${dim(`Not staging (outside allowlist): ${allSkipped.join(', ')}`)}\n`);
  }

  if (dryRun) {
    process.stdout.write(`${dim('[dry-run]')} Would stage ${allToStage.length} file(s):\n`);
    for (const p of allToStage) process.stdout.write(`  ${p}\n`);
    process.stdout.write(`${dim('[dry-run]')} Would commit and run \`npm version ${bump}\`\n`);
    return;
  }

  if (allToStage.length > 0) {
    const add = spawnSync('git', ['add', '--', ...allToStage], { cwd: config.repoRoot, encoding: 'utf8' });
    if (add.status !== 0) die(`git add failed: ${add.stderr}`);

    const planTitle = findHeldPlanTitle(config);
    const subject = planTitle
      ? `chore: release ${target} (${planTitle})`
      : `chore: release ${target}`;
    const body = `Auto-staged by \`dotmd ship\`:\n${allToStage.map(p => `- ${p}`).join('\n')}`;
    const commitMsg = `${subject}\n\n${body}`;
    const commit = spawnSync('git', ['commit', '-m', commitMsg], { cwd: config.repoRoot, encoding: 'utf8' });
    if (commit.status !== 0) die(`git commit failed: ${commit.stderr || commit.stdout}`);
    process.stdout.write(`${green('→')} Committed: ${subject}\n`);
  } else {
    process.stdout.write(`${dim('→ Nothing to commit before bump.')}\n`);
  }

  // 3. npm version <bump> — handles package.json bump, tag, push, GH release,
  //    npm publish, and local reinstall via the existing pre/postversion
  //    scripts. We stream its output so the user sees CI progress live.
  process.stdout.write(`${green('→')} Running \`npm version ${bump}\`…\n`);
  const npmResult = spawnSync('npm', ['version', bump], {
    cwd: config.repoRoot,
    stdio: 'inherit',
  });
  if (npmResult.status !== 0) {
    warn('`npm version` failed. The bump commit + tag may already exist locally. Inspect with `git log -1` and `git tag --sort=-creatordate | head` before retrying.');
    process.exit(npmResult.status ?? 1);
  }

  process.stdout.write(`${green('✓')} Shipped ${target}\n`);
}
