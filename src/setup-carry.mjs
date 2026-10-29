import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
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

// Only the resolver's pre-config locations qualify. An unrelated prompts
// library, arbitrary Markdown, and files under an existing config are not
// adoption candidates. Status vocabularies come from the resolved defaults.
export function planSetupCarry(before, after, enabled = true) {
  const result = { moves: [], outstanding: [], remaining: [] };
  if (before.configFound || !enabled) return result;
  const candidates = new Set();
  const seen = new Set();
  for (const type of ['prompt', 'plan']) {
    const oldDirs = directories(before, type);
    const newDirs = directories(after, type);
    for (const [i, directory] of oldDirs.entries()) {
      if (directory === newDirs[i]) continue;
      for (const source of markdownFiles(directory, before)) {
        candidates.add(source);
        if (seen.has(source)) continue;
        const expectedSource = readFileSync(source, 'utf8');
        const parsed = parseSimpleFrontmatter(extractFrontmatter(expectedSource).frontmatter ?? '');
        if (parsed.type !== type || !before.typeStatuses.get(type)?.has(parsed.status)) continue;
        seen.add(source);
        const archived = i === 1 || before.lifecycle.archiveStatuses.has(parsed.status);
        const target = path.join(newDirs[archived ? 1 : 0], path.basename(source));
        if (source === target) continue;
        authorizeManagedSource(source, before, { kind: 'Setup carry-over source' });
        authorizeRepoGeneratedPath(target, after, { kind: 'Setup carry-over destination' });
        const from = toRepoPath(source, before.repoRoot), to = toRepoPath(target, before.repoRoot);
        if (existsSync(target) || result.moves.some(move => move.target === target)) {
          result.outstanding.push({ description: `Carry-over collision: ${from} → ${to}; destination exists, source left in place`, path: source });
          continue;
        }
        try { if (type === 'plan') prepareOwnershipMigration(from, target, before, { sessionId: availableSessionId() }); }
        catch (error) {
          result.outstanding.push({ description: `Carry-over refused for ${from}: ${error.message}`, path: source });
          continue;
        }
        result.moves.push({ source, target, from, to, type, expectedSource });
      }
    }
  }
  result.remaining = [...candidates].filter(file => !result.moves.some(move => move.source === file));
  return result;
}

// Carry before publishing the first config, so a retained move transaction is
// recoverable under the same (unconfigured) roots that authorized its source.
// Each move is transactional; setup itself remains a sequence of stages.
export function applySetupCarry(moves, config, { testHooks } = {}) {
  const completed = [];
  const expectedSources = new Map(moves.map(move => [move.source, move.expectedSource]));
  try {
    if (config.configFound) throw new Error('A config appeared after the carry-over preview; rerun setup.');
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
      moveFileAtomic(move.source, move.target, references.movedContent, {
        repoRoot: config.repoRoot, config, expectedSourceContent: expectedSources.get(move.source),
        updates: [...references.updates, ...handoffs],
        creations: ownership ? [{ path: ownership.newRecordPath, content: ownership.newContent, label: 'ownership' }] : [],
        deletions: ownership ? [{ path: ownership.oldRecordPath, expectedContent: ownership.oldContent, label: 'ownership' }] : [],
        guards: [{ path: path.join(config.configDir, 'runlist.config.mjs'), absent: true }],
        gitMove: tracked, gitIndex: tracked ? captureGitIndexGeneration(config.repoRoot) : null,
        operation: 'move', sessionId: availableSessionId(), testHooks,
      });
      for (const update of references.updates) if (expectedSources.has(update.path)) expectedSources.set(update.path, update.content);
      completed.push(move);
      // Remove only now-empty source directories, never keepfiles or user
      // content. rmdir refuses a concurrent arrival; cleanup is best effort.
      for (const directory of [path.dirname(move.source), path.dirname(path.dirname(move.source))]) {
        const rel = path.relative(config.repoRoot, directory);
        if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
        try { rmdirSync(directory); }
        catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
      }
    }
    return { completed };
  } catch (error) { return { completed, error: error.message }; }
}
