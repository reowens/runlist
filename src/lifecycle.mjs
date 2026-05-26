import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter, replaceFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, die, warn, resolveDocPath, resolveRefPath, escapeRegex, nowIso, suggestCandidates } from './util.mjs';
import { gitMv, getGitLastModified, getGitLastModifiedBatch } from './git.mjs';
import { buildIndex, collectDocFiles } from './index.mjs';
import { renderIndexFile, writeIndex } from './index-file.mjs';
import { green, dim, yellow } from './color.mjs';
import { isInteractive, promptChoice } from './prompt.mjs';
import {
  acquireLease,
  releaseLease,
  releaseAllForSession,
  releaseStale,
  readLeases,
  currentSessionId,
  migrateLease,
} from './lease.mjs';
import { buildCard, renderCard } from './pickup-card.mjs';
import { walkSections, findSection } from './section.mjs';

function findFileRoot(filePath, config) {
  const roots = config.docsRoots || [config.docsRoot];
  return roots.find(r => filePath.startsWith(r + '/')) ?? config.docsRoot;
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
// `<dir>/<basename>` is free, returns it unchanged; otherwise appends a UTC
// timestamp (and a counter on the vanishingly rare same-second collision) so
// both the prior archive and the current one survive.
function uniqueArchiveTarget(targetDir, basename) {
  const base = path.join(targetDir, basename);
  if (!existsSync(base)) return base;

  const ext = path.extname(basename);
  const stem = basename.slice(0, -ext.length);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

  let target = path.join(targetDir, `${stem}-${stamp}${ext}`);
  let n = 2;
  while (existsSync(target)) {
    target = path.join(targetDir, `${stem}-${stamp}-${n}${ext}`);
    n++;
  }
  return target;
}

export async function runStatus(argv, config, opts = {}) {
  const { dryRun } = opts;
  const input = argv[0];
  let newStatus = argv[1];

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
  const archiveDir = path.join(fileRoot, config.archiveDir);
  const relFromRoot = path.relative(fileRoot, filePath);
  const inArchive = relFromRoot.startsWith(config.archiveDir + '/') || relFromRoot.startsWith(config.archiveDir + path.sep);
  const isArchiving = config.lifecycle.archiveStatuses.has(newStatus) && !inArchive;
  const isUnarchiving = !config.lifecycle.archiveStatuses.has(newStatus) && inArchive;
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
      const targetPath = path.join(fileRoot, path.basename(filePath));
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
  appendVersionHistory(filePath, `Status: ${oldStatus ?? 'unknown'} → ${newStatus}.`);

  if (isArchiving) {
    mkdirSync(archiveDir, { recursive: true });
    const targetPath = uniqueArchiveTarget(archiveDir, path.basename(filePath));
    const result = gitMv(filePath, targetPath, config.repoRoot);
    if (result.status !== 0) { die(result.stderr || 'git mv failed.'); }
    finalPath = targetPath;
  }

  if (isUnarchiving) {
    const targetPath = path.join(fileRoot, path.basename(filePath));
    if (existsSync(targetPath)) { die(`Target already exists: ${toRepoPath(targetPath, config.repoRoot)}`); }
    const result = gitMv(filePath, targetPath, config.repoRoot);
    if (result.status !== 0) { die(result.stderr || 'git mv failed.'); }
    finalPath = targetPath;
  }

  // Regen the index on every status change — `active → planned` etc. drift
  // the per-status sections just as much as archive crossings. Archive paths
  // also benefit (replaces the previously-gated regen).
  regenIndex(config);

  process.stdout.write(`${green(toRepoPath(finalPath, config.repoRoot))}: ${oldStatus ?? 'unknown'} → ${newStatus}\n`);

  try { config.hooks.onStatusChange?.({ path: toRepoPath(finalPath, config.repoRoot), oldStatus, newStatus }, {
    oldPath: toRepoPath(filePath, config.repoRoot),
    newPath: toRepoPath(finalPath, config.repoRoot),
  }); } catch (err) { warn(`Hook 'onStatusChange' threw: ${err.message}`); }
}

export async function runPickup(argv, config, opts = {}) {
  const { dryRun } = opts;
  const json = argv.includes('--json');
  const takeover = argv.includes('--takeover');
  const fullBody = argv.includes('--full');
  let input = argv.find(a => !a.startsWith('-'));

  // Interactive: pick from active/planned plans
  if (!input) {
    if (!isInteractive()) die('Usage: dotmd pickup <file>');
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

  // If frontmatter says we're not in-session, any lingering lease is orphaned —
  // drop it so a fresh acquire below doesn't see a phantom conflict.
  if (oldStatus !== 'in-session') {
    if (readLeases(config)[repoPath]) {
      releaseLease(config, repoPath, { force: true });
    }
  }

  const pickupable = new Set(['active', 'planned', 'in-session']);
  if (oldStatus && !pickupable.has(oldStatus)) die(`Cannot pick up a plan with status '${oldStatus}'. Must be active or planned.\n  ${repoPath}`);

  const today = nowIso();
  const leaseOldStatus = oldStatus === 'in-session' ? 'active' : (oldStatus ?? 'active');
  let leaseOutcome = 'acquired';

  if (dryRun) {
    if (oldStatus === 'in-session') {
      process.stderr.write(`${dim('[dry-run]')} Would acquire lease (status already in-session)\n`);
    } else {
      process.stderr.write(`${dim('[dry-run]')} Would update: status: ${oldStatus} → in-session, updated: ${today}\n`);
    }
  } else {
    const result = acquireLease(config, repoPath, leaseOldStatus, { takeover });
    leaseOutcome = result.outcome;
    if (result.outcome === 'conflict-alive') {
      const c = result.conflict;
      die(`Held by ${c.host}/${c.session} (pid ${c.pid}) since ${c.pickedUpAt}.\nUse --takeover to override.\n  ${repoPath}`);
    }
    if (result.outcome === 'conflict-stale') {
      const c = result.conflict;
      die(`Stale in-session lease from ${c.host}/${c.session} since ${c.pickedUpAt} (>24h old).\nUse --takeover to claim.\n  ${repoPath}`);
    }
    if (oldStatus !== 'in-session') {
      updateFrontmatter(filePath, { status: 'in-session', updated: today });
      regenIndex(config);
    }
    // VH append per lease outcome:
    //   acquired   → `Picked up (<old> → in-session).`
    //   taken-over → `Took over from <session>.`
    //   reattached → no entry (same-session noise)
    if (leaseOutcome === 'acquired') {
      appendVersionHistory(filePath, `Picked up (${oldStatus ?? 'unknown'} → in-session).`);
    } else if (leaseOutcome === 'taken-over') {
      const fromSession = result.conflict?.session ?? 'unknown';
      appendVersionHistory(filePath, `Took over from ${fromSession}.`);
    }
  }

  if (json) {
    const card = buildCard(filePath, raw, config);
    process.stdout.write(JSON.stringify({
      path: repoPath, oldStatus, newStatus: 'in-session', title,
      reattached: leaseOutcome === 'reattached',
      takenOver: leaseOutcome === 'taken-over',
      body: body?.trim() ?? '',
      card,
    }, null, 2) + '\n');
  } else {
    if (leaseOutcome === 'reattached') {
      process.stderr.write(`${green('▶ Re-attached')}: ${repoPath}\n\n`);
    } else if (leaseOutcome === 'taken-over') {
      process.stderr.write(`${green('▶ Took over')}: ${repoPath} (was ${oldStatus ?? 'unset'} → in-session)\n\n`);
    } else {
      process.stderr.write(`${green('▶ Picked up')}: ${repoPath} (${oldStatus ?? 'unset'} → in-session)\n\n`);
    }
    if (fullBody) {
      const header = `[dotmd] holding ${repoPath} — release with: dotmd release ${repoPath}\n---\n`;
      process.stdout.write(header);
      const content = (body ?? '').trim();
      if (content) process.stdout.write(content + '\n');
    } else {
      const card = buildCard(filePath, raw, config);
      process.stdout.write(renderCard(card));
    }
  }

  try { config.hooks.onPickup?.({ path: repoPath, oldStatus, newStatus: 'in-session' }); } catch (err) { warn(`Hook 'onPickup' threw: ${err.message}`); }
}

export async function runUnpickup(argv, config, opts = {}) {
  const { dryRun } = opts;
  const json = argv.includes('--json');
  const all = argv.includes('--all');
  const stale = argv.includes('--stale');
  const force = argv.includes('--force');
  const toIdx = argv.indexOf('--to');
  const toStatus = toIdx >= 0 ? argv[toIdx + 1] : null;
  const positional = argv.filter((a, i) => !a.startsWith('-') && argv[i - 1] !== '--to');
  const fileArg = positional[0];

  const session = currentSessionId();
  const released = [];
  const skipped = [];

  // Decide which leases to act on
  let targets = [];
  const leases = readLeases(config);
  if (fileArg) {
    const filePath = resolveDocPath(fileArg, config);
    if (!filePath) die(`File not found: ${fileArg}`);
    const repoPath = toRepoPath(filePath, config.repoRoot);
    if (leases[repoPath]) {
      targets.push(leases[repoPath]);
    } else {
      // Manual-edit fallback: status may be in-session with no lease.
      const raw = readFileSync(filePath, 'utf8');
      const { frontmatter: fmRaw } = extractFrontmatter(raw);
      const parsedFm = parseSimpleFrontmatter(fmRaw);
      if (asString(parsedFm.status) === 'in-session') {
        targets.push({ path: repoPath, oldStatus: null, session: null, pid: null, host: null, pickedUpAt: null, _orphan: true });
      } else {
        die(`Not in-session: ${repoPath}`);
      }
    }
  } else if (all) {
    targets = Object.values(leases);
  } else if (stale) {
    // releaseStale handled separately below — set a marker
    targets = null;
  } else {
    // Default: release all owned by current session
    targets = Object.values(leases).filter(l => l.session === session);
  }

  const targetStatus = (lease) => toStatus || lease.oldStatus || 'active';

  function flipFrontmatter(repoPath, newStatus) {
    const filePath = resolveDocPath(repoPath, config);
    if (!filePath) {
      warn(`Lease points at ${repoPath} but file not found — releasing lease without frontmatter update.`);
      return;
    }
    try {
      const raw = readFileSync(filePath, 'utf8');
      const { frontmatter: fmRaw } = extractFrontmatter(raw);
      const parsedFm = parseSimpleFrontmatter(fmRaw);
      const cur = asString(parsedFm.status);
      if (cur === 'in-session') {
        const today = nowIso();
        updateFrontmatter(filePath, { status: newStatus, updated: today });
        appendVersionHistory(filePath, `Released (in-session → ${newStatus}).`);
        regenIndex(config);
      }
      // If frontmatter is no longer in-session (manual flip), leave it alone.
    } catch (err) {
      warn(`Could not update frontmatter for ${repoPath}: ${err.message}`);
    }
  }

  if (targets === null) {
    // --stale path
    if (dryRun) {
      const staleLeases = Object.values(leases).filter(l => {
        const age = Date.now() - new Date(l.pickedUpAt).getTime();
        return Number.isNaN(age) || age > 24 * 60 * 60 * 1000;
      });
      for (const l of staleLeases) {
        process.stderr.write(`${dim('[dry-run]')} Would release stale: ${l.path} (${l.session})\n`);
      }
    } else {
      const result = releaseStale(config);
      for (const l of result.released) {
        flipFrontmatter(l.path, targetStatus(l));
        released.push({ path: l.path, oldStatus: l.oldStatus, newStatus: targetStatus(l), session: l.session, stale: true });
        try { config.hooks.onUnpickup?.({ path: l.path, oldStatus: 'in-session', newStatus: targetStatus(l) }); } catch (err) { warn(`Hook 'onUnpickup' threw: ${err.message}`); }
      }
    }
  } else {
    if (targets.length === 0 && !json) {
      process.stderr.write(`No leases to release${fileArg ? ` for ${fileArg}` : ` for session ${session}`}.\n`);
    }
    for (const lease of targets) {
      const newStatus = targetStatus(lease);
      if (dryRun) {
        process.stderr.write(`${dim('[dry-run]')} Would release: ${lease.path} (${lease.oldStatus ?? '?'} → ${newStatus})\n`);
        continue;
      }
      if (lease._orphan) {
        // Manual-edit fallback: no lease entry, just flip frontmatter.
        flipFrontmatter(lease.path, newStatus);
        warn(`No lease found for ${lease.path}; flipped status manually.`);
        released.push({ path: lease.path, oldStatus: 'in-session', newStatus, session: null, orphan: true });
        try { config.hooks.onUnpickup?.({ path: lease.path, oldStatus: 'in-session', newStatus }); } catch (err) { warn(`Hook 'onUnpickup' threw: ${err.message}`); }
        continue;
      }
      const isMine = lease.session === session;
      if (!isMine && !force && !all && !stale) {
        skipped.push({ path: lease.path, reason: 'not-yours', session: lease.session });
        continue;
      }
      const r = releaseLease(config, lease.path, { force: true });
      if (r.released) {
        flipFrontmatter(lease.path, newStatus);
        released.push({ path: lease.path, oldStatus: lease.oldStatus, newStatus, session: lease.session });
        try { config.hooks.onUnpickup?.({ path: lease.path, oldStatus: 'in-session', newStatus }); } catch (err) { warn(`Hook 'onUnpickup' threw: ${err.message}`); }
      }
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify({ released, skipped }, null, 2) + '\n');
  } else {
    for (const r of released) {
      const tag = r.stale ? ' (stale)' : (r.orphan ? ' (orphan)' : '');
      process.stdout.write(`${green('↩ Unpicked')}: ${r.path} (in-session → ${r.newStatus})${tag}\n`);
    }
    for (const s of skipped) {
      process.stderr.write(`${yellow('⚠ Skipped')}: ${s.path} (held by ${s.session}; use --force to override)\n`);
    }
  }
}

export async function runFinish(argv, config, opts = {}) {
  const { dryRun } = opts;
  const json = argv.includes('--json');
  const positional = argv.filter(a => !a.startsWith('-'));
  let input = positional[0];
  const targetStatus = positional[1] ?? 'done';

  if (!['done', 'active'].includes(targetStatus)) die(`Invalid finish status: ${targetStatus}. Use 'done' or 'active'.`);

  // Interactive: pick from in-session plans
  if (!input) {
    if (!isInteractive()) die('Usage: dotmd finish <file> [done|active]');
    const index = buildIndex(config);
    const inSession = index.docs.filter(d => d.status === 'in-session');
    if (inSession.length === 0) die('No plans currently in-session.');
    if (inSession.length === 1) {
      input = inSession[0].path;
      process.stderr.write(`${dim(`Auto-selected: ${input}`)}\n`);
    } else {
      const choice = await promptChoice('Finish which plan:', inSession.map(d => `${d.title} — ${d.path}`));
      if (!choice) die('No plan selected.');
      const idx = inSession.findIndex((_, i) => choice === `${inSession[i].title} — ${inSession[i].path}`);
      if (idx === -1) die('No plan selected.');
      input = inSession[idx].path;
    }
  }

  const filePath = resolveDocPath(input, config);
  if (!filePath) die(`File not found: ${input}`);

  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter: fmRaw } = extractFrontmatter(raw);
  const parsedFm = parseSimpleFrontmatter(fmRaw);
  const oldStatus = asString(parsedFm.status);
  const repoPath = toRepoPath(filePath, config.repoRoot);

  if (oldStatus !== 'in-session') die(`Plan is not in-session (current: ${oldStatus}).\n  ${repoPath}`);

  const today = nowIso();

  if (dryRun) {
    process.stderr.write(`${dim('[dry-run]')} Would update: status: in-session → ${targetStatus}, updated: ${today}\n`);
  } else {
    updateFrontmatter(filePath, { status: targetStatus, updated: today });
    regenIndex(config);
  }

  if (json) {
    process.stdout.write(JSON.stringify({ path: repoPath, oldStatus, newStatus: targetStatus }, null, 2) + '\n');
  } else {
    process.stdout.write(`${green('✓ Finished')}: ${repoPath} (in-session → ${targetStatus})\n`);
  }

  if (!dryRun) {
    try { releaseLease(config, repoPath, { force: true }); } catch (err) { warn(`Could not release lease for ${repoPath}: ${err.message}`); }
  }

  try { config.hooks.onFinish?.({ path: repoPath, oldStatus, newStatus: targetStatus }); } catch (err) { warn(`Hook 'onFinish' threw: ${err.message}`); }
}

export function runArchive(argv, config, opts = {}) {
  const { dryRun, out = process.stdout } = opts;
  const input = argv[0];

  if (!input) { die('Usage: dotmd archive <file>'); }

  const filePath = resolveDocPath(input, config);
  if (!filePath) { die(`File not found: ${input}\nSearched: ${toRepoPath(config.repoRoot, config.repoRoot) || '.'}, ${toRepoPath(config.docsRoot, config.repoRoot)}`); }

  const archiveFileRoot = findFileRoot(filePath, config);
  const relFromRoot = path.relative(archiveFileRoot, filePath);
  if (relFromRoot.startsWith(config.archiveDir + '/') || relFromRoot.startsWith(config.archiveDir + path.sep)) { die(`Already archived: ${toRepoPath(filePath, config.repoRoot)}`); }

  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter } = extractFrontmatter(raw);
  const parsed = parseSimpleFrontmatter(frontmatter);
  const oldStatus = asString(parsed.status) ?? 'unknown';

  const today = nowIso();
  const targetDir = path.join(archiveFileRoot, config.archiveDir);
  const targetPath = uniqueArchiveTarget(targetDir, path.basename(filePath));
  const oldRepoPath = toRepoPath(filePath, config.repoRoot);
  const newRepoPath = toRepoPath(targetPath, config.repoRoot);

  if (dryRun) {
    const prefix = dim('[dry-run]');
    out.write(`${prefix} Would update frontmatter: status: ${oldStatus} → archived, updated: ${today}\n`);
    out.write(`${prefix} Would move: ${oldRepoPath} → ${newRepoPath}\n`);
    if (config.indexPath) out.write(`${prefix} Would regenerate index\n`);

    // Preview reference updates
    const refCount = countRefsToUpdate(filePath, targetPath, config);
    if (refCount > 0) {
      out.write(`${prefix} Would update references in ${refCount} file(s)\n`);
    }
    return;
  }

  updateFrontmatter(filePath, { status: 'archived', updated: today });
  appendVersionHistory(filePath, 'Archived.');

  mkdirSync(targetDir, { recursive: true });

  const result = gitMv(filePath, targetPath, config.repoRoot);
  if (result.status !== 0) { die(result.stderr || 'git mv failed.'); }

  // Fix refs FROM the archived file (relative paths shifted by move)
  const selfRefsFixed = updateRefsFromMovedFile(filePath, targetPath, config);

  // Auto-update references in other docs
  const updatedRefCount = updateRefsAfterMove(filePath, targetPath, config);

  regenIndex(config);

  out.write(`${green('Archived')}: ${oldRepoPath} → ${newRepoPath}\n`);
  if (selfRefsFixed) out.write('Updated references in archived file.\n');
  if (updatedRefCount > 0) out.write(`Updated references in ${updatedRefCount} file(s).\n`);
  if (config.indexPath) out.write('Index regenerated.\n');

  try { releaseLease(config, oldRepoPath, { force: true }); } catch (err) { warn(`Could not release lease for ${oldRepoPath}: ${err.message}`); }

  try { config.hooks.onArchive?.({ path: newRepoPath, oldStatus }, { oldPath: oldRepoPath, newPath: newRepoPath }); } catch (err) { warn(`Hook 'onArchive' threw: ${err.message}`); }
}

