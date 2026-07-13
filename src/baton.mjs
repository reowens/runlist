import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, die, warn } from './util.mjs';
import { buildIndex, resolveDocArg } from './index.mjs';
import { preparePromptDocument, runNew, readBodyInput, readPipedBodyInput } from './new.mjs';
import { ensurePlanCompletionBeforeRelease, planHasPendingCompletion, runSet } from './lifecycle.mjs';
import { green, dim } from './color.mjs';
import { authorizeManagedSource } from './managed-path.mjs';
import { assertPlanMutationAuthorized, authoritativeSessionId, listOwnedPlans, readPlanOwnership } from './pickup.mjs';

// `dotmd baton` is the one-command handoff: save the resume prompt AND release
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

const BODY_USAGE = `dotmd baton needs the resume draft as its body. Write 10–20 lines first — the next concrete decision plus any gotchas, NOT a recap of the plan — then:
  dotmd baton @/tmp/draft.md             # body from file (preferred)
  cat /tmp/draft.md | dotmd baton        # body from stdin
  dotmd baton --message "..."            # one-liner
No plan in-session? Name the handoff instead: dotmd baton <slug> @/tmp/draft.md`;

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
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--status' && argv[i + 1]) { status = argv[++i]; statusFlag = true; continue; }
    if (a === '--note' && argv[i + 1]) { note = argv[++i]; continue; }
    if ((a === '--body' || a === '--message') && argv[i + 1]) { bodyFlag = argv[++i]; continue; }
    if (a === '--force') { force = true; continue; }
    if (a === '--json') continue;
    if (!a.startsWith('-') || a === '-' || a.startsWith('@')) { positionals.push(a); continue; }
    die(`Unknown flag for \`dotmd baton\`: ${a}`);
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
    // Auto-consume piped/redirected stdin, same probe as `dotmd new`.
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
      die(`Multiple plans are owned by this session; pass one explicitly:\n${owned.owned.map(d => '  dotmd baton ' + d.path + ' @/tmp/draft.md').join('\n')}`);
    } else {
      const diagnostics = owned.diagnostics?.length ? `\nIgnored ownership records:\n${owned.diagnostics.map(d => `  ${d}`).join('\n')}` : '';
      die(`No valid in-session plan is owned by this session, so baton needs a name for the resume prompt:\n  dotmd baton <slug> @/tmp/draft.md      # saves resume-<slug>, touches nothing else\nHanding off a specific plan? dotmd baton <plan-file> @/tmp/draft.md${diagnostics}`);
    }
  }

  let repoPath = null;
  let oldStatus = null;
  let ownershipPath = null;
  if (planPath) {
    planPath = authorizeManagedSource(planPath, config, { kind: 'Baton plan source' }).path;
    repoPath = toRepoPath(planPath, config.repoRoot);
    const raw = readFileSync(planPath, 'utf8');
    const { frontmatter: fmRaw } = extractFrontmatter(raw);
    if (!fmRaw) {
      die(`${repoPath} has no frontmatter block — baton can't flip its status.\nFix the doc first (\`dotmd bulk-tag ${repoPath} --type plan --status in-session\`), or save the prompt without a status flip: dotmd baton ${path.basename(planPath, '.md')} @/tmp/draft.md`);
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
      die('`dotmd baton --status in-session` contradicts baton release semantics. Choose active/paused/awaiting/partial/blocked.');
    }
    assertPlanMutationAuthorized(repoPath, config, { sessionId: authoritativeSessionId(), force });
    ownershipPath = readPlanOwnership(repoPath, config)?.recordPath ?? null;
    if (!dryRun) ensurePlanCompletionBeforeRelease(repoPath, config, { testHooks: opts.testHooks });
    else if (planHasPendingCompletion(repoPath, config)) process.stderr.write(`${dim('[dry-run]')} Pending claim completion would block this release.\n`);
  } else {
    if (statusFlag) warn(`--status ignored — no plan involved in this handoff (saving the prompt only).`);
    if (note) warn(`--note ignored — no plan involved in this handoff (notes land in a plan's Version History).`);
  }

  // Plan mode publishes the already-stamped prompt, status/history update, and
  // ownership release in one transaction. Slug mode has no plan transaction.
  const nameBase = planPath ? path.basename(planPath, '.md') : promptSlug;
  const slugBase = nameBase.startsWith('resume-') ? nameBase : `resume-${nameBase}`;
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
    for (let n = 1; n <= 9 && !createdSlug; n++) {
      const slug = n === 1 ? slugBase : `${slugBase}-${n}`;
      try {
        const prepared = preparePromptDocument(slug, body, config, { dryRun });
        newResult = await runNew(['prompt', slug, '--body', body], config, { dryRun, deferIndex: true });
        createdSlug = slug;
        promptRepoPath = prepared.repoPath;
      }
      catch (err) { if (!/File already exists/.test(String(err?.message))) throw err; }
    }
  } else {
    for (let n = 1; n <= 9 && !createdSlug; n++) {
      const candidate = n === 1 ? slugBase : `${slugBase}-${n}`;
      const prepared = preparePromptDocument(candidate, body, config, { plan: repoPath, dryRun });
      if (existsSync(prepared.filePath)) continue;
      const setArgs = [status, planPath];
      if (force) setArgs.push('--force');
      if (note) setArgs.push('--note', note);
      try {
        if (dryRun) process.stdout.write(`${dim('[dry-run]')} Would create: ${prepared.repoPath}\n`);
        archiveResult = await runSet(setArgs, config, {
          dryRun,
          viaBaton: true,
          testHooks: opts.testHooks,
          creations: dryRun ? [] : [{ path: prepared.filePath, content: prepared.content }],
          deferIndex: true,
        });
        createdSlug = prepared.slug;
        promptRepoPath = prepared.repoPath;
        statusChanged = oldStatus !== status;
        if (!dryRun) {
          try { config.hooks.onNew?.({ path: prepared.repoPath, status: 'pending', title: prepared.slug, type: 'prompt' }); }
          catch (err) { warn(`Hook 'onNew' threw: ${err.message}`); }
        }
      } catch (err) {
        if (!/Destination already exists|File already exists/.test(String(err?.message))) throw err;
      }
    }
  }
  } finally {
    if (json) process.stdout.write = originalStdoutWrite;
  }
  if (!createdSlug) die(`Could not find a free prompt slug for ${slugBase} (tried ${slugBase}-2 … ${slugBase}-9).`);

  const normalizeRepoPath = candidate => {
    if (!candidate) return null;
    return path.isAbsolute(candidate) ? toRepoPath(candidate, config.repoRoot) : candidate;
  };
  const touched = (archiveResult?.touched ?? (planPath && statusChanged ? [repoPath] : [])).map(normalizeRepoPath);
  const ownershipRepoPath = normalizeRepoPath(ownershipPath);
  const repositoryFiles = [...new Set(touched.filter(candidate => candidate && candidate !== ownershipRepoPath && candidate !== promptRepoPath && candidate !== normalizeRepoPath(config.indexPath)))];
  const sessionFiles = [...new Set([...(newResult?.sessionFiles ?? []), promptRepoPath, ownershipRepoPath].filter(Boolean))];
  const deferredGeneratedFiles = [...new Set(newResult?.deferredGeneratedFiles ?? (config.indexPath ? [normalizeRepoPath(config.indexPath)] : []))];
  const operationResult = {
    operation: 'baton',
    dryRun: Boolean(dryRun),
    disposition: dryRun ? 'would-change' : 'applied',
    wouldChange: Boolean(dryRun),
    mode: planPath ? 'plan' : 'slug',
    status: planPath ? { from: oldStatus, to: status, changed: statusChanged } : null,
    repositoryFiles,
    sessionFiles,
    generatedFiles: [],
    deferredGeneratedFiles,
    prompt: promptRepoPath,
    plan: archiveResult?.newRepoPath ?? repoPath,
  };

  const prefix = dryRun ? dim('[dry-run] ') : '';
  if (json) {
    process.stdout.write(JSON.stringify(operationResult, null, 2) + '\n');
    return operationResult;
  }
  process.stderr.write(`\n${prefix}${green('✓ Baton passed')}: ${createdSlug} (the next session's hud surfaces it — nothing to paste into chat)\n`);
  if (statusChanged) {
    const pathspec = operationResult.repositoryFiles.join(' ');
    let gitignored = false;
    try {
      const { isGitIgnored } = await import('./git.mjs');
      gitignored = isGitIgnored(planPath, config.repoRoot);
    } catch { /* not a git repo — fall through to the hint */ }
    if (gitignored) {
      process.stderr.write(dim(`${repoPath} is gitignored — no commit needed.\n`));
    } else {
      process.stderr.write(`${prefix}Commit the repository files (session files stay OUT of the pathspec):\n`);
      process.stderr.write(`${prefix}  git commit -m "baton: ${path.basename(planPath, '.md')} ${oldStatus} → ${status}" -- ${pathspec}\n`);
    }
  }
  if (operationResult.deferredGeneratedFiles.length) process.stderr.write(dim(`Generated index deferred: ${operationResult.deferredGeneratedFiles.join(', ')}\n`));
  return operationResult;
}
