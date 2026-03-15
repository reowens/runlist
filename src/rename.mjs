import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { toRepoPath, resolveDocPath, die, warn } from './util.mjs';
import { collectDocFiles } from './index.mjs';
import { gitMv } from './git.mjs';
import { green, dim, yellow } from './color.mjs';

export function runRename(argv, config, opts = {}) {
  const { dryRun } = opts;

  // Parse positional args (skip flags)
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('-')) continue;
    positional.push(argv[i]);
  }

  const oldInput = positional[0];
  const newInput = positional[1];

  if (!oldInput || !newInput) {
    die('Usage: dotmd rename <old> <new>');
    return;
  }

  // Resolve old path
  const oldPath = resolveDocPath(oldInput, config);
  if (!oldPath) {
    die(`File not found: ${oldInput}\nSearched: ${toRepoPath(config.repoRoot, config.repoRoot) || '.'}, ${toRepoPath(config.docsRoot, config.repoRoot)}`);
    return;
  }

  // Compute new path in same directory as old
  const oldDir = path.dirname(oldPath);
  let newBasename = newInput;
  // If newInput contains a path separator, use just the basename
  if (newInput.includes('/') || newInput.includes(path.sep)) {
    newBasename = path.basename(newInput);
  }
  // Add .md if not present
  if (!newBasename.endsWith('.md')) {
    newBasename += '.md';
  }
  const newPath = path.join(oldDir, newBasename);

  if (existsSync(newPath)) {
    die(`Target already exists: ${toRepoPath(newPath, config.repoRoot)}`);
    return;
  }

  const oldRepoPath = toRepoPath(oldPath, config.repoRoot);
  const newRepoPath = toRepoPath(newPath, config.repoRoot);
  const oldBasename = path.basename(oldPath);

  // Scan for references in other docs
  const allFiles = collectDocFiles(config);
  const allRefFields = [
    ...(config.referenceFields.bidirectional || []),
    ...(config.referenceFields.unidirectional || []),
  ];
  const refUpdates = [];
  const bodyWarnings = [];

  for (const filePath of allFiles) {
    if (filePath === oldPath) continue;
    const raw = readFileSync(filePath, 'utf8');
    const { frontmatter, body } = extractFrontmatter(raw);
    if (!frontmatter) continue;

    // Check frontmatter reference fields for old basename
    let hasRef = false;
    for (const line of frontmatter.split('\n')) {
      if (line.includes(oldBasename)) {
        hasRef = true;
        break;
      }
    }

    if (hasRef) {
      refUpdates.push(filePath);
    }

    // Check body for markdown links containing old basename
    if (body && body.includes(oldBasename)) {
      bodyWarnings.push(toRepoPath(filePath, config.repoRoot));
    }
  }

  if (dryRun) {
    const prefix = dim('[dry-run]');
    process.stdout.write(`${prefix} Would rename: ${oldRepoPath} → ${newRepoPath}\n`);
    if (refUpdates.length > 0) {
      process.stdout.write(`${prefix} Would update references in ${refUpdates.length} file(s):\n`);
      for (const f of refUpdates) {
        process.stdout.write(`${prefix}   ${toRepoPath(f, config.repoRoot)}\n`);
      }
    }
    if (bodyWarnings.length > 0) {
      process.stdout.write(`\n${yellow('Body links referencing old name')} (manual update needed):\n`);
      for (const p of bodyWarnings) {
        process.stdout.write(`  ${p}\n`);
      }
    }
    return;
  }

  // Perform git mv
  const result = gitMv(oldPath, newPath, config.repoRoot);
  if (result.status !== 0) {
    die(result.stderr || 'git mv failed.');
    return;
  }

  // Update references in frontmatter of other docs
  let updatedCount = 0;
  for (const filePath of refUpdates) {
    let raw = readFileSync(filePath, 'utf8');
    const { frontmatter: fm } = extractFrontmatter(raw);
    if (!fm) continue;

    const newFm = fm.split('\n').map(line => {
      if (line.includes(oldBasename)) {
        return line.split(oldBasename).join(newBasename);
      }
      return line;
    }).join('\n');

    if (newFm !== fm) {
      raw = raw.replace(`---\n${fm}\n---`, `---\n${newFm}\n---`);
      writeFileSync(filePath, raw, 'utf8');
      updatedCount++;
    }
  }

  process.stdout.write(`${green('Renamed')}: ${oldRepoPath} → ${newRepoPath}\n`);
  if (updatedCount > 0) {
    process.stdout.write(`Updated references in ${updatedCount} file(s).\n`);
  }

  if (bodyWarnings.length > 0) {
    process.stdout.write(`\n${yellow('Body links referencing old name')} (manual update needed):\n`);
    for (const p of bodyWarnings) {
      process.stdout.write(`  ${p}\n`);
    }
  }

  config.hooks.onRename?.({ oldPath: oldRepoPath, newPath: newRepoPath, referencesUpdated: updatedCount });
}
