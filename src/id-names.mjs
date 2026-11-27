// Whether a line names an id. A leaf with no imports, so a hook-path reader
// (src/questions.mjs) can use it without loading the document index.

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `D3` and never `D31`, `D3-B` or `D3.2`; `D3.` at a sentence end is still `D3`.
export const idPattern = id => new RegExp(`(?<![\\w.-])${escapeRe(id)}(?![\\w]|[-.][A-Z0-9])`, 'g');

// A range written out (`A2 to A12`, `A2-A12`, `A2 through 12`) names every id in it.
// The prefix is the id's code with its hyphen and an optional kind letter
// (`MLAS-`, `R10-`, `PQ-Q`); a code holding a digit needs the hyphen.
const PREFIX = '(?:[A-Z][A-Z0-9]{1,3}-|[A-Z]{1,4}-?)[A-Z]?';
const RANGE = new RegExp(`(?<![\\w.-])(${PREFIX})(\\d{1,3})\\s*(?:to|through|thru|–|—|-)\\s*(?:\\1)?(\\d{1,3})(?![\\w]|\\.\\d)`, 'g');
const SPAN = new RegExp(`^(${PREFIX})(\\d{1,3})\\s+(?:to|through)\\s+\\1?(\\d{1,3})$`);
const SINGLE = new RegExp(`^(${PREFIX})(\\d{1,3})$`);

/** Whether a line names `id`, on its own or inside a written range. An id
 * that is itself a range (`A2 to A12`) is named when any id in it is. */
export function namesId(line, id, ranges = writtenRanges(line)) {
  const span = id.match(SPAN);
  if (span) {
    if (line.includes(id)) return true;
    const [lo, hi] = [Number(span[2]), Number(span[3])];
    for (let n = lo; n <= hi && n - lo < 100; n++) if (namesId(line, `${span[1]}${n}`, ranges)) return true;
    return false;
  }
  if (line.includes(id) && idPattern(id).test(line)) return true;
  if (!ranges.length) return false;
  const m = id.match(SINGLE);
  if (!m) return false;
  const n = Number(m[2]);
  return ranges.some(([prefix, lo, hi]) => prefix === m[1] && lo <= n && n <= hi);
}

export function writtenRanges(line) {
  return [...line.matchAll(RANGE)].map(r => [r[1], Number(r[2]), Number(r[3])]);
}
