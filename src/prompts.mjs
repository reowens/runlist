import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, die, resolveDocPath, resolveRefPath, isArchivedPath } from './util.mjs';
import { buildIndex, resolveDocArg } from './index.mjs';
import { runQuery } from './query.mjs';
import { completePlanClaim, regenIndex, renderLifecycleMutation, runArchive, runStatus } from './lifecycle.mjs';
import { runNew } from './new.mjs';
import { green, dim, yellow } from './color.mjs';
import { authorizeManagedSource } from './managed-path.mjs';
import {
  authoritativeSessionId,
  classifyPlanPickup,
  ownershipLiveness,
  preparePlanClaim,
  readPlanOwnership,
} from './pickup.mjs';
import { actionablePromptStatuses, comparePromptDocs } from './status-metadata.mjs';

// `resume` is an alias for `use` — agents reach for "resume" when continuing a
// session; `use` reads as internal mechanics. Both names stay valid; the
// canonical output ("Consumed: …") is unchanged.
const SUBCOMMANDS = new Set(['list', 'next', 'use', 'resume', 'show', 'peek', 'archive', 'new', 'hold', 'unhold', 'shelve', 'unshelve']);

export async function runPrompts(argv, config, opts = {}) {
  const sub = argv[0];

  if (!sub || !SUBCOMMANDS.has(sub)) {
    return runPromptsList(argv, config, opts);
  }

  const rest = argv.slice(1);
  switch (sub) {
    case 'list':     return runPromptsList(rest, config, opts);
    case 'next':     return runPromptsNext(rest, config, opts);
    case 'use':      return runPromptsUse(rest, config, opts);
    case 'resume':   return runPromptsUse(rest, config, opts);
    case 'show':     return runPromptsShow(rest, config);
    case 'peek':     return runPromptsShow(rest, config);
    case 'archive':  return runPromptsArchive(rest, config, opts);
    case 'new':      return runPromptsNew(rest, config, opts);
    case 'hold':     return runPromptsHold(rest, config, opts);
    case 'unhold':   return runPromptsUnhold(rest, config, opts);
    case 'shelve':   return runPromptsHold(rest, config, opts);
    case 'unshelve': return runPromptsUnhold(rest, config, opts);
  }
}

function runPromptsList(argv, config, opts = {}) {
  const index = buildIndex(config);
  const hasStatusFlag = argv.includes('--status');
  const includeArchived = argv.includes('--include-archived');
  const sub = argv[0];
  const json = argv.includes('--json');

  if (opts.verbose && !json) {
    renderPromptsVerbose(index, config, { hasStatusFlag, includeArchived });
    return;
  }

  const hasPositionalFilter = argv.some(a => !a.startsWith('-') && a !== 'list');
  if (!json && !hasStatusFlag && !includeArchived && !hasPositionalFilter && sub !== 'status' && !argv.some(a => a.startsWith('--sort') || a.startsWith('--limit') || a === '--all')) {
    renderPromptQueueList(index, config);
    return;
  }

  let defaults;
  let extras = argv;
  if (sub === 'status') {
    defaults = ['--type', 'prompt', '--exclude-archived', '--sort', 'status', '--all'];
    extras = argv.slice(1);
  } else if (hasStatusFlag || includeArchived) {
    defaults = ['--type', 'prompt', '--sort', 'updated', '--limit', '10'];
  } else {
    defaults = ['--type', 'prompt', '--exclude-archived', '--sort', 'updated', '--limit', '10'];
  }
  runQuery(index, [...defaults, ...extras], config, { preset: 'prompts' });
}

