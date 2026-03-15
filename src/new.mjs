import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { toRepoPath, die } from './util.mjs';
import { green, dim } from './color.mjs';

export function runNew(argv, config, opts = {}) {
  const { dryRun } = opts;

  // Parse args
  const positional = [];
  let status = 'active';
  let title = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--status' && argv[i + 1]) { status = argv[++i]; continue; }
    if (argv[i] === '--title' && argv[i + 1]) { title = argv[++i]; continue; }
    if (!argv[i].startsWith('-')) positional.push(argv[i]);
  }

  const name = positional[0];
  if (!name) { die('Usage: dotmd new <name> [--status <s>] [--title <t>]'); return; }

  // Validate status
  if (!config.validStatuses.has(status)) {
    die(`Invalid status: ${status}\nValid: ${[...config.validStatuses].join(', ')}`);
    return;
  }

  // Slugify
  const slug = name.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) { die('Name resolves to empty slug: ' + name); return; }

  // Title
  const docTitle = title ?? name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  // Path
  const filePath = path.join(config.docsRoot, slug + '.md');
  const repoPath = toRepoPath(filePath, config.repoRoot);

  if (existsSync(filePath)) {
    die(`File already exists: ${repoPath}`);
    return;
  }

  if (dryRun) {
    process.stdout.write(`${dim('[dry-run]')} Would create: ${repoPath}\n`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const content = `---\nstatus: ${status}\nupdated: ${today}\n---\n\n# ${docTitle}\n`;

  writeFileSync(filePath, content, 'utf8');
  process.stdout.write(`${green('Created')}: ${repoPath}\n`);

  config.hooks.onNew?.({ path: repoPath, status, title: docTitle });
}
