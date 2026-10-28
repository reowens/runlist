// A conservative lexical editor for one named, immutable string export. This
// does not evaluate JavaScript or print it back out: only the literal's byte
// span changes. Unlike the status editor, groups may contain regex literals.
// Ambiguous lexical contexts are refused rather than guessed.
const VALUES = ['untracked', 'tracked', 'local'];

function manual(reason) {
  throw new Error(`${reason} Edit promptTracking manually in your config using one direct declaration, for example: export const promptTracking = 'untracked'; Allowed values: 'untracked', 'tracked', 'local'. Then rerun runlist config show. No config changes were made.`);
}

const REGEX_PREFIX = new Set([
  'return', 'throw', 'yield', 'await', 'case', 'delete', 'void', 'typeof',
  'instanceof', 'in', 'of', 'new', 'else', 'do', 'default',
]);

function stringEnd(text, start) {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === quote) return i + 1;
    if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
      i = groupEnd(text, i + 1) - 1;
    }
  }
  manual('Unterminated string.');
}

function regexEnd(text, start) {
  let characterClass = false;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '[') characterClass = true;
    if (text[i] === ']') characterClass = false;
    if (text[i] === '/' && !characterClass) {
      i++;
      while (/[A-Za-z]/.test(text[i] ?? '')) i++;
      return i;
    }
    if (text[i] === '\n' || text[i] === '\r') break;
  }
  manual('Cannot safely locate a regular expression.');
}

function triviaEnd(text, start) {
  let i = start;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text.startsWith('//', i) || (i === 0 && text.startsWith('#!', i))) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) manual('Unterminated comment.');
      i = end + 2;
      continue;
    }
    break;
  }
  return i;
}

function tokenAt(text, start, previous) {
  const c = text[start];
  let end;
  let kind = 'punctuation';
  if (c === "'" || c === '"' || c === '`') {
    end = stringEnd(text, start);
    kind = c === '`' ? 'template' : 'string';
  } else if ('{[('.includes(c)) {
    end = groupEnd(text, start);
    kind = 'group';
  } else if (c === '/') {
    // A slash after a closing group needs statement/expression grammar to
    // disambiguate (if (...) /re/ vs fn(...) / divisor). Refuse that rare case.
    if (previous?.kind === 'group') manual('A slash after a bracket group is ambiguous to the setting editor.');
    const expressionEnd = previous && (
      ['string', 'template', 'regex', 'number'].includes(previous.kind)
      || (previous.kind === 'identifier' && !REGEX_PREFIX.has(previous.raw))
      || ['++', '--', '.', '?.'].includes(previous.raw)
    );
    end = expressionEnd ? start + (text[start + 1] === '=' ? 2 : 1) : regexEnd(text, start);
    if (!expressionEnd) kind = 'regex';
  } else if (/[A-Za-z_$]/.test(c)) {
    end = start + 1;
    while (/[A-Za-z0-9_$]/.test(text[end] ?? '')) end++;
    kind = 'identifier';
  } else if (/[0-9]/.test(c)) {
    end = start + 1;
    while (/[A-Za-z0-9_.]/.test(text[end] ?? '')) end++;
    kind = 'number';
  } else {
    if (c === '\\' || c.charCodeAt(0) > 127) manual('Escaped or Unicode identifiers need a manual setting edit.');
    end = start + 1;
    if (['++', '--', '=>', '?.'].includes(text.slice(start, start + 2))) end++;
  }
  return { start, end, raw: text.slice(start, end), kind };
}

function groupEnd(text, start) {
  const close = { '{': '}', '[': ']', '(': ')' }[text[start]];
  let i = start + 1;
  let previous;
  while ((i = triviaEnd(text, i)) < text.length) {
    if (text[i] === close) return i + 1;
    if ('}])'.includes(text[i])) manual('Unbalanced brackets.');
    previous = tokenAt(text, i, previous);
    i = previous.end;
  }
  manual('Unterminated bracket group.');
}

export function renderPromptTrackingSetting(content, value) {
  if (!VALUES.includes(value)) throw new Error("promptTracking must be 'untracked', 'tracked', or 'local'.");
  const tokens = [];
  let i = 0;
  while ((i = triviaEnd(content, i)) < content.length) {
    const token = tokenAt(content, i, tokens.at(-1));
    tokens.push(token);
    i = token.end;
  }
  let literal;
  for (let n = 0; n < tokens.length; n++) {
    const token = tokens[n];
    if (token.raw === 'export') {
      const next = tokens[n + 1];
      if (next?.raw === '*' || next?.raw === 'default' || next?.raw.startsWith('{')) {
        manual('Export lists, reexports, and default exports are outside the supported setting shape.');
      }
    }
    if (token.raw !== 'promptTracking') continue;
    // Requiring every top-level occurrence to be this binding also refuses
    // mutable assignments, aliases, and multi-declaration bindings.
    if (tokens[n - 2]?.raw !== 'export' || tokens[n - 1]?.raw !== 'const' || tokens[n + 1]?.raw !== '=') {
      manual('promptTracking is not a simple named const export.');
    }
    if (literal) manual('Multiple promptTracking declarations are ambiguous.');
    const candidate = tokens[n + 2];
    if (candidate?.kind !== 'string' || !VALUES.includes(candidate.raw.slice(1, -1))) {
      manual('promptTracking uses a computed or unsupported value.');
    }
    const after = tokens[n + 3];
    // Semicolonless declarations are safe only at EOF or before another
    // explicit module declaration, separated by a newline.
    if (after && after.raw !== ';' && !(
      ['export', 'import'].includes(after.raw) && /[\r\n]/.test(content.slice(candidate.end, after.start))
    )) manual('promptTracking has a computed initializer or ambiguous declaration boundary.');
    literal = candidate;
  }
  if (literal) {
    const quote = literal.raw[0];
    return {
      content: content.slice(0, literal.start) + quote + value + quote + content.slice(literal.end),
      previousValue: literal.raw.slice(1, -1),
    };
  }
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  return {
    content: content + (content && !content.endsWith('\n') ? newline : '') + `export const promptTracking = '${value}';${newline}`,
    previousValue: 'local',
  };
}
