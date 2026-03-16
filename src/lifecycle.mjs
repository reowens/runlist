import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter, replaceFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, die, warn, resolveDocPath, escapeRegex } from './util.mjs';
import { gitMv, getGitLastModified } from './git.mjs';
import { buildIndex, collectDocFiles } from './index.mjs';
import { renderIndexFile, writeIndex } from './index-file.mjs';
import { green, dim, yellow } from './color.mjs';

function findFileRoot(filePath, config) {
  const roots = config.docsRoots || [config.docsRoot];
  return roots.find(r => filePath.startsWith(r)) ?? config.docsRoot;
}

export function runStatus(argv, config, opts = {}) {
  const { dryRun } = opts;
  const input = argv[0];
  const newStatus = argv[1];

  if (!input || !newStatus) { die('Usage: dotmd status <file> <new-status>'); }
  if (!config.validStatuses.has(newStatus)) { die(`Invalid status: ${newStatus}\nValid: ${[...config.validStatuses].join(', ')}`); }

  const filePath = resolveDocPath(input, config);
  if (!filePath) { die(`File not found: ${input}\nSearched: ${toRepoPath(config.repoRoot, config.repoRoot) || '.'}, ${toRepoPath(config.docsRoot, config.repoRoot)}`); }

  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter } = extractFrontmatter(raw);
  const parsed = parseSimpleFrontmatter(frontmatter);
  const oldStatus = asString(parsed.status);

  if (oldStatus === newStatus) {
    process.stdout.write(`${toRepoPath(filePath, config.repoRoot)}: already ${newStatus}, no changes made.\n`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const fileRoot = findFileRoot(filePath, config);
  const archiveDir = path.join(fileRoot, config.archiveDir);
  const isArchiving = config.lifecycle.archiveStatuses.has(newStatus) && !filePath.includes(`/${config.archiveDir}/`);
  const isUnarchiving = !config.lifecycle.archiveStatuses.has(newStatus) && filePath.includes(`/${config.archiveDir}/`);
  let finalPath = filePath;

  if (dryRun) {
    const prefix = dim('[dry-run]');
    process.stdout.write(`${prefix} Would update frontmatter: status: ${oldStatus ?? 'unknown'} → ${newStatus}, updated: ${today}\n`);
    if (isArchiving) {
      const targetPath = path.join(archiveDir, path.basename(filePath));
      process.stdout.write(`${prefix} Would move: ${toRepoPath(filePath, config.repoRoot)} → ${toRepoPath(targetPath, config.repoRoot)}\n`);
      finalPath = targetPath;
    }
    if (isUnarchiving) {
      const targetPath = path.join(fileRoot, path.basename(filePath));
      process.stdout.write(`${prefix} Would move: ${toRepoPath(filePath, config.repoRoot)} → ${toRepoPath(targetPath, config.repoRoot)}\n`);
      finalPath = targetPath;
    }
    if ((isArchiving || isUnarchiving) && config.indexPath) {
      process.stdout.write(`${prefix} Would regenerate index\n`);
    }
    process.stdout.write(`${prefix} ${toRepoPath(finalPath, config.repoRoot)}: ${oldStatus ?? 'unknown'} → ${newStatus}\n`);
    return;
  }

  updateFrontmatter(filePath, { status: newStatus, updated: today });

  if (isArchiving) {
    mkdirSync(archiveDir, { recursive: true });
    const targetPath = path.join(archiveDir, path.basename(filePath));
    if (existsSync(targetPath)) { die(`Target already exists: ${toRepoPath(targetPath, config.repoRoot)}`); }
    const result = gitMv(filePath, targetPath, config.repoRoot);
    if (result.status !== 0) { die(result.stderr || 'git mv failed.'); }
    finalPath = targetPath;
  }

  if (isUnarchiving) {
    const targetPath = path.join(fileRoot, path.basename(filePath));
    if (existsSync(targetPath)) { die(`Target already exists: ${toRepoPath(targetPath, config.repoRoot)}`); }
    const result = gitMv(filePath, targetPath, config.repoRoot);
    if (result.status !== 0) { die(result.stderr || 'git mv failed.'); }
    finalPath = targetPath;
  }

  if ((isArchiving || isUnarchiving) && config.indexPath) {
    const index = buildIndex(config);
    writeIndex(renderIndexFile(index, config), config);
  }

  process.stdout.write(`${green(toRepoPath(finalPath, config.repoRoot))}: ${oldStatus ?? 'unknown'} → ${newStatus}\n`);

  try { config.hooks.onStatusChange?.({ path: toRepoPath(finalPath, config.repoRoot), oldStatus, newStatus }, {
    oldPath: toRepoPath(filePath, config.repoRoot),
    newPath: toRepoPath(finalPath, config.repoRoot),
  }); } catch (err) { warn(`Hook 'onStatusChange' threw: ${err.message}`); }
}

export function runArchive(argv, config, opts = {}) {
  const { dryRun } = opts;
  const input = argv[0];

  if (!input) { die('Usage: dotmd archive <file>'); }

  const filePath = resolveDocPath(input, config);
  if (!filePath) { die(`File not found: ${input}\nSearched: ${toRepoPath(config.repoRoot, config.repoRoot) || '.'}, ${toRepoPath(config.docsRoot, config.repoRoot)}`); }
  if (filePath.includes(`/${config.archiveDir}/`)) { die(`Already archived: ${toRepoPath(filePath, config.repoRoot)}`); }

  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter } = extractFrontmatter(raw);
  const parsed = parseSimpleFrontmatter(frontmatter);
  const oldStatus = asString(parsed.status) ?? 'unknown';

  const today = new Date().toISOString().slice(0, 10);
  const archiveFileRoot = findFileRoot(filePath, config);
  const targetDir = path.join(archiveFileRoot, config.archiveDir);
  const targetPath = path.join(targetDir, path.basename(filePath));
  const oldRepoPath = toRepoPath(filePath, config.repoRoot);
  const newRepoPath = toRepoPath(targetPath, config.repoRoot);

  if (dryRun) {
    const prefix = dim('[dry-run]');
    process.stdout.write(`${prefix} Would update frontmatter: status: ${oldStatus} → archived, updated: ${today}\n`);
    if (existsSync(targetPath)) { die(`Target already exists: ${toRepoPath(targetPath, config.repoRoot)}`); }
    process.stdout.write(`${prefix} Would move: ${oldRepoPath} → ${newRepoPath}\n`);
    if (config.indexPath) process.stdout.write(`${prefix} Would regenerate index\n`);

    // Preview reference updates
    const refCount = countRefsToUpdate(filePath, targetPath, config);
    if (refCount > 0) {
      process.stdout.write(`${prefix} Would update references in ${refCount} file(s)\n`);
    }
    return;
  }

  updateFrontmatter(filePath, { status: 'archived', updated: today });

  mkdirSync(targetDir, { recursive: true });
  if (existsSync(targetPath)) { die(`Target already exists: ${toRepoPath(targetPath, config.repoRoot)}`); }

  const result = gitMv(filePath, targetPath, config.repoRoot);
  if (result.status !== 0) { die(result.stderr || 'git mv failed.'); }

  // Auto-update references in other docs
  const updatedRefCount = updateRefsAfterMove(filePath, targetPath, config);

  if (config.indexPath) {
    const index = buildIndex(config);
    writeIndex(renderIndexFile(index, config), config);
  }

  process.stdout.write(`${green('Archived')}: ${oldRepoPath} → ${newRepoPath}\n`);
  if (updatedRefCount > 0) process.stdout.write(`Updated references in ${updatedRefCount} file(s).\n`);
  if (config.indexPath) process.stdout.write('Index regenerated.\n');

  try { config.hooks.onArchive?.({ path: newRepoPath, oldStatus }, { oldPath: oldRepoPath, newPath: newRepoPath }); } catch (err) { warn(`Hook 'onArchive' threw: ${err.message}`); }
}

