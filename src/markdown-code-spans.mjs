function mask(text) {
  return text.includes('\n') ? text.replace(/[^\n]/g, 'x') : 'x'.repeat(text.length);
}

// Markdown code spans close only on a backtick run of the same length as their
// opener. The mask is deliberately the same length as the source so consumers
// can inspect neutralized Markdown while applying any edits at source offsets.
// `state` lets the conservative multiline behavior used by the reference
// rewriter survive: after an unmatched opener, nothing is treated as prose
// until a compatible closer appears.
export function maskInlineCodeLine(line, state = { run: null }) {
  if (!line.includes('`')) return state.run === null ? line : mask(line);

  const runs = [...line.matchAll(/`+/g)];
  const findCloser = (from, length) => {
    for (let i = from; i < runs.length; i++) if (runs[i][0].length === length) return i;
    return -1;
  };
  const ranges = [];
  let index = 0;

  if (state.run !== null) {
    const closingIndex = findCloser(0, state.run);
    if (closingIndex === -1) return mask(line);
    const closing = runs[closingIndex];
    ranges.push([0, closing.index + closing[0].length]);
    index = closingIndex + 1;
    state.run = null;
  }

  for (; index < runs.length; index++) {
    const opening = runs[index];
    const closingIndex = findCloser(index + 1, opening[0].length);
    if (closingIndex === -1) {
      ranges.push([opening.index, line.length]);
      state.run = opening[0].length;
      break;
    }
    const closing = runs[closingIndex];
    ranges.push([opening.index, closing.index + closing[0].length]);
    index = closingIndex;
  }

  // Ranges are ascending and disjoint, so one left-to-right pass builds the
  // result instead of re-copying the whole line once per span.
  let out = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    out += line.slice(cursor, start) + mask(line.slice(start, end));
    cursor = end;
  }
  return out + line.slice(cursor);
}

export function maskInlineCodeSpans(value) {
  const state = { run: null };
  return value.split('\n').map(line => maskInlineCodeLine(line, state)).join('\n');
}
