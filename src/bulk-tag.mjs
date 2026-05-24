import path from 'node:path';
import { readFileSync } from 'node:fs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { collectDocFiles } from './index.mjs';
import { toRepoPath, die, warn, resolveDocPath } from './util.mjs';
import { writeFrontmatter } from './lifecycle.mjs';
import { green, dim, yellow } from './color.mjs';

// Per-type default status for bulk-tagging pre-existing untagged markdown.
// These intentionally lean conservative (draft / planned) rather than active —
// the user is triaging files they didn't create through `dotmd new`, so
// dropping them into the active list would clutter it without consent. The
// audit handoff endorsed this conservative default.
const DEFAULT_STATUS_BY_TYPE = {
  plan: 'planned',
  doc: 'draft',
  prompt: 'pending',
};

// Derive a doc type from the file's first subdir under its docsRoot:
//   docs/plans/foo.md   → 'plan'
//   docs/prompts/bar.md → 'prompt'
//   docs/baz.md         → 'doc'  (root-level under docsRoot)
//   docs/notes/qux.md   → 'doc'  (unrecognized subdir falls through)
// Centralizes the inline `rootLabel.includes('plan')` heuristic from lint.mjs
// and extends it for prompts.
export function inferTypeFromPath(filePath, docsRoot) {
  const rel = path.relative(docsRoot, filePath);
  const segments = rel.split(path.sep);
  if (segments.length >= 2) {
    const sub = segments[0];
    if (sub === 'plans') return 'plan';
    if (sub === 'prompts') return 'prompt';
  }
  return 'doc';
}

function parseArgs(argv) {
  const opts = { typeOverride: null, statusOverride: null, json: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--type') { opts.typeOverride = argv[++i]; continue; }
    if (a === '--status') { opts.statusOverride = argv[++i]; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a.startsWith('-')) die(`Unknown flag: ${a}`);
    opts.positional.push(a);
  }
  return opts;
}

function findFileRoot(filePath, config) {
  const roots = config.docsRoots || [config.docsRoot];
  return roots.find(r => filePath.startsWith(r + '/')) ?? config.docsRoot;
}

export function runBulkTag(argv, config, opts = {}) {
  const { dryRun } = opts;
  const args = parseArgs(argv);

  // Determine candidate set: explicit positional args take precedence; otherwise
  // scan all collected doc files (which already excludes config.indexPath).
  const allFiles = collectDocFiles(config);
  let pool;
  if (args.positional.length > 0) {
    pool = args.positional
      .map(p => resolveDocPath(p, config))
      .filter(Boolean);
    if (pool.length === 0) die('No matching files found for the given paths.');
  } else {
    pool = allFiles;
  }

  // Skip already-archived files (mirrors bulk archive's policy at
  // lifecycle.mjs:569–573) — settled docs shouldn't be retroactively tagged.
  const archiveDir = config.archiveDir;
  const inArchive = (f) => {
    const root = findFileRoot(f, config);
    const rel = path.relative(root, f);
    return rel.startsWith(archiveDir + '/') || rel.startsWith(archiveDir + path.sep);
  };

  const candidates = [];
  for (const filePath of pool) {
    if (inArchive(filePath)) continue;
    let raw;
    try { raw = readFileSync(filePath, 'utf8'); } catch (err) { warn(`Could not read ${filePath}: ${err.message}`); continue; }
    const { frontmatter } = extractFrontmatter(raw);
    const parsed = frontmatter ? parseSimpleFrontmatter(frontmatter) : {};
    const hasType = typeof parsed.type === 'string' && parsed.type.length > 0;
    const hasStatus = typeof parsed.status === 'string' && parsed.status.length > 0;
    // Only files missing type OR status are candidates; fully tagged files are
    // skipped silently (bulk-tag's job is to fill gaps, not nag).
    if (hasType && hasStatus) continue;

    const root = findFileRoot(filePath, config);
    const inferredType = args.typeOverride ?? (hasType ? parsed.type : inferTypeFromPath(filePath, root));
    const defaultStatus = DEFAULT_STATUS_BY_TYPE[inferredType] ?? 'draft';
    const inferredStatus = args.statusOverride ?? (hasStatus ? parsed.status : defaultStatus);

    const updates = {};
    if (!hasType) updates.type = inferredType;
    if (!hasStatus) updates.status = inferredStatus;

    candidates.push({
      filePath,
      relPath: toRepoPath(filePath, config.repoRoot),
      hadFrontmatter: Boolean(frontmatter),
      hadType: hasType,
      hadStatus: hasStatus,
      currentType: hasType ? parsed.type : null,
      currentStatus: hasStatus ? parsed.status : null,
      newType: inferredType,
      newStatus: inferredStatus,
      updates,
    });
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({
      dryRun: Boolean(dryRun),
      count: candidates.length,
      candidates: candidates.map(c => ({
        path: c.relPath,
        hadFrontmatter: c.hadFrontmatter,
        currentType: c.currentType,
        currentStatus: c.currentStatus,
        newType: c.newType,
        newStatus: c.newStatus,
        updates: c.updates,
      })),
    }, null, 2) + '\n');
    if (!dryRun) {
      for (const c of candidates) {
        try { writeFrontmatter(c.filePath, c.updates); }
        catch (err) { warn(`Failed to tag ${c.relPath}: ${err.message}`); }
      }
    }
    return;
  }

  if (candidates.length === 0) {
    process.stdout.write(green('No untagged files found.') + '\n');
    return;
  }

  process.stdout.write(`${candidates.length} untagged file(s) — will tag:\n`);
  const pathWidth = Math.min(60, Math.max(...candidates.map(c => c.relPath.length)));
  for (const c of candidates) {
    const fields = [];
    if (c.updates.type) fields.push(`type: ${c.updates.type}`);
    if (c.updates.status) fields.push(`status: ${c.updates.status}`);
    const note = c.hadFrontmatter
      ? `(added ${Object.keys(c.updates).join(', ')})`
      : '(no frontmatter)';
    process.stdout.write(`  ${c.relPath.padEnd(pathWidth)}  ${fields.join('  ')}  ${dim(note)}\n`);
  }

  if (dryRun) {
    process.stdout.write(dim('\n[dry-run] No changes made.\n'));
    return;
  }

  process.stdout.write('\n');
  let tagged = 0;
  for (const c of candidates) {
    try {
      writeFrontmatter(c.filePath, c.updates);
      tagged++;
    } catch (err) {
      warn(`Failed to tag ${c.relPath}: ${err.message}`);
    }
  }
  process.stdout.write(green(`Tagged ${tagged} file(s).`) + '\n');
}
