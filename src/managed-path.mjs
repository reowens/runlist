import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { managesFile, outsideHandoffsLine } from './handoffs-scope.mjs';
import { LEGACY_PROMPT_DIR, PROMPT_DIR } from './naming.mjs';

// These checks are authorization preflights, not filesystem transactions. A
// concurrent actor can still replace a checked ancestor before the later write
// (TOCTOU); eliminating that residual boundary requires descriptor-relative IO.

function contains(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function sameNode(a, b) {
  try {
    const left = statSync(a, { bigint: true });
    const right = statSync(b, { bigint: true });
    return left.dev === right.dev && left.ino === right.ino;
  } catch { return false; }
}

// realpath on case-insensitive macOS volumes may preserve the caller's casing.
// Prove an alias by inode before treating it as contained; lowercase string
// comparison alone would be unsafe on case-sensitive volumes.
function aliasContainment(parent, child) {
  if (contains(parent, child)) return { contained: true, relative: path.relative(parent, child) };
  const parentParts = path.resolve(parent).split(path.sep).filter(Boolean);
  const childParts = path.resolve(child).split(path.sep).filter(Boolean);
  if (childParts.length < parentParts.length) return { contained: false, relative: null };
  const childPrefix = `${path.parse(path.resolve(child)).root}${childParts.slice(0, parentParts.length).join(path.sep)}`;
  if (!sameNode(parent, childPrefix)) return { contained: false, relative: null };
  return { contained: true, relative: childParts.slice(parentParts.length).join(path.sep) };
}

function lexicalRootsFor(config) {
  return (config.docsRoots ?? [config.docsRoot]).map(configuredPath => ({
    configuredPath,
    lexicalPath: path.resolve(configuredPath),
  }));
}

function rootsFor(config) {
  return lexicalRootsFor(config).map(root => {
    const { configuredPath, lexicalPath } = root;
    let canonicalPath;
    try {
      canonicalPath = realpathSync(lexicalPath);
    } catch (err) {
      throw new Error(`Configured docs root cannot be resolved: ${lexicalPath} (${err.message})`);
    }
    return { configuredPath, lexicalPath, canonicalPath };
  });
}

function rootsMessage(roots) {
  return roots.map(root => root.lexicalPath).join(', ');
}

function markdown(pathname, kind, roots) {
  if (!pathname.endsWith('.md')) {
    throw new Error(`${kind} must be a Markdown file ending in .md: ${pathname}\nConfigured docs roots: ${rootsMessage(roots)}`);
  }
}

function nearestExistingAncestor(input, roots, kind) {
  let current = input;
  while (!existsSync(current)) {
    try {
      // existsSync is false for dangling symlinks, but lstat still sees them.
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`dangling symlink: ${current}`);
      }
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
        throw new Error(`${kind} has an unsafe existing ancestor: ${current} (${err.message})\nConfigured docs roots: ${rootsMessage(roots)}`);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  try {
    return realpathSync(current);
  } catch (err) {
    throw new Error(`${kind} ancestor cannot be resolved: ${current} (${err.message})\nConfigured docs roots: ${rootsMessage(roots)}`);
  }
}

function lexicalOwner(input, roots) {
  return roots
    .filter(root => contains(root.lexicalPath, input))
    .sort((a, b) => b.lexicalPath.length - a.lexicalPath.length)[0] ?? null;
}

export function findLexicalDocsRoot(input, config) {
  return lexicalOwner(path.resolve(input), lexicalRootsFor(config))?.lexicalPath ?? null;
}

export function authorizeManagedSource(input, config, { kind = 'Managed mutation source' } = {}) {
  const roots = rootsFor(config);
  const lexicalPath = path.resolve(input);
  markdown(lexicalPath, kind, roots);

  if (!existsSync(lexicalPath)) {
    throw new Error(`${kind} does not exist: ${lexicalPath}\nConfigured docs roots: ${rootsMessage(roots)}`);
  }
  if (lstatSync(lexicalPath).isSymbolicLink()) {
    throw new Error(`${kind} may not be a symlink: ${lexicalPath}\nConfigured docs roots: ${rootsMessage(roots)}`);
  }

  let canonicalPath;
  try {
    canonicalPath = realpathSync(lexicalPath);
  } catch (err) {
    throw new Error(`${kind} cannot be resolved: ${lexicalPath} (${err.message})\nConfigured docs roots: ${rootsMessage(roots)}`);
  }
  if (!statSync(canonicalPath).isFile()) {
    throw new Error(`${kind} is not a file: ${lexicalPath}\nConfigured docs roots: ${rootsMessage(roots)}`);
  }
  if (!managesFile(canonicalPath, config)) {
    throw new Error(`${kind}: ${outsideHandoffsLine(path.relative(config.repoRoot, lexicalPath).split(path.sep).join('/'))}`);
  }

  const lexical = lexicalOwner(lexicalPath, roots);
  if (lexical && !aliasContainment(lexical.canonicalPath, canonicalPath).contained) {
    throw new Error(`${kind} is lexically owned by ${lexical.lexicalPath} but resolves outside that root: ${lexicalPath} -> ${canonicalPath}\nConfigured docs roots: ${rootsMessage(roots)}`);
  }
  const root = lexical
    ?? roots.filter(candidate => aliasContainment(candidate.canonicalPath, canonicalPath).contained)
      .sort((a, b) => b.canonicalPath.length - a.canonicalPath.length)[0];
  if (!root) {
    throw new Error(`${kind} resolves outside configured docs roots: ${lexicalPath} -> ${canonicalPath}\nConfigured docs roots: ${rootsMessage(roots)}`);
  }

  // Keep operations on the configured root spelling (important when the root
  // itself is a symlink), while normalizing OS-level aliases such as /var ->
  // /private/var back through the owning root.
  const managedPath = lexical
    ? lexicalPath
    : path.join(root.lexicalPath, aliasContainment(root.canonicalPath, canonicalPath).relative);
  return { path: managedPath, canonicalPath, root };
}

// One prompt location (src/naming.mjs): before any config, and where
// planning is off, nothing is created in the root prompts/ an older runlist
// saved prompts in. Its prompts are carried out to docs/prompts/ instead.
// Transaction recovery restoring a carry's source is not a new file.
// Whether `file` is in the root prompts/, by its path or by where its folders
// physically lead: a docs/ that is a symlink to prompts/ puts docs/prompts/
// inside it. Configured planning projects keep the prompt folder they chose,
// so callers ask only before any config or where planning is off.
export function inLegacyPromptFolder(file, repoRoot) {
  const top = path.resolve(repoRoot);
  const legacy = path.join(top, LEGACY_PROMPT_DIR);
  const lexical = path.resolve(file);
  if (contains(legacy, lexical)) return true;
  let existing = lexical;
  const rest = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return false;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    const physical = path.join(realpathSync(existing), ...rest);
    const physicalLegacy = existsSync(legacy) ? realpathSync(legacy) : path.join(realpathSync(top), LEGACY_PROMPT_DIR);
    return contains(physicalLegacy, physical);
  } catch { return false; }
}

