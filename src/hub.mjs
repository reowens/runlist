// Hub primitives: what counts as a hub, and how to read a hub's body tables.
//
// This module is deliberately a LEAF — it imports nothing from dotmd. The hub
// predicates used to live in `runlist.mjs`, but `runlist.mjs` imports
// `index.mjs` (for `resolveDocArg`), and the hub-status check has to run FROM
// `index.mjs`. Keeping the predicates here is what lets both sides share one
// definition of "hub" instead of re-deriving it — the exact duplication the
// hub-status-drift plan exists to avoid. `runlist.mjs` re-exports them so every
// existing importer is unaffected.

// A *coordination hub* is a prose-first plan that sits above a cluster of other
// plans — a "runlist" in the platform sense (master-runlist, ai-runlist, …)
// rather than a strictly-ordered frontmatter `runlist:` sprint. The signal is
// already in frontmatter (`execution_mode: coordination`), with the
// `*-runlist` / `runlist` naming convention as a fallback for the few hubs that
// predate the field. These plans aren't units of executable work — they're
// navigation maps — so the triage view tags them and lifts them out of the
// leaf-plan flow rather than treating them as one more active plan.
export function isCoordinationHub(doc) {
  if (!doc) return false;
  if (doc.type && doc.type !== 'plan') return false;
  // Broad "held-out navigational hub" predicate: both coordination hubs and the
  // tier-3 roadmap (`execution_mode: roadmap`) are lifted out of the active count
  // and into a hub section. `isRoadmapHub` is the finer split the tier-3 views
  // use to promote a roadmap above the Runlists section; here a roadmap counts as
  // a coordination hub so all the existing held-out plumbing covers it for free.
  if (doc.executionMode === 'coordination' || doc.executionMode === 'roadmap') return true;
  const base = (doc.path.split('/').pop() || '').replace(/\.md$/, '');
  return base === 'runlist' || base.endsWith('-runlist');
}

// A *roadmap* is the tier-3 hub: a coordination hub whose children are themselves
// hubs (runlists / coordination hubs), with progress rolled up across them. The
// signal is explicit — `execution_mode: roadmap` — with NO slug-convention
// fallback (unlike coordination hubs' `*-runlist`): there's no naming convention
// for roadmaps, and `dotmd check` nudges the structural case (a coordination hub
// that points at other hubs) toward the explicit field rather than auto-promoting.
export function isRoadmapHub(doc) {
  if (!doc) return false;
  if (doc.type && doc.type !== 'plan') return false;
  return doc.executionMode === 'roadmap';
}

// A *sprint hub* declares its ordered children in frontmatter (`runlist:`).
export function isSprintHub(doc) {
  return (doc?.refFields?.runlist ?? []).length > 0;
}

// Every shape of hub: a frontmatter sprint, a coordination map, or a roadmap.
// This is the set whose body tables the hub-status guard reads.
export function isHubDoc(doc) {
  return isSprintHub(doc) || isCoordinationHub(doc);
}

// The row→target anchor: the first `.md` link in a table row is the plan that
// row is ABOUT. Shared by next-pickup detection (`detectBodyRunlistRefs`) and
// the hub-status guard, so the two can never disagree about which plan a given
// row names.
const ROW_LINK_RE = /\[[^\]]+\]\(([^)]+\.md(?:#[^)]+)?)\)/;

export function firstRowLink(line) {
  const match = ROW_LINK_RE.exec(line);
  return match ? match[1] : null;
}

// ─── Reading the status word out of a hub row ──────────────────────────────
//
// A hub row prints its child's status by hand. Two ways to find that word:
//
//   position — strip HTML comments, take the cell's LEADING token, match it
//              against the vocabulary the child's own type declares. No marker
//              needed, so this works on tables that already exist. Measured on
//              472 real rows: agrees with an explicitly marked span 96% of the
//              time and picks a wrong token zero times. Every miss leaves a
//              leading word outside the vocabulary, so it declines (and the row
//              is reported as unreadable) rather than rewriting confidently.
//   marker   — `<!--s-->active<!--/s-->` pins the span when position can't find
//              it (the measured 4%: a status sitting behind a bolded headline).
//
// The marker is 19 characters against 62 for dotmd's block grammar
// (`<!-- GENERATED:dotmd:start -->`). That difference only matters because this
// one recurs hundreds of times per estate. It makes four comment grammars in
// dotmd; the other three are block-level and correct at block level. Do NOT
// "unify" them, and do not let the count grow again.
export const MARKER_OPEN = '<!--s-->';
export const MARKER_CLOSE = '<!--/s-->';

const MARKED_SPAN_RE = /<!--\s*s\s*-->([\s\S]*?)<!--\s*\/s\s*-->/;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
// Statuses are hyphenated single words (`in-session`, `queued-after`). The
// optional emphasis prefix lets `**active**` read as a leading token while
// `**Phase 1 gate** — active` still declines: the leading word there is `Phase`.
const LEADING_TOKEN_RE = /^(\s*)(\*\*|__|\*|_|`)?([A-Za-z][A-Za-z0-9-]*)/;

// Split a markdown table row into cells, keeping each cell's offsets into the
// line so a fix can rewrite one word without touching the rest of the row.
// Honors `\|` escapes and pipes inside inline code.
export function splitRowCells(line) {
  const cells = [];
  let start = 0;
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '`') { inCode = !inCode; continue; }
    if (ch === '|' && !inCode) {
      cells.push({ raw: line.slice(start, i), start, end: i });
      start = i + 1;
    }
  }
  cells.push({ raw: line.slice(start), start, end: line.length });
  // Rows are conventionally pipe-delimited on both ends; drop the empty edge
  // segments those produce so column indexes line up with the header's.
  if (cells.length && cells[0].raw.trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].raw.trim() === '') cells.pop();
  return cells;
}

