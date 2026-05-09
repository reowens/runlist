// Line-based, brace-aware editor for the `types.<typename>.statuses` block in
// dotmd.config.mjs. Edits are scoped to single-line status entries; we refuse
// (with an actionable error) on multi-line entries, array form, or anything
// outside our supported shape. Atomic write contract:
//
//   1. compute new content in memory
//   2. fs.writeFileSync(<path>.tmp, new)
//   3. import the tmp via file:// + cache-bust query — must parse
//   4. resolveConfig(tmp) — must not surface new warnings
//   5. fs.renameSync(tmp, real) only on full success
//   6. on any failure: unlink tmp, surface error, real file untouched
//
// Pulling in @babel/parser would force a heavy dep on a project with two
// runtime deps and would round-trip-mangle function-heavy configs with arrow
// functions and multi-line template literals. Line surgery preserves them.

import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolveConfig } from './config.mjs';

const STATUS_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const RESERVED_NAMES = new Set([
  'terminal', 'archive', 'skipStale', 'skipWarnings', 'quiet',
  'requiresModule', 'staleDays', 'context',
]);

export class ConfigEditError extends Error {
  constructor(msg) { super(msg); this.name = 'ConfigEditError'; }
}

export function validateStatusName(name) {
  if (typeof name !== 'string' || !name) return 'Status name is required.';
  if (!STATUS_NAME_RE.test(name)) {
    return `Invalid status name '${name}': must be lowercase letters/digits with single dashes between segments (e.g. 'in-session').`;
  }
  if (RESERVED_NAMES.has(name)) {
    return `Status name '${name}' collides with a flag keyword and would be confusing.`;
  }
  return null;
}

// ─── Tokenizer helpers ───────────────────────────────────────────────────────

function skipString(content, start) {
  const quote = content[start];
  let i = start + 1;
  while (i < content.length) {
    const c = content[i];
    if (c === '\\') { i += 2; continue; }
    if (c === quote) return i + 1;
    if (quote === '`' && c === '$' && content[i + 1] === '{') {
      i = skipBalanced(content, i + 1) + 1;
      continue;
    }
    i++;
  }
  return content.length;
}

function skipComment(content, start) {
  if (content[start] === '/' && content[start + 1] === '/') {
    const end = content.indexOf('\n', start);
    return end === -1 ? content.length : end + 1;
  }
  if (content[start] === '/' && content[start + 1] === '*') {
    const end = content.indexOf('*/', start + 2);
    return end === -1 ? content.length : end + 2;
  }
  return start;
}

