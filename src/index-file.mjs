import { readFileSync, writeFileSync } from 'node:fs';
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
  const prefix = config.docsRootPrefix;

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
    lines.push('| Doc | Status Snapshot |');
    lines.push('|-----|-----------------|');
    for (const doc of docs) {
      const snapshot = formatSnapshot(doc, config);
      const linkPath = prefix ? doc.path.replace(prefix, '') : doc.path;
      lines.push(`| [${escapeTable(doc.title)}](${linkPath}) | ${escapeTable(snapshot)} |`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function renderArchivedSection(docs, config, status) {
  const lines = [];
  const limit = config.archivedHighlightLimit;
  const prefix = config.docsRootPrefix;
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
    const linkPath = prefix ? doc.path.replace(prefix, '') : doc.path;
    lines.push(`| [${escapeTable(doc.title)}](${linkPath}) | ${escapeTable(formatSnapshot(doc, config))} |`);
  }
  lines.push('');
  lines.push('- Use `dotmd list` or `dotmd json` for the full inventory.');

  return lines;
}

export function writeIndex(content, config) {
  writeFileSync(config.indexPath, content, 'utf8');
}

export function checkIndex(docs, config) {
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
    errors.push({ path: config.indexPath, level: 'error', message: 'Generated index block is stale. Run `dotmd index`.' });
  }

  return { warnings, errors };
}
