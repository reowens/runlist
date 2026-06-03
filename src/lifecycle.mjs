import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, die, warn, resolveDocPath, resolveRefPath, escapeRegex, nowIso, suggestCandidates, emitFilesFooter, isArchivedPath } from './util.mjs';
import { gitMv, getGitLastModified, getGitLastModifiedBatch } from './git.mjs';
import { buildIndex, collectDocFiles } from './index.mjs';
import { renderIndexFile, writeIndex } from './index-file.mjs';
import { green, dim } from './color.mjs';
import { isInteractive, promptChoice } from './prompt.mjs';
import { buildCard, renderCard } from './pickup-card.mjs';
import { walkSections, findSection } from './section.mjs';

function findFileRoot(filePath, config) {
  const roots = config.docsRoots || [config.docsRoot];
  return roots.find(r => filePath.startsWith(r + '/')) ?? config.docsRoot;
}

// Resolve an archive target like `dotmd use` resolves a pickup target: an exact
// path wins (the resolveDocPath fast path), but a bare slug / basename falls
// back to a recursive basename match under the doc roots. Mirrors
// resolvePromptInput's basename pass so the closure verb is as forgiving about
// naming as `use`/`prompts archive`. A basename shared by two files errors with
// the candidate list rather than guessing which one to move.
function resolveArchiveTarget(input, config) {
  const direct = resolveDocPath(input, config);
  if (direct) return direct;
  if (!input.endsWith('.md')) {
    const withExt = resolveDocPath(input + '.md', config);
    if (withExt) return withExt;
  }

  const slug = input.replace(/\.md$/, '');
  const byBasename = collectDocFiles(config).filter(f => path.basename(f, '.md') === slug);
  if (byBasename.length === 1) return byBasename[0];
  if (byBasename.length > 1) {
    die(`Multiple docs match "${input}" by basename:\n${byBasename.map(f => '  ' + toRepoPath(f, config.repoRoot)).join('\n')}`);
  }
  return null;
}

function defaultTypeDir(docType, config) {
  if (docType === 'plan') return 'plans';
  if (docType === 'prompt') return 'prompts';
  const templateDir = config.raw?.templates?.[docType]?.dir;
  return typeof templateDir === 'string' && templateDir ? templateDir : null;
}

function findFilingRoot(filePath, fileRoot, docType, config) {
  const dirName = defaultTypeDir(docType, config);
  if (!dirName) return fileRoot;
  if (path.basename(fileRoot) === dirName) return fileRoot;

  const relSegments = path.relative(fileRoot, filePath).split(path.sep);
  if (relSegments[0] === dirName) return path.join(fileRoot, dirName);
  return fileRoot;
}

// Base directory a doc archives under. Types in lifecycle.archiveNestedTypes
// (default: prompt) archive into their own <typeDir>/ — yielding
// <typeDir>/<archiveDir> (e.g. docs/prompts/archived/) — so session-local
// prompt churn doesn't bury plans/docs in the shared <root>/<archiveDir>.
// Everything else archives under fileRoot. Used by both runStatus (set
// archived) and runArchive so the two paths stay in lockstep.
function archiveBaseFor(filePath, fileRoot, docType, config) {
  const nest = config.lifecycle?.archiveNestedTypes?.has(docType) ?? false;
  return nest ? findFilingRoot(filePath, fileRoot, docType, config) : fileRoot;
}

// Best-effort index regen for any doc-set or doc-status mutation. The
// generated block groups by status and embeds per-doc snapshots, so any
// change that affects what would render leaves the index stale. Wrapped
// in try/catch — a regen failure shouldn't undo the successful mutation,
// only warn with the recovery command.
export function regenIndex(config) {
  if (!config.indexPath) return;
  try {
    // Fast path: skip validation/git-staleness/ref-checking — the rendered
    // index file only consumes status/title/snapshot/etc. Validation runs on
    // explicit `dotmd check` / `dotmd index`. This keeps lifecycle commands
    // snappy on repos with huge git history or heavy `validate` hooks.
    const index = buildIndex(config, { fast: true });
    writeIndex(renderIndexFile(index, config), config);
  } catch (err) {
    warn(`Could not regenerate index (run \`dotmd index\`): ${err.message}`);
  }
}

// Pick an archive destination that won't clobber an existing record. If
// `<dir>/<basename>` is free, returns it unchanged; otherwise appends a
// numeric suffix (`-2`, `-3`, …) so the slug → path mapping stays readable
// across re-archives (issue #10 finding #6). The pre-0.39.5 behavior used a
// UTC timestamp on collision, which made the second archive's path
// non-deterministic and harder to cross-reference against the original.
// Closeout skeleton injected by `dotmd archive --closeout-template`. Loose
// bullet shape (not sub-headings) matches the freeform prose-and-bullets style
// of existing in-repo closeouts — agents replace bullets with prose when that
// flows better. The HTML comment is the agent-facing prompt.
const CLOSEOUT_SKELETON = `## Closeout

<!-- Fill in below. Replace bullets with prose if that flows better. -->
- **Outcomes:**
- **Key commits:**
- **Deferrals:**
`;

