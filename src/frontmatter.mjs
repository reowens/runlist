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
//
// Supports:
//   inline scalars         `key: value`
//   inline flow arrays     `key: []` / `key: [a, b, "c, d"]`
//   block arrays           `key:\n  - item\n  - item`
//   folded block scalar    `key: >\n  one line\n  continues`         → "one line continues"
//   literal block scalar   `key: |\n  one\n  two`                    → "one\ntwo"
//   chomping indicators    `>-`, `|-` (strip), `>+`, `|+` (keep), default (clip to one trailing \n)
export function parseSimpleFrontmatter(text, warnings) {
  const data = {};
  const seenDupKeys = new Set();
  let currentArrayKey = null;
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i].replace(/\r$/, '');
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

      const trimmedValue = rawValue.trim();

      // Block scalar marker: > or | with optional chomping indicator (-/+).
      const blockMatch = trimmedValue.match(/^([>|])([-+])?\s*$/);
      if (blockMatch) {
        const [, style, chomp] = blockMatch;
        const { value, consumed } = collectBlockScalar(lines, i + 1, style, chomp);
        data[key] = value;
        i += consumed;
        currentArrayKey = null;
        continue;
      }

      if (!trimmedValue) {
        data[key] = [];
        currentArrayKey = key;
        continue;
      }

      const flowArray = parseFlowArray(trimmedValue);
      if (flowArray !== null) {
        data[key] = flowArray;
        currentArrayKey = null;
        continue;
      }

      data[key] = parseScalar(trimmedValue);
      currentArrayKey = null;
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

// Reads lines starting at startIdx and collects them as a YAML block scalar
// body. Stops when a line is encountered that is dedented to (or past) the
// key's indent level (zero in our frontmatter context). Returns the joined
// string and the number of lines consumed (for the caller to advance `i`).
function collectBlockScalar(lines, startIdx, style, chomp) {
  // Determine content indent from the first non-blank line.
  let contentIndent = null;
  const collected = [];
  let i = startIdx;
  for (; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line.trim() === '') {
      collected.push(''); // preserve as blank for folding/literal rules
      continue;
    }
    const indent = line.match(/^(\s*)/)[1].length;
    if (contentIndent === null) {
      // First non-blank content line establishes the indent.
      // If it's at column 0, that's a sibling key — block was empty.
      if (indent === 0) break;
      contentIndent = indent;
      collected.push(line.slice(contentIndent));
      continue;
    }
    if (indent < contentIndent) {
      // Dedented past content level — end of block scalar.
      break;
    }
    collected.push(line.slice(contentIndent));
  }

  // Strip trailing blank lines we accidentally captured before the dedent
  // (they belong to the document, not the scalar's chomping window).
  while (collected.length > 0 && collected[collected.length - 1] === '') {
    collected.pop();
  }

  // Join according to style.
  let value;
  if (style === '|') {
    // Literal: each line preserved as-is, joined with \n.
    value = collected.join('\n');
  } else {
    // Folded: single newline between non-blank lines folds to space;
    // a blank-line run between content becomes a single \n (paragraph break).
    value = '';
    let hasContent = false;
    let prevWasBlank = false;
    for (const line of collected) {
      if (line === '') {
        if (hasContent && !prevWasBlank) value += '\n';
        prevWasBlank = true;
      } else {
        if (hasContent && !prevWasBlank) value += ' ';
        value += line;
        hasContent = true;
        prevWasBlank = false;
      }
    }
  }

  // Apply chomping: default = clip (single trailing \n if any content),
  // '-' = strip (no trailing \n), '+' = keep (preserve all).
  if (chomp === '-') {
    value = value.replace(/\n+$/, '');
  } else if (chomp === '+') {
    if (!value.endsWith('\n')) value = value + '\n';
  } else {
    // Clip: strip multiple trailing newlines down to none for inline content
    // (matches the practical expectation that `key: >` yields a string without
    // trailing whitespace artifacts when used inline).
    value = value.replace(/\n+$/, '');
  }

  return { value, consumed: i - startIdx };
}

// Parses a YAML flow sequence like `[]`, `[a, b]`, `[a, "b, c", 'd']`.
// Returns an array on success, or null if the value isn't a well-formed
// `[…]` flow sequence (caller falls back to scalar parsing).
function parseFlowArray(value) {
  if (!value.startsWith('[') || !value.endsWith(']')) return null;
  const inner = value.slice(1, -1);
  if (!inner.trim()) return [];

  const items = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      current += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
      continue;
    }
    if (c === ',') {
      items.push(parseScalar(current.trim()));
      current = '';
      continue;
    }
    current += c;
  }
  if (quote !== null) return null; // unterminated quote — not a valid flow array
  items.push(parseScalar(current.trim()));
  return items;
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