export function legacyPromptFolderMessage(file, repoRoot, kind) {
  const relative = path.relative(repoRoot, path.resolve(file)).split(path.sep).join('/') || '.';
  return `${kind}: ${relative} ${legacyPromptFolderPlace(file, repoRoot)}, where runlist no longer writes; prompts live in ${PROMPT_DIR}/.`;
}

export function legacyPromptFolderPlace(file, repoRoot) {
  return contains(path.join(path.resolve(repoRoot), LEGACY_PROMPT_DIR), path.resolve(file))
    ? `is in ${LEGACY_PROMPT_DIR}/ at the project root`
    : `leads into ${LEGACY_PROMPT_DIR}/ at the project root through a symlinked folder`;
}

function assertNotLegacyPromptFolder(lexicalPath, config, kind) {
  if (config.configFound && config.mode !== 'handoffs') return;
  if (!inLegacyPromptFolder(lexicalPath, config.repoRoot)) return;
  throw new Error(legacyPromptFolderMessage(lexicalPath, config.repoRoot, kind));
}

// Files runlist writes outside the document roots (exports): before any
// config and where planning is off, never into the root prompts/.
export function assertOutsideLegacyPromptFolder(file, config, kind) {
  assertNotLegacyPromptFolder(path.resolve(file), config, kind);
}