// Plans where to inject the closeout skeleton without writing anything. Returns:
//   { action: 'skip' }                          — section already present
//   { action: 'inject', placement, newBody }    — built body with skeleton inserted
// Placement: just before `## Version History` (so the closeout reads as work
// content, not appendix); falls back to end-of-body if VH is absent.
export function planCloseoutInjection(body) {
  if (/^##\s+Closeout\s*$/mi.test(body)) {
    return { action: 'skip' };
  }
  const vhMatch = body.match(/^##\s+Version History\s*$/mi);
  if (vhMatch && vhMatch.index !== undefined) {
    const before = body.slice(0, vhMatch.index).replace(/\s+$/, '');
    const rest = body.slice(vhMatch.index);
    return {
      action: 'inject',
      placement: 'before `## Version History`',
      newBody: `${before}\n\n${CLOSEOUT_SKELETON}\n${rest}`,
    };
  }
  const trimmed = body.replace(/\s+$/, '');
  return {
    action: 'inject',
    placement: 'end of body',
    newBody: `${trimmed}\n\n${CLOSEOUT_SKELETON}`,
  };
}

function uniqueArchiveTarget(targetDir, basename) {
  const base = path.join(targetDir, basename);
  if (!existsSync(base)) return base;

  const ext = path.extname(basename);
  const stem = basename.slice(0, -ext.length);

  let n = 2;
  let target = path.join(targetDir, `${stem}-${n}${ext}`);
  while (existsSync(target)) {
    n++;
    target = path.join(targetDir, `${stem}-${n}${ext}`);
  }
  return target;
}

export async function runStatus(argv, config, opts = {}) {
  const { dryRun } = opts;
  const noIndex = argv.includes('--no-index') || opts.noIndex;
  const showFiles = argv.includes('--show-files') || opts.showFiles;
  argv = argv.filter(a => a !== '--no-index' && a !== '--show-files');
  const input = argv[0];
  let newStatus = argv[1];

  if (!opts.suppressDeprecation) {
    process.stderr.write(dim('`dotmd status <file> <status>` is deprecated; prefer `dotmd set <status> [<file>]` (note: <status> first; <file> optional when a plan is in-session). Removed in a future major.\n'));
  }

  if (!input) { die('Usage: dotmd status <file> <new-status>'); }

  const filePath = resolveDocPath(input, config);
  if (!filePath) { die(`File not found: ${input}\nSearched: ${toRepoPath(config.repoRoot, config.repoRoot) || '.'}, ${toRepoPath(config.docsRoot, config.repoRoot)}`); }

  // Determine type-specific or root-specific valid statuses
  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter: fmRaw } = extractFrontmatter(raw);
  const parsedFm = parseSimpleFrontmatter(fmRaw);
  const docType = asString(parsedFm.type) ?? null;
  const fileRoot = findFileRoot(filePath, config);
  const rootLabel = path.relative(config.repoRoot, fileRoot).split(path.sep).join('/');

  // Build effective valid status set: type > root > global
  let effectiveValid;
  let effectiveOrder;
  if (docType && config.typeStatuses?.has(docType)) {
    effectiveValid = config.typeStatuses.get(docType);
    effectiveOrder = [...effectiveValid];
  } else {
    const rootSet = config.rootValidStatuses?.get(rootLabel);
    effectiveValid = rootSet ?? config.validStatuses;
    effectiveOrder = config.statusOrder;
  }

  if (!newStatus) {
    if (isInteractive()) {
      newStatus = await promptChoice('Which status?', effectiveOrder);
      if (!newStatus) die('No status selected.');
    } else {
      die('Usage: dotmd status <file> <new-status>');
    }
  }

  if (!effectiveValid.has(newStatus)) {
    const suggestions = suggestCandidates(newStatus, [...effectiveValid]);
    const hint = suggestions.length ? `\nDid you mean: ${suggestions.join(', ')}?` : '';
    die(`Invalid status: ${newStatus}\nValid: ${[...effectiveValid].join(', ')}${hint}`);
  }

  const oldStatus = asString(parsedFm.status);

  if (oldStatus === newStatus) {
    process.stdout.write(`${toRepoPath(filePath, config.repoRoot)}: already ${newStatus}, no changes made.\n`);
    return;
  }

  const today = nowIso();
  const filingRoot = findFilingRoot(filePath, fileRoot, docType, config);
  // Type-aware archive base (prompts nest under their type dir by default);
  // unarchive reuses archiveBase so a prompt restores to its type dir.
  const archiveBase = archiveBaseFor(filePath, fileRoot, docType, config);
  const archiveDir = path.join(archiveBase, config.archiveDir);
  const relFromFilingRoot = path.relative(filingRoot, filePath);
  const relSegments = relFromFilingRoot.split(path.sep);
  const inArchive = isArchivedPath(toRepoPath(filePath, config.repoRoot), config);
  const isArchiving = config.lifecycle.archiveStatuses.has(newStatus) && !inArchive;
  const isUnarchiving = !config.lifecycle.archiveStatuses.has(newStatus) && inArchive;

  // F15 filing: a status with `filed: true` lives in `<root>/<dirName>/`. The
  // current parent dir under root tells us whether the file is in some
  // "bucket" right now. Archiving keeps its own path; filing is a separate
  // primitive that fires only when the new status is filed (and isn't an
  // archive transition — archive wins by being earlier in the conditional).
  const filedStatuses = config.lifecycle.filedStatuses ?? new Map();
  const newFiledDir = filedStatuses.get(newStatus) ?? null;
  const oldFiledDir = oldStatus ? (filedStatuses.get(oldStatus) ?? null) : null;
  const currentBucket = relSegments.length > 1 ? relSegments[0] : null;
  const isFiling = !isArchiving && !isUnarchiving && newFiledDir && currentBucket !== newFiledDir;
  const isUnfiling = !isArchiving && !isUnarchiving && !newFiledDir && oldFiledDir && currentBucket === oldFiledDir;
  let finalPath = filePath;

  if (dryRun) {
    const prefix = dim('[dry-run]');
    process.stdout.write(`${prefix} Would update frontmatter: status: ${oldStatus ?? 'unknown'} → ${newStatus}, updated: ${today}\n`);
    if (isArchiving) {
      const targetPath = uniqueArchiveTarget(archiveDir, path.basename(filePath));
      process.stdout.write(`${prefix} Would move: ${toRepoPath(filePath, config.repoRoot)} → ${toRepoPath(targetPath, config.repoRoot)}\n`);
      finalPath = targetPath;
    }
    if (isUnarchiving) {
      const targetPath = path.join(archiveBase, path.basename(filePath));
      process.stdout.write(`${prefix} Would move: ${toRepoPath(filePath, config.repoRoot)} → ${toRepoPath(targetPath, config.repoRoot)}\n`);
      finalPath = targetPath;
    }
    if (isFiling) {
      const targetPath = path.join(filingRoot, newFiledDir, path.basename(filePath));
      process.stdout.write(`${prefix} Would file: ${toRepoPath(filePath, config.repoRoot)} → ${toRepoPath(targetPath, config.repoRoot)}\n`);
      finalPath = targetPath;
    }
    if (isUnfiling) {
      const targetPath = path.join(filingRoot, path.basename(filePath));
      process.stdout.write(`${prefix} Would unfile: ${toRepoPath(filePath, config.repoRoot)} → ${toRepoPath(targetPath, config.repoRoot)}\n`);
      finalPath = targetPath;
    }
    if ((isArchiving || isUnarchiving || isFiling || isUnfiling) && config.indexPath) {
      process.stdout.write(`${prefix} Would regenerate index\n`);
    }
    process.stdout.write(`${prefix} ${toRepoPath(finalPath, config.repoRoot)}: ${oldStatus ?? 'unknown'} → ${newStatus}\n`);
    return;
  }

  updateFrontmatter(filePath, { status: newStatus, updated: today });
  appendVersionHistory(filePath, `Status: ${oldStatus ?? 'unknown'} → ${newStatus}.`);

  if (isArchiving) {
    mkdirSync(archiveDir, { recursive: true });
    const targetPath = uniqueArchiveTarget(archiveDir, path.basename(filePath));
    const result = gitMv(filePath, targetPath, config.repoRoot);
    if (result.status !== 0) { die(result.stderr || 'git mv failed.'); }
    finalPath = targetPath;
  }

  if (isUnarchiving) {
    const targetPath = path.join(archiveBase, path.basename(filePath));
    if (existsSync(targetPath)) { die(`Target already exists: ${toRepoPath(targetPath, config.repoRoot)}`); }
    const result = gitMv(filePath, targetPath, config.repoRoot);
    if (result.status !== 0) { die(result.stderr || 'git mv failed.'); }
    finalPath = targetPath;
  }

  if (isFiling) {
    const targetDir = path.join(filingRoot, newFiledDir);
    mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, path.basename(filePath));
    if (existsSync(targetPath)) { die(`Target already exists: ${toRepoPath(targetPath, config.repoRoot)}`); }
    const result = gitMv(filePath, targetPath, config.repoRoot);
    if (result.status !== 0) { die(result.stderr || 'git mv failed.'); }
    finalPath = targetPath;
  }

  if (isUnfiling) {
    const targetPath = path.join(filingRoot, path.basename(filePath));
    if (existsSync(targetPath)) { die(`Target already exists: ${toRepoPath(targetPath, config.repoRoot)}`); }
    const result = gitMv(filePath, targetPath, config.repoRoot);
    if (result.status !== 0) { die(result.stderr || 'git mv failed.'); }
    finalPath = targetPath;
  }

  // Regen the index on every status change — `active → planned` etc. drift
  // the per-status sections just as much as archive crossings. Archive paths
  // also benefit (replaces the previously-gated regen). `--no-index` skips
  // this so concurrent agents can do path-limited commits without pulling
  // each other's uncommitted index changes into the staging area.
  if (noIndex) {
    process.stderr.write(dim('(index not regenerated — run `dotmd index` to refresh)\n'));
  } else {
    regenIndex(config);
  }

  process.stdout.write(`${green(toRepoPath(finalPath, config.repoRoot))}: ${oldStatus ?? 'unknown'} → ${newStatus}\n`);

  if (showFiles) {
    const touched = [filePath];
    if (finalPath !== filePath) touched.push(finalPath);
    if (config.indexPath && !noIndex) touched.push(config.indexPath);
    emitFilesFooter(touched, config);
  }

  try { config.hooks.onStatusChange?.({ path: toRepoPath(finalPath, config.repoRoot), oldStatus, newStatus }, {
    oldPath: toRepoPath(filePath, config.repoRoot),
    newPath: toRepoPath(finalPath, config.repoRoot),
  }); } catch (err) { warn(`Hook 'onStatusChange' threw: ${err.message}`); }
}