function renderPromptQueueList(index, config) {
  const queue = pendingPromptsOldestFirst(config);
  const queuedPaths = new Set(queue.map(q => q.doc.path));
  const others = index.docs
    .filter(d => d.type === 'prompt' && !queuedPaths.has(d.path) && !isArchivedPath(d.path, config) && d.status !== 'archived')
    .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '') || (a.title ?? a.path).localeCompare(b.title ?? b.path));
  const prompts = [...queue.map(q => q.doc), ...others];

  if (prompts.length === 0) {
    process.stdout.write('No prompts.\n');
    return;
  }

  const counts = {};
  for (const p of prompts) counts[p.status ?? 'unknown'] = (counts[p.status ?? 'unknown'] ?? 0) + 1;
  const summary = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(' · ');
  process.stdout.write(dim(`${prompts.length} prompts · ${summary}`) + '\n\n');

  const maxSlug = Math.min(36, Math.max(...prompts.map(p => path.basename(p.path, '.md').length)));
  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    const slug = path.basename(p.path, '.md').padEnd(maxSlug);
    const marker = i === 0 && p.status === 'pending' ? green('[NEXT]') : '      ';
    const status = `[${(p.status ?? 'unknown').toUpperCase()}]`;
    process.stdout.write(`  ${marker} ${slug} ${status}\n`);
  }
}

// Resolve a prompt's "target plan" for `prompts list --verbose`. Order:
//   1. frontmatter `related_plans:` (first entry — assumed plan slug)
//   2. frontmatter `parent_plan:`
//   3. first body markdown link to a .md file
// Returns a repo-relative display path or null.
function findPromptTarget(promptDoc, config) {
  const refs = promptDoc.refFields ?? {};
  const fmTargets = [...(refs.related_plans ?? []), ...(refs.parent_plan ?? [])];
  for (const t of fmTargets) {
    if (typeof t === 'string' && t.trim()) return slugToPlanPath(t.trim(), config);
  }

  const links = promptDoc.bodyLinks ?? [];
  const mdLink = links.find(l => l.targetKind === 'document');
  if (mdLink) return resolveBodyLink(mdLink.href, promptDoc.path);
  return null;
}

// Plan slugs in frontmatter (e.g. `related_plans: [foo-bar]`) resolve to
// <docs-root>/plans/<slug>.md.
function slugToPlanPath(s, config) {
  const cleaned = s.replace(/#.*$/, '').replace(/^\.\//, '');
  if (cleaned.includes('/') || cleaned.endsWith('.md')) return cleaned;
  return `${config.docsRootPrefix || 'docs/'}plans/${cleaned}.md`;
}

// Resolve a markdown body link relative to the prompt's location so e.g.
// `../plans/foo.md` from docs/prompts/x.md → docs/plans/foo.md.
function resolveBodyLink(link, promptRepoPath) {
  const cleaned = link.replace(/#.*$/, '').replaceAll('\\', '/');
  if (cleaned.startsWith('/')) return cleaned.replace(/^\/+/, '');
  const promptDir = path.posix.dirname(promptRepoPath.replaceAll('\\', '/'));
  return path.posix.normalize(path.posix.join(promptDir, cleaned));
}

function renderPromptsVerbose(index, config, { hasStatusFlag, includeArchived }) {
  let prompts = index.docs.filter(d => d.type === 'prompt');
  if (!hasStatusFlag && !includeArchived) {
    prompts = prompts.filter(d => d.status !== 'archived');
  }
  if (prompts.length === 0) {
    process.stdout.write('No prompts.\n');
    return;
  }

  prompts.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));

  const counts = {};
  for (const p of prompts) counts[p.status ?? 'unknown'] = (counts[p.status ?? 'unknown'] ?? 0) + 1;
  const summary = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(' · ');
  process.stdout.write(`${prompts.length} prompt${prompts.length === 1 ? '' : 's'} · ${summary}\n\n`);

  for (const p of prompts) {
    const slug = path.basename(p.path, '.md');
    const target = findPromptTarget(p, config);
    const status = (p.status ?? 'unknown').toUpperCase();
    const arrow = target ? `  ${dim('→')} ${target}` : `  ${dim('→ (no target plan)')}`;
    process.stdout.write(`  ${green(slug)}  [${status}]\n${arrow}\n`);
  }
}