export function runTouch(argv, config, opts = {}) {
  const { dryRun } = opts;
  const useGit = argv.includes('--git');
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') { i++; continue; }
    if (argv[i].startsWith('-')) continue;
    positional.push(argv[i]);
  }
  const input = positional[0];

  // --git mode: bulk-sync frontmatter dates from git history
  if (useGit) {
    const allFiles = input ? [resolveDocPath(input, config)].filter(Boolean) : collectDocFiles(config);
    if (input && allFiles.length === 0) { die(`File not found: ${input}`); }

    const prefix = dryRun ? dim('[dry-run] ') : '';
    let synced = 0;

    for (const filePath of allFiles) {
      const repoPath = toRepoPath(filePath, config.repoRoot);
      const raw = readFileSync(filePath, 'utf8');
      const { frontmatter } = extractFrontmatter(raw);
      if (!frontmatter) continue;

      const parsed = parseSimpleFrontmatter(frontmatter);
      const status = asString(parsed.status);
      if (config.lifecycle.skipStaleFor.has(status)) continue;

      const fmUpdated = asString(parsed.updated);
      const gitDate = getGitLastModified(repoPath, config.repoRoot);
      if (!gitDate) continue;

      const gitDay = gitDate.slice(0, 10);
      if (fmUpdated === gitDay) continue;

      // Only sync if git is newer than frontmatter
      const gitMs = new Date(gitDate).getTime();
      const fmMs = fmUpdated ? new Date(fmUpdated).getTime() : 0;
      if (fmMs >= gitMs) continue;

      if (!dryRun) {
        updateFrontmatter(filePath, { updated: gitDay });
      }
      process.stdout.write(`${prefix}${green('Synced')}: ${repoPath} (updated → ${gitDay})\n`);
      synced++;
    }

    if (synced === 0) {
      process.stdout.write(green('All frontmatter dates are in sync with git.') + '\n');
    } else {
      process.stdout.write(`\n${prefix}${synced} file(s) synced.\n`);
    }
    return;
  }

  if (!input) { die('Usage: dotmd touch <file>\n       dotmd touch --git          Bulk-sync dates from git history'); }

  const filePath = resolveDocPath(input, config);
  if (!filePath) { die(`File not found: ${input}\nSearched: ${toRepoPath(config.repoRoot, config.repoRoot) || '.'}, ${toRepoPath(config.docsRoot, config.repoRoot)}`); }

  const today = new Date().toISOString().slice(0, 10);

  if (dryRun) {
    process.stdout.write(`${dim('[dry-run]')} Would touch: ${toRepoPath(filePath, config.repoRoot)} (updated → ${today})\n`);
    return;
  }

  updateFrontmatter(filePath, { updated: today });
  process.stdout.write(`${green('Touched')}: ${toRepoPath(filePath, config.repoRoot)} (updated → ${today})\n`);

  try { config.hooks.onTouch?.({ path: toRepoPath(filePath, config.repoRoot) }, { path: toRepoPath(filePath, config.repoRoot), date: today }); } catch (err) { warn(`Hook 'onTouch' threw: ${err.message}`); }
}

