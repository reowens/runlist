// Setup runs existing verbs in fresh processes: config imports cannot retain a
// policy from before a narrow edit, and verb exit codes cannot poison previews.
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { resolveConfig } from './config.mjs';
import { runInit } from './init.mjs';
import { runConfig } from './config-command.mjs';
import { runBulkTag } from './bulk-tag.mjs';
import { runNew, catchAllRoot, promptDirectory, titleize } from './new.mjs';
import { collectDocFiles, buildIndex, parseDocFile } from './index.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { authorizeManagedSource, authorizeRepoGeneratedPath } from './managed-path.mjs';
import { readTemplateStore } from './template-store.mjs';
import { regenIndex, renderLifecycleMutation } from './lifecycle.mjs';
import { snapshotFile, replaceSnapshot, inspectTransactions, recoverAbandonedTransactions, transactionResolutionAdvice } from './atomic-mutation.mjs';
import { planSetupCarry, applySetupCarry, cleanupSetupSourceDirectories } from './setup-carry.mjs';
import { planHandoffsUpgrade } from './handoffs-mode.mjs';

function regularOrMissing(file, directory = false) {
  let stat;
  try { stat = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) {
    throw new Error(`Setup destination must be a regular ${directory ? 'directory' : 'file'}: ${file}`);
  }
}

function firstPlan(config, choices) {
  if (!choices.firstPlan) return null;
  const custom = config.raw.templates?.plan;
  if (typeof custom === 'function' || custom?.frontmatter || custom?.body || readTemplateStore(config).data.templates.plan) {
    throw new Error('Setup cannot safely preview a custom plan template. Preserve it and create your plan separately with runlist new plan.');
  }
  const template = { dir: 'plans', targetRoot: 'plans', ...custom };
  const routed = template.targetRoot && config.docsRoots.find(root => root.endsWith(template.targetRoot) || path.basename(root) === template.targetRoot);
  const directory = routed || path.join(catchAllRoot(config), template.dir || '');
  const file = path.join(directory, `${choices.firstPlan}.md`);
  authorizeRepoGeneratedPath(file, config, { kind: 'Setup first-plan destination' });
  if (!config.docsRoots.some(root => file.startsWith(root + path.sep) || path.dirname(file) === root)) {
    throw new Error(`First-plan destination is outside configured roots: ${file}`);
  }
  if (existsSync(file)) throw new Error(`First plan already exists: ${file}. Inspect it with runlist show ${path.relative(config.repoRoot, file)}, choose another slug, or omit --first-plan.`);
  const statuses = config.typeStatuses.get('plan') ?? config.validStatuses;
  const status = statuses.has('planned') ? 'planned' : [...statuses][0];
  const title = titleize(choices.firstPlan);
  const body = `---\nsummary: ${JSON.stringify(choices.currentState)}\ncurrent_state: ${JSON.stringify(choices.currentState)}\nnext_step: ${JSON.stringify(choices.nextStep)}\n---\n# ${title}\n\n## Problem\n\n${choices.currentState}\n\n## Next step\n\n${choices.nextStep}\n`;
  const today = new Date().toISOString().slice(0, 10);
  const source = `---\ntype: plan\nstatus: ${status}\ncreated: ${today}\nupdated: ${today}\nsummary: ${JSON.stringify(choices.currentState)}\ncurrent_state: ${JSON.stringify(choices.currentState)}\nnext_step: ${JSON.stringify(choices.nextStep)}\n---\n# ${title}\n\n## Problem\n\n${choices.currentState}\n\n## Next step\n\n${choices.nextStep}\n`;
  const doc = parseDocFile(file, config, { source });
  if (doc.errors.length || doc.warnings.length) {
    throw new Error(`First-plan validation failed before writing:\n${[...doc.errors, ...doc.warnings].map(issue => issue.message).join('\n')}`);
  }
  return { path: file, status, body, argv: ['plan', path.relative(config.repoRoot, file), '--status', status, '--body', body], checks: { errors: doc.errors, warnings: doc.warnings } };
}

