import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { toRepoPath, die, warn } from './util.mjs';
import { collectDocFiles, resolveDocArg } from './index.mjs';
import { regenIndex } from './lifecycle.mjs';
import { captureGitIndexGeneration, isTracked } from './git.mjs';
import { green, dim } from './color.mjs';
import { isInteractive, promptText } from './prompt.mjs';
import { authorizeManagedDestination, authorizeManagedSource, authorizeManagedSweep } from './managed-path.mjs';
import { availableSessionId, prepareOwnershipMigration } from './pickup.mjs';
import { moveFileAtomic } from './atomic-mutation.mjs';
import { configuredReferenceFields, createReferenceIdentitySet, planReferenceMove, rewriteDocumentReferences } from './reference-planner.mjs';

export async function runRename(argv, config, opts = {}) {
  const { dryRun } = opts;
  const positional = argv.filter(arg => !arg.startsWith('-'));
  const oldInput = positional[0];
  let newInput = positional[1];
  if (!oldInput) die('Usage: dotmd rename <old> <new>');
  if (!newInput) {
    if (!isInteractive()) die('Usage: dotmd rename <old> <new>');
    newInput = await promptText('New name: ');
    if (!newInput) die('No name provided.');
  }

  let oldPath = resolveDocArg(oldInput, config);
  const sourceAuthorization = authorizeManagedSource(oldPath, config, { kind: 'Rename source' });
  oldPath = sourceAuthorization.path;
  let newPath;
  if (newInput.includes('/') || newInput.includes(path.sep)) {
    newPath = path.resolve(config.repoRoot, newInput.endsWith('.md') ? newInput : `${newInput}.md`);
  } else {
    newPath = path.join(path.dirname(oldPath), newInput.endsWith('.md') ? newInput : `${newInput}.md`);
  }
  if (existsSync(newPath)) die(`Target already exists: ${toRepoPath(newPath, config.repoRoot)}`);
  newPath = authorizeManagedDestination(newPath, config, { root: sourceAuthorization.root, kind: 'Rename destination' }).path;

  const oldRepoPath = toRepoPath(oldPath, config.repoRoot);
  const newRepoPath = toRepoPath(newPath, config.repoRoot);
  const allFiles = collectDocFiles(config);
  authorizeManagedSweep(allFiles, config, { kind: 'Rename reference rewrite source' });
  const documents = allFiles.map(filePath => ({ path: filePath, content: readFileSync(filePath, 'utf8') }));
  let sourceDocument = documents.find(document => document.path === oldPath);
  if (!sourceDocument) {
    sourceDocument = { path: oldPath, content: readFileSync(oldPath, 'utf8') };
    documents.push(sourceDocument);
  }
  const sourceContent = sourceDocument.content;
  const referenceFields = configuredReferenceFields(config);
  const referencePlan = planReferenceMove({ documents, oldPath, newPath, repoRoot: config.repoRoot, referenceFields });
  const ownership = prepareOwnershipMigration(oldRepoPath, newPath, config, { sessionId: availableSessionId() });

  if (dryRun) {
    const prefix = dim('[dry-run]');
    process.stdout.write(`${prefix} Would rename: ${oldRepoPath} → ${newRepoPath}\n`);
    if (referencePlan.updates.length) {
      process.stdout.write(`${prefix} Would update references in ${referencePlan.updates.length} file(s):\n`);
      for (const item of referencePlan.updates) process.stdout.write(`${prefix}   ${toRepoPath(item.path, config.repoRoot)}\n`);
    }
    if (ownership) process.stdout.write(`${prefix} Would migrate this session's ownership record.\n`);
    return;
  }

  const tracked = isTracked(oldPath, config.repoRoot);
  const gitIndex = tracked ? captureGitIndexGeneration(config.repoRoot) : null;
  const identities = createReferenceIdentitySet(allFiles);
  const result = moveFileAtomic(oldPath, newPath, current => rewriteDocumentReferences(current, {
    sourcePath: oldPath,
    outputPath: newPath,
    repoRoot: config.repoRoot,
    identities,
    oldPath,
    newPath,
    referenceFields,
    rebaseAll: true,
  }), {
    repoRoot: config.repoRoot,
    config,
    updates: allFiles.filter(filePath => filePath !== oldPath).map(filePath => ({
      path: filePath,
      render: current => rewriteDocumentReferences(current, {
        sourcePath: filePath, repoRoot: config.repoRoot, identities, oldPath, newPath, referenceFields,
      }),
    })),
    creations: ownership ? [{ path: ownership.newRecordPath, content: ownership.newContent, label: 'ownership' }] : [],
    deletions: ownership ? [{ path: ownership.oldRecordPath, expectedContent: ownership.oldContent, label: 'ownership' }] : [],
    gitMove: tracked,
    gitIndex,
    operation: 'rename',
    sessionId: availableSessionId(),
    testHooks: opts.testHooks,
  });
  regenIndex(config);
  process.stdout.write(`${green('Renamed')}: ${oldRepoPath} → ${newRepoPath}\n`);
  if (result.updatedPaths.length) process.stdout.write(`Updated references in ${result.updatedPaths.length} file(s).\n`);
  try { config.hooks.onRename?.({ oldPath: oldRepoPath, newPath: newRepoPath, referencesUpdated: result.updatedPaths.length }); }
  catch (err) { warn(`Hook 'onRename' threw: ${err.message}`); }
  return { oldRepoPath, newRepoPath, referencePaths: result.updatedPaths.map(item => toRepoPath(item, config.repoRoot)) };
}
