import { readFileSync } from 'node:fs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, die } from './util.mjs';
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

  if (!field || !oldValue || !newValue) {
    die('Usage: dotmd migrate <field> <old-value> <new-value>');
  }

  const allFiles = collectDocFiles(config);
  const matches = [];

  for (const filePath of allFiles) {
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
    process.stdout.write(`No docs found with ${bold(field)}: ${oldValue}\n`);
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
