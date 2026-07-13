import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { die, warn, toRepoPath } from './util.mjs';
import { assertGitIndex } from './git.mjs';
import { green, dim, yellow } from './color.mjs';

// Files dotmd ship will auto-stage when they're dirty. Anything outside this
// allowlist stays in the working tree — user has to `git add` it explicitly,
// so secrets / .env / sibling-session WIP never get bundled into a release.
const ALLOWLIST_PATTERNS = [
  /^src\//,
  /^test\//,
  /^bin\//,
  /^docs\//,
  // Plugin artifacts ship in lockstep with the CLI (the plugin-based workflow
  // is canonical), so a dirty SKILL.md / command / hook / manifest is a release
  // change. `.claude/commands/` stays for repos that still hand-author slash
  // commands — harmless, and dropping it would un-stage their edits.
  /^plugins\//,
  /^\.claude-plugin\//,
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

export function listDirtyFiles(repoRoot) {
  const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) die(`git status failed: ${result.stderr}`);
  const fields = result.stdout.split('\0');
  const files = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (!record) continue;
    const status = record.slice(0, 2);
    const destination = record.slice(3);
    files.push({ status, path: destination });
    if (status.includes('R')) {
      const source = fields[++i];
      if (source) files.push({ status, path: source });
    } else if (status.includes('C')) {
      i++; // Porcelain -z includes the unchanged copy source as a second field.
    }
  }
  return files;
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

  try {
    assertGitIndex(config.repoRoot);
  } catch (err) {
    die(`Refusing to ship with inherited staged files. ${err.message}`);
  }

  // Per-repo slash-command scaffolding is retired (the dotmd plugin's SKILL.md
  // is canonical now), so there is nothing to regenerate at ship time. Any
  // stale generated files are swept by `dotmd hud` / `dotmd doctor`.

  // Identify dirty tracked files. Anything matching the allowlist gets
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

  if (allSkipped.length > 0) {
    die('Refusing to create a release preparation commit while skipped files are dirty. Commit, stash, or remove them first.');
  }

  if (allToStage.length > 0) {
    const add = spawnSync('git', ['add', '--', ...allToStage], { cwd: config.repoRoot, encoding: 'utf8' });
    if (add.status !== 0) die(`git add failed: ${add.stderr}`);

    try {
      assertGitIndex(config.repoRoot, allToStage);
    } catch (err) {
      die(`Refusing to commit an unexpected Git index. ${err.message}`);
    }

    const subject = `chore: release ${target}`;
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
    warn('`npm version` failed. If the target tag exists, run `npm run release:resume`; otherwise follow the rollback/rerun guidance from the version lifecycle.');
    process.exit(npmResult.status ?? 1);
  }

  process.stdout.write(`${green('✓')} Shipped ${target}\n`);
}
