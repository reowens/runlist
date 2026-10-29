import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { promptDirectory, planDirectory } from './new.mjs';
import { archiveBaseFor } from './lifecycle.mjs';
import { collectDocFiles } from './index.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { authorizeManagedSource, authorizeManagedSweep, authorizeRepoGeneratedPath } from './managed-path.mjs';
import { moveFileAtomic } from './atomic-mutation.mjs';
import { configuredReferenceFields, planReferenceMove } from './reference-planner.mjs';
import { availableSessionId, prepareOwnershipMigration } from './pickup.mjs';
import { listPendingHandoffs } from './handoff-record.mjs';
import { captureGitIndexGeneration, isTracked } from './git.mjs';
import { toRepoPath } from './util.mjs';
import { locateConfig } from './config.mjs';
import { CONFIG_FILENAMES, LEGACY_PROMPT_DIR, rootIsWorkingFolder } from './naming.mjs';
import { statusMetadataFor } from './status-metadata.mjs';

function markdownFiles(directory, config) {
  authorizeRepoGeneratedPath(directory, config, { kind: 'Setup carry-over folder' });
  if (!existsSync(directory)) return [];
  if (!lstatSync(directory).isDirectory()) throw new Error(`Carry-over folder must be a regular directory: ${directory}`);
  return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => path.join(directory, entry.name)).sort();
}

function directories(config, type) {
  const live = type === 'prompt' ? promptDirectory(config) : planDirectory(config);
  const archive = path.join(archiveBaseFor(path.join(live, 'document.md'), config.docsRoot, type, config), config.archiveDir);
  return [live, archive];
}

// Live/archive pairs to carry from: the resolver's pre-config folders, plus
// the root prompts/ (and its archive) where older builds saved prompts before
// any config. Nothing writes there now (src/naming.mjs).
function sourceDirectories(config, type) {
  const own = directories(config, type);
  if (type !== 'prompt' || !rootIsWorkingFolder(config)) return own;
  const legacy = path.join(config.docsRoot, ...LEGACY_PROMPT_DIR.split('/'));
  return [...own, legacy, path.join(legacy, config.archiveDir)];
}

// Only the resolver's pre-config locations qualify. An unrelated prompts
// library, arbitrary Markdown, and files under an existing config are not
// adoption candidates. Status vocabularies come from the resolved defaults.
export function planSetupCarry(before, after, enabled = true, { types = ['prompt', 'plan'] } = {}) {
  const result = { moves: [], outstanding: [], remaining: [] };
  if (before.configFound) return result;
  const candidates = new Set();
  const seen = new Set();
  const targets = new Set();
  for (const type of types) {
    const oldDirs = sourceDirectories(before, type);
    const newDirs = directories(after, type);
    for (const [i, directory] of oldDirs.entries()) {
      if (directory === newDirs[i % 2]) continue;
      for (const source of markdownFiles(directory, before)) {
        candidates.add(source);
        if (seen.has(source)) continue;
        const expectedSource = readFileSync(source, 'utf8');
        const parsed = parseSimpleFrontmatter(extractFrontmatter(expectedSource).frontmatter ?? '');
        if (parsed.type !== type || !before.typeStatuses.get(type)?.has(parsed.status)) continue;
        const archiveStatus = statusMetadataFor(before, type, parsed.status)?.archive;
        // The shared root-level archive is also a common user folder. Its
        // location alone is no evidence that runlist archived this document.
        if (directory === path.join(before.repoRoot, before.archiveDir) && !archiveStatus) continue;
        seen.add(source);
        const archived = i % 2 === 1 || archiveStatus;
        const target = path.join(newDirs[archived ? 1 : 0], path.basename(source));
        if (source === target) continue;
        authorizeManagedSource(source, before, { kind: 'Setup carry-over source' });
        authorizeRepoGeneratedPath(target, after, { kind: 'Setup carry-over destination' });
        const from = toRepoPath(source, before.repoRoot), to = toRepoPath(target, before.repoRoot);
        if (!enabled) continue;
        const targetKey = target.normalize('NFC').toLowerCase().normalize('NFC');
        if (existsSync(target) || targets.has(targetKey)) {
          result.outstanding.push({ description: `Carry-over collision: ${from} → ${to}; ${targets.has(targetKey) ? 'collides with another file being carried' : 'destination exists'}, source left in place`, path: source });
          continue;
        }
        try { if (type === 'plan') prepareOwnershipMigration(from, target, before, { sessionId: availableSessionId() }); }
        catch (error) {
          result.outstanding.push({ description: `Carry-over refused for ${from}: ${error.message}`, path: source });
          continue;
        }
        result.moves.push({ source, target, from, to, type, expectedSource });
        targets.add(targetKey);
      }
    }
  }
  result.remaining = [...candidates].filter(file => !result.moves.some(move => move.source === file));
  return result;
}

