import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter, normalizeEol } from './frontmatter.mjs';
import { asString, toRepoPath, die, warn, resolveDocPath, escapeRegex, nowIso, suggestCandidates, emitFilesFooter, isArchivedPath, currentSessionId } from './util.mjs';
import { readJournalEntries } from './journal.mjs';
import { captureGitIndexGeneration, getGitLastModifiedBatch, isTracked } from './git.mjs';
import { buildIndex, collectDocFiles, resolveDocArg } from './index.mjs';
import { writeRenderedIndex } from './index-file.mjs';
import { green, dim } from './color.mjs';
import { isInteractive, promptChoice } from './prompt.mjs';
import { buildCard, renderCard } from './pickup-card.mjs';
import { walkSections, findSection } from './section.mjs';
import { authorizeManagedDestination, authorizeManagedSource, authorizeManagedSweep } from './managed-path.mjs';
import { withPathLocks, snapshotFile, replaceSnapshot, moveFileAtomic, mutateFile, mutateFileSet } from './atomic-mutation.mjs';
import { configuredReferenceFields, createReferenceIdentitySet, rewriteDocumentReferences } from './reference-planner.mjs';
import {
  assertPlanMutationAuthorized,
  assertHookDeliveryTakeoverSafe,
  abandonClaimHookDelivery,
  authoritativeSessionId,
  availableSessionId,
  beginClaimHookDelivery,
  classifyPlanPickup,
  commitPlanClaim,
  finishClaimHookDelivery,
  listOwnedPlans,
  pickupFactsForDoc,
  prepareOwnershipRelease,
  readPlanOwnership,
  skipClaimHookDelivery,
  updateOwnershipOperation,
  validatedClaimOperation,
} from './pickup.mjs';

export function renderLifecycleMutation(raw, updates, historyEntry, { createSection = false, bodyTransform = null } = {}) {
  raw = normalizeEol(raw);
  if (!raw.startsWith('---\n')) throw new Error('Document has no frontmatter block. Retrofit it with `dotmd bulk-tag` first.');
  const endMarker = raw.indexOf('\n---\n', 4);
  if (endMarker === -1) throw new Error('Document has an unclosed frontmatter block.');
  let frontmatter = raw.slice(4, endMarker);
  let body = raw.slice(endMarker + 5);
  if (bodyTransform) body = bodyTransform(body);
  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${escapeRegex(key)}:.*$`, 'm');
    frontmatter = regex.test(frontmatter)
      ? frontmatter.replace(regex, `${key}: ${value}`)
      : `${frontmatter}\n${key}: ${value}`;
  }
  if (historyEntry) {
    const bullet = `- **${updates.updated ?? nowIso()}** ${historyEntry}`;
    const vh = findSection(walkSections(body), 'Version History');
    if (vh) {
      const lines = body.split('\n');
      let insertAt = vh.lineStart;
      while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
      lines.splice(insertAt, 0, bullet, ...(insertAt >= lines.length || lines[insertAt]?.startsWith('#') ? [''] : []));
      body = lines.join('\n');
    } else if (createSection) {
      body = `${body.replace(/\n+$/, '')}\n\n## Version History\n\n${bullet}\n`;
    }
  }
  return `---\n${frontmatter}\n---\n${body}`;
}

function commitLifecycleMutation(filePath, targetPath, config, updates, historyForOldStatus, options = {}) {
  const render = sourceContent => {
    const currentFm = parseSimpleFrontmatter(extractFrontmatter(sourceContent).frontmatter);
    const currentOldStatus = asString(currentFm.status) ?? 'unknown';
    let content = renderLifecycleMutation(sourceContent, updates, historyForOldStatus(currentOldStatus), options);
    const beforeSelfRefs = content;
    if (targetPath) content = renderMovedFileRefs(content, filePath, targetPath, config);
    return {
      oldStatus: currentOldStatus,
      content,
      selfRefsFixed: content !== beforeSelfRefs,
    };
  };
  if (targetPath) {
    let result;
    const tracked = isTracked(filePath, config.repoRoot);
    const gitIndex = tracked ? captureGitIndexGeneration(config.repoRoot) : null;
    const companionPaths = new Set((options.additionalUpdates ?? []).map(item => path.resolve(item.path)));
    const allFiles = collectDocFiles(config).filter(candidate => candidate !== filePath && candidate !== targetPath && !companionPaths.has(path.resolve(candidate)));
    authorizeManagedSweep(allFiles, config, { kind: 'Reference rewrite source' });
    const identities = createReferenceIdentitySet([filePath, ...allFiles]);
    const referenceFields = configuredReferenceFields(config);
    const moveResult = moveFileAtomic(filePath, targetPath, sourceContent => {
      result = render(sourceContent);
      return result.content;
    }, {
      repoRoot: config.repoRoot,
      config,
      updates: [...allFiles.map(docFile => ({
        path: docFile,
        render: raw => rewriteDocumentReferences(raw, {
          sourcePath: docFile, repoRoot: config.repoRoot, identities, oldPath: filePath, newPath: targetPath, referenceFields,
        }),
      })), ...(options.additionalUpdates ?? []).map(item => ({
        ...item,
        content: item.content === undefined ? undefined : rewriteDocumentReferences(item.content, {
          sourcePath: item.path, repoRoot: config.repoRoot, identities, oldPath: filePath, newPath: targetPath, referenceFields,
        }),
      }))],
      creations: options.creations ?? [],
      gitMove: tracked,
      gitIndex,
      operation: 'lifecycle-move',
      sessionId: availableSessionId(),
      testHooks: options.testHooks,
    });
    return { ...result, sourceContent: moveResult.source.content, updatedPaths: moveResult.updatedPaths };
  }
  if ((options.additionalUpdates?.length ?? 0) > 0 || (options.creations?.length ?? 0) > 0) {
    const sourceContent = readFileSync(filePath, 'utf8');
    const result = render(sourceContent);
    mutateFileSet({
      updates: [{ path: filePath, expectedContent: sourceContent, content: result.content }, ...(options.additionalUpdates ?? [])],
      creations: options.creations ?? [],
    }, { repoRoot: config.repoRoot, testHooks: options.testHooks });
    return { ...result, sourceContent, updatedPaths: [] };
  }
  return withPathLocks([filePath], { repoRoot: config.repoRoot }, () => {
    const sourceSnapshot = snapshotFile(filePath);
    const result = render(sourceSnapshot.content);
    replaceSnapshot(sourceSnapshot, result.content, { repoRoot: config.repoRoot, locked: true });
    return { ...result, sourceContent: sourceSnapshot.content, updatedPaths: [] };
  });
}

