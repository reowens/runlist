import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { capitalize, escapeTable } from './util.mjs';
import { formatSnapshot } from './render.mjs';

export function renderIndexFile(index, config) {
  const current = readFileSync(config.indexPath, 'utf8');
  const start = current.indexOf(config.indexStartMarker);
  const end = current.indexOf(config.indexEndMarker);

  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${config.indexPath} is missing generated block markers.`);
  }

  const before = current.slice(0, start + config.indexStartMarker.length);
  const after = current.slice(end);
  const generated = `\n\n${renderGeneratedBlock(index, config)}\n`;
  return `${before}${generated}${after}`;
}

function renderGeneratedBlock(index, config) {
  const lines = [];
  const indexDir = config.indexPath ? path.dirname(path.relative(config.repoRoot, config.indexPath)).split(path.sep).join('/') : '';
  const snapshotMode = config.indexSnapshot ?? 'status';

  for (const status of config.statusOrder) {
    const docs = index.docs.filter(doc => doc.status === status);
    if (docs.length === 0) continue;

    if (config.lifecycle.archiveStatuses.has(status)) {
      lines.push(...renderArchivedSection(docs, config, status));
      lines.push('');
      continue;
    }

    lines.push(`## ${capitalize(status)}`);
    lines.push('');
    lines.push(...snapshotHeader(snapshotMode));
    for (const doc of docs) {
      const snapshot = renderIndexSnapshot(doc, config, snapshotMode);
      const linkPath = indexDir ? path.relative(indexDir, doc.path).split(path.sep).join('/') : doc.path;
      lines.push(`| [${escapeTable(doc.title)}](${linkPath}) | ${escapeTable(snapshot)} |`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function renderArchivedSection(docs, config, status) {
  const lines = [];
  const limit = config.archivedHighlightLimit;
  const indexDir = config.indexPath ? path.dirname(path.relative(config.repoRoot, config.indexPath)).split(path.sep).join('/') : '';
  const highlights = docs
    .filter(doc => doc.currentState && doc.currentState !== 'No current_state set')
    .sort((a, b) => {
      const aUpdated = a.updated ?? '';
      const bUpdated = b.updated ?? '';
      return bUpdated.localeCompare(aUpdated);
    })
    .slice(0, limit);

  lines.push(`## ${capitalize(status)}`);
  lines.push('');
  lines.push(`${capitalize(status)} docs are indexed by the CLI/JSON output. Showing ${highlights.length} recent or high-signal highlights out of ${docs.length} ${status} docs:`);
  lines.push('');
  lines.push('| Doc | Status Snapshot |');
  lines.push('|-----|-----------------|');
  for (const doc of highlights) {
    const linkPath = indexDir ? path.relative(indexDir, doc.path).split(path.sep).join('/') : doc.path;
    lines.push(`| [${escapeTable(doc.title)}](${linkPath}) | ${escapeTable(formatSnapshot(doc, config))} |`);
  }
  lines.push('');
  lines.push('- Use `dotmd list` or `dotmd json` for the full inventory.');

  return lines;
}

function snapshotHeader(snapshotMode) {
  if (snapshotMode === 'state') return ['| Doc | Status Snapshot |', '|-----|-----------------|'];
  return ['| Doc | Status |', '|-----|--------|'];
}

function renderIndexSnapshot(doc, config, snapshotMode) {
  if (snapshotMode === 'state') return formatSnapshot(doc, config);
  return capitalize(doc.status ?? 'unknown');
}

export function writeIndex(content, config) {
  writeFileSync(config.indexPath, content, 'utf8');
}

// `autoHeal: true` rewrites the index in place when drift is detected and
// downgrades the result to a warning ("Auto-regenerated stale index block").
// Drift happens when frontmatter changes (status/title/current_state/module)
// arrive via paths that don't call `regenIndex` — direct file edits, `lint
// --fix`, `frontmatter-fix`, `bulk-tag`, etc. The README block is fully
// generated content; treating drift as an error forced the user to run
// `dotmd index` themselves every session. Callers inside `buildIndex` pass
// `autoHeal: true` because the docs there are always the canonical full set
// (filtering happens later in the CLI dispatcher). Direct callers with a
// filtered/synthetic docs list omit it to keep the old error semantics —
// auto-overwriting from a partial doc list would clobber valid content.
export function checkIndex(docs, config, opts = {}) {
  const { autoHeal = false } = opts;
  const warnings = [];
  const errors = [];

  if (!config.indexPath) return { warnings, errors };

  const current = readFileSync(config.indexPath, 'utf8');
  const start = current.indexOf(config.indexStartMarker);
  const end = current.indexOf(config.indexEndMarker);

  if (start === -1 || end === -1 || end < start) {
    errors.push({ path: config.indexPath, level: 'error', message: 'Missing generated index block markers.' });
    return { warnings, errors };
  }

  const index = { docs };
  const expected = renderIndexFile(index, config);
  if (expected !== current) {
    if (autoHeal) {
      try {
        writeFileSync(config.indexPath, expected, 'utf8');
        warnings.push({ path: config.indexPath, level: 'warning', message: 'Auto-regenerated stale index block.' });
      } catch (err) {
        errors.push({ path: config.indexPath, level: 'error', message: `Could not auto-regenerate stale index block: ${err.message}` });
      }
    } else {
      errors.push({ path: config.indexPath, level: 'error', message: 'Generated index block is stale. Run `dotmd index`.' });
    }
  }

  return { warnings, errors };
}
