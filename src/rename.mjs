import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { toRepoPath, resolveDocPath, die, warn } from './util.mjs';
import { collectDocFiles } from './index.mjs';
import { gitMv } from './git.mjs';
import { green, dim } from './color.mjs';
import { isInteractive, promptText } from './prompt.mjs';

export async function runRename(argv, config, opts = {}) {
  const { dryRun } = opts;

  // Parse positional args (skip flags)
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('-')) continue;
    positional.push(argv[i]);
  }

  const oldInput = positional[0];
  let newInput = positional[1];

  if (!oldInput) { die('Usage: dotmd rename <old> <new>'); }
  if (!newInput) {
    if (isInteractive()) {
      newInput = await promptText('New name: ');
      if (!newInput) die('No name provided.');
    } else {
      die('Usage: dotmd rename <old> <new>');
    }
  }

  // Resolve old path
  const oldPath = resolveDocPath(oldInput, config);
  if (!oldPath) {
    die(`File not found: ${oldInput}\nSearched: ${toRepoPath(config.repoRoot, config.repoRoot) || '.'}, ${toRepoPath(config.docsRoot, config.repoRoot)}`);
  }

  // Compute new path — cross-directory if input has slashes, same directory otherwise
  let newPath;
  if (newInput.includes('/') || newInput.includes(path.sep)) {
    let resolved = newInput;
    if (!resolved.endsWith('.md')) resolved += '.md';
    newPath = path.resolve(config.repoRoot, resolved);
  } else {
    let newBasename = newInput;
    if (!newBasename.endsWith('.md')) newBasename += '.md';
    newPath = path.join(path.dirname(oldPath), newBasename);
  }

  if (existsSync(newPath)) {
    die(`Target already exists: ${toRepoPath(newPath, config.repoRoot)}`);
    return;
  }

  const oldRepoPath = toRepoPath(oldPath, config.repoRoot);
  const newRepoPath = toRepoPath(newPath, config.repoRoot);
  const oldBasename = path.basename(oldPath);
  const newBasename = path.basename(newPath);

  // Scan for references in other docs
  const allFiles = collectDocFiles(config);
  const filesToUpdate = [];

  for (const filePath of allFiles) {
    if (filePath === oldPath) continue;
    const raw = readFileSync(filePath, 'utf8');
    if (raw.includes(oldBasename)) {
      filesToUpdate.push(filePath);
    }
  }

  if (dryRun) {
    const prefix = dim('[dry-run]');
    process.stdout.write(`${prefix} Would rename: ${oldRepoPath} → ${newRepoPath}\n`);
    if (filesToUpdate.length > 0) {
      process.stdout.write(`${prefix} Would update references in ${filesToUpdate.length} file(s):\n`);
      for (const f of filesToUpdate) {
        process.stdout.write(`${prefix}   ${toRepoPath(f, config.repoRoot)}\n`);
      }
    }
    return;
  }

  // Perform git mv
  const result = gitMv(oldPath, newPath, config.repoRoot);
  if (result.status !== 0) {
    die(result.stderr || 'git mv failed.');
  }

  // Update all references (frontmatter + body) in other docs
  let updatedCount = 0;
  for (const filePath of filesToUpdate) {
    const raw = readFileSync(filePath, 'utf8');
    const updated = raw.split(oldBasename).join(newBasename);
    if (updated !== raw) {
      writeFileSync(filePath, updated, 'utf8');
      updatedCount++;
    }
  }

  process.stdout.write(`${green('Renamed')}: ${oldRepoPath} → ${newRepoPath}\n`);
  if (updatedCount > 0) {
    process.stdout.write(`Updated references in ${updatedCount} file(s).\n`);
  }

  try { config.hooks.onRename?.({ oldPath: oldRepoPath, newPath: newRepoPath, referencesUpdated: updatedCount }); } catch (err) { warn(`Hook 'onRename' threw: ${err.message}`); }
}
