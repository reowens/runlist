import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { resolveDocArg } from './index.mjs';
import { authorizeManagedSource } from './managed-path.mjs';
import { mutateFileSet } from './atomic-mutation.mjs';
import { availableSessionId, assertPlanMutationAuthorized } from './pickup.mjs';
import { regenIndex, renderLifecycleMutation, runArchive } from './lifecycle.mjs';
import { isArchivedPath, nowIso, resolveRefPath, toRepoPath } from './util.mjs';
import { validateCommandArgs } from './commands.mjs';
import { compareYardstick, readYardstick, renderYardstick, YARDSTICK_FIELDS } from './yardstick.mjs';

function readPlan(input, config) {
  const resolved = resolveDocArg(input, config, { dieOnMiss: false });
  if (!resolved) throw new Error(`Plan not found: ${input}`);
  const file = authorizeManagedSource(resolved, config, { kind: 'Yardstick plan' }).path;
  const raw = readFileSync(file, 'utf8');
  const warnings = [];
  const { frontmatter } = extractFrontmatter(raw);
  const fm = parseSimpleFrontmatter(frontmatter, warnings);
  if (fm.type !== 'plan') throw new Error('Yardstick assessments apply only to plans.');
  if (warnings.some(item => ['type', 'status', ...YARDSTICK_FIELDS].includes(item.key))) {
    throw new Error('Duplicate lifecycle/yardstick fields must be resolved before an assessment.');
  }
  const repoPath = toRepoPath(file, config.repoRoot);
  return { file, raw, fm, repoPath, archived: isArchivedPath(repoPath, config) && config.lifecycle.archiveStatuses.has(fm.status) };
}

function authorizePlan(plan, config) {
  const ownership = assertPlanMutationAuthorized(plan.repoPath, config, { sessionId: availableSessionId() });
  if (plan.fm.status === 'in-session' && ownership?.state !== 'owned') {
    throw new Error('The in-session plan has no valid ownership record; recover its claim before assessing it.');
  }
}

