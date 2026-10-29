import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { promptDirectory, planDirectory } from './new.mjs';
import { archiveBaseFor } from './lifecycle.mjs';
import { collectDocFiles } from './index.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { authorizeManagedSource, authorizeManagedSweep, authorizeRepoGeneratedPath, inLegacyPromptFolder } from './managed-path.mjs';
import { moveFileAtomic } from './atomic-mutation.mjs';
import { configuredReferenceFields, planReferenceMove } from './reference-planner.mjs';
import { availableSessionId, prepareOwnershipMigration } from './pickup.mjs';
import { listPendingHandoffs } from './handoff-record.mjs';
import { captureGitIndexGeneration, isTracked } from './git.mjs';
import { toRepoPath } from './util.mjs';
import { locateConfig, resolveConfig } from './config.mjs';
import { CONFIG_FILENAMES, LEGACY_PROMPT_DIR, RETIRED_PROMPT_STATUSES, rootIsWorkingFolder } from './naming.mjs';
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

// Live/archive pairs to carry from: the resolver's pre-config folders.
function sourceDirectories(config, type) {
  return directories(config, type);
}

// The root prompts/ older builds saved prompts in before any config. Nothing
// writes there now (src/naming.mjs); every prompt below it, at any depth, is
// carried with its folder relative to prompts/ kept.
export function legacyPromptRoot(config) {
  return rootIsWorkingFolder(config) ? path.join(config.docsRoot, ...LEGACY_PROMPT_DIR.split('/')) : null;
}

function legacyMarkdownFiles(root, config) {
  authorizeRepoGeneratedPath(root, config, { kind: 'Setup carry-over folder' });
  if (!existsSync(root)) return [];
  if (!lstatSync(root).isDirectory()) throw new Error(`Carry-over folder must be a regular directory: ${root}`);
  const files = [];
  // A folder's own files before its subfolders, so live prompts are planned
  // ahead of the archive below them, as they always were.
  const walk = directory => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.md')) files.push(path.join(directory, entry.name));
    for (const entry of entries) if (entry.isDirectory()) walk(path.join(directory, entry.name));
  };
  walk(root);
  return files;
}

function carryKey(target) {
  return target.normalize('NFC').toLowerCase().normalize('NFC');
}

// The project as it read before any config: the docs root is the project's
// top, so the folders an older runlist saved plans and prompts in are the
// carry's sources. Setup turning planning on in a handoffs-only project
// carries from here too, under the same roots a fresh setup uses.
export async function preConfigView(top) {
  const view = await resolveConfig(top, path.join(top, `${CONFIG_FILENAMES[0]}.pre-config`));
  return { ...view, configFound: false, configPath: null, mode: 'plans', planning: true };
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
  const consider = ({ source, target, type, expectedSource }) => {
    if (source === target) return;
    authorizeManagedSource(source, before, { kind: 'Setup carry-over source' });
    authorizeRepoGeneratedPath(target, after, { kind: 'Setup carry-over destination' });
    const from = toRepoPath(source, before.repoRoot), to = toRepoPath(target, before.repoRoot);
    if (!enabled) return;
    const targetKey = carryKey(target);
    if (existsSync(target) || targets.has(targetKey)) {
      result.outstanding.push({ description: `Carry-over collision: ${from} → ${to}; ${targets.has(targetKey) ? 'collides with another file being carried' : 'destination exists'}, source left in place`, path: source });
      return;
    }
    try { if (type === 'plan') prepareOwnershipMigration(from, target, before, { sessionId: availableSessionId() }); }
    catch (error) {
      result.outstanding.push({ description: `Carry-over refused for ${from}: ${error.message}`, path: source });
      return;
    }
    result.moves.push({ source, target, from, to, type, expectedSource });
    targets.add(targetKey);
  };
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
        consider({ source, target: path.join(newDirs[archived ? 1 : 0], path.basename(source)), type, expectedSource });
      }
    }
    // A `type: prompt` file anywhere below the root prompts/, with a status
    // runlist gives prompts or one an older build did, is one runlist saved
    // there; everything else there is the user's and stays.
    const legacy = type === 'prompt' ? legacyPromptRoot(before) : null;
    if (!legacy) continue;
    for (const source of legacyMarkdownFiles(legacy, before)) {
      candidates.add(source);
      if (seen.has(source)) continue;
      const expectedSource = readFileSync(source, 'utf8');
      const parsed = parseSimpleFrontmatter(extractFrontmatter(expectedSource).frontmatter ?? '');
      if (parsed.type !== 'prompt' || !(before.typeStatuses.get(type)?.has(parsed.status) || RETIRED_PROMPT_STATUSES.has(parsed.status))) continue;
      seen.add(source);
      const relative = path.relative(legacy, source);
      const archivedAlready = relative.split(path.sep).slice(0, -1).includes(before.archiveDir);
      const archiveStatus = before.typeStatuses.get(type)?.has(parsed.status) && statusMetadataFor(before, type, parsed.status)?.archive;
      consider({ source, target: path.join(newDirs[archiveStatus && !archivedAlready ? 1 : 0], relative), type, expectedSource });
    }
  }
  result.remaining = [...candidates].filter(file => !result.moves.some(move => move.source === file));
  return result;
}