// Open a plan for work: flip its frontmatter status to `in-session` and print
// its card (body + related + next steps). No lease, no claiming — just a
// status write. Backs `dotmd use <plan>` and `dotmd runlist next`.
export async function startPlan(argv, config, opts = {}) {
  const { dryRun } = opts;
  const json = argv.includes('--json');
  const fullBody = argv.includes('--full');
  const noIndex = argv.includes('--no-index') || opts.noIndex;
  const showFiles = argv.includes('--show-files') || opts.showFiles;
  let input = argv.find(a => !a.startsWith('-'));

  // Interactive: pick from active/planned plans
  if (!input) {
    if (!isInteractive()) die('Usage: dotmd use <plan>');
    const index = buildIndex(config);
    const candidates = index.docs.filter(d =>
      d.type === 'plan' && (d.status === 'active' || d.status === 'planned')
    );
    if (candidates.length === 0) die('No active/planned plans.');
    const labelFor = (d) => `${d.title} (${d.status}) — ${d.path}`;
    const choice = await promptChoice('Pick a plan:', candidates.map(labelFor));
    if (!choice) die('No plan selected.');
    const idx = candidates.findIndex(d => choice === labelFor(d));
    if (idx === -1) die('No plan selected.');
    input = candidates[idx].path;
  }

  const filePath = resolveDocPath(input, config);
  if (!filePath) die(`File not found: ${input}`);

  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter: fmRaw, body } = extractFrontmatter(raw);
  const parsedFm = parseSimpleFrontmatter(fmRaw);
  const docType = asString(parsedFm.type) ?? null;
  const oldStatus = asString(parsedFm.status);
  const title = asString(parsedFm.title) ?? path.basename(filePath, '.md');
  const repoPath = toRepoPath(filePath, config.repoRoot);

  if (docType && docType !== 'plan') warn(`${repoPath} has type '${docType}', not 'plan'.`);

  if (oldStatus === 'blocked') {
    const blockers = parsedFm.blockers ? (Array.isArray(parsedFm.blockers) ? parsedFm.blockers.join(', ') : String(parsedFm.blockers)) : 'unknown';
    die(`Plan is blocked: ${blockers}\n  ${repoPath}`);
  }

  const today = nowIso();
  if (dryRun) {
    if (oldStatus === 'in-session') {
      process.stderr.write(`${dim('[dry-run]')} Already in-session: ${repoPath}\n`);
    } else {
      process.stderr.write(`${dim('[dry-run]')} Would update: status: ${oldStatus} → in-session, updated: ${today}\n`);
    }
  } else if (oldStatus !== 'in-session') {
    updateFrontmatter(filePath, { status: 'in-session', updated: today });
    appendVersionHistory(filePath, `Started (${oldStatus ?? 'unknown'} → in-session).`);
    if (noIndex) {
      process.stderr.write(dim('(index not regenerated — run `dotmd index` to refresh)\n'));
    } else {
      regenIndex(config);
    }
  }

  if (json) {
    const card = buildCard(filePath, raw, config);
    process.stdout.write(JSON.stringify({
      path: repoPath, oldStatus, newStatus: 'in-session', title,
      body: body?.trim() ?? '',
      card,
    }, null, 2) + '\n');
  } else {
    process.stderr.write(`${green('▶ Started')}: ${repoPath} (${oldStatus ?? 'unset'} → in-session)\n\n`);
    if (fullBody) {
      const header = `[dotmd] in-session: ${repoPath} — close with: dotmd set <status> ${repoPath}\n---\n`;
      process.stdout.write(header);
      const content = (body ?? '').trim();
      if (content) process.stdout.write(content + '\n');
    } else {
      const card = buildCard(filePath, raw, config);
      process.stdout.write(renderCard(card));
    }
  }

  if (showFiles && oldStatus !== 'in-session') {
    const touched = [filePath];
    if (config.indexPath && !noIndex) touched.push(config.indexPath);
    emitFilesFooter(touched, config);
  }

  try { config.hooks.onPickup?.({ path: repoPath, oldStatus, newStatus: 'in-session' }); } catch (err) { warn(`Hook 'onPickup' threw: ${err.message}`); }
}

