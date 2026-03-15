export function extractFrontmatter(raw) {
  if (!raw.startsWith('---\n')) {
    return { frontmatter: '', body: raw };
  }

  const endMarker = raw.indexOf('\n---\n', 4);
  if (endMarker === -1) {
    return { frontmatter: '', body: raw };
  }

  return {
    frontmatter: raw.slice(4, endMarker),
    body: raw.slice(endMarker + 5),
  };
}

export function parseSimpleFrontmatter(text) {
  const data = {};
  let currentArrayKey = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;

    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      const [, key, rawValue] = keyMatch;
      if (!rawValue.trim()) {
        data[key] = [];
        currentArrayKey = key;
      } else {
        data[key] = parseScalar(rawValue.trim());
        currentArrayKey = null;
      }
      continue;
    }

    if (currentArrayKey) {
      const itemMatch = line.match(/^\s*-\s+(.*)$/);
      if (itemMatch) {
        data[currentArrayKey].push(parseScalar(itemMatch[1].trim()));
        continue;
      }
    }
  }

  return data;
}

function parseScalar(value) {
  const unquoted = value.replace(/^['"]|['"]$/g, '');
  if (unquoted === 'true') return true;
  if (unquoted === 'false') return false;
  return unquoted;
}
