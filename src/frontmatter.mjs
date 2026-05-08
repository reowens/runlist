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

export function replaceFrontmatter(raw, newFrontmatter) {
  if (!raw.startsWith('---\n')) return raw;
  const endMarker = raw.indexOf('\n---\n', 4);
  if (endMarker === -1) return raw;
  const body = raw.slice(endMarker + 5);
  return `---\n${newFrontmatter}\n---\n${body}`;
}

// Parses our YAML subset. Optional `warnings` array receives non-fatal
// structural issues (e.g. duplicate keys) — caller decides whether to surface
// them. Default behavior is unchanged: keep first occurrence of a duplicate
// key, ignore subsequent ones.
export function parseSimpleFrontmatter(text, warnings) {
  const data = {};
  const seenDupKeys = new Set();
  let currentArrayKey = null;
  let lineNum = 0;

  for (const rawLine of text.split('\n')) {
    lineNum++;
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;

    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      const [, key, rawValue] = keyMatch;
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        currentArrayKey = null;
        if (warnings && !seenDupKeys.has(key)) {
          seenDupKeys.add(key);
          warnings.push({ key, line: lineNum,
            message: `Duplicate frontmatter key \`${key}\` at line ${lineNum}; keeping first occurrence, ignoring later values.` });
        }
        continue;
      }
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
  let unquoted = value;
  if (value.length > 1 &&
      ((value.startsWith("'") && value.endsWith("'")) ||
       (value.startsWith('"') && value.endsWith('"')))) {
    unquoted = value.slice(1, -1);
  }
  if (unquoted === 'true') return true;
  if (unquoted === 'false') return false;
  return unquoted;
}
