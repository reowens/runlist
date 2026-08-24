function maskRange(value, start, end) {
  return value.slice(0, start)
    + value.slice(start, end).replace(/[^\n]/g, 'x')
    + value.slice(end);
}

// Markdown code spans close only on a backtick run of the same length as their
// opener. The mask is deliberately the same length as the source so consumers
// can inspect neutralized Markdown while applying any edits at source offsets.
// `state` lets the conservative multiline behavior used by the reference
// rewriter survive: after an unmatched opener, nothing is treated as prose
// until a compatible closer appears.
export function maskInlineCodeLine(line, state = { run: null }) {
  const ranges = [];
  const runs = [...line.matchAll(/`+/g)];
  let index = 0;

  if (state.run !== null) {
    const closingIndex = runs.findIndex(candidate => candidate[0].length === state.run);
    if (closingIndex === -1) return maskRange(line, 0, line.length);
    const closing = runs[closingIndex];
    ranges.push([0, closing.index + closing[0].length]);
    index = closingIndex + 1;
    state.run = null;
  }

  for (; index < runs.length; index++) {
    const opening = runs[index];
    const closingIndex = runs.findIndex((candidate, candidateIndex) =>
      candidateIndex > index && candidate[0].length === opening[0].length);
    if (closingIndex === -1) {
      ranges.push([opening.index, line.length]);
      state.run = opening[0].length;
      break;
    }
    const closing = runs[closingIndex];
    ranges.push([opening.index, closing.index + closing[0].length]);
    index = closingIndex;
  }

  return ranges.reduceRight((masked, [start, end]) => maskRange(masked, start, end), line);
}

export function maskInlineCodeSpans(value) {
  const state = { run: null };
  return value.split('\n').map(line => maskInlineCodeLine(line, state)).join('\n');
}