/**
 * After a file moves (archive/unarchive), update frontmatter references in all
 * docs that pointed to the old location so they point to the new one.
 */
function updateRefsAfterMove(oldPath, newPath, config) {
  const basename = path.basename(oldPath);
  const allFiles = collectDocFiles(config);
  let updatedCount = 0;

  for (const docFile of allFiles) {
    if (docFile === newPath) continue;
    let raw = readFileSync(docFile, 'utf8');
    const { frontmatter: fm } = extractFrontmatter(raw);
    if (!fm || !fm.includes(basename)) continue;

    const docDir = path.dirname(docFile);
    const oldRelPath = path.relative(docDir, oldPath).split(path.sep).join('/');
    const newRelPath = path.relative(docDir, newPath).split(path.sep).join('/');

    let newFm = fm;

    // Replace exact relative path
    if (newFm.includes(oldRelPath)) {
      newFm = newFm.split(oldRelPath).join(newRelPath);
    }

    // Also handle ./ prefix variant
    const dotSlashOld = './' + oldRelPath;
    if (newFm.includes(dotSlashOld)) {
      newFm = newFm.split(dotSlashOld).join(newRelPath);
    }

    if (newFm !== fm) {
      raw = replaceFrontmatter(raw, newFm);
      writeFileSync(docFile, raw, 'utf8');
      updatedCount++;
    }
  }

  return updatedCount;
}

function countRefsToUpdate(oldPath, newPath, config) {
  const basename = path.basename(oldPath);
  const allFiles = collectDocFiles(config);
  let count = 0;

  for (const docFile of allFiles) {
    if (docFile === newPath) continue;
    const raw = readFileSync(docFile, 'utf8');
    const { frontmatter: fm } = extractFrontmatter(raw);
    if (!fm || !fm.includes(basename)) continue;

    const docDir = path.dirname(docFile);
    const oldRelPath = path.relative(docDir, oldPath).split(path.sep).join('/');
    if (fm.includes(oldRelPath) || fm.includes('./' + oldRelPath)) {
      count++;
    }
  }

  return count;
}

export function updateFrontmatter(filePath, updates) {
  const raw = readFileSync(filePath, 'utf8');
  if (!raw.startsWith('---\n')) throw new Error(`${filePath} has no frontmatter block.`);

  const endMarker = raw.indexOf('\n---\n', 4);
  if (endMarker === -1) throw new Error(`${filePath} has unclosed frontmatter block.`);

  let frontmatter = raw.slice(4, endMarker);
  const body = raw.slice(endMarker + 5);

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${escapeRegex(key)}:.*$`, 'm');
    if (regex.test(frontmatter)) {
      frontmatter = frontmatter.replace(regex, `${key}: ${value}`);
    } else {
      frontmatter += `\n${key}: ${value}`;
    }
  }

  writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`, 'utf8');
}