export function runArchive(argv, config, opts = {}) {
  const { dryRun, out = process.stdout } = opts;
  const noIndex = argv.includes('--no-index') || opts.noIndex;
  const showFiles = argv.includes('--show-files') || opts.showFiles;
  const closeoutTemplate = argv.includes('--closeout-template');
  argv = argv.filter(a => a !== '--no-index' && a !== '--show-files' && a !== '--closeout-template');
  const input = argv[0];

  if (!input) { die('Usage: dotmd archive <file>'); }

  const filePath = resolveArchiveTarget(input, config);
  if (!filePath) { die(`File not found: ${input}\nSearched: ${toRepoPath(config.repoRoot, config.repoRoot) || '.'}, ${toRepoPath(config.docsRoot, config.repoRoot)}`); }

  const archiveFileRoot = findFileRoot(filePath, config);
  const relFromRoot = path.relative(archiveFileRoot, filePath);
  // Segment-membership covers both single-root (`<root>/archived/foo.md`) and
  // multi-root (`<type-root>/archived/foo.md`) layouts. The older
  // startsWith-only check missed nested cases where archived/ wasn't the first
  // segment under the resolved root.
  const inArchiveDir = relFromRoot.split(path.sep).includes(config.archiveDir);

  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter, body } = extractFrontmatter(raw);
  const parsed = parseSimpleFrontmatter(frontmatter);
  const oldStatus = asString(parsed.status) ?? 'unknown';

  // Heal stuck frontmatter (issue #13): file is under archiveDir/ but its
  // status hasn't been flipped. Flip in place; don't try to move (it's already
  // archived on disk) and don't refuse — refusal leaves the drift permanent.
  if (inArchiveDir) {
    if (oldStatus === 'archived') {
      die(`Already archived: ${toRepoPath(filePath, config.repoRoot)}`);
    }
    const today = nowIso();
    const repoPathHeal = toRepoPath(filePath, config.repoRoot);
    if (dryRun) {
      const prefix = dim('[dry-run]');
      out.write(`${prefix} Would heal frontmatter in place: status: ${oldStatus} → archived, updated: ${today}\n`);
      out.write(`${prefix} Would skip git mv (file already under \`${config.archiveDir}/\`)\n`);
      return;
    }
    updateFrontmatter(filePath, { status: 'archived', updated: today });
    appendVersionHistory(filePath, `Archived (frontmatter healed in place from \`${oldStatus}\`).`);
    if (!noIndex) regenIndex(config);
    out.write(`${green('✓ Healed')}: ${repoPathHeal} (${oldStatus} → archived; file already under \`${config.archiveDir}/\`)\n`);
    const touched = [repoPathHeal];
    if (config.indexPath && !noIndex) touched.push(config.indexPath);
    if (showFiles) emitFilesFooter(touched, config);
    return {
      action: 'healed',
      oldRepoPath: repoPathHeal,
      newRepoPath: repoPathHeal,
      touched,
    };
  }

  const closeoutAction = closeoutTemplate ? planCloseoutInjection(body) : null;

  const today = nowIso();
  // Type-aware: prompts archive under docs/prompts/archived/ by default (see
  // archiveBaseFor); plans/docs keep the shared <root>/archived/.
  const targetDir = path.join(archiveBaseFor(filePath, archiveFileRoot, asString(parsed.type), config), config.archiveDir);
  const targetPath = uniqueArchiveTarget(targetDir, path.basename(filePath));
  const oldRepoPath = toRepoPath(filePath, config.repoRoot);
  const newRepoPath = toRepoPath(targetPath, config.repoRoot);

  if (dryRun) {
    const prefix = dim('[dry-run]');
    if (closeoutAction?.action === 'inject') {
      out.write(`${prefix} Would inject \`## Closeout\` template (${closeoutAction.placement})\n`);
    } else if (closeoutAction?.action === 'skip') {
      out.write(`${prefix} \`## Closeout\` section already present — no injection\n`);
    }
    out.write(`${prefix} Would update frontmatter: status: ${oldStatus} → archived, updated: ${today}\n`);
    out.write(`${prefix} Would move: ${oldRepoPath} → ${newRepoPath}\n`);
    if (config.indexPath && !noIndex) out.write(`${prefix} Would regenerate index\n`);
    if (config.indexPath && noIndex) out.write(`${prefix} Would skip index regen (--no-index)\n`);

    // Preview reference updates
    const refCount = countRefsToUpdate(filePath, targetPath, config);
    if (refCount > 0) {
      out.write(`${prefix} Would update references in ${refCount} file(s)\n`);
    }

    // Preview onArchive hook fire
    if (config.hooks?.onArchive) {
      out.write(`${prefix} Would fire hook: onArchive\n`);
    }
    return;
  }

  if (closeoutAction?.action === 'inject') {
    writeFileSync(filePath, `---\n${frontmatter}\n---\n${closeoutAction.newBody}`, 'utf8');
  }

  updateFrontmatter(filePath, { status: 'archived', updated: today });
  appendVersionHistory(filePath, 'Archived.');

  mkdirSync(targetDir, { recursive: true });

  const result = gitMv(filePath, targetPath, config.repoRoot);
  if (result.status !== 0) { die(result.stderr || 'git mv failed.'); }

  // Fix refs FROM the archived file (relative paths shifted by move)
  const selfRefsFixed = updateRefsFromMovedFile(filePath, targetPath, config);

  // Auto-update references in other docs
  const { count: updatedRefCount, paths: refTouchedPaths } = updateRefsAfterMove(filePath, targetPath, config);

  if (!noIndex) regenIndex(config);

  out.write(`${green('Archived')}: ${oldRepoPath} → ${newRepoPath}\n`);
  if (closeoutAction?.action === 'inject') {
    out.write(`Injected \`## Closeout\` template — fill in: outcomes, key commits, deferrals.\n`);
  } else if (closeoutAction?.action === 'skip') {
    out.write(dim('(closeout template skipped — `## Closeout` section already present)\n'));
  }
  if (selfRefsFixed) out.write('Updated references in archived file.\n');
  if (updatedRefCount > 0) out.write(`Updated references in ${updatedRefCount} file(s).\n`);
  if (config.indexPath && !noIndex) out.write('Index regenerated.\n');
  if (config.indexPath && noIndex) out.write(dim('(index not regenerated — run `dotmd index` to refresh)\n'));

  const touched = [oldRepoPath, newRepoPath, ...refTouchedPaths];
  if (config.indexPath && !noIndex) touched.push(config.indexPath);
  if (showFiles) emitFilesFooter(touched, config);

  try { config.hooks.onArchive?.({ path: newRepoPath, oldStatus }, { oldPath: oldRepoPath, newPath: newRepoPath }); } catch (err) { warn(`Hook 'onArchive' threw: ${err.message}`); }

  return {
    action: 'archived',
    oldRepoPath,
    newRepoPath,
    touched,
  };
}