export function authorizeManagedDestination(input, config, { root: requiredRoot = null, kind = 'Managed mutation destination', recovery = false } = {}) {
  const roots = rootsFor(config);
  const lexicalPath = path.resolve(input);
  markdown(lexicalPath, kind, roots);
  if (!recovery) assertNotLegacyPromptFolder(lexicalPath, config, kind);

  const root = requiredRoot
    ? roots.find(candidate => candidate.lexicalPath === requiredRoot.lexicalPath && candidate.canonicalPath === requiredRoot.canonicalPath)
    : lexicalOwner(lexicalPath, roots);
  if (!root || !contains(root.lexicalPath, lexicalPath)) {
    const ownership = requiredRoot ? `Owning docs root: ${requiredRoot.lexicalPath}\n` : '';
    throw new Error(`${kind} is lexically outside its configured docs root: ${lexicalPath}\n${ownership}Configured docs roots: ${rootsMessage(roots)}`);
  }

  const ancestor = nearestExistingAncestor(lexicalPath, roots, kind);
  if (!aliasContainment(root.canonicalPath, ancestor).contained) {
    throw new Error(`${kind} escapes through an existing symlinked parent: ${lexicalPath} -> ${ancestor}\nOwning docs root: ${root.lexicalPath}\nConfigured docs roots: ${rootsMessage(roots)}`);
  }
  return { path: lexicalPath, canonicalPath: existsSync(lexicalPath) ? realpathSync(lexicalPath) : null, root };
}

export function authorizeManagedMove(source, destination, config, options = {}) {
  const authorizedSource = authorizeManagedSource(source, config, options);
  const authorizedDestination = authorizeManagedDestination(destination, config, {
    ...options,
    kind: options.destinationKind ?? 'Managed mutation destination',
    root: authorizedSource.root,
  });
  return { source: authorizedSource, destination: authorizedDestination };
}

export function authorizeManagedSweep(files, config, { kind = 'Managed mutation sweep' } = {}) {
  return files.map(file => authorizeManagedSource(file, config, { kind }));
}

export function authorizeRepoGeneratedPath(input, config, { kind = 'Repository-generated destination' } = {}) {
  const lexicalPath = path.resolve(input);
  const repoRoot = path.resolve(config.repoRoot);
  let canonicalRepo;
  try { canonicalRepo = realpathSync(repoRoot); }
  catch (err) { throw new Error(`Repository root cannot be resolved: ${repoRoot} (${err.message})`); }

  if (!contains(repoRoot, lexicalPath)) {
    throw new Error(`${kind} is outside the repository: ${lexicalPath}\nRepository root: ${repoRoot}`);
  }
  const ancestor = nearestExistingAncestor(lexicalPath, [{ lexicalPath: repoRoot }], kind);
  if (!contains(canonicalRepo, ancestor)) {
    throw new Error(`${kind} escapes through an existing symlinked parent: ${lexicalPath} -> ${ancestor}\nRepository root: ${repoRoot}`);
  }
  if (existsSync(lexicalPath) && lstatSync(lexicalPath).isSymbolicLink()) {
    throw new Error(`${kind} may not be a symlink: ${lexicalPath}\nRepository root: ${repoRoot}`);
  }
  return { path: lexicalPath, canonicalPath: existsSync(lexicalPath) ? realpathSync(lexicalPath) : null };
}