export function pendingPromptsOldestFirst(config) {
  const index = buildIndex(config, { fast: true, invokeHooks: false });
  const actionable = actionablePromptStatuses(config);
  const prompts = index.docs.filter(d =>
    d.type === 'prompt'
    && actionable.has(d.status)
    && !isArchivedPath(d.path, config),
  );

  return prompts
    .sort(comparePromptDocs)
    .map(d => ({ doc: d, abs: resolveDocPath(d.path, config), created: d.created ?? '' }));
}

async function runPromptsNext(argv, config, opts = {}) {
  const queue = pendingPromptsOldestFirst(config);
  if (queue.length === 0) {
    die('No pending prompts.');
  }
  const head = queue[0];
  if (!head.abs) die(`Could not resolve path: ${head.doc.path}`);
  return consumePrompt(head.abs, config, opts);
}

// Resolve user input to a prompt path. Tries (in order): exact path,
// path + '.md', exact basename match across type: prompt docs, substring
// match across type: prompt docs. Returns the absolute path or dies with a
// helpful message (no match / ambiguous match).
export function resolvePromptInput(input, config, options = {}) {
  const dieOnMiss = options.dieOnMiss !== false;
  const direct = resolveDocPath(input, config);
  if (direct) return direct;

  if (!input.endsWith('.md')) {
    const withExt = resolveDocPath(input + '.md', config);
    if (withExt) return withExt;
  }

  const index = buildIndex(config, { fast: true, invokeHooks: false });
  const prompts = index.docs.filter(d => d.type === 'prompt');
  if (prompts.length === 0) {
    if (dieOnMiss) die(`No prompts in the index.`);
    return null;
  }

  const slug = input.replace(/\.md$/, '');

  const byBasename = prompts.filter(d => path.basename(d.path, '.md') === slug);
  if (byBasename.length === 1) return path.resolve(config.repoRoot, byBasename[0].path);
  if (byBasename.length > 1) {
    die(`Multiple prompts match "${input}" by basename:\n${byBasename.map(d => '  ' + d.path).join('\n')}`);
  }

  const bySubstring = prompts.filter(d =>
    d.path.includes(slug) || path.basename(d.path).includes(slug),
  );
  if (bySubstring.length === 1) return path.resolve(config.repoRoot, bySubstring[0].path);
  if (bySubstring.length > 1) {
    die(`Multiple prompts match "${input}":\n${bySubstring.map(d => '  ' + d.path).join('\n')}`);
  }

  if (dieOnMiss) die(`No prompt found matching: ${input}`);
  return null;
}

async function runPromptsUse(argv, config, opts = {}) {
  const input = argv.find(a => !a.startsWith('-'));
  if (!input) die('Usage: dotmd prompts use <file-or-slug>');
  const noIndex = argv.includes('--no-index') || opts.noIndex;
  const showFiles = argv.includes('--show-files') || opts.showFiles;
  const filePath = resolvePromptInput(input, config);
  return consumePrompt(filePath, config, { ...opts, noIndex, showFiles });
}

