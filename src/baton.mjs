import { readFileSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, die, warn, isArchivedPath, resolveRefPath, nowIso } from './util.mjs';
import { buildIndex, resolveDocArg } from './index.mjs';
import { preparePromptDocument, runNew, readBodyInput, readPipedBodyInput } from './new.mjs';
import { ensurePlanCompletionBeforeRelease, planHasPendingCompletion, renderLifecycleMutation, runSet } from './lifecycle.mjs';
import { green, dim } from './color.mjs';
import { authorizeManagedDestination, authorizeManagedSource } from './managed-path.mjs';
import { mutateFileSet } from './atomic-mutation.mjs';
import { assertPlanMutationAuthorized, authoritativeSessionId, listOwnedPlans, readPlanOwnership } from './pickup.mjs';

// `runlist baton` is the one-command handoff: save the resume prompt AND release
// the plan in a single atomic-ish verb. It exists because the three-step skill
// version ("save prompt, pick a status, commit") kept expanding in practice —
// sessions turned closeout into repo triage, forgot the prompt body, or got
// tangled in what to commit. Baton does exactly one plan, one prompt, one
// status flip, and then *tells* the agent the exact commit command.

export function findOwnedPlan(config, index = null) {
  const idx = index ?? buildIndex(config);
  const inSession = idx.docs.filter(d => d.type === 'plan' && d.status === 'in-session');
  let records = [];
  try { records = listOwnedPlans(config, authoritativeSessionId()); } catch { return { plan: null, via: null, inSession }; }
  const owned = records.map(record => inSession.find(doc => doc.path === record.plan)).filter(Boolean);
  const clean = (records.diagnostics?.length ?? 0) === 0;
  return { plan: clean && owned.length === 1 ? owned[0] : null, via: clean && owned.length === 1 ? 'ownership' : null, inSession, owned, diagnostics: records.diagnostics ?? [] };
}

// One line that says what is missing, then one example. Baton never drafts the
// resume itself: the session that did the work is the only one that knows the
// next decision, and a prompt assembled from frontmatter reads like a handoff
// while carrying nothing the plan doesn't already say.
// The three forms are listed because this is the message a bare `runlist baton`
// prints, and an agent unsure of the shape should be able to act on it without
// a trip through --help.
const BODY_USAGE = `Nothing saved: baton needs the resume you wrote, passed as @<file> or - (stdin).
  runlist baton @/tmp/draft.md               # hand off the plan this session owns
  runlist baton <plan-file> @/tmp/draft.md   # hand off a named plan
  runlist baton <slug> @/tmp/draft.md        # no plan: save resume-<slug>, change nothing else`;

// A handoff that lands beside a pending one leaves two prompts for the same
// work, and the next session picks whichever sorts first. Baton used to step to
// `resume-<x>-2` silently; it now refuses and names what is waiting, so the
// older prompt is consumed or archived on purpose. Plan mode also catches a
// pending prompt under a different name that links the same plan.
function pendingHandoffs(promptPath, planPath, config) {
  const found = new Set();
  if (existsSync(promptPath)) found.add(toRepoPath(promptPath, config.repoRoot));
  if (planPath) {
    const planReal = realpathSync(planPath);
    const index = buildIndex(config, { fast: true, invokeHooks: false });
    for (const doc of index.docs) {
      if (doc.type !== 'prompt' || doc.status === 'archived' || isArchivedPath(doc.path, config)) continue;
      const abs = path.resolve(config.repoRoot, doc.path);
      let planRef;
      try { planRef = asString(parseSimpleFrontmatter(extractFrontmatter(readFileSync(abs, 'utf8')).frontmatter).plan); }
      catch { continue; }
      const linked = planRef ? resolveRefPath(planRef, path.dirname(abs), config.repoRoot) : null;
      try { if (linked && realpathSync(linked) === planReal) found.add(doc.path); }
      catch { /* stale plan link is not evidence this prompt belongs to the plan */ }
    }
  }
  return [...found];
}

function refusePendingHandoff(pending) {
  const lines = pending.map(p => `  ${p}`).join('\n');
  const slug = path.basename(pending[0], '.md');
  die(`Nothing saved: a handoff for this is already pending:\n${lines}\nInspect it with \`runlist prompts show ${slug}\`. If it is current, keep it and do not hand off again. If it is stale, re-run baton with \`--replace\` to preserve the old handoff under archived/.`);
}