// Everything left in the root prompts/ (what the carry does not move) is the
// user's, by its path or through a symlinked folder: the carry never rewrites
// it, and a link there to a carried file is reported instead.
function staysInLegacyFolder(file, config, carried) {
  return !carried.has(path.resolve(file)) && inLegacyPromptFolder(file, config.repoRoot);
}

function carryReferenceFields(config) {
  return [...new Set([...configuredReferenceFields(config), 'plan', 'parent_prompt'])];
}

// Links to a carried file from Markdown runlist does not manage, which the
// move's reference sweep never rewrites: a README with no frontmatter that
// points at prompts/older.md, say, or any document that stays in the root
// prompts/. Reported for the user to update, never edited. Read only on the
// explicit save, init and setup paths.
export function unmanagedCarryReferences(config, moves) {
  if (!moves.length) return [];
  const carried = new Set(moves.map(move => path.resolve(move.source)));
  const plain = [];
  for (const file of collectDocFiles(config)) {
    if (carried.has(path.resolve(file))) continue;
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    if (extractFrontmatter(content).frontmatter) {
      if (staysInLegacyFolder(file, config, carried)) plain.push({ path: file, content });
      continue;
    }
    // Lent a frontmatter block so the planner reads the body; never written.
    plain.push({ path: file, content: `---\nrunlist-probe: true\n---\n${content}` });
  }
  if (!plain.length) return [];
  const referenceFields = carryReferenceFields(config);
  const found = [];
  for (const move of moves) {
    const documents = [{ path: move.source, content: move.expectedSource }, ...plain];
    const { updates } = planReferenceMove({ documents, oldPath: move.source, newPath: move.target, repoRoot: config.repoRoot, referenceFields });
    for (const update of updates) found.push({ file: toRepoPath(update.path, config.repoRoot), from: move.from, to: move.to });
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.from.localeCompare(b.from));
}

// Only clean parents of sources moved by this run or its recovery. An empty
// default folder alone does not establish that setup owns its cleanup.
export function cleanupSetupSourceDirectories(config, movedSources) {
  if (config.configFound) return;
  const legacy = legacyPromptRoot(config);
  const legacyFolders = legacy ? movedSources.flatMap(source => {
    const folders = [];
    for (let directory = path.dirname(source); directory.startsWith(`${legacy}${path.sep}`); directory = path.dirname(directory)) folders.push(directory);
    return path.dirname(source) === legacy || folders.length ? [...folders, legacy] : [];
  }) : [];
  const sources = [...new Set([...['prompt', 'plan'].flatMap(type => sourceDirectories(config, type)), ...legacyFolders])].filter(directory =>
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
// `expectedConfig` ({ path, content }) is the handoffs-only config setup is
// about to upgrade: it must stay exactly as previewed, and no other config may
// appear, for the whole carry.
export function applySetupCarry(moves, config, { testHooks, expectedConfig = null } = {}) {
  const completed = [];
  const createdDirectories = [];
  const expectedSources = new Map(moves.map(move => [move.source, move.expectedSource]));
  const carried = new Set(moves.map(move => path.resolve(move.source)));
  const configUnchanged = () => {
    if (!expectedConfig) return !config.configFound && !locateConfig(config.configDir).configPath;
    try { return locateConfig(config.configDir).configPath === expectedConfig.path && readFileSync(expectedConfig.path, 'utf8') === expectedConfig.content; }
    catch { return false; }
  };
  const configGuards = CONFIG_FILENAMES.map(name => path.join(config.configDir, name)).map(file =>
    expectedConfig && path.resolve(file) === path.resolve(expectedConfig.path) ? { path: file, expectedContent: expectedConfig.content } : { path: file, absent: true });
  try {
    const checkConfig = () => {
      if (!configUnchanged()) throw new Error(expectedConfig ? 'The config changed after the carry-over preview; rerun setup.' : 'A config appeared after the carry-over preview; rerun setup.');
    };
    checkConfig();
    for (const move of moves) {
      if (readFileSync(move.source, 'utf8') !== move.expectedSource) throw new Error(`Carry-over source changed after preview: ${move.from}`);
    }
    for (const move of moves) {
      // What stays in the root prompts/ is the user's and is never rewritten;
      // unmanagedCarryReferences lists its links to a carried file.
      const files = collectDocFiles(config).filter(file => !staysInLegacyFolder(file, config, carried));
      authorizeManagedSweep(files, config, { kind: 'Setup carry-over reference source' });
      const documents = files.map(file => ({ path: file, content: readFileSync(file, 'utf8') }));
      const references = planReferenceMove({ documents, oldPath: move.source, newPath: move.target, repoRoot: config.repoRoot, referenceFields: carryReferenceFields(config) });
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
        guards: configGuards,
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
    if (configUnchanged()) {
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