export async function consumePrompt(filePath, config, opts) {
  const { dryRun, noIndex, showFiles } = opts;
  filePath = authorizeManagedSource(filePath, config, { kind: 'Prompt consumption source' }).path;
  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter, body } = extractFrontmatter(raw);
  const parsed = parseSimpleFrontmatter(frontmatter);
  const docType = asString(parsed.type);
  const status = asString(parsed.status);
  const repoPath = toRepoPath(filePath, config.repoRoot);

  if (docType !== 'prompt') {
    die(`Not a prompt (type: ${docType ?? 'unknown'}): ${repoPath}`);
  }
  if (status === 'archived' || isArchivedPath(repoPath, config)) {
    die(`Already consumed: ${repoPath}`);
  }

  const planRef = asString(parsed.plan);
  let linkedClaim = null;
  let claimSkipReason = null;
  if (planRef) {
    const outcome = prepareLinkedPromptClaim(planRef, config, path.dirname(filePath));
    if (outcome?.skipped) claimSkipReason = outcome.reason;
    else linkedClaim = outcome;
  }

  if (dryRun) {
    const prefix = dim('[dry-run]');
    process.stderr.write(`${prefix} Would emit body and archive: ${repoPath} (${status ?? 'unknown'} → archived)\n`);
    if (claimSkipReason) process.stderr.write(`${prefix} Would NOT claim the linked plan: ${claimSkipReason}\n`);
    const bytes = Buffer.byteLength(body, 'utf8');
    const lines = body.split('\n').length;
    process.stderr.write(`${prefix} body preview (${bytes}B, ${lines} lines):\n`);
    process.stderr.write(`${dim('---8<---')}\n`);
    process.stderr.write(body);
    if (!body.endsWith('\n')) process.stderr.write('\n');
    process.stderr.write(`${dim('--->8---')}\n`);
    runArchive([filePath], config, { dryRun: true, noIndex, out: process.stderr, skipInboundRefs: true });
    return;
  }

  // Archive BEFORE emitting the body. If runArchive throws (git mv failure,
  // hook crash, anything), the body must not have already gone to stdout —
  // otherwise `claude "$(dotmd prompts next)"` consumes the prompt without it
  // ever being archived, and the next session sees the same prompt as pending.
  const archiveResult = runArchive([filePath], config, {
    noIndex,
    showFiles,
    out: process.stderr,
    testHooks: opts.testHooks,
    deferIndex: Boolean(linkedClaim),
    // Saved prompts are gitignored session state, never durable reference
    // targets. Avoid locking and replanning the entire corpus on consumption.
    skipInboundRefs: true,
    additionalUpdates: linkedClaim?.prepared?.updates,
    creations: linkedClaim?.prepared?.creations,
    // An adopt-shaped claim writes no plan content, so the plan file rides
    // along as a read-only guard — the claim is only valid while the plan still
    // says what the disposition was read from.
    guards: linkedClaim?.prepared?.guards,
  });
  const consumedBody = archiveResult?.consumedBody ?? body;

  const consumedPath = archiveResult?.newRepoPath ?? repoPath;
  // Consume output is at-most-once: archive/claim commits before stdout. A
  // downstream failure cannot roll the transaction back or make it consumable
  // again; the archived path remains available through `prompts show`.
  await writeConsumedBody(consumedBody, consumedPath, opts.writeBody, linkedClaim?.repoPath);
  let completion = { indexRegenerated: false, ownershipChanged: false, hook: 'none', pending: false };
  if (linkedClaim) {
    try {
      completion = completePlanClaim(linkedClaim.repoPath, config, opts);
      if (!noIndex && config.indexPath && !completion.indexRegenerated) {
        regenIndex(config, { throwOnError: true, testHooks: opts.testHooks });
        completion.indexRegenerated = true;
      }
    } catch (err) {
      throw new Error(`Prompt consumed and body delivered; linked claim completion remains pending for ${linkedClaim.repoPath}: ${err.message}`);
    }
    process.stderr.write(`${green('→ Claimed')}: ${linkedClaim.repoPath} (in-session)\n`);
  }
  if (claimSkipReason) process.stderr.write(`${yellow('→ Not claimed')}: ${claimSkipReason}\n`);
  process.stderr.write(`${green('✓ Consumed')}: ${consumedPath}\n`);
  const ownershipRecordPath = linkedClaim?.prepared?.recordPath ?? (linkedClaim ? readPlanOwnership(linkedClaim.repoPath, config)?.recordPath : null);
  const ownershipPath = ownershipRecordPath ? toRepoPath(ownershipRecordPath, config.repoRoot) : null;
  const normalize = candidate => path.isAbsolute(candidate) ? toRepoPath(candidate, config.repoRoot) : candidate.split(path.sep).join('/');
  const resultPaths = [
    ...(linkedClaim?.planChanged ? [linkedClaim.repoPath] : []),
    ...(archiveResult?.referencePaths ?? []),
  ].filter(Boolean).map(normalize);
  const ownershipResultPaths = resultPaths.filter(candidate => candidate.startsWith('.dotmd/ownership/'));
  const repositoryFiles = [...new Set(resultPaths.filter(candidate => !candidate.startsWith('.dotmd/ownership/')))];
  const sessionFiles = [...new Set([
    repoPath,
    consumedPath,
    (linkedClaim?.prepared || completion.ownershipChanged) ? ownershipPath : null,
    ...ownershipResultPaths,
  ].filter(Boolean).map(normalize))];
  return {
    operation: 'consume',
    status: { from: status ?? null, to: 'archived', changed: true },
    repositoryFiles,
    sessionFiles,
    generatedFiles: config.indexPath && !noIndex && (completion.indexRegenerated || archiveResult?.indexRegenerated) ? [toRepoPath(config.indexPath, config.repoRoot)] : [],
    deferredGeneratedFiles: config.indexPath && noIndex ? [toRepoPath(config.indexPath, config.repoRoot)] : [],
    claim: linkedClaim ? { plan: linkedClaim.repoPath, changed: linkedClaim.planChanged, pendingCompletion: completion.pending, hook: completion.hook } : null,
  };
}