// Replace entire YAML field spans, including duplicates and multiline values,
// without removing comments or any unrelated frontmatter/body text.
export function renderAssessment(raw, fields) {
  const { frontmatter, body, bodyLineOffset } = extractFrontmatter(raw);
  if (!bodyLineOffset) throw new Error('Plan needs a valid frontmatter block.');
  const lines = frontmatter.split('\n');
  const kept = [];
  let skip = false;
  for (const line of lines) {
    const key = line.match(/^([A-Za-z0-9_-]+):/);
    if (key) skip = YARDSTICK_FIELDS.includes(key[1]);
    if (!skip || /^\s*#/.test(line)) kept.push(line);
  }
  for (const [key, value] of Object.entries(fields)) kept.push(`${key}: ${JSON.stringify(value)}`);
  return `---\n${kept.join('\n')}\n---\n${body}`;
}

function replacementChain(source, input, config) {
  const target = readPlan(input, config);
  const seen = new Set([realpathSync(source.file)]);
  const guards = [];
  let current = target;
  while (current) {
    const identity = realpathSync(current.file);
    if (seen.has(identity)) throw new Error('A fold cannot reference itself or create a circular replacement chain.');
    seen.add(identity);
    guards.push({ path: current.file, expectedContent: current.raw });
    if (current.fm.yardstick_disposition !== 'folded') break;
    const ref = current.fm.yardstick_into;
    if (typeof ref !== 'string' || !ref.trim()) throw new Error('The replacement chain has a missing plan link.');
    const next = resolveRefPath(ref, path.dirname(current.file), config.repoRoot);
    if (!next) throw new Error('The replacement chain has an unavailable plan.');
    current = readPlan(next, config);
  }
  return { target, guards };
}

// Trusted adapters use this before loading a retained review's configuration.
export function assertYardstickReviewGuards(guards = []) {
  for (const guard of guards) {
    if (guard.absent ? existsSync(guard.path) : !existsSync(guard.path)
      || readFileSync(guard.path, 'utf8') !== guard.expectedContent) {
      throw new Error('Yardstick review material changed; reload before applying.');
    }
  }
}

export async function runYardstick(argv, config, opts = {}) {
  argv = validateCommandArgs('yardstick', argv);
  const out = opts.out ?? process.stdout;
  const dryRun = Boolean(opts.dryRun);
  const json = argv.includes('--json');
  const noIndex = argv.includes('--no-index');
  const values = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reason' || argv[i] === '--into') values[argv[i]] = argv[++i];
    else if (!argv[i].startsWith('--')) positional.push(argv[i]);
  }
  const [action, input, disposition] = positional;
  // Trusted local adapters retain these snapshots between Review and Apply.
  // They are never command-line arguments or renderer-controlled material.
  assertYardstickReviewGuards(opts.guards);
  const goal = readYardstick(config);
  if (action === 'show') {
    const plan = input ? readPlan(input, config) : null;
    const comparison = plan ? compareYardstick(plan.fm, config, goal, plan.archived)
      : { goal, delivers: null, assessment: null };
    const result = { ...(plan ? { path: plan.repoPath } : {}), ...comparison };
    out.write(json ? `${JSON.stringify(result, null, 2)}\n` : renderYardstick(result));
    return result;
  }

  const plan = readPlan(input, config);
  authorizePlan(plan, config);
  if (goal.snapshot) {
    const sourceNode = statSync(plan.file);
    const goalNode = statSync(goal.snapshot.path);
    if (sourceNode.dev === goalNode.dev && sourceNode.ino === goalNode.ino) {
      throw new Error('Keep the product goal in a separate document; it cannot assess or archive itself.');
    }
  }
  if (action === 'mark' && disposition !== 'serves') throw new Error('Use mark <plan> serves; close and fold are explicit archive actions.');
  if (action !== 'clear' && goal.state !== 'ready') throw new Error(`Product goal is unavailable: ${goal.message ?? 'configure yardstick first'}`);
  const reason = values['--reason']?.trim();
  if (['close', 'fold'].includes(action) && !reason) throw new Error('Closing or folding requires --reason with the owner reason.');
  if (values['--reason'] !== undefined && (!reason || reason.includes('\0'))) throw new Error('Reason must be nonempty text without NUL characters.');
  const closing = action === 'close' || action === 'fold';
  const fields = action === 'clear' ? {} : {
    yardstick_disposition: action === 'mark' ? 'serves' : action === 'fold' ? 'folded' : 'closed',
    yardstick_revision: goal.revision,
    ...(reason ? { yardstick_reason: reason } : {}),
  };
  const guards = [{ path: plan.file, expectedContent: plan.raw }, ...(opts.guards ?? [])];
  if (action !== 'clear') guards.push(goal.snapshot);
  if (action === 'fold') {
    if (!values['--into']) throw new Error('Folding requires --into with a replacement plan.');
    const chain = replacementChain(plan, values['--into'], config);
    fields.yardstick_into = `./${path.relative(path.dirname(plan.file), chain.target.file).split(path.sep).join('/')}`;
    guards.push(...chain.guards);
  }
  const history = action === 'clear' ? 'Yardstick assessment cleared; execution status unchanged.'
    : `Yardstick: ${fields.yardstick_disposition}${fields.yardstick_into ? ` into ${fields.yardstick_into}` : ''}${reason ? ` — ${reason.replace(/\r?\n/g, ' ')}` : '.'}`;
  let result = { action, dryRun, path: plan.repoPath, assessment: fields, archived: plan.archived };
  let archiveOutput = '';
  if (closing && !plan.archived) {
    const archived = runArchive([plan.file, ...(noIndex ? ['--no-index'] : [])], config, {
      dryRun, out: { write(text) { archiveOutput += text; } }, note: history, guards, testHooks: opts.testHooks,
      expectedDestination: opts.expectedDestination,
      sourceTransform: raw => renderAssessment(raw, fields),
    });
    // Healing an already archived path previews an in-place change; the
    // lifecycle dry-run intentionally has no move result in that case.
    result = { ...result, archived: true, path: archived?.newRepoPath ?? plan.repoPath, previousPath: plan.repoPath, touched: archived?.touched ?? [] };
    result.lifecycle = archiveOutput.trimEnd();
  } else if (!dryRun) {
    mutateFileSet({ guards, updates: [{ path: plan.file, expectedContent: plan.raw, render: raw => {
      authorizePlan(plan, config);
      return renderLifecycleMutation(renderAssessment(raw, fields), { updated: nowIso() }, history, { createSection: true });
    } }] }, { repoRoot: config.repoRoot, testHooks: opts.testHooks });
    if (!noIndex) regenIndex(config);
    result.touched = [plan.repoPath];
  }
  if (!dryRun) {
    const actual = readPlan(result.path, config);
    result.comparison = compareYardstick(actual.fm, config, readYardstick(config), actual.archived);
  } else if (opts.captureGuards) {
    // GUI Review must show the same literal material these snapshots guard,
    // including the proposed assessment, rather than an earlier panel read.
    const proposed = Object.fromEntries(Object.entries(plan.fm).filter(([key]) => !YARDSTICK_FIELDS.includes(key)));
    result.comparison = compareYardstick({ ...proposed, ...fields }, config, goal, closing || plan.archived);
  }
  if (json) out.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    if (archiveOutput) out.write(archiveOutput);
    out.write(`${dryRun ? '[dry-run] Would record' : 'Recorded'} yardstick ${action}: ${result.path}${closing ? ' (archived)' : ''}\n`);
    if (dryRun && reason) out.write(`Owner reason: ${reason}\n`);
    if (dryRun && fields.yardstick_into) out.write(`Replacement (relative to the original plan): ${fields.yardstick_into}\n`);
    if (result.comparison) out.write(renderYardstick(result.comparison, { compact: true }));
  }
  if (opts.captureGuards) Object.defineProperty(result, 'preparedGuards', { value: guards });
  return result;
}
