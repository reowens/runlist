import { readFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, resolveDocPath, die } from './util.mjs';
import { collectDocFiles } from './index.mjs';
import { updateFrontmatter } from './lifecycle.mjs';
import { bold, green, dim } from './color.mjs';

export function runMigrate(argv, config, opts = {}) {
  const { dryRun } = opts;

  // Parse positional args (skip flags)
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('-')) continue;
    positional.push(argv[i]);
  }

  const field = positional[0];
  const oldValue = positional[1];
  const newValue = positional[2];
  const fileArgs = positional.slice(3);

  if (!field || !oldValue || !newValue) {
    die('Usage: dotmd migrate <field> <old-value> <new-value> [files...]');
  }

  const allFiles = collectDocFiles(config);

  // When file args are passed, resolve them to a filter set (mirrors runBulkArchive).
  let fileFilter = null;
  if (fileArgs.length > 0) {
    const matched = [];
    const unresolved = [];
    for (const input of fileArgs) {
      const filePath = resolveDocPath(input, config);
      if (filePath) {
        matched.push(filePath);
        continue;
      }
      const hits = allFiles.filter(f => f.includes(input) || path.basename(f).includes(input));
      if (hits.length === 0) {
        unresolved.push(input);
      } else {
        matched.push(...hits);
      }
    }
    if (unresolved.length > 0) {
      die(`No matching file(s) for: ${unresolved.join(', ')}`);
    }
    fileFilter = new Set(matched);
  }

  const matches = [];

  for (const filePath of allFiles) {
    if (fileFilter && !fileFilter.has(filePath)) continue;
    const raw = readFileSync(filePath, 'utf8');
    const { frontmatter } = extractFrontmatter(raw);
    if (!frontmatter) continue;
    const parsed = parseSimpleFrontmatter(frontmatter);
    const current = asString(parsed[field]);
    if (current === oldValue) {
      matches.push({ filePath, repoPath: toRepoPath(filePath, config.repoRoot) });
    }
  }

  if (matches.length === 0) {
    const scope = fileFilter ? ` in the specified file(s)` : '';
    process.stdout.write(`No docs found with ${bold(field)}: ${oldValue}${scope}\n`);
    return;
  }

  const prefix = dryRun ? dim('[dry-run] ') : '';

  for (const { filePath, repoPath } of matches) {
    if (!dryRun) {
      updateFrontmatter(filePath, { [field]: newValue });
    }
    process.stdout.write(`${prefix}${green('Updated')}: ${repoPath} (${field}: ${oldValue} → ${newValue})\n`);
  }

  process.stdout.write(`\n${prefix}${matches.length} file(s) ${dryRun ? 'would be ' : ''}updated.\n`);
}