export async function writeConsumedBody(body, archivedPath, write = null, linkedPlan = null) {
  const content = body.endsWith('\n') ? body : `${body}\n`;
  try {
    if (write) {
      const accepted = await write(content);
      if (accepted === false) throw Object.assign(new Error('writer reported unresolved backpressure'), { code: 'BACKPRESSURE' });
    } else {
      await new Promise((resolve, reject) => process.stdout.write(content, err => err ? reject(err) : resolve()));
    }
  }
  catch (err) {
    const completion = linkedPlan ? ` Then complete the linked claim with \`dotmd use ${linkedPlan}\`.` : '';
    throw new Error(`Prompt was consumed but body output failed (${err.code ?? err.message}). It will not be emitted again; recover it with \`dotmd prompts show ${archivedPath}\`.${completion}`);
  }
}

// `planRef` is a reference written in the prompt's own frontmatter, so it obeys
// the same convention every other ref field does: doc-relative first (baton's
// `../plans/x.md` from `docs/prompts/`), repo-root-relative second. Resolving it
// with `resolveDocPath` alone read only the repo-root form, so a doc-relative
// link — the form nothing validates, since `plan` is not a `referenceFields`
// entry — died as "missing" while pointing at a file that was plainly there.
// Why a linked plan could not be claimed, phrased so the reader knows what to
// do next. Each of these used to abort consumption entirely (see the skip
// contract on prepareLinkedPromptClaim).
// `startable` comes from the repo's own lifecycle config rather than the
// built-in default: a repo that configures its own startable statuses would
// otherwise be told to run `dotmd set active`, which its own validation
// rejects.
function explainUnclaimablePlan(disposition, repoPath, status, startable) {
  switch (disposition.kind) {
    case 'parked':
      return `${repoPath} is ${status} — \`dotmd set ${startable} ${repoPath}\` to unpark it, then \`dotmd use ${repoPath}\``;
    case 'busy':
      return `${repoPath} is claimed by another session (${disposition.owner})`;
    case 'terminal':
    case 'physical-archive':
      return `${repoPath} is already closed (${status})`;
    case 'wrong-type':
      return `${repoPath} is not a plan`;
    case 'unconfigured-status':
      return `${repoPath} has a status this repo does not configure (${status ?? 'none'})`;
    case 'ownership-corrupt':
      return `${repoPath} has an unreadable ownership record — \`dotmd doctor --claims\``;
    default:
      return `${repoPath} cannot be claimed (${disposition.kind})`;
  }
}