function scaffolding(config, existing, choices, moves = []) {
  const planTemplate = { dir: 'plans', targetRoot: 'plans', ...config.raw.templates?.plan };
  const routed = planTemplate.targetRoot && config.docsRoots.find(root => root.endsWith(planTemplate.targetRoot) || path.basename(root) === planTemplate.targetRoot);
  const plansDir = routed || path.join(catchAllRoot(config), planTemplate.dir || '');
  const typeDirs = [['plans', plansDir], ['prompts', promptDirectory(config)]].filter(([sub, target]) => {
    const sibling = path.join(config.repoRoot, sub);
    if (existsSync(target) || config.docsRoots.some(root => sibling === root || sibling.startsWith(root + path.sep)) || !existsSync(sibling)) return true;
    // Match init's refusal to create a parallel type directory beside an
    // already populated root-level plans/ or prompts/ directory.
    return moves.some(move => path.dirname(move.target) === target) || !readdirSync(sibling, { withFileTypes: true }).some(entry => entry.isFile() && entry.name.endsWith('.md'));
  });
  const dirs = [...config.docsRoots, ...typeDirs.map(([, target]) => target)];
  const files = existing ? [] : [config.configPath];
  const markers = [];
  for (const [i, dir] of dirs.entries()) {
    // Existing configured symlink roots are valid for read commands, but setup
    // does not extend them implicitly or publish generated files through them.
    authorizeRepoGeneratedPath(dir, config, { kind: 'Setup folder' });
    regularOrMissing(dir, true);
    if (i < config.docsRoots.length) continue;
    if ((!existsSync(dir) || readdirSync(dir).length === 0) && !moves.some(move => move.target.startsWith(dir + path.sep))) {
      markers.push(path.join(dir, '.gitkeep'));
    }
  }
  if (config.indexPath) files.push(config.indexPath);
  files.push(...markers);
  for (const file of files) {
    authorizeRepoGeneratedPath(file, config, { kind: 'Setup scaffold destination' });
    regularOrMissing(file);
  }
  const existingSample = path.join(plansDir, 'example-plan.md');
  return { folders: [...new Set(dirs)], files, sample: existsSync(existingSample) ? existingSample : null, gitignore: choices.gitignore ? path.join(config.repoRoot, '.gitignore') : null };
}

function adoption(config, file) {
  if (file === config.indexPath) throw new Error(`Cannot adopt the generated index: ${file}`);
  authorizeManagedSource(file, config, { kind: 'Setup adoption source' });
  const rel = path.relative(config.docsRoots.find(root => file.startsWith(root + path.sep)) ?? config.docsRoot, file);
  if (rel.split(path.sep).includes(config.archiveDir)) throw new Error(`Cannot adopt an archived document: ${file}`);
  let captured = '';
  const saved = process.stdout.write;
  try {
    process.stdout.write = chunk => { captured += chunk; return true; };
    runBulkTag([file, '--json'], config, { dryRun: true });
  } finally { process.stdout.write = saved; }
  const inferred = JSON.parse(captured).candidates[0];
  const source = readFileSync(file, 'utf8');
  const before = extractFrontmatter(source).frontmatter;
  const parsed = parseSimpleFrontmatter(before);
  const updates = { ...inferred?.updates };
  const type = inferred?.newType ?? parsed.type;
  const status = inferred?.newStatus ?? parsed.status;
  const valid = config.typeStatuses.get(type) ?? config.validStatuses;
  if (!config.validTypes.has(type) || !valid.has(status)) throw new Error(`Adoption has invalid type/status: ${file} (${type}/${status}). Tag it explicitly with runlist bulk-tag first.`);
  // Adoption modifies the file today. This date is factual; its original
  // creation date and authored summary/state are deliberately not invented.
  if (!parsed.updated || (Array.isArray(parsed.updated) && !parsed.updated.length)) updates.updated = new Date().toISOString().slice(0, 10);
  const serialized = Object.fromEntries(Object.entries(updates).map(([key, value]) => [key, /^[a-z][a-z0-9-]*$|^\d{4}-\d{2}-\d{2}$/.test(value) && !['true', 'false', 'null'].includes(value) ? value : JSON.stringify(value)]));
  let content = source;
  if (Object.keys(updates).length) {
    const normalized = source.replace(/\r\n/g, '\n');
    content = normalized.startsWith('---\n')
      ? renderLifecycleMutation(normalized, serialized, null)
      : `---\n${Object.entries(serialized).map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n${normalized}`;
    if (source.includes('\r\n')) content = content.replace(/\n/g, '\r\n');
  }
  const doc = parseDocFile(file, config, { source: content });
  if (doc.errors.length) throw new Error(`Selected adoption failed validation before writing: ${file}\n${doc.errors.map(issue => issue.message).join('\n')}\nResolve this document explicitly before setup.`);
  return { path: file, candidate: Object.keys(updates).length ? { ...inferred, newType: type, newStatus: status, updates } : null,
    beforeFrontmatter: before ?? '', afterFrontmatter: extractFrontmatter(content).frontmatter ?? '',
    checks: { errors: doc.errors, warnings: doc.warnings }, source, content };
}

