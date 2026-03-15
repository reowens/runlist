import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, die } from './util.mjs';
import { gitMv } from './git.mjs';
import { buildIndex, collectDocFiles } from './index.mjs';
import { renderIndexFile, writeIndex } from './index-file.mjs';
import { green, dim } from './color.mjs';

export function runStatus(argv, config, opts = {}) {
  const { dryRun } = opts;
  const input = argv[0];
  const newStatus = argv[1];

  if (!input || !newStatus) { die('Usage: dotmd status <file> <new-status>'); return; }
  if (!config.validStatuses.has(newStatus)) { die(`Invalid status: ${newStatus}\nValid: ${[...config.validStatuses].join(', ')}`); return; }

  const filePath = resolveDocPath(input, config);
  if (!filePath) { die(`File not found: ${input}`); return; }

  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter } = extractFrontmatter(raw);
  const parsed = parseSimpleFrontmatter(frontmatter);
  const oldStatus = asString(parsed.status);

  if (oldStatus === newStatus) {
    process.stdout.write(`${toRepoPath(filePath, config.repoRoot)}: already ${newStatus}, no changes made.\n`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const archiveDir = path.join(config.docsRoot, config.archiveDir);
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
      const targetPath = path.join(config.docsRoot, path.basename(filePath));
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
    const targetPath = path.join(archiveDir, path.basename(filePath));
    if (existsSync(targetPath)) { die(`Target already exists: ${toRepoPath(targetPath, config.repoRoot)}`); return; }
    const result = gitMv(filePath, targetPath, config.repoRoot);
    if (result.status !== 0) { die(result.stderr || 'git mv failed.'); return; }
    finalPath = targetPath;
  }

  if (isUnarchiving) {
    const targetPath = path.join(config.docsRoot, path.basename(filePath));
    if (existsSync(targetPath)) { die(`Target already exists: ${toRepoPath(targetPath, config.repoRoot)}`); return; }
    const result = gitMv(filePath, targetPath, config.repoRoot);
    if (result.status !== 0) { die(result.stderr || 'git mv failed.'); return; }
    finalPath = targetPath;
  }

  if ((isArchiving || isUnarchiving) && config.indexPath) {
    const index = buildIndex(config);
    writeIndex(renderIndexFile(index, config), config);
  }

  process.stdout.write(`${green(toRepoPath(finalPath, config.repoRoot))}: ${oldStatus ?? 'unknown'} → ${newStatus}\n`);

  config.hooks.onStatusChange?.({ path: toRepoPath(finalPath, config.repoRoot), oldStatus, newStatus }, {
    oldPath: toRepoPath(filePath, config.repoRoot),
    newPath: toRepoPath(finalPath, config.repoRoot),
  });
}