// Returns a claim, or `{ skipped, reason }` when the linked plan cannot be
// claimed. It never refuses the consumption itself.
//
// It used to `die` on all three of these paths, which deadlocked the handoff
// loop the feature exists to close: `dotmd baton` stamps this link and parks
// the plan in the same breath, and five of the seven statuses it parks with are
// not startable — so baton routinely produced a prompt that `dotmd use` would
// refuse forever, while the SessionStart hud kept telling every new session to
// run exactly that command. The body is the whole point of a saved prompt, and
// no reason to skip the claim is a reason to withhold it.
function prepareLinkedPromptClaim(planRef, config, promptDir) {
  const skip = reason => ({ skipped: true, reason });
  let planPath = resolveRefPath(planRef, promptDir, config.repoRoot)
    ?? resolveDocPath(planRef, config)
    ?? resolveDocArg(planRef, config, { dieOnMiss: false });
  if (!planPath || !existsSync(planPath)) return skip(`linked plan is missing (moved or renamed): ${planRef}`);
  planPath = authorizeManagedSource(planPath, config, { kind: 'Prompt linked plan source' }).path;
  const raw = readFileSync(planPath, 'utf8');
  let parsed;
  try { parsed = parseSimpleFrontmatter(extractFrontmatter(raw).frontmatter); }
  catch { return skip(`linked plan has malformed frontmatter: ${toRepoPath(planPath, config.repoRoot)}`); }
  const repoPath = toRepoPath(planPath, config.repoRoot);
  const sessionId = authoritativeSessionId();
  const ownership = readPlanOwnership(repoPath, config);
  const oldStatus = asString(parsed.status);
  const disposition = classifyPlanPickup({
    type: asString(parsed.type),
    status: oldStatus,
    ownerLiveness: ownershipLiveness(ownership),
    validStatuses: config.typeStatuses?.get('plan') ?? config.validStatuses,
    startableStatuses: config.lifecycle.startableStatuses,
    terminalStatuses: config.lifecycle.terminalStatuses,
    archiveStatuses: config.lifecycle.archiveStatuses,
    physicallyArchived: isArchivedPath(repoPath, config),
    ownership,
    sessionId,
    malformed: false,
  });
  if (!disposition.pickupable) {
    const startable = [...(config.lifecycle.startableStatuses ?? [])][0] ?? 'active';
    return skip(explainUnclaimablePlan(disposition, repoPath, oldStatus, startable));
  }
  if (disposition.kind === 'resume') return { planPath, repoPath, prepared: null, planChanged: false, disposition: disposition.kind };
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const rendered = disposition.kind === 'start'
    ? renderLifecycleMutation(raw, { status: 'in-session', updated: now }, `Started (${oldStatus} → in-session).`, { createSection: true })
    : null;
  const prepared = preparePlanClaim({ filePath: planPath, sourceContent: raw, renderedContent: rendered,
    ownership, sessionId, now, config });
  return {
    planPath,
    repoPath,
    prepared,
    planChanged: prepared.updates.some(item => path.resolve(item.path) === path.resolve(planPath)),
    disposition: disposition.kind,
  };
}

// Read-only peek: print the body WITHOUT consuming. The sanctioned triage path
// — surveying pending prompts must not archive them (that's `use`'s job), and
// it must not require raw cat/Read (which the guard warns about).
// Read one prompt for peeking. Returns null rather than dying so a bulk sweep
// isn't aborted by a single bad doc.
function readPromptForShow(filePath, config, { strict }) {
  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter, body } = extractFrontmatter(raw);
  const parsed = parseSimpleFrontmatter(frontmatter);
  const repoPath = toRepoPath(filePath, config.repoRoot);
  if (asString(parsed.type) !== 'prompt') {
    if (strict) die(`Not a prompt (type: ${asString(parsed.type) ?? 'unknown'}): ${repoPath}`);
    return null;
  }
  return { repoPath, body, status: asString(parsed.status) ?? 'unknown' };
}