function inventory(config) {
  return collectDocFiles(config).filter(file => {
    const { frontmatter } = extractFrontmatter(readFileSync(file, 'utf8'));
    const parsed = parseSimpleFrontmatter(frontmatter);
    return !parsed.type || !parsed.status;
  });
}

export async function setupWorker(request) {
  const { operation, cwd, configPath, choices } = request;
  let config = await resolveConfig(cwd, configPath || undefined);
  const before = config;
  if (operation === 'carry') return applySetupCarry(request.moves, before);
  if (operation === 'recover') {
    let recoveryError;
    const pending = inspectTransactions(before.repoRoot, { config: before });
    let recovered = [];
    try { recovered = recoverAbandonedTransactions(before.repoRoot, { config: before }); }
    catch (error) { recoveryError = error; }
    const remaining = inspectTransactions(before.repoRoot, { config: before });
    if (remaining.length || recoveryError) {
      const advice = remaining.map(item => `${item.id}: ${transactionResolutionAdvice(item)}`).join('\n');
      throw new Error(`Pre-config transaction recovery failed: ${advice || recoveryError.message}. No config was written.`);
    }
    const movedSources = recovered.filter(item => item.result === 'rolled-forward').flatMap(item =>
      pending.find(transaction => transaction.id === item.id)?.participants?.filter(participant =>
        participant.label === 'source' && !existsSync(participant.path)).map(participant => participant.path) ?? []);
    cleanupSetupSourceDirectories(before, movedSources);
    return null;
  }
  const existing = Boolean(config.configPath && existsSync(config.configPath));
  // Handoffs-only config: every stage before the rewrite sees the upgraded
  // layout through overrides, so the preview is what applying will do. Its
  // prompts are already under the config's root, so nothing is carried.
  const upgrade = existing && config.mode === 'handoffs' ? planHandoffsUpgrade(config, choices.docsRoot || 'docs') : null;
  if (operation === 'upgrade') {
    if (!upgrade) throw new Error('The config is no longer a handoffs-only config; rerun setup.');
    const snapshot = snapshotFile(config.configPath);
    if (snapshot.content !== request.expectedSource) throw new Error('Config changed since preview; rerun setup.');
    replaceSnapshot(snapshot, upgrade.content, { repoRoot: config.repoRoot });
    return { path: config.configPath };
  }
  if (upgrade) config = await resolveConfig(cwd, configPath || undefined, { overrides: upgrade.overrides });
  if (!existing) {
    const root = path.resolve(cwd, choices.docsRoot || 'docs');
    config = { ...config, repoRoot: cwd, configDir: cwd, configPath: path.join(cwd, 'runlist.config.mjs'), configFound: false,
      docsRoot: root, docsRoots: [root], indexPath: path.join(root, 'docs.md'), docsRootPrefix: path.relative(cwd, root),
      raw: { ...config.raw, root: choices.docsRoot || 'docs', promptTracking: choices.promptTracking }, promptTracking: choices.promptTracking };
  }
  config._execution = { ...config._execution, suppressSideEffects: true, gitStaleness: false };
  const initArgv = [ ...(choices.gitignore ? ['--gitignore'] : []), ...(!existing ? ['--prompt-tracking', choices.promptTracking] : []) ];
  if (operation === 'prepare') {
    const carry = planSetupCarry(before, config, choices.carryPrompts);
    const layout = scaffolding(config, existing, choices, carry.moves);
    let policy = null;
    if (existing && choices.selectPromptTracking) {
      policy = await runConfig(['set', 'promptTracking', choices.promptTracking], config, { dryRun: true });
      config = { ...config, promptTracking: choices.promptTracking, raw: { ...config.raw, promptTracking: choices.promptTracking } };
    }
    // Init sees the proposed policy for ignore planning, but never edits the
    // existing config. The narrow setter owns that separate apply stage.
    await runInit(config.repoRoot, config, { argv: initArgv, dryRun: true, guidance: false, samplePlan: false, carryMoves: carry.moves, ...(!existing ? { docsRoot: choices.docsRoot } : {}) });
    const untagged = inventory(config);
    // What turning planning on brings into view: Markdown under the new roots
    // that the handoffs config did not manage. A walk, not a read: outside the
    // prompt folder nothing is opened (inside it, files are read for their
    // type, as every handoffs-mode command does).
    let newlyListed = null;
    if (upgrade) {
      const managed = new Set(collectDocFiles(before));
      const files = collectDocFiles(config).filter(file => !managed.has(file));
      const roots = (config.docsRoots ?? [config.docsRoot]).filter(root => files.some(file => !path.relative(root, file).startsWith('..')));
      newlyListed = { count: files.length, roots: roots.map(root => `${path.relative(config.repoRoot, root).split(path.sep).join('/')}/`) };
    }
    const adoptions = [];
    for (const selected of choices.adopt) {
      const file = path.resolve(config.repoRoot, selected);
      const { source, content, ...preview } = adoption(config, file);
      adoptions.push(preview);
    }
    const plan = firstPlan(config, choices);
    if (plan && carry.moves.some(move => move.target === plan.path)) throw new Error(`First plan collides with a pre-setup plan being carried over: ${plan.path}`);
    const transactions = existing ? [] : inspectTransactions(before.repoRoot, { config: before });
    return { layout, policy, adoptions, firstPlan: plan, untagged, carry, transactions,
      upgrade: upgrade ? { source: upgrade.source, content: upgrade.content, promptRoot: upgrade.promptRoot, newlyListed } : null, skippedValidationHooks: ['validate', 'transformDoc'].filter(name => typeof config.hooks?.[name] === 'function') };
  }
  if (operation === 'init') {
    // Check again after carry, including when there were no moves. Never let
    // a retained, live, deferred or failed-manual manifest cross the root change.
    if (!existing) await setupWorker({ ...request, operation: 'recover' });
    // A policy change is applied first; this new process now resolves it.
    await runInit(config.repoRoot, config, { argv: initArgv, guidance: false, samplePlan: false, ...(!existing ? { docsRoot: choices.docsRoot } : {}) });
  } else if (operation === 'policy') {
    return runConfig(['set', 'promptTracking', choices.promptTracking], config);
  } else if (operation === 'adopt') {
    const proposed = adoption(config, request.path);
    if (proposed.source !== request.expectedSource) throw new Error(`Adoption source changed after preview: ${request.path}`);
    const snapshot = snapshotFile(request.path);
    if (snapshot.content !== proposed.source) throw new Error(`Adoption source changed during validation: ${request.path}`);
    replaceSnapshot(snapshot, proposed.content, { repoRoot: config.repoRoot, testHooks: { beforeReplacePublish() {
      authorizeManagedSource(request.path, config, { kind: 'Setup adoption source' });
    } } });
    return { path: request.path, checks: proposed.checks };
  } else if (operation === 'plan') {
    const plan = firstPlan(config, choices);
    await runNew(plan.argv, config, { deferIndex: true });
    const checked = parseDocFile(plan.path, config);
    if (checked.errors.length || checked.warnings.length) throw new Error(`Created first plan has validation findings: ${[...checked.errors, ...checked.warnings].map(issue => issue.message).join('; ')}`);
    return { path: plan.path, errors: checked.errors, warnings: checked.warnings };
  } else if (operation === 'index') {
    regenIndex(config, { throwOnError: true });
  } else if (operation === 'check') {
    const index = buildIndex(config, { invokeHooks: false, gitStaleness: false, autoHealIndex: false });
    return { errors: index.errors, warnings: index.warnings, untagged: inventory(config), firstPlan: choices.firstPlan && existsSync(request.planPath) ? (() => {
      const file = request.planPath;
      const doc = parseDocFile(file, config);
      return { path: file, errors: doc.errors, warnings: doc.warnings };
    })() : null };
  } else throw new Error(`Unknown setup operation: ${operation}`);
  return null;
}