// Unified status-transition verb. Collapses status/archive/release into one
// signature — `dotmd set <status> [<path>]` — and dispatches to the right
// plumbing based on the *target* status:
//   - target in archiveStatuses (and file not already archived) → runArchive
//     (gets us ref-fixing + auto lease release + closeout-template offer)
//   - source = in-session, target != in-session                → runStatus +
//     auto-release of the held lease (so users don't have to chain `release`)
//   - everything else (incl. unarchive, plain transitions)     → runStatus
//
// Path is inferred from the calling session's held lease when omitted. With
// zero leases or >1 leases, we refuse and ask for explicit `<path>` instead
// of guessing.
//
// `dotmd set in-session <path>` is refused — acquiring a lease is asymmetric
// enough to deserve its own verb (`dotmd pickup`), and silently routing here
// would skip the lease-acquisition path entirely.
export async function runSet(argv, config, opts = {}) {
  const { dryRun } = opts;
  const noIndex = argv.includes('--no-index');
  const showFiles = argv.includes('--show-files');
  argv = argv.filter(a => a !== '--no-index' && a !== '--show-files');

  const newStatus = argv[0];
  const input = argv[1];

  if (!newStatus) die('Usage: dotmd set <status> <path>');
  if (!input) die('Usage: dotmd set <status> <path>');

  const filePath = resolveDocPath(input, config);
  if (!filePath) die(`File not found: ${input}\nSearched: ${toRepoPath(config.repoRoot, config.repoRoot) || '.'}, ${toRepoPath(config.docsRoot, config.repoRoot)}`);

  const inArchive = isArchivedPath(toRepoPath(filePath, config.repoRoot), config);

  if (config.lifecycle.archiveStatuses.has(newStatus) && !inArchive) {
    const archiveArgs = [filePath];
    if (noIndex) archiveArgs.push('--no-index');
    if (showFiles) archiveArgs.push('--show-files');
    return runArchive(archiveArgs, config, { dryRun });
  }

  const statusArgs = [filePath, newStatus];
  if (noIndex) statusArgs.push('--no-index');
  if (showFiles) statusArgs.push('--show-files');
  await runStatus(statusArgs, config, { dryRun, suppressDeprecation: true });
}

