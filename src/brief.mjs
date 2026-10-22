import { extractFrontmatter, normalizeEol } from './frontmatter.mjs';
import { detectMarker, findActivePhase, isPhaseHeading, matchSections, phaseMarkerConflict, phaseTally, walkChecklist, walkSections } from './section.mjs';

// A document in a few KB, for an agent to read in place of the whole file: a
// heading outline and the open checklist boxes, both with file line numbers,
// and one section on request. Pure: callers read the file and render.

export const LIMITS = {
  outline: 60, // headings shown; the deepest levels drop first
  boxes: 30, // open boxes shown without --all
  width: 140, // a heading, box or frontmatter line is cut to this
  listItems: 8, // a frontmatter list longer than this is collapsed
  textLines: 4, // and a multi-line frontmatter value cut to this many lines
  sectionLines: 500, // lines of one section read
  sectionBytes: 60 * 1024,
};

// Several files at once is a survey; each one gets less.
export const SURVEY_LIMITS = { ...LIMITS, outline: 20, boxes: 10 };

export const cut = (text, width = LIMITS.width) =>
  text.length > width ? `${text.slice(0, width - 3)}...` : text;

// The file split into lines, without the empty one a final newline leaves.
function fileLines(text) {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Headings with file coordinates: `line` is the heading, `end` the last line of
// its section (the line before the next heading at the same or a higher level).
// A phase heading also carries `phase`: its marker, its own checklist tally,
// whether it is the active phase (the rule the `use` pickup card applies), and
// a contradiction between marker and boxes when there is one.
function headingsOf(body, bodyLineOffset, lastLine) {
  const sections = walkSections(body);
  const active = findActivePhase(sections);
  return sections.map(s => {
    const h = {
      line: s.lineStart + bodyLineOffset,
      end: Math.min(s.lineEnd + bodyLineOffset, lastLine),
      level: s.level,
      heading: s.heading,
    };
    if (isPhaseHeading(s)) {
      const tally = phaseTally(s);
      const conflict = phaseMarkerConflict(s);
      h.phase = {
        marker: detectMarker(s.heading),
        done: tally.checked,
        total: tally.total,
        active: s === active,
        conflict: conflict ? { declared: conflict.declared, implied: conflict.implied } : null,
      };
    }
    return h;
  });
}

// The phase heading a body line sits under, if any.
function phaseAt(headings, line) {
  let found = null;
  for (const h of headings) if (h.phase && h.line <= line && line <= h.end) found = h;
  return found;
}

// Drop the deepest heading levels until the outline fits, then cut the tail.
function boundOutline(headings, cap) {
  let shown = headings;
  while (shown.length > cap) {
    const deepest = Math.max(...shown.map(h => h.level));
    if (deepest <= 1) break;
    shown = shown.filter(h => h.level < deepest);
  }
  shown = shown.slice(0, cap);
  return { shown, omitted: headings.length - shown.length };
}

// Frontmatter as written, with long values cut and long lists collapsed.
export function collapseFrontmatter(frontmatter, limits = LIMITS) {
  if (!frontmatter) return [];
  const out = [];
  let listRun = 0;
  let textRun = 0;
  const flush = () => {
    if (listRun > limits.listItems) out.push(`  (+${listRun - limits.listItems} more)`);
    if (textRun > limits.textLines) out.push(`  (+${textRun - limits.textLines} more lines)`);
    listRun = 0;
    textRun = 0;
  };
  for (const line of frontmatter.split('\n')) {
    if (/^\s+-\s/.test(line)) {
      if (++listRun <= limits.listItems) out.push(cut(line, limits.width));
      continue;
    }
    if (/^\s+\S/.test(line)) {
      if (++textRun <= limits.textLines) out.push(cut(line, limits.width));
      continue;
    }
    flush();
    out.push(cut(line, limits.width));
  }
  flush();
  return out;
}

/**
 * The brief of one document's raw text: its size, a bounded outline and the
 * open boxes. `all` lists every open box. Counts are of what sits outside code
 * fences, so a template's example checklist is not reported as work.
 */
export function buildBrief(raw, { all = false, limits = LIMITS } = {}) {
  const text = normalizeEol(raw);
  const { frontmatter, body, bodyLineOffset } = extractFrontmatter(text);
  const lines = fileLines(text);
  const headings = headingsOf(body, bodyLineOffset, lines.length);
  const { shown, omitted } = boundOutline(headings, limits.outline);
  const boxes = walkChecklist(body).map(b => ({ ...b, line: b.line + bodyLineOffset }));
  const open = boxes.filter(b => b.open)
    .map(({ line, text: t }) => ({ line, text: t, phase: phaseAt(headings, line)?.heading ?? null }));
  const active = headings.find(h => h.phase?.active) ?? null;
  const listed = all ? open : open.slice(0, limits.boxes);
  return {
    lines: lines.length,
    bytes: Buffer.byteLength(text),
    frontmatterLines: frontmatter ? bodyLineOffset : 0,
    outline: shown,
    outlineOmitted: omitted,
    activePhase: active ? { line: active.line, heading: active.heading } : null,
    boxes: { open: open.length, done: boxes.length - open.length },
    open: listed,
    openOmitted: open.length - listed.length,
  };
}

/**
 * One section of a document by heading: its lines from `from` (default the
 * heading) to the section's end, cut at `limits.sectionLines` lines or
 * `limits.sectionBytes`. `next` is the first line not printed when cut.
 * Returns { found: false, headings } when nothing matches.
 */
export function readSection(raw, query, { from = null, limits = LIMITS } = {}) {
  const text = normalizeEol(raw);
  const { body, bodyLineOffset } = extractFrontmatter(text);
  const lines = fileLines(text);
  const headings = headingsOf(body, bodyLineOffset, lines.length);
  const matches = matchSections(headings, query);
  if (!matches.length) return { found: false, query, headings };

  const [match, ...others] = matches;
  const start = from == null ? match.line : Math.max(from, match.line);
  if (start > match.end) {
    return { found: true, past: true, query, heading: match, from: start, others };
  }
  const rows = [];
  let bytes = 0;
  for (let n = start; n <= match.end; n++) {
    bytes += Buffer.byteLength(lines[n - 1]) + 1;
    if (rows.length >= limits.sectionLines || (rows.length && bytes > limits.sectionBytes)) break;
    rows.push({ line: n, text: lines[n - 1] });
  }
  const to = rows.length ? rows[rows.length - 1].line : start - 1;
  return {
    found: true,
    query,
    heading: match,
    from: start,
    to,
    next: to < match.end ? to + 1 : null,
    rows,
    others,
  };
}
