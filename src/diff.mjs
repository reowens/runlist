import { readFileSync } from 'node:fs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, resolveDocPath, die, warn } from './util.mjs';
import { gitDiffSince } from './git.mjs';
import { buildIndex } from './index.mjs';
import { summarizeDiffText, DEFAULT_MODEL } from './ai.mjs';
import { bold, dim, green } from './color.mjs';

export function runDiff(argv, config) {
  // Parse flags
  let file = null;
  let stat = false;
  let sinceOverride = null;
  let summarize = false;
  let model = DEFAULT_MODEL;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--stat') { stat = true; continue; }
    if (argv[i] === '--summarize') { summarize = true; continue; }
    if (argv[i] === '--since' && argv[i + 1]) { sinceOverride = argv[++i]; continue; }
    if (argv[i] === '--model' && argv[i + 1]) { model = argv[++i]; continue; }
    if (!argv[i].startsWith('-')) { file = argv[i]; }
  }

  if (file) {
    // Single file mode
    const filePath = resolveDocPath(file, config);
    if (!filePath) {
      die(`File not found: ${file}\nSearched: ${toRepoPath(config.repoRoot, config.repoRoot) || '.'}, ${toRepoPath(config.docsRoot, config.repoRoot)}`);
    }

    const raw = readFileSync(filePath, 'utf8');
    const { frontmatter } = extractFrontmatter(raw);
    const parsed = parseSimpleFrontmatter(frontmatter);
    const since = sinceOverride ?? asString(parsed.updated);

    if (!since) {
      die(`No updated date found in ${file} and no --since provided.`);
    }

    const relPath = toRepoPath(filePath, config.repoRoot);
    const diffOutput = gitDiffSince(relPath, since, config.repoRoot, { stat });

    if (!diffOutput) {
      process.stdout.write(`No changes since ${since} for ${relPath}\n`);
      return;
    }

    printFileDiff(relPath, since, diffOutput, { summarize, model, config });
  } else {
    // All drifted docs mode
    const index = buildIndex(config);
    const drifted = [];

    for (const doc of index.docs) {
      if (!doc.updated) continue;
      const relPath = doc.path;
      const since = sinceOverride ?? doc.updated;
      const diffOutput = gitDiffSince(relPath, since, config.repoRoot, { stat });
      if (diffOutput && diffOutput.trim()) {
        drifted.push({ relPath, since, diffOutput });
      }
    }

    if (drifted.length === 0) {
      process.stdout.write('No drifted docs.\n');
      return;
    }

    process.stdout.write(bold(`${drifted.length} doc(s) with changes since their updated date:\n\n`));
    for (const { relPath, since, diffOutput } of drifted) {
      printFileDiff(relPath, since, diffOutput, { summarize, model, config });
    }
  }
}

function printFileDiff(relPath, since, diffOutput, opts) {
  process.stdout.write(bold(relPath) + dim(` (updated: ${since})`) + '\n');

  if (opts.summarize) {
    let summary;
    try {
      summary = opts.config?.hooks?.summarizeDiff
        ? opts.config.hooks.summarizeDiff(diffOutput, relPath)
        : summarizeDiffText(diffOutput, relPath, opts.model);
    } catch (err) {
      warn(`Hook 'summarizeDiff' threw: ${err.message}`);
      summary = null;
    }
    if (summary) {
      process.stdout.write(dim(`  Summary: ${summary}`) + '\n');
    } else {
      warn('  Summary unavailable (model call failed)');
    }
  }

  process.stdout.write(diffOutput);
  process.stdout.write('\n');
}