function archivedCopyPath(promptPath, config) {
  const dir = path.join(path.dirname(promptPath), config.archiveDir);
  const ext = path.extname(promptPath);
  const stem = path.basename(promptPath, ext);
  let candidate = path.join(dir, `${stem}${ext}`);
  for (let n = 2; existsSync(candidate); n++) candidate = path.join(dir, `${stem}-${n}${ext}`);
  return authorizeManagedDestination(candidate, config, { kind: 'Baton replacement archive' }).path;
}

function shellQuote(value) {
  const raw = String(value);
  return /^[A-Za-z0-9_./:@+-]+$/.test(raw) ? raw : `"${raw.replace(/["\\$`]/g, '\\$&')}"`;
}

function commitCommand(config, message, paths) {
  const fallback = ['git', 'commit', '-m', message, '--', ...paths];
  let argv = fallback;
  if (typeof config.hooks.batonCommitCommand === 'function') {
    try {
      const custom = config.hooks.batonCommitCommand(message, [...paths]);
      if (!Array.isArray(custom) || custom.length === 0 || !custom.every(part => typeof part === 'string' && part.length > 0)) {
        throw new Error('return a nonempty string argv array');
      }
      argv = custom;
    } catch (err) { warn(`batonCommitCommand failed (${err.message}); printing the default git command.`); }
  }
  return argv.map(shellQuote).join(' ');
}

// Is this positional a filesystem reference (must resolve, typos die) or a
// bare word (may be a plan slug, may be a brand-new handoff name)?
function looksLikePath(arg) {
  return arg.includes('/') || arg.endsWith('.md');
}