export function updateFrontmatterAtomic(filePath, updates, config, options = {}) {
  return mutateFile(filePath, { repoRoot: config.repoRoot }, raw => {
    if (options.expected) {
      const current = parseSimpleFrontmatter(extractFrontmatter(raw).frontmatter);
      for (const [key, value] of Object.entries(options.expected)) {
        if (asString(current[key]) !== value) throw new Error(`${key} changed while the mutation was being prepared.`);
      }
    }
    return renderLifecycleMutation(raw, updates, null);
  });
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
export function regenIndex(config, options = {}) {
  if (!config.indexPath) return false;
  try {
    // Fast path: skip validation/git-staleness/ref-checking — the rendered
    // index file only consumes status/title/snapshot/etc. Validation runs on
    // explicit `dotmd check` / `dotmd index`. This keeps lifecycle commands
    // snappy on repos with huge git history or heavy `validate` hooks.
    options.testHooks?.beforeClaimIndex?.();
    writeRenderedIndex(() => buildIndex(config, { fast: true }), config, { testHooks: options.testHooks });
    return true;
  } catch (err) {
    if (options.throwOnError) throw err;
    warn(`Could not regenerate index (run \`dotmd index\`): ${err.message}`);
    return false;
  }
}

function reconcileClaimOperation(repoPath, config, opts = {}) {
  let current = validatedClaimOperation(repoPath, config);
  if (!current) return { indexRegenerated: false, ownershipChanged: false, hook: 'none', pending: false };
  let indexRegenerated = false;
  let ownershipChanged = false;
  const binding = current.binding;
  if (current.operation.index === 'pending') {
    regenIndex(config, { throwOnError: true, testHooks: opts.testHooks });
    indexRegenerated = true;
    updateOwnershipOperation(repoPath, config, binding, op => { op.index = 'done'; });
    ownershipChanged = true;
    current = validatedClaimOperation(repoPath, config, binding);
    if (!current) throw new Error(`Claim completion was superseded for ${repoPath}.`);
  }
  if (['pending', 'delivering'].includes(current.operation.hook)) {
    if (current.operation.hook === 'pending' && !config.hooks.onPickup) {
      updateOwnershipOperation(repoPath, config, binding, op => {
        op.hook = 'skipped';
        delete op.hookDeliveryToken;
        delete op.hookDeliveryStartedAt;
        delete op.hookDeliveryOwner;
      });
      return { indexRegenerated, ownershipChanged: true, hook: 'skipped', pending: false };
    }
    // Durable outbox contract: retries reuse operationId until the hook returns.
    // Hooks that perform external side effects must deduplicate by operationId.
    // No local protocol can distinguish a crash after the external side effect
    // from a crash before the completion marker is persisted.
    opts.testHooks?.beforeClaimHookInvoke?.({ repoPath, binding });
    const lease = beginClaimHookDelivery(repoPath, config, binding, {
      now: opts.hookLeaseNow,
      leaseMs: opts.hookLeaseMs,
      ownerLiveness: opts.hookOwnerLiveness,
    });
    if (!lease) return { indexRegenerated, ownershipChanged, hook: current.operation.hook, pending: true };
    if (lease.busy) throw new Error(`Claim hook delivery is already in progress for ${repoPath}.`);
    if (!config.hooks.onPickup) {
      skipClaimHookDelivery(repoPath, config, binding, lease.token);
      return { indexRegenerated, ownershipChanged: true, hook: 'skipped', pending: false };
    }
    try {
      const operation = lease.operation;
      const event = { path: repoPath, oldStatus: operation.oldStatus, newStatus: 'in-session', operationId: operation.id };
      config.hooks.onPickup(event);
    } catch (err) {
      abandonClaimHookDelivery(repoPath, config, binding, lease.token);
      throw err;
    }
    finishClaimHookDelivery(repoPath, config, binding, lease.token);
    ownershipChanged = true;
  }
  const after = validatedClaimOperation(repoPath, config, binding);
  return { indexRegenerated, ownershipChanged, hook: after?.operation?.hook ?? 'done', pending: Boolean(after && (after.operation.index === 'pending' || ['pending', 'delivering'].includes(after.operation.hook))) };
}

export function completePlanClaim(repoPath, config, opts = {}) {
  const current = validatedClaimOperation(repoPath, config);
  let skipped = false;
  if (opts.noIndex && current) {
    updateOwnershipOperation(repoPath, config, current.binding, op => { op.index = 'skipped'; });
    skipped = true;
  }
  const result = reconcileClaimOperation(repoPath, config, opts);
  if (skipped) result.ownershipChanged = true;
  return result;
}

export function ensurePlanCompletionBeforeRelease(repoPath, config, opts = {}) {
  const before = validatedClaimOperation(repoPath, config);
  if (!before) return;
  reconcileClaimOperation(repoPath, config, opts);
  const after = validatedClaimOperation(repoPath, config, before.binding);
  if (after && (after.operation.index === 'pending' || ['pending', 'delivering'].includes(after.operation.hook))) {
    throw new Error(`Cannot release ${repoPath}; claim completion is still pending.`);
  }
}

export function planHasPendingCompletion(repoPath, config) {
  const current = validatedClaimOperation(repoPath, config);
  return Boolean(current && (current.operation.index === 'pending' || ['pending', 'delivering'].includes(current.operation.hook)));
}

export function pickupCandidates(index, config, sessionId) {
  return index.docs.filter(doc => pickupFactsForDoc(doc, config, { sessionId }).pickupable);
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
  let note = opts.note ?? null;
  const noteIdx = argv.indexOf('--note');
  if (noteIdx !== -1) {
    note = note ?? argv[noteIdx + 1] ?? null;
    if (!note || note.startsWith('--')) die('--note requires a value: --note "what changed and why"');
    argv = argv.filter((_, i) => i !== noteIdx && i !== noteIdx + 1);
  }
  const input = argv[0];
  let newStatus = argv[1];

  if (!opts.suppressDeprecation) {
    process.stderr.write(dim('`dotmd status <file> <status>` is deprecated; prefer `dotmd set <status> [<file>]` (note: <status> first; <file> optional when a plan is in-session). Removed in a future major.\n'));
  }

  if (!input) { die('Usage: dotmd status <file> <new-status>'); }

  let filePath = resolveDocArg(input, config);
  const sourceAuthorization = authorizeManagedSource(filePath, config, { kind: 'Status source' });
  filePath = sourceAuthorization.path;

  // Determine type-specific or root-specific valid statuses
  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter: fmRaw } = extractFrontmatter(raw);
  const parsedFm = parseSimpleFrontmatter(fmRaw);
  const docType = asString(parsedFm.type) ?? null;
  const fileRoot = sourceAuthorization.root.lexicalPath;
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

  if (!opts.suppressDeprecation) {
    const delegated = [newStatus, input];
    if (note) delegated.push('--note', note);
    if (noIndex) delegated.push('--no-index');
    if (showFiles) delegated.push('--show-files');
    if (argv.includes('--force')) delegated.push('--force');
    return runSet(delegated, config, { ...opts, suppressDeprecation: true });
  }

  const oldStatus = asString(parsedFm.status);

  if (oldStatus === newStatus) {
    if (!dryRun && (opts.additionalUpdates?.length || opts.creations?.length)) {
      mutateFileSet({ updates: opts.additionalUpdates ?? [], creations: opts.creations ?? [] }, {
        repoRoot: config.repoRoot,
        testHooks: opts.testHooks,
      });
    }
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
  const authorizeTarget = targetPath => authorizeManagedDestination(targetPath, config, {
    root: sourceAuthorization.root,
    kind: 'Status move destination',
  }).path;
  let targetDir = null;
  let targetPath = null;
  if (isArchiving) {
    targetDir = archiveDir;
    targetPath = authorizeTarget(uniqueArchiveTarget(targetDir, path.basename(filePath)));
  } else if (isUnarchiving) {
    targetPath = authorizeTarget(path.join(archiveBase, path.basename(filePath)));
  } else if (isFiling) {
    targetDir = path.join(filingRoot, newFiledDir);
    targetPath = authorizeTarget(path.join(targetDir, path.basename(filePath)));
  } else if (isUnfiling) {
    targetPath = authorizeTarget(path.join(filingRoot, path.basename(filePath)));
  }
  if (targetPath && !isArchiving && existsSync(targetPath)) {
    die(`Target already exists: ${toRepoPath(targetPath, config.repoRoot)}`);
  }
  let finalPath = targetPath ?? filePath;

  if (dryRun) {
    const prefix = dim('[dry-run]');
    process.stdout.write(`${prefix} Would update frontmatter: status: ${oldStatus ?? 'unknown'} → ${newStatus}, updated: ${today}\n`);
    if (isArchiving) {
      process.stdout.write(`${prefix} Would move: ${toRepoPath(filePath, config.repoRoot)} → ${toRepoPath(targetPath, config.repoRoot)}\n`);
    }
    if (isUnarchiving) {
      process.stdout.write(`${prefix} Would move: ${toRepoPath(filePath, config.repoRoot)} → ${toRepoPath(targetPath, config.repoRoot)}\n`);
    }
    if (isFiling) {
      process.stdout.write(`${prefix} Would file: ${toRepoPath(filePath, config.repoRoot)} → ${toRepoPath(targetPath, config.repoRoot)}\n`);
    }
    if (isUnfiling) {
      process.stdout.write(`${prefix} Would unfile: ${toRepoPath(filePath, config.repoRoot)} → ${toRepoPath(targetPath, config.repoRoot)}\n`);
    }
    if (finalPath !== filePath) {
      const refCount = countRefsToUpdate(filePath, finalPath, config);
      if (refCount > 0) process.stdout.write(`${prefix} Would update references in ${refCount} file(s)\n`);
    }
    if ((isArchiving || isUnarchiving || isFiling || isUnfiling) && config.indexPath) {
      process.stdout.write(`${prefix} Would regenerate index\n`);
    }
    if (note) {
      process.stdout.write(`${prefix} Would append Version History: - **${today}** Status: ${oldStatus ?? 'unknown'} → ${newStatus} — ${note}\n`);
    }
    process.stdout.write(`${prefix} ${toRepoPath(finalPath, config.repoRoot)}: ${oldStatus ?? 'unknown'} → ${newStatus}\n`);
    return;
  }

  const mutationResult = commitLifecycleMutation(filePath, targetPath, config, { status: newStatus, updated: today }, currentOld => {
    const currentTransition = `Status: ${currentOld} → ${newStatus}`;
    return note ? `${currentTransition} — ${note}` : `${currentTransition}.`;
  }, {
    createSection: Boolean(note),
    additionalUpdates: opts.additionalUpdates,
    creations: opts.creations,
    testHooks: opts.testHooks,
  });

  // Any of the four moves above shifts the file's directory, which breaks
  // relative refs in both directions — links FROM the moved file and inbound
  // refs TO it from other docs. runArchive repairs both; mirror that here so
  // the deprecated `dotmd status <file> archived` path and the `dotmd set`
  // unarchive/file/unfile transitions (which route through runStatus, not
  // runArchive) don't silently leave dangling links.
  const selfRefsFixed = Boolean(mutationResult.selfRefsFixed);
  const inboundRefPaths = mutationResult.updatedPaths ?? [];
  const inboundRefCount = inboundRefPaths.length;

  // Regen the index on every status change — `active → planned` etc. drift
  // the per-status sections just as much as archive crossings. Archive paths
  // also benefit (replaces the previously-gated regen). `--no-index` skips
  // this so concurrent agents can do path-limited commits without pulling
  // each other's uncommitted index changes into the staging area.
  if (noIndex) {
    process.stderr.write(dim('(index not regenerated — run `dotmd index` to refresh)\n'));
  } else if (!opts.deferIndex) {
    regenIndex(config);
  }

  process.stdout.write(`${green(toRepoPath(finalPath, config.repoRoot))}: ${oldStatus ?? 'unknown'} → ${newStatus}\n`);
  if (selfRefsFixed) process.stdout.write('Updated references in moved file.\n');
  if (inboundRefCount > 0) process.stdout.write(`Updated references in ${inboundRefCount} file(s).\n`);

  if (showFiles) {
    const touched = [filePath];
    if (finalPath !== filePath) touched.push(finalPath);
    touched.push(...inboundRefPaths);
    if (config.indexPath && !noIndex && !opts.deferIndex) touched.push(config.indexPath);
    emitFilesFooter(touched, config);
  }

  try { config.hooks.onStatusChange?.({ path: toRepoPath(finalPath, config.repoRoot), oldStatus, newStatus }, {
    oldPath: toRepoPath(filePath, config.repoRoot),
    newPath: toRepoPath(finalPath, config.repoRoot),
  }); } catch (err) { warn(`Hook 'onStatusChange' threw: ${err.message}`); }
  return {
    action: 'status-changed',
    oldRepoPath: toRepoPath(filePath, config.repoRoot),
    newRepoPath: toRepoPath(finalPath, config.repoRoot),
    touched: [toRepoPath(filePath, config.repoRoot), ...(finalPath !== filePath ? [toRepoPath(finalPath, config.repoRoot)] : []), ...inboundRefPaths.map(item => toRepoPath(item, config.repoRoot))],
  };
}

// Atomically claim a plan for this session, then reconcile its generated index
// and pickup hook before printing the card. Backs direct use and next selectors.
export async function startPlan(argv, config, opts = {}) {
  const { dryRun } = opts;
  const json = argv.includes('--json');
  const fullBody = argv.includes('--full');
  const noIndex = argv.includes('--no-index') || opts.noIndex;
  const showFiles = argv.includes('--show-files') || opts.showFiles;
  const force = argv.includes('--force') || opts.force;
  let input = argv.find(a => !a.startsWith('-'));

  // Interactive: pick from active/planned plans
  if (!input) {
    if (!isInteractive()) die('Usage: dotmd use <plan>');
    const index = buildIndex(config);
    const sessionId = authoritativeSessionId();
    const candidates = pickupCandidates(index, config, sessionId);
    if (candidates.length === 0) die('No pickup-able plans.');
    const labelFor = (d) => `${d.title} (${d.status}) — ${d.path}`;
    const choice = await promptChoice('Pick a plan:', candidates.map(labelFor));
    if (!choice) die('No plan selected.');
    const idx = candidates.findIndex(d => choice === labelFor(d));
    if (idx === -1) die('No plan selected.');
    input = candidates[idx].path;
  }

  let filePath = resolveDocArg(input, config);
  filePath = authorizeManagedSource(filePath, config, { kind: 'Plan start source' }).path;

  const raw = readFileSync(filePath, 'utf8');
  let fmRaw, body, parsedFm;
  try {
    ({ frontmatter: fmRaw, body } = extractFrontmatter(raw));
    if (!fmRaw) throw new Error('missing frontmatter');
    parsedFm = parseSimpleFrontmatter(fmRaw);
  } catch {
    die(`Malformed plan document: ${toRepoPath(filePath, config.repoRoot)}`);
  }
  const docType = asString(parsedFm.type) ?? null;
  const oldStatus = asString(parsedFm.status);
  const title = asString(parsedFm.title) ?? path.basename(filePath, '.md');
  const repoPath = toRepoPath(filePath, config.repoRoot);

  const sessionId = dryRun ? (availableSessionId() ?? '__dry-run-no-session__') : authoritativeSessionId();
  const ownership = readPlanOwnership(repoPath, config);
  if (force) assertHookDeliveryTakeoverSafe(ownership, {
    now: opts.hookLeaseNow,
    leaseMs: opts.hookLeaseMs,
    ownerLiveness: opts.hookOwnerLiveness,
  });
  let disposition = classifyPlanPickup({
    type: docType,
    status: oldStatus,
    validStatuses: config.typeStatuses?.get('plan') ?? config.validStatuses,
    startableStatuses: config.lifecycle.startableStatuses,
    terminalStatuses: config.lifecycle.terminalStatuses,
    archiveStatuses: config.lifecycle.archiveStatuses,
    physicallyArchived: isArchivedPath(repoPath, config),
    ownership,
    sessionId,
    malformed: false,
  });
  if (force && ['busy', 'ownership-corrupt'].includes(disposition.kind)) {
    disposition = classifyPlanPickup({
      type: docType, status: oldStatus,
      validStatuses: config.typeStatuses?.get('plan') ?? config.validStatuses,
      startableStatuses: config.lifecycle.startableStatuses,
      terminalStatuses: config.lifecycle.terminalStatuses,
      archiveStatuses: config.lifecycle.archiveStatuses,
      physicallyArchived: isArchivedPath(repoPath, config), ownership: null, sessionId, malformed: false,
    });
  }
  if (!disposition.pickupable) {
    const detail = disposition.kind === 'busy' ? ` (owned by ${disposition.owner})` : '';
    die(`Plan cannot be picked up: ${disposition.kind}${detail}\n  ${repoPath}`);
  }
  const today = nowIso();
  if (dryRun) {
    if (disposition.kind === 'resume') {
      process.stderr.write(`${dim('[dry-run]')} Already in-session: ${repoPath}\n`);
    } else if (disposition.kind === 'adopt') {
      process.stderr.write(`${dim('[dry-run]')} Would adopt unowned in-session plan: ${repoPath}\n`);
    } else {
      process.stderr.write(`${dim('[dry-run]')} Would update: status: ${oldStatus} → in-session, updated: ${today}\n`);
    }
  } else if (disposition.kind !== 'resume') {
    const history = opts.note
      ? `Started (${oldStatus} → in-session) — ${opts.note}`
      : `Started (${oldStatus} → in-session).`;
    const rendered = disposition.kind === 'start'
      ? renderLifecycleMutation(raw, { status: 'in-session', updated: today }, history, { createSection: true })
      : null;
    commitPlanClaim({ filePath, repoPath, sourceContent: raw, renderedContent: rendered,
      ownership, sessionId, now: today, config, testHooks: opts.testHooks });
  }

  if (!dryRun) {
    if (noIndex) {
      const current = validatedClaimOperation(repoPath, config);
      if (current) updateOwnershipOperation(repoPath, config, current.binding, op => { op.index = 'skipped'; });
    }
    reconcileClaimOperation(repoPath, config, { ...opts, oldStatus });
  }

  if (opts.quiet) {
    // Prompt consume owns the user-facing output; the transition is identical.
  } else if (json) {
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

  if (showFiles && disposition.kind === 'start') {
    const touched = [filePath];
    if (config.indexPath && !noIndex && !opts.deferIndex) touched.push(config.indexPath);
    emitFilesFooter(touched, config);
  }

  return { path: repoPath, oldStatus, disposition: disposition.kind };
}

export function runArchive(argv, config, opts = {}) {
  const { dryRun, out = process.stdout } = opts;
  const force = argv.includes('--force') || opts.force;
  const noIndex = argv.includes('--no-index') || opts.noIndex;
  const showFiles = argv.includes('--show-files') || opts.showFiles;
  const closeoutTemplate = argv.includes('--closeout-template');
  argv = argv.filter(a => a !== '--no-index' && a !== '--show-files' && a !== '--closeout-template' && a !== '--force');
  let note = opts.note ?? null;
  const noteIdx = argv.indexOf('--note');
  if (noteIdx !== -1) {
    note = note ?? argv[noteIdx + 1] ?? null;
    if (!note || note.startsWith('--')) die('--note requires a value: --note "what shipped / why closed"');
    argv = argv.filter((_, i) => i !== noteIdx && i !== noteIdx + 1);
  }
  const input = argv[0];

  if (!input) { die('Usage: dotmd archive <file>'); }

  let filePath = resolveDocArg(input, config);
  const sourceAuthorization = authorizeManagedSource(filePath, config, { kind: 'Archive source' });
  filePath = sourceAuthorization.path;

  const archiveFileRoot = sourceAuthorization.root.lexicalPath;
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
  const archiveRepoPath = toRepoPath(filePath, config.repoRoot);
  const archiveOwnership = asString(parsed.type) === 'plan' ? readPlanOwnership(archiveRepoPath, config) : null;
  const releasingOwnership = asString(parsed.type) === 'plan'
    && (oldStatus === 'in-session' || archiveOwnership?.state === 'owned' || archiveOwnership?.corrupt);
  const releaseSessionId = releasingOwnership ? authoritativeSessionId() : null;
  if (releasingOwnership) assertPlanMutationAuthorized(archiveRepoPath, config, { sessionId: releaseSessionId, force });
  if (releasingOwnership && !dryRun) ensurePlanCompletionBeforeRelease(archiveRepoPath, config, { testHooks: opts.testHooks });
  if (releasingOwnership && dryRun && planHasPendingCompletion(archiveRepoPath, config)) {
    out.write(`${dim('[dry-run]')} Pending claim completion would block this release.\n`);
  }
  const releaseUpdate = releasingOwnership
    ? prepareOwnershipRelease(archiveRepoPath, config, { sessionId: releaseSessionId, force })
    : null;

  // Preserve a configured custom archive status (e.g. `done` with archive:true)
  // when one is threaded through from `dotmd set <archive-status>`. Fall back to
  // the canonical `archived`, or — if the config has no `archived` at all — its
  // first declared archive status, so we never write a status the config can't
  // validate.
  const archiveStatuses = config.lifecycle.archiveStatuses;
  const defaultArchiveStatus = archiveStatuses.has('archived')
    ? 'archived'
    : (archiveStatuses.values().next().value ?? 'archived');
  const targetStatus = opts.archiveStatus ?? defaultArchiveStatus;

  // Heal stuck frontmatter (issue #13): file is under archiveDir/ but its
  // status hasn't been flipped. Flip in place; don't try to move (it's already
  // archived on disk) and don't refuse — refusal leaves the drift permanent.
  if (inArchiveDir) {
    if (oldStatus === targetStatus) {
      die(`Already archived: ${toRepoPath(filePath, config.repoRoot)}`);
    }
    const today = nowIso();
    const repoPathHeal = toRepoPath(filePath, config.repoRoot);
    if (dryRun) {
      const prefix = dim('[dry-run]');
      out.write(`${prefix} Would heal frontmatter in place: status: ${oldStatus} → ${targetStatus}, updated: ${today}\n`);
      out.write(`${prefix} Would skip git mv (file already under \`${config.archiveDir}/\`)\n`);
      return;
    }
    commitLifecycleMutation(filePath, null, config, { status: targetStatus, updated: today },
      currentOld => `Archived (frontmatter healed in place from \`${currentOld}\`)${note ? ` — ${note}` : '.'}`,
      {
        createSection: Boolean(note),
        additionalUpdates: [...(opts.additionalUpdates ?? []), ...(releaseUpdate ? [releaseUpdate] : [])],
        creations: opts.creations,
        testHooks: opts.testHooks,
      });
    if (!noIndex && !opts.deferIndex) regenIndex(config);
    out.write(`${green('✓ Healed')}: ${repoPathHeal} (${oldStatus} → ${targetStatus}; file already under \`${config.archiveDir}/\`)\n`);
    const touched = [repoPathHeal];
    if (config.indexPath && !noIndex && !opts.deferIndex) touched.push(config.indexPath);
    if (showFiles) emitFilesFooter(touched, config);
    return {
      action: 'healed',
      oldRepoPath: repoPathHeal,
      newRepoPath: repoPathHeal,
      touched,
    };
  }

  const closeoutAction = closeoutTemplate ? planCloseoutInjection(body) : null;
  let committedCloseoutAction = closeoutAction;

  const today = nowIso();
  // Type-aware: prompts archive under docs/prompts/archived/ by default (see
  // archiveBaseFor); plans/docs keep the shared <root>/archived/.
  const targetDir = path.join(archiveBaseFor(filePath, archiveFileRoot, asString(parsed.type), config), config.archiveDir);
  const targetPath = authorizeManagedDestination(uniqueArchiveTarget(targetDir, path.basename(filePath)), config, {
    root: sourceAuthorization.root,
    kind: 'Archive destination',
  }).path;
  const oldRepoPath = toRepoPath(filePath, config.repoRoot);
  const newRepoPath = toRepoPath(targetPath, config.repoRoot);

  if (dryRun) {
    const prefix = dim('[dry-run]');
    if (closeoutAction?.action === 'inject') {
      out.write(`${prefix} Would inject \`## Closeout\` template (${closeoutAction.placement})\n`);
    } else if (closeoutAction?.action === 'skip') {
      out.write(`${prefix} \`## Closeout\` section already present — no injection\n`);
    }
    out.write(`${prefix} Would update frontmatter: status: ${oldStatus} → ${targetStatus}, updated: ${today}\n`);
    if (note) {
      out.write(`${prefix} Would append Version History: - **${today}** Archived — ${note}\n`);
    }
    out.write(`${prefix} Would move: ${oldRepoPath} → ${newRepoPath}\n`);
    if (config.indexPath && !noIndex && !opts.deferIndex) out.write(`${prefix} Would regenerate index\n`);
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

  const mutationResult = commitLifecycleMutation(filePath, targetPath, config, { status: targetStatus, updated: today },
    () => note ? `Archived — ${note}` : 'Archived.', {
      createSection: Boolean(note),
      testHooks: opts.testHooks,
      additionalUpdates: [...(opts.additionalUpdates ?? []), ...(releaseUpdate ? [releaseUpdate] : [])],
      creations: opts.creations,
      bodyTransform: closeoutTemplate ? currentBody => {
        committedCloseoutAction = planCloseoutInjection(currentBody);
        return committedCloseoutAction.action === 'inject' ? committedCloseoutAction.newBody : currentBody;
      } : null,
    });

  const selfRefsFixed = mutationResult.selfRefsFixed;
  const refTouchedPaths = mutationResult.updatedPaths;
  const updatedRefCount = refTouchedPaths.length;

  const indexRegenerated = !noIndex && !opts.deferIndex ? regenIndex(config) : false;

  out.write(`${green('Archived')}: ${oldRepoPath} → ${newRepoPath}\n`);
  if (committedCloseoutAction?.action === 'inject') {
    out.write(`Injected \`## Closeout\` template — fill in: outcomes, key commits, deferrals.\n`);
  } else if (committedCloseoutAction?.action === 'skip') {
    out.write(dim('(closeout template skipped — `## Closeout` section already present)\n'));
  }
  if (selfRefsFixed) out.write('Updated references in archived file.\n');
  if (updatedRefCount > 0) out.write(`Updated references in ${updatedRefCount} file(s).\n`);
  if (config.indexPath && indexRegenerated) out.write('Index regenerated.\n');
  if (config.indexPath && noIndex) out.write(dim('(index not regenerated — run `dotmd index` to refresh)\n'));

  const touched = [oldRepoPath, newRepoPath, ...refTouchedPaths];
  if (config.indexPath && indexRegenerated) touched.push(config.indexPath);
  if (showFiles) emitFilesFooter(touched, config);

  try { config.hooks.onArchive?.({ path: newRepoPath, oldStatus }, { oldPath: oldRepoPath, newPath: newRepoPath }); } catch (err) { warn(`Hook 'onArchive' threw: ${err.message}`); }

  return {
    action: 'archived',
    oldRepoPath,
    newRepoPath,
    touched,
    referencePaths: refTouchedPaths.map(item => toRepoPath(item, config.repoRoot)),
    indexRegenerated,
    consumedBody: extractFrontmatter(mutationResult.sourceContent).body,
    consumedFrontmatter: parseSimpleFrontmatter(extractFrontmatter(mutationResult.sourceContent).frontmatter),
  };
}

// Unified status-transition verb. Collapses status/archive/release into one
// signature — `dotmd set <status> [<path>]` — and dispatches to the right
// plumbing based on the *target* status:
//   - target in archiveStatuses (and file not already archived) → runArchive
//     (gets us ref-fixing + atomic ownership release + closeout-template offer)
//   - source = in-session, target != in-session                → runStatus +
//     atomic release of the ownership record
//   - everything else (incl. unarchive, plain transitions)     → runStatus
//
// Path is inferred from the calling session's valid ownership record when omitted. With
// zero records, ambiguity, or corruption, we refuse and ask for explicit `<path>` instead
// of guessing.
//
// `dotmd set in-session <path>` routes through the exact same claim transition
// as `dotmd use`, including history, ownership, index, and hook completion.

// Did THIS session already hand off via `dotmd baton`? The journal records the
// top-level argv of every invocation; a successful `baton …` means a resume
// prompt was saved this session, so the closure nudge would be redundant. Best
// effort — a disabled journal degrades to "might nudge," which is harmless for
// an advisory line. (baton's own internal `runSet` is suppressed by `viaBaton`,
// since its journal entry isn't written until the process exits.)
function batonSavedThisSession(config) {
  const sid = currentSessionId();
  let entries = [];
  try { entries = readJournalEntries(config); } catch { return false; }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.sid === sid && (e.exit ?? 0) === 0 && Array.isArray(e.argv) && e.argv[0] === 'baton') return true;
  }
  return false;
}

export async function runSet(argv, config, opts = {}) {
  const { dryRun } = opts;
  const noIndex = argv.includes('--no-index');
  const showFiles = argv.includes('--show-files');
  const force = argv.includes('--force') || opts.force;
  argv = argv.filter(a => a !== '--no-index' && a !== '--show-files' && a !== '--force');
  let note = opts.note ?? null;
  const noteIdx = argv.indexOf('--note');
  if (noteIdx !== -1) {
    note = note ?? argv[noteIdx + 1] ?? null;
    if (!note || note.startsWith('--')) die('--note requires a value: --note "what changed and why"');
    argv = argv.filter((_, i) => i !== noteIdx && i !== noteIdx + 1);
  }

  const newStatus = argv[0];
  let input = argv[1];

  if (!newStatus) die('Usage: dotmd set <status> [<path>]');
  let sessionId = null;
  if (!input) {
    sessionId = authoritativeSessionId();
    const owned = listOwnedPlans(config, sessionId);
    if (owned.length !== 1 || owned.diagnostics?.length) {
      const diagnostics = owned.diagnostics?.length ? `\nIgnored ownership records:\n${owned.diagnostics.map(d => `  ${d}`).join('\n')}` : '';
      die(`No-target set requires exactly one valid in-session plan owned by this session; found ${owned.length}. Pass an explicit path.${diagnostics}`);
    }
    input = owned[0].plan;
  }

  let filePath = resolveDocArg(input, config);
  filePath = authorizeManagedSource(filePath, config, { kind: 'Set source' }).path;
  const repoPath = toRepoPath(filePath, config.repoRoot);

  if (newStatus === 'in-session') {
    const args = [filePath];
    if (noIndex) args.push('--no-index');
    if (showFiles) args.push('--show-files');
    if (force) args.push('--force');
    return startPlan(args, config, { ...opts, force, note });
  }

  let oldFm = null;
  try { oldFm = parseSimpleFrontmatter(extractFrontmatter(readFileSync(filePath, 'utf8')).frontmatter); } catch { /* runStatus reports malformed docs */ }
  const oldOwnership = asString(oldFm?.type) === 'plan' ? readPlanOwnership(repoPath, config) : null;
  const releasing = asString(oldFm?.type) === 'plan'
    && (asString(oldFm?.status) === 'in-session' || oldOwnership?.state === 'owned' || oldOwnership?.corrupt);
  if (releasing) {
    sessionId ??= authoritativeSessionId();
    assertPlanMutationAuthorized(repoPath, config, { sessionId, force });
    if (!dryRun) ensurePlanCompletionBeforeRelease(repoPath, config, { testHooks: opts.testHooks });
    else if (planHasPendingCompletion(repoPath, config)) process.stderr.write(`${dim('[dry-run]')} Pending claim completion would block this release.\n`);
  }

  const inArchive = isArchivedPath(toRepoPath(filePath, config.repoRoot), config);

  if (config.lifecycle.archiveStatuses.has(newStatus) && !inArchive) {
    const archiveArgs = [filePath];
    if (noIndex) archiveArgs.push('--no-index');
    if (showFiles) archiveArgs.push('--show-files');
    // Preserve the exact target status — a config may name its archive status
    // `done` (with archive:true) rather than `archived`. Without this, runArchive
    // would silently rewrite it to `archived`.
    return runArchive(archiveArgs, config, {
      dryRun, note, archiveStatus: newStatus, force, testHooks: opts.testHooks, deferIndex: opts.deferIndex,
      additionalUpdates: opts.additionalUpdates,
      creations: opts.creations,
    });
  }

  // Two advisory reminders, both computed from one pre-transition frontmatter
  // read (a non-archive `set` never moves the file, so the path stays valid).
  // Advisory only — never block the transition.
  let partialReminder = false;
  let batonNudge = false;
  try {
    const { frontmatter: fmRaw, body } = extractFrontmatter(readFileSync(filePath, 'utf8'));
    const fm = parseSimpleFrontmatter(fmRaw);

    // `partial` promises a successor tracking the deferred tail. When neither a
    // --note nor any doc reference exists to point at it, remind.
    if (newStatus === 'partial' && !note) {
      const related = fm.related_plans;
      const hasRelated = Array.isArray(related) ? related.length > 0 : Boolean(asString(related)?.trim());
      partialReminder = !hasRelated && !/[\w./-]+\.md\b/.test(body);
    }

    // Baton-on-exit backstop (the one core-loop step with no other mechanical
    // catch). Fire ONLY on the baton-less in-session release: a plan you were
    // actively working (old status `in-session`) is being parked at a
    // non-terminal stop status while a known next pickup (`next_step`) remains,
    // and no baton was saved this session. `archived` never reaches here (routed
    // to runArchive above), so this can't fire on a fully-done close. Gating on
    // `in-session` keeps it off pure triage of never-started plans — where no
    // session work is owed a handoff — which is how the nag-fatigue risk is
    // managed. Suppressed for baton's own internal release via `opts.viaBaton`.
    if (!opts.viaBaton) {
      const docType = asString(fm.type) ?? 'plan';
      const oldStatus = asString(fm.status);
      const nextStep = asString(fm.next_step)?.trim();
      batonNudge = docType === 'plan'
        && oldStatus === 'in-session'
        && newStatus !== 'in-session'
        && Boolean(nextStep)
        && !batonSavedThisSession(config);
    }
  } catch { /* advisory only */ }

  const statusArgs = [filePath, newStatus];
  if (noIndex) statusArgs.push('--no-index');
  if (showFiles) statusArgs.push('--show-files');
  const releaseUpdate = releasing
    ? prepareOwnershipRelease(repoPath, config, { sessionId, force })
    : null;
  const result = await runStatus(statusArgs, config, {
    dryRun,
    suppressDeprecation: true,
    note,
    additionalUpdates: releaseUpdate ? [releaseUpdate] : [],
    creations: opts.creations,
    testHooks: opts.testHooks,
    deferIndex: opts.deferIndex,
  });

  if (!dryRun) {
    if (partialReminder) {
      warn('partial usually references the successor plan tracking the tail — add a link to the body, or rerun with --note "tail tracked in <plan>".');
    }
    if (batonNudge) {
      warn(`wrapping up? leave a baton so the next session picks up cleanly — \`dotmd baton ${path.basename(filePath, '.md')} @draft\` saves a resume prompt (no copy-paste into chat).`);
    }
  }
  return result;
}

export function runBulkArchive(argv, config, opts = {}) {
  const { dryRun } = opts;
  const json = argv.includes('--json');
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
  authorizeManagedSweep(unique, config, { kind: 'Bulk archive source' });

  if (!json) {
    process.stdout.write(`${unique.length} file(s) to archive (independent per-item transactions):\n`);
    for (const f of unique) process.stdout.write(`  ${toRepoPath(f, config.repoRoot)}\n`);
  }

  if (dryRun) {
    const result = { operation: 'bulk-archive', atomicity: 'per-item', dryRun: true, items: unique.map(file => ({ path: toRepoPath(file, config.repoRoot), result: 'would-archive' })) };
    if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else process.stdout.write(dim('\n[dry-run] No changes made.\n'));
    return result;
  }

  if (!json) process.stdout.write('\n');
  // Bulk archives always defer index regen to the end — N individual regens
  // is wasteful and the final state is the same. `--no-index` skips even
  // the final one.
  const bulkTouched = [];
  const items = [];
  let indexRegenerated = false;
  let indexError = null;
  let succeeded = 0;
  const originalStdoutWrite = process.stdout.write;
  if (json) process.stdout.write = () => true;
  try {
  for (const f of unique) {
    const relPath = toRepoPath(f, config.repoRoot);
    try {
      const result = runArchive([relPath], config, { ...opts, noIndex: true, showFiles: false });
      if (result?.touched) bulkTouched.push(...result.touched);
      items.push({ path: relPath, result: 'archived', newPath: result?.newRepoPath ?? null, repositoryFiles: result?.touched ?? [] });
    } catch (err) {
      items.push({ path: relPath, result: 'failed', error: err.message });
      if (!json) warn(`Failed to archive ${relPath}: ${err.message}`);
    }
  }
  succeeded = items.filter(item => item.result === 'archived').length;
  if (!noIndex && succeeded > 0) {
    try { indexRegenerated = regenIndex(config, { throwOnError: true, testHooks: opts.testHooks }); }
    catch (err) { indexError = err.message; }
    if (config.indexPath && indexRegenerated) process.stdout.write('Index regenerated.\n');
  } else if (config.indexPath) {
    process.stdout.write(dim('(index not regenerated — run `dotmd index` to refresh)\n'));
  }
  if (showFiles) {
    const all = [...bulkTouched];
    if (config.indexPath && !noIndex) all.push(config.indexPath);
    emitFilesFooter(all, config);
  }
  } finally {
    if (json) process.stdout.write = originalStdoutWrite;
  }
  const normalize = item => path.isAbsolute(item) ? toRepoPath(item, config.repoRoot) : item.split(path.sep).join('/');
  for (const item of items) if (item.repositoryFiles) item.repositoryFiles = [...new Set(item.repositoryFiles.map(normalize))];
  const deferredGeneratedFiles = config.indexPath && succeeded > 0 && (noIndex || indexError) ? [toRepoPath(config.indexPath, config.repoRoot)] : [];
  const result = {
    operation: 'bulk-archive', atomicity: 'per-item', items,
    repositoryFiles: [...new Set(bulkTouched.map(normalize))],
    generatedFiles: config.indexPath && indexRegenerated ? [toRepoPath(config.indexPath, config.repoRoot)] : [],
    deferredGeneratedFiles,
    index: !config.indexPath ? { status: 'not-configured' }
      : indexRegenerated ? { status: 'generated', path: toRepoPath(config.indexPath, config.repoRoot) }
        : indexError ? { status: 'failed', path: toRepoPath(config.indexPath, config.repoRoot), error: indexError }
          : { status: noIndex ? 'deferred' : 'skipped', path: toRepoPath(config.indexPath, config.repoRoot) },
  };
  if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (items.some(item => item.result === 'failed') || indexError) process.exitCode = 1;
  return result;
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
    const allFiles = input ? [resolveDocArg(input, config)] : collectDocFiles(config);
    authorizeManagedSweep(allFiles, config, { kind: 'Touch --git source' });

    const prefix = dryRun ? dim('[dry-run] ') : '';
    let synced = 0;
    const repoPaths = allFiles.map(filePath => toRepoPath(filePath, config.repoRoot));
    const rootPathspecs = input ? null : (config.docsRoots || [config.docsRoot])
      .map(root => toRepoPath(root, config.repoRoot) || '.');
    const gitMetadata = getGitLastModifiedBatch(config.repoRoot, repoPaths, {
      ...(rootPathspecs ? { pathspecs: rootPathspecs } : {}),
      ...opts.gitMetadataOptions,
    });
    if (!gitMetadata.complete) {
      die(`Cannot touch from incomplete Git metadata (${gitMetadata.reason}); no files were changed.`);
    }
    const gitDates = gitMetadata.dates;

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
        const result = mutateFile(filePath, { repoRoot: config.repoRoot, testHooks: opts.testHooks }, current => {
          const currentFm = parseSimpleFrontmatter(extractFrontmatter(current).frontmatter);
          if (config.lifecycle.skipStaleFor.has(asString(currentFm.status))) return current;
          const currentUpdated = asString(currentFm.updated);
          if (currentUpdated && currentUpdated >= gitDay) return current;
          return renderLifecycleMutation(current, { updated: gitDay }, null);
        });
        if (!result.changed) continue;
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

  let filePath = resolveDocArg(input, config);
  filePath = authorizeManagedSource(filePath, config, { kind: 'Touch source' }).path;

  const today = nowIso();

  if (dryRun) {
    process.stdout.write(`${dim('[dry-run]')} Would touch: ${toRepoPath(filePath, config.repoRoot)} (updated → ${today})\n`);
    return;
  }

  mutateFile(filePath, { repoRoot: config.repoRoot, testHooks: opts.testHooks }, current => renderLifecycleMutation(current, { updated: today }, null));
  process.stdout.write(`${green('Touched')}: ${toRepoPath(filePath, config.repoRoot)} (updated → ${today})\n`);

  try { config.hooks.onTouch?.({ path: toRepoPath(filePath, config.repoRoot) }, { path: toRepoPath(filePath, config.repoRoot), date: today }); } catch (err) { warn(`Hook 'onTouch' threw: ${err.message}`); }
}

// Rewrite every frontmatter ref token (a `*.md` path in a YAML list item or an
// inline scalar, quoted or `>`-prefixed) that points at `oldPath` so it points
// at `newPath`. Each token is resolved doc-relative *and* repo-relative and
// compared to oldPath by absolute path — mirroring how the body-link branch and
// `updateRefsFromMovedFile` resolve refs. This replaces an older substring
// rewrite (`fm.split(oldRelPath).join(newRelPath)`) that only knew doc-relative
// paths, so it: left repo-relative cross-dir refs (`docs/plans/child.md` from
// `docs/rfcs/spec.md`) broken; mangled same-dir repo-relative refs into
// `docs/plans/../archived/child.md`; and could corrupt a `grandchild.md` ref
// when archiving `child.md` (suffix match). oldPath no longer exists on disk
// post-`git mv`, so existsSync-based resolveRefPath can't be used here.
function renderMovedFileRefs(raw, oldPath, newPath, config) {
  const files = collectDocFiles(config);
  return rewriteDocumentReferences(raw, {
    sourcePath: oldPath,
    outputPath: newPath,
    repoRoot: config.repoRoot,
    identities: createReferenceIdentitySet(files),
    referenceFields: configuredReferenceFields(config),
    oldPath,
    newPath,
    rebaseAll: true,
  });
}

function countRefsToUpdate(oldPath, newPath, config) {
  const allFiles = collectDocFiles(config);
  const identities = createReferenceIdentitySet(allFiles);
  return allFiles.filter(docFile => {
    if (docFile === oldPath || docFile === newPath) return false;
    const raw = readFileSync(docFile, 'utf8');
    return rewriteDocumentReferences(raw, {
      sourcePath: docFile, repoRoot: config.repoRoot, identities, oldPath, newPath, referenceFields: configuredReferenceFields(config),
    }) !== raw;
  }).length;
}

// Append a one-line dated bullet to the file's `## Version History` section.
// Newest-first ordering: inserted at the top of the section, right after the
// heading + blank-line gap. If the section is missing, this is a silent no-op
// — never auto-creates the section (don't surprise users on old plans/docs).
export function appendVersionHistory(filePath, entry, { createSection = false } = {}) {
  let raw;
  try { raw = normalizeEol(readFileSync(filePath, 'utf8')); } catch { return false; }
  if (!raw.startsWith('---\n')) return false;

  const endMarker = raw.indexOf('\n---\n', 4);
  if (endMarker === -1) return false;
  const frontmatter = raw.slice(4, endMarker);
  const body = raw.slice(endMarker + 5);

  const bullet = `- **${nowIso()}** ${entry}`;

  const vh = findSection(walkSections(body), 'Version History');
  if (!vh) {
    // Bare docs (no scaffold) have no Version History; transitions silently
    // skip the worklog. But an explicit `--note` must not be dropped — the
    // caller opts into creating the section at the end of the body.
    if (!createSection) return false;
    const trimmed = body.replace(/\n+$/, '');
    writeFileSync(filePath, `---\n${frontmatter}\n---\n${trimmed}\n\n## Version History\n\n${bullet}\n`, 'utf8');
    return true;
  }
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
  const raw = normalizeEol(readFileSync(filePath, 'utf8'));
  // Name the remedy in the error: this is where every status verb lands when a
  // doc was created outside dotmd, and "no frontmatter block" alone left
  // sessions retrying other verbs instead of fixing the doc.
  if (!raw.startsWith('---\n')) throw new Error(`${filePath} has no frontmatter block. Retrofit it first: dotmd bulk-tag ${filePath} --type <type> --status <status>`);

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
  const raw = normalizeEol(readFileSync(filePath, 'utf8'));
  if (raw.startsWith('---\n')) {
    updateFrontmatter(filePath, fields);
    return;
  }
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');
  writeFileSync(filePath, `---\n${lines}\n---\n${raw}`, 'utf8');
}
