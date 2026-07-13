import { createHash } from 'node:crypto';
import path from 'node:path';

export const HTML_FALLBACK_DIR = '__dotmd';

function normalizeRelative(value, kind) {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error(`${kind} must be a string without NUL bytes`);
  }
  const normalized = path.posix.normalize(value || '.');
  if (path.posix.isAbsolute(normalized)) throw new Error(`${kind} must be relative: ${value}`);
  return normalized;
}

function isTraversal(value) {
  return value === '..' || value.startsWith('../');
}

function pathsConflict(a, b) {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function validateHtmlPath(value) {
  const normalized = normalizeRelative(value, 'HTML output path');
  if (normalized === '.' || isTraversal(normalized) || normalized !== value) {
    throw new Error(`Unsafe HTML output path: ${value}`);
  }
  return normalized;
}

export function outputPathToUrl(value) {
  return validateHtmlPath(value).split('/').map(encodeURIComponent).join('/');
}

export function allocateOutputIdentities(docs) {
  const entries = [];
  const logicalIds = new Set();

  for (const doc of docs) {
    const logicalId = normalizeRelative(doc.path, 'Document path');
    if (logicalIds.has(logicalId)) throw new Error(`Duplicate document path: ${logicalId}`);
    logicalIds.add(logicalId);

    const root = normalizeRelative(doc.root || '.', 'Document root');
    const relativeSource = path.posix.relative(root, logicalId);
    if (!relativeSource || isTraversal(relativeSource) || path.posix.isAbsolute(relativeSource)) {
      throw new Error(`Document path is not owned by its root: ${logicalId} (root: ${root})`);
    }
    if (!relativeSource.toLowerCase().endsWith('.md')) {
      throw new Error(`Document path must end in .md: ${logicalId}`);
    }

    const preferred = validateHtmlPath(relativeSource.slice(0, -3) + '.html');
    entries.push({
      logicalId,
      label: path.posix.basename(logicalId, path.posix.extname(logicalId)),
      preferred,
      conflict: preferred.toLowerCase() === 'index.html'
        || preferred.toLowerCase().startsWith('index.html/')
        || preferred.toLowerCase().startsWith(`${HTML_FALLBACK_DIR.toLowerCase()}/`),
    });
  }

  entries.sort((a, b) => a.logicalId.localeCompare(b.logicalId));
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (!pathsConflict(entries[i].preferred, entries[j].preferred)) continue;
      entries[i].conflict = true;
      entries[j].conflict = true;
    }
  }

  const digestOwners = new Map();
  for (const entry of entries) {
    if (!entry.conflict) {
      entry.htmlPath = entry.preferred;
      continue;
    }
    const digest = createHash('sha256').update(entry.logicalId).digest('hex');
    const owner = digestOwners.get(digest);
    if (owner && owner !== entry.logicalId) {
      throw new Error(`Output identity hash collision: ${owner} and ${entry.logicalId}`);
    }
    digestOwners.set(digest, entry.logicalId);
    entry.htmlPath = `${HTML_FALLBACK_DIR}/${digest}.html`;
  }

  const finalEntries = [...entries].sort((a, b) => a.htmlPath.localeCompare(b.htmlPath));
  for (let i = 0; i < finalEntries.length; i++) {
    validateHtmlPath(finalEntries[i].htmlPath);
    for (let j = i + 1; j < finalEntries.length; j++) {
      if (pathsConflict(finalEntries[i].htmlPath, finalEntries[j].htmlPath)) {
        throw new Error(`Conflicting HTML output paths: ${finalEntries[i].htmlPath} and ${finalEntries[j].htmlPath}`);
      }
    }
  }

  return new Map(entries.map(entry => [entry.logicalId, {
    logicalId: entry.logicalId,
    label: entry.label,
    htmlPath: entry.htmlPath,
    htmlUrl: outputPathToUrl(entry.htmlPath),
  }]));
}