export async function runBaton(argv, config, opts = {}) {
  const { dryRun } = opts;
  const json = argv.includes('--json');

  let status = 'active';
  let statusFlag = false;
  let note = null;
  let bodyFlag = null;
  let force = false;
  let replace = false;
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--status' && argv[i + 1]) { status = argv[++i]; statusFlag = true; continue; }
    if (a === '--note' && argv[i + 1]) { note = argv[++i]; continue; }
    if ((a === '--body' || a === '--message') && argv[i + 1]) { bodyFlag = argv[++i]; continue; }
    if (a === '--force') { force = true; continue; }
    if (a === '--replace') { replace = true; continue; }
    if (a === '--json') continue;
    if (!a.startsWith('-') || a === '-' || a.startsWith('@')) { positionals.push(a); continue; }
    die(`Unknown flag for \`runlist baton\`: ${a}`);
  }

  let planArg = null;
  let bodyArg = null;
  for (const p of positionals) {
    if (p === '-' || p.startsWith('@')) { bodyArg = p; continue; }
    if (!planArg) { planArg = p; continue; }
    if (bodyArg === null) bodyArg = p; // trailing inline body
  }

  // Body FIRST — it's the common failure (`new prompt` without a body was the
  // top real-world baton error), and nothing must mutate before it's secured.
  let body = null;
  if (bodyFlag !== null) body = bodyFlag;
  else if (bodyArg !== null) body = readBodyInput(bodyArg);
  else {
    // Auto-consume piped/redirected stdin, same probe as `runlist new`.
    body = readPipedBodyInput();
  }
  if (!body || !body.trim()) die(BODY_USAGE);

  // Resolve what's being handed off. Two modes:
  //   plan mode — a plan is released alongside the prompt (one status flip).
  //   slug mode — no plan involved: "save a resume prompt for what I'm doing
  //   right now". The hallmark use ("update the docs and save a resume prompt
  //   for this") must work mid-anything, claimed plan or not — baton does
  //   nothing but save the prompt in this mode.
  let planPath = null;
  let promptSlug = null;
  if (planArg) {
    if (looksLikePath(planArg)) {
      planPath = resolveDocArg(planArg, config); // typos die loudly — a mistyped path must not silently become a prompt name
    } else {
      // Bare word: a plan slug if it resolves to a plan, else a handoff name.
      const resolved = resolveDocArg(planArg, config, { dieOnMiss: false });
      let resolvedType = null;
      if (resolved) {
        try {
          const { frontmatter: fmProbe } = extractFrontmatter(readFileSync(resolved, 'utf8'));
          resolvedType = fmProbe ? asString(parseSimpleFrontmatter(fmProbe).type) : null;
        } catch { resolvedType = null; }
      }
      if (resolved && resolvedType === 'plan') planPath = resolved;
      else promptSlug = planArg;
    }
  } else {
    const owned = findOwnedPlan(config);
    if (owned.plan) {
      planPath = path.resolve(config.repoRoot, owned.plan.path);
    } else if (owned.owned?.length > 1) {
      die(`Multiple plans are owned by this session; pass one explicitly:\n${owned.owned.map(d => '  runlist baton ' + d.path + ' @/tmp/draft.md').join('\n')}`);
    } else {
      const diagnostics = owned.diagnostics?.length ? `\nIgnored ownership records:\n${owned.diagnostics.map(d => `  ${d}`).join('\n')}` : '';
      die(`No valid in-session plan is owned by this session, so baton needs a name for the resume prompt:\n  runlist baton <slug> @/tmp/draft.md      # saves resume-<slug>, touches nothing else\nHanding off a specific plan? runlist baton <plan-file> @/tmp/draft.md${diagnostics}`);
    }
  }

  const nameBase = planPath ? path.basename(planPath, '.md') : promptSlug;
  const slugBase = nameBase.startsWith('resume-') ? nameBase : `resume-${nameBase}`;
  let replacement = null;
  const resolvePending = () => {
    const target = preparePromptDocument(slugBase, body, config, { dryRun: true });
    const pending = pendingHandoffs(target.filePath, planPath, config);
    if (!replace) {
      if (pending.length) refusePendingHandoff(pending);
      return;
    }
    if (pending.length !== 1) {
      const detail = pending.length ? `Found ${pending.length}:\n${pending.map(p => `  ${p}`).join('\n')}` : 'No pending handoff matches this work.';
      die(`Nothing replaced: --replace requires exactly one pending handoff. ${detail}`);
    }
    const oldRepoPath = pending[0];
    const oldPath = authorizeManagedSource(path.resolve(config.repoRoot, oldRepoPath), config, { kind: 'Baton replacement source' }).path;
    const oldRaw = readFileSync(oldPath, 'utf8');
    const { frontmatter, body: oldBody } = extractFrontmatter(oldRaw);
    const fm = parseSimpleFrontmatter(frontmatter);
    if (asString(fm.type) !== 'prompt' || asString(fm.status) !== 'pending') {
      die(`Nothing replaced: ${oldRepoPath} is not a pending prompt.`);
    }
    const priorPlanRef = asString(fm.plan);
    const priorPlanPath = priorPlanRef ? resolveRefPath(priorPlanRef, path.dirname(oldPath), config.repoRoot) : null;
    if (!planPath && priorPlanRef) {
      die(`Nothing replaced: ${oldRepoPath} links a plan (${priorPlanRef}). Use \`runlist baton <plan-file> @<draft-file> --replace\` so the plan link and release stay together.`);
    }
    replacement = {
      oldPath, oldRepoPath, oldRaw,
      archivedPath: archivedCopyPath(oldPath, config),
      alreadyCurrent: oldBody.trim() === body.trim()
        && (!planPath || (priorPlanPath && path.resolve(priorPlanPath) === path.resolve(planPath))),
      canonicalPath: target.filePath,
    };
  };

  let repoPath = null;
  let oldStatus = null;
  let ownershipPath = null;
  let planGuard = null;
  let wouldReleaseClaim = false;
  if (planPath) {
    planPath = authorizeManagedSource(planPath, config, { kind: 'Baton plan source' }).path;
    repoPath = toRepoPath(planPath, config.repoRoot);
    const raw = readFileSync(planPath, 'utf8');
    const { frontmatter: fmRaw } = extractFrontmatter(raw);
    if (!fmRaw) {
      die(`${repoPath} has no frontmatter block — baton can't flip its status.\nFix the doc first (\`runlist bulk-tag ${repoPath} --type plan --status in-session\`), or save the prompt without a status flip: runlist baton ${path.basename(planPath, '.md')} @/tmp/draft.md`);
    }
    const fm = parseSimpleFrontmatter(fmRaw);
    const docType = asString(fm.type);
    oldStatus = asString(fm.status) ?? 'unset';
    if (docType && docType !== 'plan') warn(`${repoPath} has type '${docType}', not 'plan'.`);

    // Validate the target status BEFORE creating the prompt so a bad --status
    // doesn't leave a half-done handoff.
    const validStatuses = config.typeStatuses?.get(docType ?? 'plan') ?? config.validStatuses;
    if (validStatuses && validStatuses.size > 0 && !validStatuses.has(status)) {
      die(`Invalid status \`${status}\` for type \`${docType ?? 'plan'}\`\nValid: ${[...validStatuses].join(', ')}`);
    }
    if (status === 'in-session') {
      die('`runlist baton --status in-session` contradicts baton release semantics. Choose active/paused/awaiting/partial/blocked.');
    }
    const sessionId = authoritativeSessionId();
    const ownership = assertPlanMutationAuthorized(repoPath, config, { sessionId, force });
    const ownedHere = ownership?.state === 'owned' && ownership.sessionId === sessionId;
    wouldReleaseClaim = ownership?.state === 'owned';
    // Baton's release only means something when there is a claim to release. A
    // plan that is neither in-session nor owned here carries a status someone
    // chose on purpose (`awaiting`, `blocked`, a repo's own `awaiting-testing`),
    // and flipping it to the default `active` as a side effect of saving a
    // prompt overwrites that reason — silently, since baton's headline is the
    // prompt it saved. That is not hypothetical: a prompt-refresh pass named a
    // plan slug, got a status flip it never asked for, and had to notice and
    // undo it. So the prompt still lands with its `plan:` link, and the plan's
    // status stays put unless the caller states the transition with --status.
    const currentStatus = asString(fm.status);
    if (!statusFlag && oldStatus !== 'in-session' && !ownedHere) {
      if (!currentStatus || (validStatuses?.size > 0 && !validStatuses.has(currentStatus))) {
        die(`${repoPath} is not in-session and its status (\`${oldStatus}\`) is not one baton can leave in place.\n`
          + `Say what it should become: runlist baton ${repoPath} @<draft-file> --status <status>\n`
          + `Or save the prompt without touching the plan: runlist baton ${path.basename(planPath, '.md')} @<draft-file>`);
      }
      status = currentStatus;
      planGuard = { path: planPath, expectedContent: raw };
      if (note) warn('--note ignored — the plan\'s status is unchanged, so there is no transition to record.');
    }
    // Before the plan-completion step: a refusal must leave nothing changed.
    resolvePending();
    // A status transition may file the plan at a new path. Refreshing the
    // prompt inside that transaction keeps its plan link valid even when its
    // body text happened to be identical to the previous handoff.
    if (replacement && status !== oldStatus) replacement.alreadyCurrent = false;
    ownershipPath = readPlanOwnership(repoPath, config)?.recordPath ?? null;
    if (!dryRun) ensurePlanCompletionBeforeRelease(repoPath, config, { testHooks: opts.testHooks });
    else if (planHasPendingCompletion(repoPath, config)) process.stderr.write(`${dim('[dry-run]')} Pending claim completion would block this release.\n`);
  } else {
    resolvePending();
    if (statusFlag) warn(`--status ignored — no plan involved in this handoff (saving the prompt only).`);
    if (note) warn(`--note ignored — no plan involved in this handoff (notes land in a plan's Version History).`);
  }

  const preparedReplacement = prepared => {
    if (!replacement || replacement.alreadyCurrent) return { updates: [], creations: [], guards: [] };
    let archivedContent = renderLifecycleMutation(replacement.oldRaw,
      { status: 'archived', updated: nowIso() }, () => 'Archived.');
    if (repoPath) archivedContent = archivedContent.replace(/^plan:[ \t]*\S.*$/m, `plan: ${repoPath}`);
    return {
      updates: [{ path: replacement.oldPath, expectedContent: replacement.oldRaw, content: prepared.content }],
      creations: [{ path: replacement.archivedPath, content: archivedContent }],
      guards: path.resolve(replacement.canonicalPath) === path.resolve(replacement.oldPath)
        ? [] : [{ path: replacement.canonicalPath, absent: true }],
    };
  };
  if (dryRun && !json && replacement && !replacement.alreadyCurrent) {
    process.stdout.write(`${dim('[dry-run]')} Would preserve old handoff: ${replacement.oldRepoPath} → ${toRepoPath(replacement.archivedPath, config.repoRoot)}\n`);
  }

  // Plan mode publishes the already-stamped prompt, status/history update, and
  // ownership release in one transaction. Slug mode has no plan transaction.
  let createdSlug = null;
  let archiveResult = null;
  let statusChanged = false;
  let promptRepoPath = null;
  let newResult = null;
  const muted = [];
  const originalStdoutWrite = process.stdout.write;
  if (json) process.stdout.write = chunk => { muted.push(String(chunk)); return true; };
  try {
  if (!planPath) {
    const promptName = replacement ? path.basename(replacement.oldPath, '.md') : slugBase;
    const prepared = preparePromptDocument(promptName, body, config, { dryRun });
    if (replacement) {
      const mutation = preparedReplacement(prepared);
      if (!dryRun && !replacement.alreadyCurrent) mutateFileSet(mutation, { repoRoot: config.repoRoot, testHooks: opts.testHooks });
      newResult = { sessionFiles: [replacement.oldRepoPath, ...(replacement.alreadyCurrent ? [] : [toRepoPath(replacement.archivedPath, config.repoRoot)])] };
    } else {
      try {
        newResult = await runNew(['prompt', slugBase, '--body', body], config, { dryRun, deferIndex: true });
      } catch (err) {
        // Lost a race with another baton between the pending check and the write.
        if (/File already exists/.test(String(err?.message))) refusePendingHandoff([prepared.repoPath]);
        throw err;
      }
    }
    createdSlug = promptName;
    promptRepoPath = replacement?.oldRepoPath ?? prepared.repoPath;
  } else {
    const promptName = replacement ? path.basename(replacement.oldPath, '.md') : slugBase;
    const prepared = preparePromptDocument(promptName, body, config, { plan: repoPath, dryRun });
    const mutation = preparedReplacement(prepared);
    const setArgs = [status, planPath];
    if (force) setArgs.push('--force');
    if (note && !planGuard) setArgs.push('--note', note);
    try {
      if (dryRun) process.stdout.write(`${dim('[dry-run]')} Would ${replacement ? (replacement.alreadyCurrent ? 'keep' : 'replace') : 'create'}: ${replacement?.oldRepoPath ?? prepared.repoPath}\n`);
      archiveResult = await runSet(setArgs, config, {
        dryRun,
        viaBaton: true,
        testHooks: opts.testHooks,
        additionalUpdates: dryRun ? [] : mutation.updates,
        creations: dryRun ? [] : replacement ? mutation.creations : [{ path: prepared.filePath, content: prepared.content }],
        guards: dryRun ? [] : [...mutation.guards, ...(planGuard ? [planGuard] : [])],
        deferIndex: true,
      });
    } catch (err) {
      if (/Destination already exists|File already exists/.test(String(err?.message))) refusePendingHandoff([prepared.repoPath]);
      throw err;
    }
    createdSlug = prepared.slug;
    promptRepoPath = replacement?.oldRepoPath ?? prepared.repoPath;
    statusChanged = oldStatus !== status;
    if (!dryRun && !replacement) {
      try { config.hooks.onNew?.({ path: prepared.repoPath, status: 'pending', title: prepared.slug, type: 'prompt' }); }
      catch (err) { warn(`Hook 'onNew' threw: ${err.message}`); }
    }
  }
  } finally {
    if (json) process.stdout.write = originalStdoutWrite;
  }

  if (!dryRun && replacement && !replacement.alreadyCurrent) {
    const archivedRepoPath = toRepoPath(replacement.archivedPath, config.repoRoot);
    try { config.hooks.onArchive?.({ path: archivedRepoPath, oldStatus: 'pending' }, { oldPath: replacement.oldRepoPath, newPath: archivedRepoPath }); }
    catch (err) { warn(`Hook 'onArchive' threw: ${err.message}`); }
    try { config.hooks.onNew?.({ path: replacement.oldRepoPath, status: 'pending', title: createdSlug, type: 'prompt' }); }
    catch (err) { warn(`Hook 'onNew' threw: ${err.message}`); }
  }

  const normalizeRepoPath = candidate => {
    if (!candidate) return null;
    return path.isAbsolute(candidate) ? toRepoPath(candidate, config.repoRoot) : candidate;
  };
  const touched = (archiveResult?.touched ?? (planPath && statusChanged ? [repoPath] : [])).map(normalizeRepoPath);
  const ownershipRepoPath = normalizeRepoPath(ownershipPath);
  const archivedPromptRepoPath = replacement && !replacement.alreadyCurrent ? toRepoPath(replacement.archivedPath, config.repoRoot) : null;
  const repositoryFiles = [...new Set(touched.filter(candidate => candidate && candidate !== ownershipRepoPath && candidate !== promptRepoPath && candidate !== archivedPromptRepoPath && candidate !== normalizeRepoPath(config.indexPath)))];
  const sessionFiles = [...new Set([...(newResult?.sessionFiles ?? []), promptRepoPath, archivedPromptRepoPath, ownershipRepoPath].filter(Boolean))];
  const deferredGeneratedFiles = [...new Set(newResult?.deferredGeneratedFiles ?? (config.indexPath ? [normalizeRepoPath(config.indexPath)] : []))];
  const operationResult = {
    operation: 'baton',
    dryRun: Boolean(dryRun),
    disposition: replacement?.alreadyCurrent && !statusChanged && !wouldReleaseClaim ? 'already-current' : dryRun ? 'would-change' : 'applied',
    wouldChange: Boolean(dryRun),
    mode: planPath ? 'plan' : 'slug',
    status: planPath ? { from: oldStatus, to: status, changed: statusChanged } : null,
    repositoryFiles,
    sessionFiles,
    generatedFiles: [],
    deferredGeneratedFiles,
    prompt: promptRepoPath,
    plan: archiveResult?.newRepoPath ?? repoPath,
    planMovement: planPath ? { from: repoPath, to: archiveResult?.newRepoPath ?? repoPath } : null,
    replacement: replacement ? {
      previousPrompt: replacement.oldRepoPath,
      archivedPrompt: archivedPromptRepoPath,
      pendingPrompt: promptRepoPath,
      alreadyCurrent: replacement.alreadyCurrent,
    } : null,
    claimRelease: planPath ? { wouldRelease: wouldReleaseClaim, released: !dryRun && wouldReleaseClaim } : null,
  };

  const prefix = dryRun ? dim('[dry-run] ') : '';
  if (json) {
    process.stdout.write(JSON.stringify(operationResult, null, 2) + '\n');
    return operationResult;
  }
  const verdict = replacement?.alreadyCurrent ? '✓ Handoff kept' : replacement ? '✓ Baton replaced' : '✓ Baton passed';
  process.stderr.write(`\n${prefix}${green(verdict)}: ${createdSlug} (the next session's hud surfaces it — nothing to paste into chat)\n`);
  if (archivedPromptRepoPath) process.stderr.write(dim(`${prefix}Previous handoff preserved: ${archivedPromptRepoPath}\n`));
  if (planGuard) {
    process.stderr.write(dim(`${repoPath} left at \`${oldStatus}\` — it was not in-session, so there was no claim to release.\n`));
    process.stderr.write(dim(`Meant to change it? runlist set <status> ${repoPath}\n`));
  }
  if (statusChanged) {
    let gitignored = false;
    try {
      const { isGitIgnored } = await import('./git.mjs');
      gitignored = isGitIgnored(planPath, config.repoRoot);
    } catch { /* not a git repo — fall through to the hint */ }
    if (gitignored) {
      process.stderr.write(dim(`${repoPath} is gitignored — no commit needed.\n`));
    } else {
      process.stderr.write(`${prefix}Commit the repository files (session files stay OUT of the pathspec):\n`);
      process.stderr.write(`${prefix}  ${commitCommand(config, `baton: ${path.basename(planPath, '.md')} ${oldStatus} → ${status}`, operationResult.repositoryFiles)}\n`);
    }
  }
  if (operationResult.deferredGeneratedFiles.length) process.stderr.write(dim(`Generated index deferred: ${operationResult.deferredGeneratedFiles.join(', ')}\n`));
  return operationResult;
}