export function runArchive(argv, config, opts = {}) {
  const { dryRun } = opts;
  const input = argv[0];

  if (!input) { die('Usage: dotmd archive <file>'); return; }

  const filePath = resolveDocPath(input, config);
  if (!filePath) { die(`File not found: ${input}`); return; }
  if (filePath.includes(`/${config.archiveDir}/`)) { die(`Already archived: ${toRepoPath(filePath, config.repoRoot)}`); return; }

  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter } = extractFrontmatter(raw);
  const parsed = parseSimpleFrontmatter(frontmatter);
  const oldStatus = asString(parsed.status) ?? 'unknown';

  const today = new Date().toISOString().slice(0, 10);
  const targetDir = path.join(config.docsRoot, config.archiveDir);
  const targetPath = path.join(targetDir, path.basename(filePath));
  const oldRepoPath = toRepoPath(filePath, config.repoRoot);
  const newRepoPath = toRepoPath(targetPath, config.repoRoot);

  if (dryRun) {
    const prefix = dim('[dry-run]');
    process.stdout.write(`${prefix} Would update frontmatter: status: ${oldStatus} → archived, updated: ${today}\n`);
    if (existsSync(targetPath)) { die(`Target already exists: ${toRepoPath(targetPath, config.repoRoot)}`); return; }
    process.stdout.write(`${prefix} Would move: ${oldRepoPath} → ${newRepoPath}\n`);
    if (config.indexPath) process.stdout.write(`${prefix} Would regenerate index\n`);

    // Reference scan is read-only, still useful in dry-run
    const basename = path.basename(filePath);
    const references = [];
    for (const docFile of collectDocFiles(config)) {
      if (docFile === targetPath) continue;
      const docRaw = readFileSync(docFile, 'utf8');
      const { frontmatter: docFm } = extractFrontmatter(docRaw);
      if (docFm.includes(basename)) {
        references.push(toRepoPath(docFile, config.repoRoot));
      }
    }
    if (references.length > 0) {
      process.stdout.write('\nThese docs reference the old path — would need updating:\n');
      for (const ref of references) process.stdout.write(`- ${ref}\n`);
    }
    return;
  }

  updateFrontmatter(filePath, { status: 'archived', updated: today });

  if (existsSync(targetPath)) { die(`Target already exists: ${toRepoPath(targetPath, config.repoRoot)}`); return; }

  const result = gitMv(filePath, targetPath, config.repoRoot);
  if (result.status !== 0) { die(result.stderr || 'git mv failed.'); return; }

  if (config.indexPath) {
    const index = buildIndex(config);
    writeIndex(renderIndexFile(index, config), config);
  }

  process.stdout.write(`${green('Archived')}: ${oldRepoPath} → ${newRepoPath}\n`);
  if (config.indexPath) process.stdout.write('Index regenerated.\n');

  const basename = path.basename(filePath);
  const references = [];
  for (const docFile of collectDocFiles(config)) {
    if (docFile === targetPath) continue;
    const docRaw = readFileSync(docFile, 'utf8');
    const { frontmatter: docFm } = extractFrontmatter(docRaw);
    if (docFm.includes(basename)) {
      references.push(toRepoPath(docFile, config.repoRoot));
    }
  }

  if (references.length > 0) {
    process.stdout.write('\nThese docs reference the old path — update reference entries:\n');
    for (const ref of references) process.stdout.write(`- ${ref}\n`);
  }

  process.stdout.write('\nNext: commit, then update references if needed.\n');
  config.hooks.onArchive?.({ path: newRepoPath, oldStatus }, { oldPath: oldRepoPath, newPath: newRepoPath });
}

export function runTouch(argv, config, opts = {}) {
  const { dryRun } = opts;
  const input = argv[0];

  if (!input) { die('Usage: dotmd touch <file>'); return; }

  const filePath = resolveDocPath(input, config);
  if (!filePath) { die(`File not found: ${input}`); return; }

  const today = new Date().toISOString().slice(0, 10);

  if (dryRun) {
    process.stdout.write(`${dim('[dry-run]')} Would touch: ${toRepoPath(filePath, config.repoRoot)} (updated → ${today})\n`);
    return;
  }

  updateFrontmatter(filePath, { updated: today });
  process.stdout.write(`${green('Touched')}: ${toRepoPath(filePath, config.repoRoot)} (updated → ${today})\n`);

  config.hooks.onTouch?.({ path: toRepoPath(filePath, config.repoRoot) }, { path: toRepoPath(filePath, config.repoRoot), date: today });
}

function resolveDocPath(input, config) {
  if (!input) return null;
  if (path.isAbsolute(input)) return existsSync(input) ? input : null;

  let candidate = path.resolve(config.repoRoot, input);
  if (existsSync(candidate)) return candidate;

  candidate = path.resolve(config.docsRoot, input);
  if (existsSync(candidate)) return candidate;

  return null;
}

export function updateFrontmatter(filePath, updates) {
  const raw = readFileSync(filePath, 'utf8');
  if (!raw.startsWith('---\n')) throw new Error(`${filePath} has no frontmatter block.`);

  const endMarker = raw.indexOf('\n---\n', 4);
  if (endMarker === -1) throw new Error(`${filePath} has unclosed frontmatter block.`);

  let frontmatter = raw.slice(4, endMarker);
  const body = raw.slice(endMarker + 5);

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}:.*$`, 'm');
    if (regex.test(frontmatter)) {
      frontmatter = frontmatter.replace(regex, `${key}: ${value}`);
    } else {
      frontmatter += `\n${key}: ${value}`;
    }
  }

  writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`, 'utf8');
}