export function runBulkArchive(argv, config, opts = {}) {
  const { dryRun } = opts;
  const noIndex = argv.includes('--no-index') || opts.noIndex;
  const showFiles = argv.includes('--show-files') || opts.showFiles;
  const inputs = argv.filter(a => !a.startsWith('-'));
  if (inputs.length === 0) die('Usage: dotmd bulk archive <file1> <file2> ... or <glob>');

  const allFiles = collectDocFiles(config);
  const matched = [];

  for (const input of inputs) {
    const filePath = resolveDocPath(input, config);
    if (filePath) {
      matched.push(filePath);
    } else {
      // Try as glob-style substring match
      const hits = allFiles.filter(f => f.includes(input) || path.basename(f).includes(input));
      matched.push(...hits);
    }
  }

  const unique = [...new Set(matched)].filter(f => !isArchivedPath(toRepoPath(f, config.repoRoot), config));
  if (unique.length === 0) die('No matching files found (already-archived files are excluded).');

  process.stdout.write(`${unique.length} file(s) to archive:\n`);
  for (const f of unique) {
    process.stdout.write(`  ${toRepoPath(f, config.repoRoot)}\n`);
  }

  if (dryRun) {
    process.stdout.write(dim('\n[dry-run] No changes made.\n'));
    return;
  }

  process.stdout.write('\n');
  // Bulk archives always defer index regen to the end — N individual regens
  // is wasteful and the final state is the same. `--no-index` skips even
  // the final one.
  const bulkTouched = [];
  for (const f of unique) {
    const relPath = toRepoPath(f, config.repoRoot);
    try {
      const result = runArchive([relPath], config, { ...opts, noIndex: true, showFiles: false });
      if (result?.touched) bulkTouched.push(...result.touched);
    } catch (err) {
      warn(`Failed to archive ${relPath}: ${err.message}`);
    }
  }
  if (!noIndex) {
    regenIndex(config);
    if (config.indexPath) process.stdout.write('Index regenerated.\n');
  } else if (config.indexPath) {
    process.stdout.write(dim('(index not regenerated — run `dotmd index` to refresh)\n'));
  }
  if (showFiles) {
    const all = [...bulkTouched];
    if (config.indexPath && !noIndex) all.push(config.indexPath);
    emitFilesFooter(all, config);
  }
}