// Only clean parents of sources moved by this run or its recovery. An empty
// default folder alone does not establish that setup owns its cleanup.
export function cleanupSetupSourceDirectories(config, movedSources) {
  if (config.configFound) return;
  const sources = [...new Set(['prompt', 'plan'].flatMap(type => sourceDirectories(config, type)))].filter(directory =>
    movedSources.some(source => path.dirname(source) === directory || path.dirname(source).startsWith(`${directory}${path.sep}`)));
  for (const directory of sources.sort((a, b) => b.length - a.length)) {
    if (directory === config.repoRoot) continue;
    authorizeRepoGeneratedPath(directory, config, { kind: 'Setup source folder' });
    try { rmdirSync(directory); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  }
}

// Carry before publishing the first config, so a retained move transaction is
// recoverable under the same (unconfigured) roots that authorized its source.
// Each move is transactional; setup itself remains a sequence of stages.
export function applySetupCarry(moves, config, { testHooks } = {}) {
  const completed = [];
  const createdDirectories = [];
  const expectedSources = new Map(moves.map(move => [move.source, move.expectedSource]));
  try {
    const checkConfig = () => {
      if (config.configFound || locateConfig(config.configDir).configPath) throw new Error('A config appeared after the carry-over preview; rerun setup.');
    };
    checkConfig();
    for (const move of moves) {
      if (readFileSync(move.source, 'utf8') !== move.expectedSource) throw new Error(`Carry-over source changed after preview: ${move.from}`);
    }
    for (const move of moves) {
      const files = collectDocFiles(config);
      authorizeManagedSweep(files, config, { kind: 'Setup carry-over reference source' });
      const documents = files.map(file => ({ path: file, content: readFileSync(file, 'utf8') }));
      const referenceFields = [...new Set([...configuredReferenceFields(config), 'plan', 'parent_prompt'])];
      const references = planReferenceMove({ documents, oldPath: move.source, newPath: move.target, repoRoot: config.repoRoot, referenceFields });
      const ownership = move.type === 'plan' ? prepareOwnershipMigration(move.from, move.target, config, { sessionId: availableSessionId() }) : null;
      const handoffs = listPendingHandoffs(config).flatMap(record => {
        const expectedContent = readFileSync(record.recordFile, 'utf8');
        const data = JSON.parse(expectedContent);
        let changed = false;
        for (const field of ['prompt', 'plan']) if (data[field] === move.from) { data[field] = move.to; changed = true; }
        if (!changed) return [];
        authorizeRepoGeneratedPath(record.recordFile, config, { kind: 'Setup handoff record' });
        return [{ path: record.recordFile, expectedContent, content: JSON.stringify(data, null, 2) + '\n', label: 'handoff' }];
      });
      const tracked = isTracked(move.source, config.repoRoot);
      // Scaffold directories belong to setup, never to the move transaction.
      // Keep failed carry cleanup separate from transaction recovery; recovery
      // evidence must be resolved under the old roots before setup writes config.
      for (const directory of [path.dirname(move.target), ...(ownership ? [path.dirname(ownership.newRecordPath)] : [])]) {
        authorizeRepoGeneratedPath(directory, config, { kind: 'Setup carry-over folder' });
        const missing = [];
        for (let next = directory; !existsSync(next); next = path.dirname(next)) missing.push(next);
        for (const next of missing.reverse()) {
          try { mkdirSync(next); }
          catch (error) { if (error.code === 'EEXIST') continue; throw error; }
          createdDirectories.push({ path: next, identity: lstatSync(next) });
        }
      }
      checkConfig();
      moveFileAtomic(move.source, move.target, references.movedContent, {
        repoRoot: config.repoRoot, config, expectedSourceContent: expectedSources.get(move.source),
        updates: [...references.updates, ...handoffs],
        creations: ownership ? [{ path: ownership.newRecordPath, content: ownership.newContent, label: 'ownership' }] : [],
        deletions: ownership ? [{ path: ownership.oldRecordPath, expectedContent: ownership.oldContent, label: 'ownership' }] : [],
        guards: CONFIG_FILENAMES.map(name => ({ path: path.join(config.configDir, name), absent: true })),
        gitMove: tracked, gitIndex: tracked ? captureGitIndexGeneration(config.repoRoot) : null,
        operation: 'move', sessionId: availableSessionId(), testHooks: { ...testHooks, beforeMoveSnapshot(info) {
          testHooks?.beforeMoveSnapshot?.(info);
          checkConfig();
        } },
      });
      for (const update of references.updates) if (expectedSources.has(update.path)) expectedSources.set(update.path, update.content);
      completed.push(move);
      cleanupSetupSourceDirectories(config, [move.source]);
    }
    return { completed };
  } catch (error) {
    if (!locateConfig(config.configDir).configPath) {
      for (const entry of createdDirectories.reverse()) {
        try {
          const stat = lstatSync(entry.path);
          if (stat.isDirectory() && stat.dev === entry.identity.dev && stat.ino === entry.identity.ino) rmdirSync(entry.path);
        } catch { /* Keep nonempty/replaced directories and preserve the original failure. */ }
      }
    }
    return { completed, error: error.message };
  }
}