export function runBulkArchive(argv, config, opts = {}) {
  const { dryRun } = opts;
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

  const unique = [...new Set(matched)].filter(f => {
    const root = findFileRoot(f, config);
    const rel = path.relative(root, f);
    return !rel.startsWith(config.archiveDir + '/') && !rel.startsWith(config.archiveDir + path.sep);
  });
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
  for (const f of unique) {
    const relPath = toRepoPath(f, config.repoRoot);
    try {
      runArchive([relPath], config, opts);
    } catch (err) {
      warn(`Failed to archive ${relPath}: ${err.message}`);
    }
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
  let updatedCount = 0;

  for (const docFile of allFiles) {
    if (docFile === newPath) continue;
    let raw = readFileSync(docFile, 'utf8');
    const { frontmatter: fm } = extractFrontmatter(raw);
    if (!fm || !fm.includes(basename)) continue;

    const docDir = path.dirname(docFile);
    const oldRelPath = path.relative(docDir, oldPath).split(path.sep).join('/');
    const newRelPath = path.relative(docDir, newPath).split(path.sep).join('/');

    let newFm = fm;

    // Replace exact relative path
    if (newFm.includes(oldRelPath)) {
      newFm = newFm.split(oldRelPath).join(newRelPath);
    }

    // Also handle ./ prefix variant
    const dotSlashOld = './' + oldRelPath;
    if (newFm.includes(dotSlashOld)) {
      newFm = newFm.split(dotSlashOld).join(newRelPath);
    }

    if (newFm !== fm) {
      raw = replaceFrontmatter(raw, newFm);
      writeFileSync(docFile, raw, 'utf8');
      updatedCount++;
    }
  }

  return updatedCount;
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
    const rebuilt = replaceFrontmatter(raw, newFm);
    // Replace body: rebuilt has updated frontmatter but old body
    const { frontmatter: updatedFm } = extractFrontmatter(rebuilt);
    writeFileSync(newPath, `---\n${updatedFm}\n---${newBody}`, 'utf8');
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
    const { frontmatter: fm } = extractFrontmatter(raw);
    if (!fm || !fm.includes(basename)) continue;

    const docDir = path.dirname(docFile);
    const oldRelPath = path.relative(docDir, oldPath).split(path.sep).join('/');
    if (fm.includes(oldRelPath) || fm.includes('./' + oldRelPath)) {
      count++;
    }
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
