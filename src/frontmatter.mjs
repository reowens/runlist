// Windows-authored (CRLF) docs otherwise slip past the LF-only fence detection
// below and read as having NO frontmatter — silently dropping them from the
// managed set (no type, no status). Normalizing CRLF→LF at every parse/rewrite
// boundary is the fix; the per-line value parser already strips a trailing \r,
// so only the fence scan was blind. A managed doc settles to LF the first time a
// dotmd verb rewrites it — content-preserving line-ending normalization, not
// corruption. For LF docs this is a no-op (the `\r` guard skips the replace), so
// existing behavior is byte-identical.
export function normalizeEol(text) {
  return typeof text === 'string' && text.includes('\r') ? text.replace(/\r\n/g, '\n') : text;
}

export function extractFrontmatter(raw) {
  const text = normalizeEol(raw);
  if (!text.startsWith('---\n')) {
    return { frontmatter: '', body: text };
  }

  const endMarker = text.indexOf('\n---\n', 4);
  if (endMarker === -1) {
    return { frontmatter: '', body: text };
  }

  return {
    frontmatter: text.slice(4, endMarker),
    body: text.slice(endMarker + 5),
  };
}

export function replaceFrontmatter(raw, newFrontmatter) {
  const text = normalizeEol(raw);
  // No frontmatter to replace: return the ORIGINAL bytes untouched (a no-op
  // rewrite must not normalize a file the caller didn't intend to change).
  if (!text.startsWith('---\n')) return raw;
  const endMarker = text.indexOf('\n---\n', 4);
  if (endMarker === -1) return raw;
  const body = text.slice(endMarker + 5);
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
//
// Supported-subset boundary (deliberately NOT a full YAML parser):
//   - Scalars stay strings except literal `true`/`false`. Numbers, null, and
//     dates are kept verbatim as strings; callers coerce where they need a type
//     (so `1.0`, `2025-01-01`, version strings, and numeric-looking ids survive
//     intact rather than silently changing type).
//   - Duplicate keys keep the FIRST occurrence; later ones are ignored (and
//     reported via the optional `warnings` array).
//   - Nested maps / multi-level indentation are not parsed — only top-level
//     keys, with one level of `- ` items under an array key.
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