// Triage the queue without consuming it. Bulk mode exists because surveying a
// backlog was the one thing `show` could not do: sessions sweeping 25-28 saved
// prompts had to fall back to Read, which the guard then warned about once per
// file. `--all` and multiple paths make the supported route the cheap one.
function runPromptsShow(argv, config) {
  const all = argv.includes('--all');
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number.parseInt(argv[limitIdx + 1], 10) : null;
  if (limitIdx >= 0 && (!Number.isInteger(limit) || limit < 1)) {
    die('--limit takes a positive integer.');
  }
  // Skip the value that belongs to --limit; it is not a prompt name. Guard the
  // absent case explicitly — limitIdx is -1 there, and -1 + 1 would drop argv[0].
  const limitValueIdx = limitIdx >= 0 ? limitIdx + 1 : -1;
  const inputs = argv.filter((a, i) => !a.startsWith('-') && i !== limitValueIdx);

  if (!inputs.length && !all) {
    die('Usage: dotmd prompts show <file-or-slug>...\n       dotmd prompts show --all [--limit N]   # peek the whole pending queue');
  }
  if (inputs.length && all) die('Pass either prompt names or --all, not both.');

  let targets;
  if (all) {
    const queue = pendingPromptsOldestFirst(config);
    if (!queue.length) die('No pending prompts.');
    targets = queue.filter(entry => entry.abs).map(entry => entry.abs);
  } else {
    targets = inputs.map(input => resolvePromptInput(input, config));
  }
  const total = targets.length;
  if (limit !== null) targets = targets.slice(0, limit);

  // Single-target output is unchanged: bare body on stdout, one dim header on
  // stderr. Only a multi-target sweep adds separators, so scripts piping one
  // prompt keep working.
  const multi = targets.length > 1;
  let shown = 0;
  for (const filePath of targets) {
    const prompt = readPromptForShow(filePath, config, { strict: !all && !multi });
    if (!prompt) continue;
    const { repoPath, body, status } = prompt;
    if (multi) {
      if (shown > 0) process.stdout.write('\n');
      process.stdout.write(dim(`──── ${repoPath} [${status}] ────\n`));
    } else {
      process.stderr.write(dim(`${repoPath} [${status}] — read-only peek; \`dotmd use ${repoPath}\` to consume\n`));
    }
    process.stdout.write(body);
    if (!body.endsWith('\n')) process.stdout.write('\n');
    shown++;
  }

  // Footer whenever the sweep showed more than one OR hid some: a truncated
  // --limit 1 collapses to single-prompt formatting, and silently dropping the
  // rest would read as "that's the whole queue".
  const truncated = total > targets.length;
  if (multi || truncated) {
    const suffix = truncated ? ` of ${total} (use --limit to change)` : '';
    process.stderr.write(dim(`\n${shown} prompt${shown === 1 ? '' : 's'}${suffix} — read-only peek; \`dotmd use <file>\` to consume one\n`));
  }
}

function runPromptsArchive(argv, config, opts = {}) {
  const input = argv.find(a => !a.startsWith('-'));
  if (!input) die('Usage: dotmd prompts archive <file-or-slug>');
  const noIndex = argv.includes('--no-index') || opts.noIndex;
  const showFiles = argv.includes('--show-files') || opts.showFiles;
  const filePath = resolvePromptInput(input, config);

  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter } = extractFrontmatter(raw);
  const parsed = parseSimpleFrontmatter(frontmatter);
  if (asString(parsed.type) !== 'prompt') {
    die(`Not a prompt: ${toRepoPath(filePath, config.repoRoot)}`);
  }

  runArchive([filePath], config, { ...opts, noIndex, showFiles });
}

async function runPromptsNew(argv, config, opts = {}) {
  if (!argv[0] || argv[0].startsWith('-')) {
    die('Usage: dotmd prompts new <slug> [body]\n       body: inline text | piped stdin (auto) | "@path" (file) | --body "..."');
  }
  return runNew(['prompt', ...argv], config, opts);
}

async function runPromptsHold(argv, config, opts = {}) {
  const input = argv.find(a => !a.startsWith('-'));
  if (!input) die('Usage: dotmd prompts hold <file-or-slug>');
  const filePath = resolvePromptInput(input, config);
  return runStatus([filePath, 'held'], config, opts);
}

async function runPromptsUnhold(argv, config, opts = {}) {
  const input = argv.find(a => !a.startsWith('-'));
  if (!input) die('Usage: dotmd prompts unhold <file-or-slug>');
  const filePath = resolvePromptInput(input, config);
  return runStatus([filePath, 'pending'], config, opts);
}
