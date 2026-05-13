import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter, replaceFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, die, warn, resolveDocPath, escapeRegex } from './util.mjs';
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
import { hasHandoff, consumeHandoff, appendHandoff, handoffPath, listQueuedHandoffs } from './handoff.mjs';

function findFileRoot(filePath, config) {
  const roots = config.docsRoots || [config.docsRoot];
  return roots.find(r => filePath.startsWith(r + '/')) ?? config.docsRoot;
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

  if (!effectiveValid.has(newStatus)) { die(`Invalid status: ${newStatus}\nValid: ${[...effectiveValid].join(', ')}`); }

  const oldStatus = asString(parsedFm.status);

  if (oldStatus === newStatus) {
    process.stdout.write(`${toRepoPath(filePath, config.repoRoot)}: already ${newStatus}, no changes made.\n`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
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
      const targetPath = path.join(archiveDir, path.basename(filePath));
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

  if (isArchiving) {
    mkdirSync(archiveDir, { recursive: true });
    const targetPath = path.join(archiveDir, path.basename(filePath));
    if (existsSync(targetPath)) { die(`Target already exists: ${toRepoPath(targetPath, config.repoRoot)}`); }
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

  if ((isArchiving || isUnarchiving) && config.indexPath) {
    const index = buildIndex(config);
    writeIndex(renderIndexFile(index, config), config);
  }

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
  let input = argv.find(a => !a.startsWith('-'));

  // Interactive: pick from active/planned plans + anything with a queued handoff
  if (!input) {
    if (!isInteractive()) die('Usage: dotmd pickup <file>');
    const index = buildIndex(config);
    const queued = new Set(listQueuedHandoffs(config).map(h => h.repoPath));
    const candidates = index.docs.filter(d =>
      d.type === 'plan' && (d.status === 'active' || d.status === 'planned' || queued.has(d.path))
    );
    if (candidates.length === 0) die('No active/planned plans and no queued handoffs.');
    candidates.sort((a, b) => Number(queued.has(b.path)) - Number(queued.has(a.path)));
    const labelFor = (d) => `${queued.has(d.path) ? '▶ handoff queued · ' : ''}${d.title} (${d.status}) — ${d.path}`;
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

  const handoffQueued = hasHandoff(config, repoPath);
  const pickupable = new Set(['active', 'planned', 'in-session']);
  if (oldStatus && !pickupable.has(oldStatus) && !handoffQueued) die(`Cannot pick up a plan with status '${oldStatus}'. Must be active or planned.\n  ${repoPath}`);

  const today = new Date().toISOString().slice(0, 10);
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
    }
  }

  let handoffBody = null;
  if (handoffQueued && !dryRun) {
    try { handoffBody = consumeHandoff(config, repoPath); } catch (err) { warn(`Could not consume handoff for ${repoPath}: ${err.message}`); }
  }

  if (json) {
    process.stdout.write(JSON.stringify({
      path: repoPath, oldStatus, newStatus: 'in-session', title,
      reattached: leaseOutcome === 'reattached',
      takenOver: leaseOutcome === 'taken-over',
      handoffConsumed: handoffBody !== null,
      body: (handoffBody ?? body)?.trim() ?? '',
    }, null, 2) + '\n');
  } else {
    if (leaseOutcome === 'reattached') {
      process.stderr.write(`${green('▶ Re-attached')}: ${repoPath}\n\n`);
    } else if (leaseOutcome === 'taken-over') {
      process.stderr.write(`${green('▶ Took over')}: ${repoPath} (was ${oldStatus ?? 'unset'} → in-session)\n\n`);
    } else {
      process.stderr.write(`${green('▶ Picked up')}: ${repoPath} (${oldStatus ?? 'unset'} → in-session)\n\n`);
    }
    const header = handoffBody
      ? `[dotmd] holding ${repoPath} — consumed handoff. Release with: dotmd release ${repoPath}\n---\n`
      : `[dotmd] holding ${repoPath} — release with: dotmd release ${repoPath}\n---\n`;
    process.stdout.write(header);
    const content = (handoffBody ?? body ?? '').trim();
    if (content) process.stdout.write(content + '\n');
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
        const today = new Date().toISOString().slice(0, 10);
        updateFrontmatter(filePath, { status: newStatus, updated: today });
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

  const today = new Date().toISOString().slice(0, 10);

  if (dryRun) {
    process.stderr.write(`${dim('[dry-run]')} Would update: status: in-session → ${targetStatus}, updated: ${today}\n`);
  } else {
    updateFrontmatter(filePath, { status: targetStatus, updated: today });
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
  const { dryRun } = opts;
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

  const today = new Date().toISOString().slice(0, 10);
  const targetDir = path.join(archiveFileRoot, config.archiveDir);
  const targetPath = path.join(targetDir, path.basename(filePath));
  const oldRepoPath = toRepoPath(filePath, config.repoRoot);
  const newRepoPath = toRepoPath(targetPath, config.repoRoot);

  if (dryRun) {
    const prefix = dim('[dry-run]');
    process.stdout.write(`${prefix} Would update frontmatter: status: ${oldStatus} → archived, updated: ${today}\n`);
    if (existsSync(targetPath)) { die(`Target already exists: ${toRepoPath(targetPath, config.repoRoot)}`); }
    process.stdout.write(`${prefix} Would move: ${oldRepoPath} → ${newRepoPath}\n`);
    if (config.indexPath) process.stdout.write(`${prefix} Would regenerate index\n`);

    // Preview reference updates
    const refCount = countRefsToUpdate(filePath, targetPath, config);
    if (refCount > 0) {
      process.stdout.write(`${prefix} Would update references in ${refCount} file(s)\n`);
    }
    return;
  }

  updateFrontmatter(filePath, { status: 'archived', updated: today });

  mkdirSync(targetDir, { recursive: true });
  if (existsSync(targetPath)) { die(`Target already exists: ${toRepoPath(targetPath, config.repoRoot)}`); }

  const result = gitMv(filePath, targetPath, config.repoRoot);
  if (result.status !== 0) { die(result.stderr || 'git mv failed.'); }

  // Fix refs FROM the archived file (relative paths shifted by move)
  const selfRefsFixed = updateRefsFromMovedFile(filePath, targetPath, config);

  // Auto-update references in other docs
  const updatedRefCount = updateRefsAfterMove(filePath, targetPath, config);

  if (config.indexPath) {
    const index = buildIndex(config);
    writeIndex(renderIndexFile(index, config), config);
  }

  process.stdout.write(`${green('Archived')}: ${oldRepoPath} → ${newRepoPath}\n`);
  if (selfRefsFixed) process.stdout.write('Updated references in archived file.\n');
  if (updatedRefCount > 0) process.stdout.write(`Updated references in ${updatedRefCount} file(s).\n`);
  if (config.indexPath) process.stdout.write('Index regenerated.\n');

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

  const today = new Date().toISOString().slice(0, 10);

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

  // Fix frontmatter ref fields (YAML list items like  - ./path.md)
  let newFm = frontmatter;
  const refRegex = /^(\s+-\s+)(\S+\.md)$/gm;
  newFm = newFm.replace(refRegex, (match, prefix, refPath) => {
    const absTarget = path.resolve(oldDir, refPath);
    if (!existsSync(absTarget)) return match;
    const newRelPath = path.relative(newDir, absTarget).split(path.sep).join('/');
    return `${prefix}${newRelPath}`;
  });

  // Fix body markdown links [text](path.md)
  let newBody = body;
  const linkRegex = /(\[[^\]]*\]\()([^)]+\.md)(\))/g;
  newBody = newBody.replace(linkRegex, (match, pre, href, post) => {
    if (href.startsWith('http')) return match;
    const absTarget = path.resolve(oldDir, href);
    if (!existsSync(absTarget)) return match;
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

function readHandoffInput(source) {
  if (source === '-') {
    const chunks = [];
    try { chunks.push(readFileSync(0, 'utf8')); } catch (err) { die(`Could not read handoff from stdin: ${err.message}`); }
    return chunks.join('');
  }
  if (typeof source === 'string' && source.startsWith('@')) {
    const file = source.slice(1);
    if (!existsSync(file)) die(`Handoff file not found: ${file}`);
    return readFileSync(file, 'utf8');
  }
  return source;
}

export async function runHandoff(argv, config, opts = {}) {
  const { dryRun } = opts;
  const json = argv.includes('--json');
  const replace = argv.includes('--replace');
  const messageIdx = argv.indexOf('--message');
  const messageFlag = messageIdx >= 0 ? argv[messageIdx + 1] : null;
  const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--message');

  let input = positional[0];
  let text = messageFlag !== null ? messageFlag : positional[1];

  // Interactive: pick from in-session plans owned by current session
  if (!input) {
    if (!isInteractive()) die('Usage: dotmd handoff <file> [text | - | @path]   (or --message "text")');
    const leases = readLeases(config);
    const session = currentSessionId();
    const owned = Object.values(leases).filter(l => l.session === session);
    if (owned.length === 0) die('No in-session plans owned by this session.');
    if (owned.length === 1) {
      input = owned[0].path;
      process.stderr.write(`${dim(`Auto-selected: ${input}`)}\n`);
    } else {
      const choice = await promptChoice('Handoff which plan:', owned.map(l => l.path));
      if (!choice) die('No plan selected.');
      input = choice;
    }
  }

  const filePath = resolveDocPath(input, config);
  if (!filePath) die(`File not found: ${input}`);
  const repoPath = toRepoPath(filePath, config.repoRoot);

  // Resolve text: explicit arg/stdin/@file, else die (no $EDITOR fallback — sessions are non-interactive)
  if (text === undefined || text === null) {
    die('Missing handoff text. Pass inline, --message "text", - for stdin, or @path for a file.');
  }
  const body = readHandoffInput(text);
  if (!body.trim()) die('Handoff text is empty.');

  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter: fmRaw } = extractFrontmatter(raw);
  const parsedFm = parseSimpleFrontmatter(fmRaw);
  const oldStatus = asString(parsedFm.status);

  // Must be holding this plan in current session
  const leases = readLeases(config);
  const lease = leases[repoPath];
  const session = currentSessionId();
  if (!lease || lease.session !== session) {
    die(`Not held by this session: ${repoPath}\n  Run \`dotmd pickup ${repoPath}\` first.`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const targetStatus = lease.oldStatus || 'active';

  if (dryRun) {
    process.stderr.write(`${dim('[dry-run]')} Would ${replace ? 'replace' : 'append to'} ${toRepoPath(handoffPath(config, repoPath), config.repoRoot)}\n`);
    process.stderr.write(`${dim('[dry-run]')} Would release lease and flip status: in-session → ${targetStatus}\n`);
    if (json) process.stdout.write(JSON.stringify({ path: repoPath, handoff: toRepoPath(handoffPath(config, repoPath), config.repoRoot), bytes: body.length, replace, dryRun: true }, null, 2) + '\n');
    return;
  }

  // Order: write handoff first, then release. A crash between leaves a queued
  // handoff with a held lease (recoverable) instead of a released lease with
  // no handoff (silently lost).
  const written = appendHandoff(config, repoPath, body, { replace });

  if (oldStatus === 'in-session') {
    updateFrontmatter(filePath, { status: targetStatus, updated: today });
  }
  releaseLease(config, repoPath, { force: true });

  if (json) {
    process.stdout.write(JSON.stringify({
      path: repoPath,
      handoff: toRepoPath(written, config.repoRoot),
      bytes: body.length,
      replace,
      newStatus: targetStatus,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(`${green('▶ Handoff queued')}: ${toRepoPath(written, config.repoRoot)} (${body.length} bytes${replace ? ', replaced' : ', appended'})\n`);
    process.stdout.write(`${green('↩ Released')}: ${repoPath} (in-session → ${targetStatus})\n`);
  }

  try { config.hooks.onUnpickup?.({ path: repoPath, oldStatus: 'in-session', newStatus: targetStatus }); } catch (err) { warn(`Hook 'onUnpickup' threw: ${err.message}`); }
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
