import { readFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, resolveDocPath, die, warn } from './util.mjs';
import { summarizeDocBody } from './ai.mjs';
import { bold, dim } from './color.mjs';

export function runSummary(argv, config) {
  const positional = [];
  let model;
  let maxTokens;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model' && argv[i + 1]) { model = argv[++i]; continue; }
    if (argv[i] === '--max-tokens' && argv[i + 1]) { maxTokens = Number.parseInt(argv[++i], 10); continue; }
    if (argv[i] === '--config') { i++; continue; }
    if (argv[i] === '--json') { json = true; continue; }
    if (argv[i].startsWith('-')) continue;
    positional.push(argv[i]);
  }

  const input = positional[0];
  if (!input) { die('Usage: dotmd summary <file> [--model <name>] [--json]'); }

  const filePath = resolveDocPath(input, config);
  if (!filePath) { die(`File not found: ${input}`); }

  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter, body } = extractFrontmatter(raw);
  const parsed = parseSimpleFrontmatter(frontmatter);
  const repoPath = toRepoPath(filePath, config.repoRoot);
  const title = asString(parsed.title) ?? path.basename(filePath, '.md');
  const status = asString(parsed.status) ?? 'unknown';

  const meta = { title, status, path: repoPath };
  const opts = {};
  if (model) opts.model = model;
  if (maxTokens) opts.maxTokens = maxTokens;

  let summary;
  try {
    summary = config.hooks.summarizeDoc
      ? config.hooks.summarizeDoc(body, meta)
      : summarizeDocBody(body, meta, opts);
  } catch (err) {
    warn(`Hook 'summarizeDoc' threw: ${err.message}`);
    summary = null;
  }

  if (json) {
    process.stdout.write(JSON.stringify({ path: repoPath, title, status, summary: summary ?? null }, null, 2) + '\n');
    return;
  }

  process.stdout.write(`${bold(title)} ${dim(`(${status})`)}\n`);
  process.stdout.write(`${dim(repoPath)}\n\n`);
  if (summary) {
    process.stdout.write(`${summary}\n`);
  } else {
    process.stdout.write(dim('Summary unavailable (model call failed or uv not installed).') + '\n');
  }
}
