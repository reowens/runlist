import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { toRepoPath, nowIso } from './util.mjs';
import { getGitFirstAdded } from './git.mjs';
import { bold, green, dim } from './color.mjs';
import { readFileSync as rfs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(rfs(path.join(__dirname, '..', 'package.json'), 'utf8'));

function findPromptCandidates(config) {
  const roots = config.docsRoots || [config.docsRoot];
  // Build the set of directories to search: each root, plus each root's parent
  // (catches `docs/prompts/` when roots are like `docs/plans/`, `docs/modules/`),
  // plus the repo root itself.
  const candidates = new Set();
  for (const root of roots) {
    candidates.add(path.join(root, 'prompts'));
    candidates.add(path.join(path.dirname(root), 'prompts'));
  }
  candidates.add(path.join(config.repoRoot, 'prompts'));

  const out = [];
  const seen = new Set();
  for (const dir of candidates) {
    if (!existsSync(dir) || seen.has(dir)) continue;
    seen.add(dir);
    walkDir(dir, out);
  }
  return out;
}

function walkDir(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walkDir(full, out); continue; }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    out.push(full);
  }
}

function deriveContext(body, filePath) {
  // Use first heading or filename as the context label.
  const firstH1 = body.match(/^#\s+(.+?)\s*$/m);
  if (firstH1) return firstH1[1].slice(0, 100);
  // Fall back to slug, title-cased.
  const slug = path.basename(filePath, '.md');
  return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 100);
}

export function migrateOnePrompt(raw, opts = {}) {
  const { frontmatter, body: rawBody } = extractFrontmatter(raw);
  const created = opts.created || nowIso();

  // Case 1: no frontmatter at all → wrap with full fresh frontmatter.
  if (!frontmatter || frontmatter.length === 0) {
    const body = raw.trimStart();
    const context = deriveContext(body, opts.filePath || 'unknown');
    const fm = [
      'type: prompt',
      'status: pending',
      `created: ${created}`,
      `dotmd_version: ${pkg.version}`,
      `context: "${context.replace(/"/g, '\\"')}"`,
      'related_plans: []',
    ].join('\n');
    return {
      changes: [{ kind: 'add-frontmatter', detail: `type=prompt, created=${created}, context="${context}"` }],
      newRaw: `---\n${fm}\n---\n\n${body.trim()}\n`,
    };
  }

  // Case 2: frontmatter exists. If it already has `type: prompt`, leave alone.
  const parsed = parseSimpleFrontmatter(frontmatter);
  if (parsed.type === 'prompt') {
    return { changes: [], newRaw: raw, skipped: 'already-prompt' };
  }

  // Case 3: partial/ad-hoc frontmatter (e.g., `title:` + `purpose:` only).
  // Add missing required fields while preserving existing keys.
  const needed = [];
  if (!parsed.type) needed.push(['type', 'prompt']);
  if (!parsed.status) needed.push(['status', 'pending']);
  if (!parsed.created) needed.push(['created', created]);
  if (!parsed.dotmd_version) needed.push(['dotmd_version', pkg.version]);
  if (!parsed.context) {
    // Prefer existing `title:` if present, else derive from body/filename.
    const ctx = typeof parsed.title === 'string' ? parsed.title : deriveContext(rawBody || raw, opts.filePath || 'unknown');
    needed.push(['context', `"${ctx.replace(/"/g, '\\"')}"`]);
  }
  if (!parsed.related_plans) needed.push(['related_plans', '[]']);

  if (needed.length === 0) {
    return { changes: [], newRaw: raw, skipped: 'frontmatter-complete' };
  }

  // Prepend the missing fields (so `type` ends up at the top for grep-friendliness).
  const addedLines = needed.map(([k, v]) => `${k}: ${v}`).join('\n');
  const newFrontmatter = `${addedLines}\n${frontmatter}`;
  const newRaw = `---\n${newFrontmatter}\n---\n${rawBody}`;
  return {
    changes: [{ kind: 'merge-frontmatter', detail: `added: ${needed.map(([k]) => k).join(', ')}` }],
    newRaw,
  };
}

export function runMigratePrompts(argv, config, opts = {}) {
  const { dryRun } = opts;
  const json = argv.includes('--json');
  const fileArg = argv.find(a => !a.startsWith('-') && a !== 'doctor');

  let files;
  if (fileArg) {
    const target = fileArg.endsWith('.md') ? fileArg : `${fileArg}.md`;
    files = findPromptCandidates(config).filter(f => f.endsWith(target) || f === target);
    if (files.length === 0) {
      process.stderr.write(`File not found in any prompts/ subdir: ${fileArg}\n`);
      process.exitCode = 1;
      return;
    }
  } else {
    files = findPromptCandidates(config);
  }

  const results = [];
  let touched = 0;

  for (const filePath of files) {
    const raw = readFileSync(filePath, 'utf8');
    const created = getGitFirstAdded(toRepoPath(filePath, config.repoRoot), config.repoRoot)
      || new Date(statSync(filePath).birthtimeMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const result = migrateOnePrompt(raw, { created, filePath });
    if (result.changes.length === 0) continue;

    const repoPath = toRepoPath(filePath, config.repoRoot);
    results.push({ path: repoPath, changes: result.changes });
    touched++;

    if (!dryRun) writeFileSync(filePath, result.newRaw, 'utf8');
  }

  if (json) {
    process.stdout.write(JSON.stringify({
      dryRun: Boolean(dryRun),
      filesScanned: files.length,
      filesTouched: touched,
      results,
    }, null, 2) + '\n');
    return;
  }

  if (results.length === 0) {
    process.stdout.write(green('No prompts need migration.') + dim(` (${files.length} scanned)`) + '\n');
    return;
  }

  const prefix = dryRun ? dim('[dry-run] ') : '';
  process.stdout.write(bold(`${prefix}${touched} prompt${touched === 1 ? '' : 's'} ${dryRun ? 'would be' : 'were'} migrated:\n\n`));
  for (const r of results) {
    process.stdout.write(`  ${r.path}\n`);
    for (const c of r.changes) {
      process.stdout.write(dim(`    [${c.kind}] ${c.detail}\n`));
    }
  }
  if (dryRun) process.stdout.write(`\nRun ${bold('dotmd doctor --migrate-prompts')} without --dry-run to apply.\n`);
}
