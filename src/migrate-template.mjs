import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, nowIso } from './util.mjs';
import { collectDocFiles } from './index.mjs';
import { bold, green, yellow, dim } from './color.mjs';

const HEADING_RENAMES = [
  { from: /^##\s+Open questions\s*$/gm, to: '## Open Questions' },
  { from: /^##\s+open questions\s*$/gm, to: '## Open Questions' },
  { from: /^##\s+Out of [Ss]cope\s*$/gm, to: '## Non-Goals' },
  { from: /^##\s+out of scope\s*$/gm, to: '## Non-Goals' },
  { from: /^##\s+Non-goals\s*$/gm, to: '## Non-Goals' },
];

// Detect "both surface and surfaces are populated" — applies same logic to module/modules.
// Returns the singular-line text to delete, or null if no fix needed.
function findRedundantSingular(rawFrontmatter, singularKey, pluralKey, parsed) {
  const singularVal = asString(parsed[singularKey]);
  const pluralVal = parsed[pluralKey];
  const pluralHasValues = Array.isArray(pluralVal) && pluralVal.length > 0;
  if (!singularVal || !pluralHasValues) return null;
  // Find the exact line: `<singularKey>: <value>` (single inline, not a block start)
  const lineRe = new RegExp(`^${singularKey}:\\s*[^\\n]+$`, 'm');
  const match = rawFrontmatter.match(lineRe);
  return match ? match[0] : null;
}

function ensureVersionHistory(body, timestamp) {
  if (/^##\s+Version History\s*$/m.test(body)) return null;
  const newSection = `## Version History\n\n- **${timestamp}** Migrated to v0.21 template.\n`;
  // Insert before ## Closeout if it exists; else append at end.
  const closeoutMatch = body.match(/^##\s+Closeout\s*$/m);
  if (closeoutMatch) {
    const idx = body.indexOf(closeoutMatch[0]);
    return body.slice(0, idx) + newSection + '\n' + body.slice(idx);
  }
  return body.trimEnd() + '\n\n' + newSection;
}

// Run plan-shape migrations on one file. Pure-ish: returns { changes, newRaw }
// without writing. Caller handles IO.
export function migrateOne(raw) {
  const { frontmatter, body } = extractFrontmatter(raw);
  if (!frontmatter || !body) return { changes: [], newRaw: raw };
  const parsed = parseSimpleFrontmatter(frontmatter);
  if (asString(parsed.type) !== 'plan') return { changes: [], newRaw: raw, skipped: 'not-plan' };

  let newFrontmatter = frontmatter;
  let newBody = body;
  const changes = [];

  // 1. Drop redundant singular surface/module when array form is populated.
  const dropSurface = findRedundantSingular(newFrontmatter, 'surface', 'surfaces', parsed);
  if (dropSurface) {
    newFrontmatter = newFrontmatter.replace(new RegExp(`\\n?${dropSurface.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\n?`), '\n').replace(/\n+/g, '\n');
    changes.push({ kind: 'drop-singular', detail: dropSurface });
  }
  const dropModule = findRedundantSingular(newFrontmatter, 'module', 'modules', parsed);
  if (dropModule) {
    newFrontmatter = newFrontmatter.replace(new RegExp(`\\n?${dropModule.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\n?`), '\n').replace(/\n+/g, '\n');
    changes.push({ kind: 'drop-singular', detail: dropModule });
  }

  // 2. Heading renames in body
  for (const { from, to } of HEADING_RENAMES) {
    const matches = [...newBody.matchAll(from)];
    if (matches.length > 0) {
      newBody = newBody.replace(from, to);
      for (const m of matches) {
        changes.push({ kind: 'rename-heading', detail: `\`${m[0].trim()}\` → \`${to}\`` });
      }
    }
  }

  // 3. Add ## Version History section if missing.
  // Use the file's `updated` timestamp if present, else nowIso(), so the
  // seed entry reads truthfully ("when this plan was last touched") rather
  // than dating itself to the migration moment.
  const seedTs = asString(parsed.updated) || nowIso();
  const withVh = ensureVersionHistory(newBody, seedTs);
  if (withVh !== null) {
    newBody = withVh;
    changes.push({ kind: 'add-version-history', detail: `seeded with ${seedTs}` });
  }

  if (changes.length === 0) return { changes: [], newRaw: raw };

  const newRaw = `---\n${newFrontmatter.trim()}\n---\n${newBody}`;
  return { changes, newRaw };
}

function isInArchive(filePath, config) {
  const archiveDir = config.archiveDir || 'archived';
  const sep = path.sep;
  return filePath.includes(`${sep}${archiveDir}${sep}`) || filePath.endsWith(`${sep}${archiveDir}`);
}

export function runMigrateTemplate(argv, config, opts = {}) {
  const { dryRun } = opts;
  const json = argv.includes('--json');
  const includeArchived = argv.includes('--include-archived');
  // First positional anywhere in argv (skip 'doctor' subcommand if present at idx 0).
  const fileArg = argv.find(a => !a.startsWith('-') && a !== 'doctor');

  // Allow targeting one file, else sweep all plans (excluding archived by default).
  let files;
  if (fileArg) {
    const target = fileArg.endsWith('.md') ? fileArg : `${fileArg}.md`;
    files = collectDocFiles(config).filter(f => f.endsWith(target) || f === target);
    if (files.length === 0) {
      process.stderr.write(`File not found: ${fileArg}\n`);
      process.exitCode = 1;
      return;
    }
  } else {
    files = collectDocFiles(config);
    if (!includeArchived) files = files.filter(f => !isInArchive(f, config));
  }

  const results = [];
  let totalChanges = 0;
  let touched = 0;

  for (const filePath of files) {
    const raw = readFileSync(filePath, 'utf8');
    const result = migrateOne(raw);
    if (result.changes.length === 0) continue;

    const repoPath = toRepoPath(filePath, config.repoRoot);
    results.push({ path: repoPath, changes: result.changes });
    totalChanges += result.changes.length;
    touched++;

    if (!dryRun) writeFileSync(filePath, result.newRaw, 'utf8');
  }

  if (json) {
    process.stdout.write(JSON.stringify({
      dryRun: Boolean(dryRun),
      filesTouched: touched,
      totalChanges,
      results,
    }, null, 2) + '\n');
    return;
  }

  if (results.length === 0) {
    process.stdout.write(green('No template migrations needed.') + '\n');
    return;
  }

  const prefix = dryRun ? dim('[dry-run] ') : '';
  process.stdout.write(bold(`${prefix}${touched} plan${touched === 1 ? '' : 's'} ${dryRun ? 'would be' : 'were'} migrated (${totalChanges} change${totalChanges === 1 ? '' : 's'}):\n\n`));

  for (const r of results) {
    process.stdout.write(`  ${r.path}\n`);
    for (const c of r.changes) {
      process.stdout.write(dim(`    [${c.kind}] ${c.detail}\n`));
    }
  }

  if (dryRun) {
    process.stdout.write(`\nRun ${bold('dotmd doctor --migrate-template')} without --dry-run to apply.\n`);
  } else {
    process.stdout.write(`\n${green('Done.')} Re-run ${bold('dotmd check')} to see remaining issues.\n`);
  }
}