export function runTouch(argv, config, opts = {}) {
  const { dryRun } = opts;
  const useGit = argv.includes('--git');
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') { i++; continue; }
    if (argv[i].startsWith('-')) continue;
    positional.push(argv[i]);
  }
  const input = positional[0];

  // --git mode: bulk-sync frontmatter dates from git history
  if (useGit) {
    const allFiles = input ? [resolveDocPath(input, config)].filter(Boolean) : collectDocFiles(config);
    if (input && allFiles.length === 0) { die(`File not found: ${input}`); }

    const prefix = dryRun ? dim('[dry-run] ') : '';
    let synced = 0;
    const gitDates = getGitLastModifiedBatch(config.repoRoot);

    for (const filePath of allFiles) {
      const repoPath = toRepoPath(filePath, config.repoRoot);
      const raw = readFileSync(filePath, 'utf8');
      const { frontmatter } = extractFrontmatter(raw);
      if (!frontmatter) continue;

      const parsed = parseSimpleFrontmatter(frontmatter);
      const status = asString(parsed.status);
      if (config.lifecycle.skipStaleFor.has(status)) continue;

      const fmUpdated = asString(parsed.updated);
      const gitDate = gitDates.get(repoPath) ?? null;
      if (!gitDate) continue;

      const gitDay = gitDate.slice(0, 10);
      if (fmUpdated === gitDay) continue;

      // Only sync if git is newer than frontmatter (compare date strings)
      if (fmUpdated && fmUpdated >= gitDay) continue;

      if (!dryRun) {
        updateFrontmatter(filePath, { updated: gitDay });
      }
      process.stdout.write(`${prefix}${green('Synced')}: ${repoPath} (updated → ${gitDay})\n`);
      synced++;
    }

    if (synced === 0) {
      process.stdout.write(green('All frontmatter dates are in sync with git.') + '\n');
    } else {
      process.stdout.write(`\n${prefix}${synced} file(s) synced.\n`);
    }
    return;
  }

  if (!input) { die('Usage: dotmd touch <file>\n       dotmd touch --git          Bulk-sync dates from git history'); }

  const filePath = resolveDocPath(input, config);
  if (!filePath) { die(`File not found: ${input}\nSearched: ${toRepoPath(config.repoRoot, config.repoRoot) || '.'}, ${toRepoPath(config.docsRoot, config.repoRoot)}`); }

  const today = nowIso();

  if (dryRun) {
    process.stdout.write(`${dim('[dry-run]')} Would touch: ${toRepoPath(filePath, config.repoRoot)} (updated → ${today})\n`);
    return;
  }

  updateFrontmatter(filePath, { updated: today });
  process.stdout.write(`${green('Touched')}: ${toRepoPath(filePath, config.repoRoot)} (updated → ${today})\n`);

  try { config.hooks.onTouch?.({ path: toRepoPath(filePath, config.repoRoot) }, { path: toRepoPath(filePath, config.repoRoot), date: today }); } catch (err) { warn(`Hook 'onTouch' threw: ${err.message}`); }
}

/**
 * After a file moves (archive/unarchive), update frontmatter references in all
 * docs that pointed to the old location so they point to the new one.
 */
function updateRefsAfterMove(oldPath, newPath, config) {
  const basename = path.basename(oldPath);
  const allFiles = collectDocFiles(config);
  const touched = [];

  for (const docFile of allFiles) {
    if (docFile === newPath) continue;
    const raw = readFileSync(docFile, 'utf8');
    if (!raw.includes(basename)) continue;
    const { frontmatter: fm, body } = extractFrontmatter(raw);
    if (!fm) continue;

    const docDir = path.dirname(docFile);
    const oldRelPath = path.relative(docDir, oldPath).split(path.sep).join('/');
    const newRelPath = path.relative(docDir, newPath).split(path.sep).join('/');

    let newFm = fm;
    if (newFm.includes(oldRelPath)) {
      newFm = newFm.split(oldRelPath).join(newRelPath);
    }
    const dotSlashOld = './' + oldRelPath;
    if (newFm.includes(dotSlashOld)) {
      newFm = newFm.split(dotSlashOld).join(newRelPath);
    }

    // Body markdown links [text](path.md) or [text](path.md#anchor) pointing
    // at oldPath. resolveRefPath can't be used here: oldPath no longer exists
    // on disk (git mv already ran), so its existsSync probe would fail. Match
    // by resolving the href manually and comparing absolute paths instead.
    const linkRegex = /(\[[^\]]*\]\()([^)#]+\.md)(#[^)]*)?(\))/g;
    const newBody = body.replace(linkRegex, (match, pre, href, frag, post) => {
      if (/^https?:/i.test(href)) return match;
      const docRelAbs = path.resolve(docDir, href);
      const repoRelAbs = path.resolve(config.repoRoot, href);
      if (docRelAbs !== oldPath && repoRelAbs !== oldPath) return match;
      const newHref = path.relative(docDir, newPath).split(path.sep).join('/');
      return `${pre}${newHref}${frag ?? ''}${post}`;
    });

    if (newFm !== fm || newBody !== body) {
      writeFileSync(docFile, `---\n${newFm}\n---\n${newBody}`, 'utf8');
      touched.push(docFile);
    }
  }

  return { count: touched.length, paths: touched };
}

function updateRefsFromMovedFile(oldPath, newPath, config) {
  const oldDir = path.dirname(oldPath);
  const newDir = path.dirname(newPath);
  if (oldDir === newDir) return 0;

  let raw = readFileSync(newPath, 'utf8');
  const { frontmatter, body } = extractFrontmatter(raw);

  // Fix frontmatter ref fields (YAML list items like  - ./path.md).
  // Resolve doc-relative first, then repo-root-relative — so a ref like
  // `docs/foo/bar.md` written from any nesting level gets rewritten correctly
  // when the source moves. Without the repo-root fallback, repo-relative refs
  // silently skipped rewriting (existsSync on the doubled doc-relative path
  // returned false).
  let newFm = frontmatter;
  const refRegex = /^(\s+-\s+)(\S+\.md)$/gm;
  newFm = newFm.replace(refRegex, (match, prefix, refPath) => {
    const absTarget = resolveRefPath(refPath, oldDir, config.repoRoot);
    if (!absTarget) return match;
    const newRelPath = path.relative(newDir, absTarget).split(path.sep).join('/');
    return `${prefix}${newRelPath}`;
  });

  // Fix body markdown links [text](path.md)
  let newBody = body;
  const linkRegex = /(\[[^\]]*\]\()([^)]+\.md)(\))/g;
  newBody = newBody.replace(linkRegex, (match, pre, href, post) => {
    if (href.startsWith('http')) return match;
    const absTarget = resolveRefPath(href, oldDir, config.repoRoot);
    if (!absTarget) return match;
    const newHref = path.relative(newDir, absTarget).split(path.sep).join('/');
    return `${pre}${newHref}${post}`;
  });

  if (newFm !== frontmatter || newBody !== body) {
    writeFileSync(newPath, `---\n${newFm}\n---\n${newBody}`, 'utf8');
    return 1;
  }

  return 0;
}

