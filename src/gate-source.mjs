import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { normalizeStringList } from './util.mjs';

export const gateField = config => config.dependencyField ?? 'depends_on';
export function gateDeclarations(source, config) {
  const field = gateField(config);
  const fm = extractFrontmatter(source).frontmatter ?? '';
  const parsed = parseSimpleFrontmatter(fm, []);
  const lines = source.split(/\r?\n/);
  let active = false;
  const locations = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') break;
    const key = /^([\w-]+):/.exec(lines[i]);
    if (key) active = key[1] === field;
    if (active && (/^\s*-\s*\S/.test(lines[i]) || key)) locations.push(i + 1);
  }
  const values = normalizeStringList(parsed[field]).map(String).map(s => s.trim()).filter(Boolean);
  return { field, entries:values.map((raw,i) => ({raw, line:locations[i + (locations.length > values.length ? 1 : 0)] ?? locations[0] ?? 1})) };
}

export function parseGate(raw) {
  const match = /^([a-z]+):\s*(.*)$/.exec(raw);
  if (match) return {kind:match[1], ref:match[2].trim()};
  return {kind:/\.md(?:[?#].*)?$/i.test(raw) ? 'plan' : 'unknown',ref:raw};
}
