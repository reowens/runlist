import path from 'node:path';
import { collectMembershipBackrefCandidates } from './hub-membership.mjs';
import { planChildParentUpdate } from './parent-plan.mjs';
import { mutateFileSet, MutationConflictError } from './atomic-mutation.mjs';
import { authorizeManagedSweep } from './managed-path.mjs';
import { isHubDoc } from './hub.mjs';
import { bold, dim, green, yellow } from './color.mjs';
import { die } from './util.mjs';

function resolveHubArgs(args, docs) {
  const paths = new Set();
  for (const arg of args) {
    const slug = arg.replace(/\.md$/, '');
    const matches = docs.filter(doc =>
      doc.path === arg || doc.path === `${slug}.md`
      || path.basename(doc.path, '.md') === path.basename(slug));
    if (matches.length === 0) die(`No doc matches "${arg}".`);
    if (matches.length > 1) {
      die(`Multiple docs match "${arg}":\n${matches.map(match => `  ${match.path}`).join('\n')}`);
    }
    const [match] = matches;
    if (!isHubDoc(match)) {
      die(`${match.path} is not a hub — it has no \`runlist:\` and no \`execution_mode: coordination|roadmap\`. `
        + 'Run `dotmd fix-membership` with no argument to sweep every hub.');
    }
    paths.add(match.path);
  }
  return paths;
}

export function fixMembershipBackrefs(config, {
  docs,
  dryRun = false,
  hubPaths = null,
  quiet = false,
  testHooks,
} = {}) {
  const planned = collectMembershipBackrefCandidates(docs, config, { hubPaths });
  const updates = [];
  const changes = [];
  const skipped = [];
  const guardByPath = new Map();

  testHooks?.afterMembershipCandidates?.(planned);
  for (const candidate of planned.candidates) {
    if (candidate.childType !== 'plan') {
      skipped.push({ path: candidate.childPath, hub: candidate.hubPath, reason: 'untyped-child' });
      continue;
    }
    const update = planChildParentUpdate(candidate.childAbs, candidate.hubAbs, config);
    if (update.raw !== candidate.childRaw) {
      throw new MutationConflictError(`Child changed while membership repair was being prepared: ${candidate.childPath}`);
    }
    if (!update.update) {
      skipped.push({
        path: candidate.childPath,
        hub: candidate.hubPath,
        reason: update.reason,
        ...(update.existing ? { existing: update.existing } : {}),
      });
      continue;
    }
    updates.push(update.update);
    guardByPath.set(candidate.hubAbs, { path: candidate.hubAbs, expectedContent: candidate.hubRaw });
    changes.push({
      path: candidate.childPath,
      hub: candidate.hubPath,
      ref: update.ref,
      sources: candidate.sources,
    });
  }

  const ambiguous = planned.ambiguous.map(item => ({ path: item.childPath, hubs: item.hubPaths }));
  const managed = [
    ...updates.map(update => update.path),
    ...guardByPath.values().map(guard => guard.path),
  ];
  if (managed.length) authorizeManagedSweep(managed, config, { kind: 'Membership repair source' });

  testHooks?.afterMembershipPlan?.({ changes, ambiguous, skipped });
  if (!dryRun && updates.length > 0) {
    mutateFileSet({ updates, guards: [...guardByPath.values()] }, { repoRoot: config.repoRoot, testHooks });
  }

  const result = {
    fixed: changes.length,
    skipped: skipped.length + ambiguous.length,
    ambiguous: ambiguous.length,
    changes,
    skippedDetails: skipped,
    ambiguousDetails: ambiguous,
  };

  if (!quiet) {
    const prefix = dryRun ? `${dim('[dry-run]')} ` : '';
    for (const change of changes) {
      process.stdout.write(`${prefix}${green(dryRun ? 'Would set' : 'Set')}: ${change.path} `
        + `${dim(`parent_plan: ${change.ref} (stated by ${change.hub})`)}\n`);
    }
    for (const item of ambiguous) {
      process.stdout.write(yellow(`Skipped ambiguous membership: ${item.path} is ranked by ${item.hubs.join(', ')}.`) + '\n');
    }
    for (const item of skipped) {
      process.stdout.write(yellow(`Skipped membership repair: ${item.path} (${item.reason}).`) + '\n');
    }
    if (changes.length > 0) {
      process.stdout.write(`\n${bold(`${prefix}${changes.length} membership back-reference${changes.length === 1 ? '' : 's'} ${dryRun ? 'would be repaired' : 'repaired'}.`)}\n`);
    } else if (ambiguous.length === 0 && skipped.length === 0) {
      process.stdout.write(green('Membership back-references are in sync.') + '\n');
    }
  }
  return result;
}

export async function runFixMembership(argv, config, opts = {}) {
  const { buildIndex } = await import('./index.mjs');
  const json = argv.includes('--json');
  const hubArgs = argv.filter(arg => !arg.startsWith('-'));
  const docs = buildIndex(config).docs;
  const hubPaths = hubArgs.length ? resolveHubArgs(hubArgs, docs) : null;
  const result = fixMembershipBackrefs(config, {
    docs,
    dryRun: opts.dryRun,
    hubPaths,
    quiet: json,
    testHooks: opts.testHooks,
  });
  if (json) {
    process.stdout.write(`${JSON.stringify({ dryRun: Boolean(opts.dryRun), ...result }, null, 2)}\n`);
  }
  return result;
}