function isDelimiterRow(cells) {
  return cells.length > 0 && cells.every(cell => /^\s*:?-+:?\s*$/.test(cell.raw));
}

// A table declares a status column when a header cell IS "status"/"state".
// Deliberately exact (after stripping emphasis): a header that only mentions
// status in passing is not a promise that the column holds one.
function isStatusHeader(raw) {
  const normalized = raw.replace(/[*_`]/g, '').trim().toLowerCase();
  return normalized === 'status' || normalized === 'state';
}

export function findMarkedSpan(line) {
  const match = MARKED_SPAN_RE.exec(line);
  if (!match) return null;
  const innerStart = match.index + match[0].indexOf('-->') + 3;
  const inner = match[1];
  const lead = inner.length - inner.trimStart().length;
  const text = inner.trim();
  if (!text) return null;
  return { start: innerStart + lead, end: innerStart + lead + text.length, text, marked: true };
}

// Positional read of a cell: leading token, comments stripped, vocabulary-gated.
// `isKnownStatus` is the caller's vocabulary test — it depends on the CHILD's
// type, which only the caller can resolve, so it is injected rather than
// guessed here. Returns line-absolute offsets, like `findMarkedSpan`.
export function readPositionalToken(cell, isKnownStatus) {
  if (!cell) return null;
  // Blank out comments instead of deleting them so offsets stay line-absolute.
  const masked = cell.raw.replace(HTML_COMMENT_RE, comment => ' '.repeat(comment.length));
  const match = LEADING_TOKEN_RE.exec(masked);
  if (!match) return null;
  const word = match[3];
  if (!isKnownStatus(word)) return null;
  const start = cell.start + match[1].length + (match[2]?.length ?? 0);
  return { start, end: start + word.length, text: word, marked: false };
}

// Walk a hub body's markdown tables and return one entry per row that names a
// child (`.md` link). Pure: no vocabulary, no resolution, no IO — the caller
// resolves the target and then reads the status word, because the vocabulary
// depends on the child's own type.
//
// Returns [{ lineIndex, ref, hasStatusColumn, statusCell, marked }] where
// `lineIndex` is 0-based into `body.split('\n')` and `statusCell`/`marked`
// carry line-absolute offsets.
export function scanHubStatusRows(body) {
  if (!body) return [];
  const lines = body.split('\n');
  const rows = [];
  let fence = null;
  let table = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = FENCE_RE.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    // Fenced examples routinely contain sample hub rows (this plan's own body
    // does). Reading them would report drift against a fictional child.
    if (fenceMatch) { fence = fenceMatch[1]; table = null; continue; }

    if (!line.trim().startsWith('|')) { table = null; continue; }
    const cells = splitRowCells(line);

    if (!table) {
      // A pipe line is a table header only when a delimiter row follows it.
      const next = i + 1 < lines.length ? lines[i + 1] : '';
      if (next.trim().startsWith('|') && isDelimiterRow(splitRowCells(next))) {
        table = { statusColumn: cells.findIndex(cell => isStatusHeader(cell.raw)) };
      }
      continue;
    }
    if (isDelimiterRow(cells)) continue;

    const ref = firstRowLink(line);
    if (!ref) continue;
    rows.push({
      lineIndex: i,
      ref,
      hasStatusColumn: table.statusColumn >= 0,
      statusCell: table.statusColumn >= 0 ? cells[table.statusColumn] ?? null : null,
      marked: findMarkedSpan(line),
    });
  }
  return rows;
}

// Write `replacement` in the case style the author used, so a fix never
// restyles a table (`Active` stays capitalized, `ACTIVE` stays shouted).
export function applyStatusCase(sample, replacement) {
  if (/[A-Z]/.test(sample) && sample === sample.toUpperCase()) return replacement.toUpperCase();
  if (/^[A-Z]/.test(sample)) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  return replacement;
}