// Skip a balanced bracket group starting at `start` (which must point at
// `{`, `[`, or `(`). Returns the position OF the matching close.
function skipBalanced(content, start) {
  const open = content[start];
  const close = open === '{' ? '}' : open === '[' ? ']' : ')';
  const stack = [close];
  let i = start + 1;
  while (i < content.length && stack.length > 0) {
    const c = content[i];
    if (c === '\'' || c === '"' || c === '`') { i = skipString(content, i); continue; }
    if (c === '/' && (content[i + 1] === '/' || content[i + 1] === '*')) { i = skipComment(content, i); continue; }
    if (c === '{') { stack.push('}'); i++; continue; }
    if (c === '[') { stack.push(']'); i++; continue; }
    if (c === '(') { stack.push(')'); i++; continue; }
    if (c === '}' || c === ']' || c === ')') {
      const expected = stack.pop();
      if (c !== expected) {
        throw new ConfigEditError(`Unexpected '${c}' at offset ${i}; expected '${expected}'.`);
      }
      if (stack.length === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

// ─── Locating the types.<typename>.statuses block ───────────────────────────

// Find the `types` declaration anywhere at the top level of the file. Matches
// `export const types = {`, `types: {` (inside default-export), or any other
// occurrence of `types <ws>(=|:) <ws>{`. Returns { start, end } pointing
// immediately after the `{` and at the matching `}`.
function locateTypesBlock(content) {
  let i = 0;
  while (i < content.length) {
    const c = content[i];
    if (c === '\'' || c === '"' || c === '`') { i = skipString(content, i); continue; }
    if (c === '/' && (content[i + 1] === '/' || content[i + 1] === '*')) { i = skipComment(content, i); continue; }

    const prevIsIdent = i > 0 && /[A-Za-z0-9_$]/.test(content[i - 1]);
    if (!prevIsIdent && content.startsWith('types', i)) {
      const after = content[i + 5] ?? '';
      if (!/[A-Za-z0-9_$]/.test(after)) {
        let j = i + 5;
        while (j < content.length && /\s/.test(content[j])) j++;
        if (content[j] === '=' || content[j] === ':') {
          j++;
          while (j < content.length) {
            const cc = content[j];
            if (cc === ' ' || cc === '\t' || cc === '\n' || cc === '\r') { j++; continue; }
            if (cc === '/' && (content[j + 1] === '/' || content[j + 1] === '*')) { j = skipComment(content, j); continue; }
            break;
          }
          if (content[j] === '{') {
            const close = skipBalanced(content, j);
            if (close !== -1) return { start: j + 1, end: close };
          }
        }
      }
    }
    i++;
  }
  return null;
}

// Within the region `[regionStart, regionEnd)`, find the immediate-level
// property `<key>: <value>` where <value> is a `{...}` object or `[...]`
// array. Returns { keyPos, openPos, closePos, openChar } or null.
function findChildProperty(content, regionStart, regionEnd, key) {
  let i = regionStart;
  while (i < regionEnd) {
    const c = content[i];
    if (c === '\'' || c === '"' || c === '`') { i = skipString(content, i); continue; }
    if (c === '/' && (content[i + 1] === '/' || content[i + 1] === '*')) { i = skipComment(content, i); continue; }
    if (/[\s,]/.test(c)) { i++; continue; }
    if (c === '{' || c === '[' || c === '(') {
      const close = skipBalanced(content, i);
      if (close === -1) return null;
      i = close + 1;
      continue;
    }

    const keyMatch = matchPropertyKey(content, i, regionEnd);
    if (!keyMatch) { i++; continue; }

    if (keyMatch.name === key) {
      let j = keyMatch.afterColon;
      while (j < regionEnd) {
        const cc = content[j];
        if (cc === ' ' || cc === '\t' || cc === '\n' || cc === '\r') { j++; continue; }
        if (cc === '/' && (content[j + 1] === '/' || content[j + 1] === '*')) { j = skipComment(content, j); continue; }
        break;
      }
      const openChar = content[j];
      if (openChar !== '{' && openChar !== '[') {
        return { keyPos: i, openPos: -1, closePos: -1, openChar };
      }
      const close = skipBalanced(content, j);
      return { keyPos: i, openPos: j, closePos: close, openChar };
    }

    // Skip past this property's value to the next comma at our depth.
    i = skipToNextProperty(content, keyMatch.afterColon, regionEnd);
  }
  return null;
}

function matchPropertyKey(content, start, end) {
  let i = start;
  let name;
  if (content[i] === '\'' || content[i] === '"') {
    const quote = content[i];
    const close = content.indexOf(quote, i + 1);
    if (close === -1 || close >= end) return null;
    name = content.slice(i + 1, close);
    i = close + 1;
  } else {
    const slice = content.slice(i, end);
    const m = slice.match(/^[A-Za-z_$][A-Za-z0-9_$-]*/);
    if (!m) return null;
    name = m[0];
    i += name.length;
  }
  while (i < end && /[ \t]/.test(content[i])) i++;
  if (content[i] !== ':') return null;
  return { name, afterColon: i + 1 };
}

function skipToNextProperty(content, start, end) {
  let i = start;
  while (i < end) {
    const c = content[i];
    if (c === '\'' || c === '"' || c === '`') { i = skipString(content, i); continue; }
    if (c === '/' && (content[i + 1] === '/' || content[i + 1] === '*')) { i = skipComment(content, i); continue; }
    if (c === '{' || c === '[' || c === '(') {
      const close = skipBalanced(content, i);
      if (close === -1) return end;
      i = close + 1;
      continue;
    }
    if (c === ',') return i + 1;
    i++;
  }
  return end;
}

// ─── Parsing the statuses block ──────────────────────────────────────────────

// Parse the statuses block, returning a structural view we can edit:
//   { form: 'object'|'array', blockStart, blockEnd, entries, openLineEnd, closeLineStart }
// `entries` items have shape { name, lineStart, lineEnd, multiLine, raw }.
// `lineStart` / `lineEnd` are absolute file offsets. `lineEnd` is exclusive
// and includes the trailing newline (one past `\n`); `lineStart` is the
// position of the first character of the entry's line.
export function parseStatusesBlock(content, typeName) {
  const types = locateTypesBlock(content);
  if (!types) {
    throw new ConfigEditError('Your dotmd.config.mjs does not define a `types` block — there is nothing for `dotmd statuses` to edit. Add a `types: {...}` export to opt in to per-project status taxonomy. See dotmd.config.example.mjs for the rich-form template.');
  }
  const typeProp = findChildProperty(content, types.start, types.end, typeName);
  if (!typeProp) {
    throw new ConfigEditError(`Type '${typeName}' is not defined in this config's \`types\` block.`);
  }
  if (typeProp.openChar !== '{') {
    throw new ConfigEditError(`Type '${typeName}' must be an object (found ${typeProp.openChar === '[' ? 'array' : 'a non-object value'}).`);
  }
  const statuses = findChildProperty(content, typeProp.openPos + 1, typeProp.closePos, 'statuses');
  if (!statuses || statuses.openPos === -1) {
    throw new ConfigEditError(`Type '${typeName}' has no \`statuses\` property.`);
  }

  const blockStart = statuses.openPos + 1;
  const blockEnd = statuses.closePos;
  const form = statuses.openChar === '{' ? 'object' : 'array';

  if (form === 'array') {
    // For array form we replace the whole literal during migrate; per-line
    // invariants don't apply.
    return {
      form, blockStart, blockEnd,
      entries: parseArrayEntries(content, blockStart, blockEnd),
      openLineEnd: -1, closeLineStart: -1,
    };
  }

  // Object form needs the open/close brace on their own lines for line-based
  // editing.
  const openLineEnd = nextNewline(content, statuses.openPos) + 1;
  const closeLineStart = lineStartOf(content, blockEnd);

  if (openLineEnd === 0 || openLineEnd > blockEnd) {
    throw new ConfigEditError(`statuses block for type '${typeName}' is not in the expected multi-line form.`);
  }

  return { form, blockStart, blockEnd, entries: parseObjectEntries(content, openLineEnd, closeLineStart), openLineEnd, closeLineStart };
}

function nextNewline(content, from) {
  return content.indexOf('\n', from);
}

function lineStartOf(content, pos) {
  const prev = content.lastIndexOf('\n', pos - 1);
  return prev === -1 ? 0 : prev + 1;
}

function parseObjectEntries(content, regionStart, regionEnd) {
  const entries = [];
  let i = regionStart;
  while (i < regionEnd) {
    const lineEndIdx = content.indexOf('\n', i);
    const lineEnd = lineEndIdx === -1 || lineEndIdx > regionEnd ? regionEnd : lineEndIdx;
    const lineEndExclusive = lineEnd === regionEnd ? regionEnd : lineEnd + 1;
    const lineRaw = content.slice(i, lineEnd);

    const stripped = stripCommentsAndTrim(lineRaw);
    if (stripped === '') {
      i = lineEndExclusive;
      continue;
    }

    const entry = parseSingleLineEntry(content, i, lineEnd);
    if (entry) {
      entries.push({
        name: entry.name,
        lineStart: i,
        lineEnd: lineEndExclusive,
        multiLine: false,
        raw: content.slice(i, lineEndExclusive),
      });
      i = lineEndExclusive;
      continue;
    }

    // Possibly multi-line: detect if it starts a property with an opening `{`
    // that doesn't close on the same line.
    const multi = parseMultiLineEntryStart(content, i, regionEnd);
    if (multi) {
      const multiLineEnd = content.indexOf('\n', multi.endPos);
      const ml = multiLineEnd === -1 || multiLineEnd > regionEnd ? regionEnd : multiLineEnd + 1;
      entries.push({
        name: multi.name,
        lineStart: i,
        lineEnd: ml,
        multiLine: true,
        raw: content.slice(i, ml),
      });
      i = ml;
      continue;
    }

    // Unknown line shape (could be a stray construct) — skip it.
    i = lineEndExclusive;
  }
  return entries;
}

function stripCommentsAndTrim(line) {
  // Strip `//` and `/* ... */` (single-line) and trim. Coarse but enough to
  // detect whether a line is meaningful.
  let s = line;
  // Remove /* ... */ entirely (single-line cases)
  s = s.replace(/\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//g, '');
  const slashIdx = findUnquotedSlashSlash(s);
  if (slashIdx !== -1) s = s.slice(0, slashIdx);
  return s.trim();
}

function findUnquotedSlashSlash(s) {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\'' || c === '"' || c === '`') {
      i = skipString(s, i);
      continue;
    }
    if (c === '/' && s[i + 1] === '/') return i;
    i++;
  }
  return -1;
}

function parseSingleLineEntry(content, lineStart, lineEnd) {
  let i = lineStart;
  while (i < lineEnd && /[ \t]/.test(content[i])) i++;
  if (i >= lineEnd) return null;

  let name;
  if (content[i] === '\'' || content[i] === '"') {
    const quote = content[i];
    const close = content.indexOf(quote, i + 1);
    if (close === -1 || close >= lineEnd) return null;
    name = content.slice(i + 1, close);
    i = close + 1;
  } else if (/[A-Za-z_$]/.test(content[i])) {
    const slice = content.slice(i, lineEnd);
    const m = slice.match(/^[A-Za-z_$][A-Za-z0-9_$-]*/);
    if (!m) return null;
    name = m[0];
    i += name.length;
  } else {
    return null;
  }

  while (i < lineEnd && /[ \t]/.test(content[i])) i++;
  if (content[i] !== ':') return null;
  i++;
  while (i < lineEnd && /[ \t]/.test(content[i])) i++;
  if (content[i] !== '{') return null;
  const close = skipBalanced(content, i);
  if (close === -1 || close >= lineEnd) return null;

  // Allow trailing whitespace, optional comma, optional inline comment.
  let j = close + 1;
  while (j < lineEnd && /[ \t]/.test(content[j])) j++;
  if (content[j] === ',') j++;
  while (j < lineEnd && /[ \t]/.test(content[j])) j++;
  // Allow trailing line comment
  if (j < lineEnd) {
    if (content[j] === '/' && (content[j + 1] === '/' || content[j + 1] === '*')) {
      // OK — rest of line is a comment
    } else {
      return null;
    }
  }
  return { name };
}

function parseMultiLineEntryStart(content, lineStart, regionEnd) {
  let i = lineStart;
  while (i < regionEnd && /[ \t]/.test(content[i])) i++;
  if (i >= regionEnd) return null;
  let name;
  if (content[i] === '\'' || content[i] === '"') {
    const quote = content[i];
    const close = content.indexOf(quote, i + 1);
    if (close === -1) return null;
    name = content.slice(i + 1, close);
    i = close + 1;
  } else if (/[A-Za-z_$]/.test(content[i])) {
    const slice = content.slice(i, regionEnd);
    const m = slice.match(/^[A-Za-z_$][A-Za-z0-9_$-]*/);
    if (!m) return null;
    name = m[0];
    i += name.length;
  } else {
    return null;
  }
  while (i < regionEnd && /\s/.test(content[i])) i++;
  if (content[i] !== ':') return null;
  i++;
  while (i < regionEnd && /\s/.test(content[i])) i++;
  if (content[i] !== '{') return null;
  const close = skipBalanced(content, i);
  if (close === -1 || close >= regionEnd) return null;
  return { name, endPos: close + 1 };
}

function parseArrayEntries(content, regionStart, regionEnd) {
  const entries = [];
  let i = regionStart;
  while (i < regionEnd) {
    const c = content[i];
    if (c === '\'' || c === '"') {
      const quote = c;
      const close = content.indexOf(quote, i + 1);
      if (close === -1 || close >= regionEnd) break;
      entries.push({ name: content.slice(i + 1, close) });
      i = close + 1;
      continue;
    }
    if (c === '/' && (content[i + 1] === '/' || content[i + 1] === '*')) {
      i = skipComment(content, i);
      continue;
    }
    i++;
  }
  return entries;
}

// ─── Detecting an explicit `lifecycle` export ────────────────────────────────

export function hasExplicitLifecycle(content) {
  // Walk the file, skipping strings/comments, looking for
  // `export <ws> const <ws> lifecycle <ws> =` at depth 0.
  let i = 0;
  let depth = 0;
  while (i < content.length) {
    const c = content[i];
    if (c === '\'' || c === '"' || c === '`') { i = skipString(content, i); continue; }
    if (c === '/' && (content[i + 1] === '/' || content[i + 1] === '*')) { i = skipComment(content, i); continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; i++; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; i++; continue; }
    if (depth === 0) {
      if ((i === 0 || !/[A-Za-z0-9_$]/.test(content[i - 1])) && content.startsWith('export', i)) {
        let j = i + 6;
        while (j < content.length && /\s/.test(content[j])) j++;
        if (content.startsWith('const', j) || content.startsWith('let', j) || content.startsWith('var', j)) {
          j += content[j] === 'c' ? 5 : 3;
          while (j < content.length && /\s/.test(content[j])) j++;
          if (content.startsWith('lifecycle', j) && !/[A-Za-z0-9_$]/.test(content[j + 9] ?? '')) {
            return true;
          }
        }
      }
    }
    i++;
  }
  return false;
}

// ─── Edit operations ─────────────────────────────────────────────────────────

// Build the literal text of a `'name': { flags... },` line.
export function renderEntryLine(name, props, indent = '    ') {
  const quotedName = `'${name}'`;
  const pairs = [];
  // Stable ordering matches the example config.
  const order = ['context', 'staleDays', 'requiresModule', 'archive', 'terminal', 'skipStale', 'skipWarnings', 'quiet'];
  for (const key of order) {
    if (key in props) pairs.push(`${key}: ${formatPropValue(props[key])}`);
  }
  for (const [key, val] of Object.entries(props)) {
    if (!order.includes(key)) pairs.push(`${key}: ${formatPropValue(val)}`);
  }
  return `${indent}${quotedName}: { ${pairs.join(', ')} },\n`;
}

function formatPropValue(v) {
  if (typeof v === 'string') return `'${v.replace(/'/g, "\\'")}'`;
  return String(v);
}

// Insert a new status entry. Position rule: before the first entry whose
// flags include `terminal: true` or `archive: true`. If none exist, append at
// the end (right before the closing brace's line).
export function spliceEntry(content, parsed, line, beforeName) {
  let insertPos;
  if (beforeName) {
    const target = parsed.entries.find(e => e.name === beforeName);
    if (!target) {
      throw new ConfigEditError(`Internal: insertion target '${beforeName}' not found.`);
    }
    insertPos = target.lineStart;
  } else {
    insertPos = parsed.closeLineStart;
  }
  return content.slice(0, insertPos) + line + content.slice(insertPos);
}

// Replace the entry line for `name` with `newLine`. Refuses on multi-line.
export function replaceEntry(content, parsed, name, newLine) {
  const target = parsed.entries.find(e => e.name === name);
  if (!target) {
    throw new ConfigEditError(`Status '${name}' is not defined for this type.`);
  }
  if (target.multiLine) {
    throw new ConfigEditError(`Status '${name}' spans multiple lines; this CLI only edits single-line entries. Edit dotmd.config.mjs by hand.`);
  }
  return content.slice(0, target.lineStart) + newLine + content.slice(target.lineEnd);
}

// Delete the entry line for `name`, including its trailing newline.
export function deleteEntry(content, parsed, name) {
  const target = parsed.entries.find(e => e.name === name);
  if (!target) {
    throw new ConfigEditError(`Status '${name}' is not defined for this type.`);
  }
  if (target.multiLine) {
    throw new ConfigEditError(`Status '${name}' spans multiple lines; delete it by hand in dotmd.config.mjs.`);
  }
  return content.slice(0, target.lineStart) + content.slice(target.lineEnd);
}

// Inferred indent of inner entries — used when the block has none yet.
export function inferIndent(content, parsed) {
  if (parsed.entries.length === 0) {
    // Fall back to 4 spaces past the open-line's leading whitespace.
    const openLineStart = lineStartOf(content, parsed.openLineEnd - 1);
    const openLine = content.slice(openLineStart, parsed.openLineEnd - 1);
    const leading = openLine.match(/^\s*/)[0];
    return leading + '  ';
  }
  const firstLine = parsed.entries[0].raw;
  const m = firstLine.match(/^(\s*)/);
  return m ? m[1] : '    ';
}

// ─── Atomic write ────────────────────────────────────────────────────────────

export async function writeConfigAtomic(configPath, newContent, cwd) {
  // Node only imports .mjs/.js/.cjs, so the temp must keep a JS extension.
  // Sibling file in the same dir → atomic renameSync within one filesystem.
  const tmpPath = configPath.replace(/(\.[^.]+)$/, `.dotmd-edit-${process.pid}-${Date.now()}$1`);
  writeFileSync(tmpPath, newContent, 'utf8');

  try {
    // Step 1: must parse.
    const url = pathToFileURL(tmpPath).href + '?bust=' + Date.now();
    try {
      await import(url);
    } catch (err) {
      throw new ConfigEditError(`Generated config does not parse: ${err.message}`);
    }

    // Step 2: must resolve cleanly. Existing warnings are tolerated; new ones
    // produced by the rewrite are not.
    let baseline = [];
    if (existsSync(configPath)) {
      try {
        const cfg = await resolveConfig(cwd, configPath);
        baseline = cfg.configWarnings ?? [];
      } catch {
        // Couldn't resolve original — skip the diff check.
      }
    }
    const updated = await resolveConfig(cwd, tmpPath);
    const baselineSet = new Set(baseline);
    const novel = (updated.configWarnings ?? []).filter(w => !baselineSet.has(w));
    if (novel.length > 0) {
      throw new ConfigEditError(`Generated config surfaces new warnings:\n  - ${novel.join('\n  - ')}`);
    }

    renameSync(tmpPath, configPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}