function countRefsToUpdate(oldPath, newPath, config) {
  const basename = path.basename(oldPath);
  const allFiles = collectDocFiles(config);
  let count = 0;

  for (const docFile of allFiles) {
    if (docFile === newPath) continue;
    const raw = readFileSync(docFile, 'utf8');
    if (!raw.includes(basename)) continue;
    const { frontmatter: fm, body } = extractFrontmatter(raw);
    if (!fm) continue;

    const docDir = path.dirname(docFile);
    const oldRelPath = path.relative(docDir, oldPath).split(path.sep).join('/');
    const fmHit = fm.includes(oldRelPath) || fm.includes('./' + oldRelPath);

    let bodyHit = false;
    if (!fmHit) {
      const linkRegex = /\[[^\]]*\]\(([^)#]+\.md)(?:#[^)]*)?\)/g;
      for (const match of body.matchAll(linkRegex)) {
        const href = match[1];
        if (/^https?:/i.test(href)) continue;
        const docRelAbs = path.resolve(docDir, href);
        const repoRelAbs = path.resolve(config.repoRoot, href);
        if (docRelAbs === oldPath || repoRelAbs === oldPath) { bodyHit = true; break; }
      }
    }

    if (fmHit || bodyHit) count++;
  }

  return count;
}

// Append a one-line dated bullet to the file's `## Version History` section.
// Newest-first ordering: inserted at the top of the section, right after the
// heading + blank-line gap. If the section is missing, this is a silent no-op
// — never auto-creates the section (don't surprise users on old plans/docs).
export function appendVersionHistory(filePath, entry) {
  let raw;
  try { raw = readFileSync(filePath, 'utf8'); } catch { return false; }
  if (!raw.startsWith('---\n')) return false;

  const endMarker = raw.indexOf('\n---\n', 4);
  if (endMarker === -1) return false;
  const frontmatter = raw.slice(4, endMarker);
  const body = raw.slice(endMarker + 5);

  const vh = findSection(walkSections(body), 'Version History');
  if (!vh) return false;

  const bullet = `- **${nowIso()}** ${entry}`;
  const lines = body.split('\n');

  // vh.lineStart is 1-indexed for the heading line. The line immediately
  // after the heading is at 0-indexed `vh.lineStart`. Skip leading blanks
  // to find the first content line (existing bullet or next heading).
  let insertAt = vh.lineStart;
  while (insertAt < lines.length && lines[insertAt].trim() === '') {
    insertAt++;
  }

  // If we're inserting just before another heading (next H2), pad with a
  // blank line after our bullet for readability. Otherwise just splice in.
  const atSectionBoundary = insertAt >= lines.length || lines[insertAt].startsWith('#');
  if (atSectionBoundary) {
    lines.splice(insertAt, 0, bullet, '');
  } else {
    lines.splice(insertAt, 0, bullet);
  }

  writeFileSync(filePath, `---\n${frontmatter}\n---\n${lines.join('\n')}`, 'utf8');
  return true;
}

export function updateFrontmatter(filePath, updates) {
  const raw = readFileSync(filePath, 'utf8');
  if (!raw.startsWith('---\n')) throw new Error(`${filePath} has no frontmatter block.`);

  const endMarker = raw.indexOf('\n---\n', 4);
  if (endMarker === -1) throw new Error(`${filePath} has unclosed frontmatter block.`);

  let frontmatter = raw.slice(4, endMarker);
  const body = raw.slice(endMarker + 5);

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${escapeRegex(key)}:.*$`, 'm');
    if (regex.test(frontmatter)) {
      frontmatter = frontmatter.replace(regex, `${key}: ${value}`);
    } else {
      frontmatter += `\n${key}: ${value}`;
    }
  }

  writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`, 'utf8');
}

// Prepend a fresh `---\n…\n---\n` block to a file that has no frontmatter yet.
// Sibling to updateFrontmatter() for the bulk-tag flow, which needs to tag
// pre-existing markdown files that never had a frontmatter block. Delegates
// to updateFrontmatter when a block already exists so callers can hand it any
// file without pre-checking — the result is the same shape either way.
export function writeFrontmatter(filePath, fields) {
  const raw = readFileSync(filePath, 'utf8');
  if (raw.startsWith('---\n')) {
    updateFrontmatter(filePath, fields);
    return;
  }
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');
  writeFileSync(filePath, `---\n${lines}\n---\n${raw}`, 'utf8');
}
