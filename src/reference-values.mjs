import { normalizeStringList } from './util.mjs';

export function referenceValues(value) {
  const paths = [], directions = [];
  for (const entry of normalizeStringList(value)) {
    const oneWay = entry.match(/^>\s*(.+)$/);
    paths.push(oneWay ? oneWay[1].trim() : entry);
    directions.push(oneWay ? 'one-way' : 'two-way');
  }
  return { paths, directions };
}
