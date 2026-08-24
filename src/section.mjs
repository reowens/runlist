// Pure markdown section walker. Regex-walks H1-H6 headings respecting fenced
// code blocks (``` and ~~~). Returns flat list of sections with body content
// and body-relative line numbers (1-indexed). Callers with stripped frontmatter
// add extractFrontmatter().bodyLineOffset before exposing file coordinates.

export function walkSections(body) {
  const lines = body.split('\n');
  const fenceRe = /^(`{3,}|~{3,})/;
  const headingRe = /^(#{1,6})\s+(.+?)\s*$/;
  const sections = [];
  let fenceChar = null;
  let h2Ancestor = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(fenceRe);
    if (fence) {
      const tok = fence[1][0]; // ` or ~
      if (fenceChar === null) fenceChar = tok;
      else if (fenceChar === tok) fenceChar = null;
      continue;
    }
    if (fenceChar !== null) continue;
    const h = line.match(headingRe);
    if (!h) continue;
    const level = h[1].length;
    const heading = h[2];
    if (level === 1) h2Ancestor = null;
    sections.push({
      level,
      heading,
      h2Ancestor: level > 2 ? h2Ancestor : null,
      lineStart: i + 1, // 1-indexed
      lineEnd: lines.length, // patched below
      bodyLineStart: i + 2,
    });
    if (level === 2) h2Ancestor = heading;
  }

  for (let i = 0; i < sections.length; i++) {
    const next = sections.find((s, j) => j > i && s.level <= sections[i].level);
    sections[i].lineEnd = next ? next.lineStart - 1 : lines.length;
  }

  for (const s of sections) {
    s.body = lines.slice(s.bodyLineStart - 1, s.lineEnd).join('\n').trim();
  }

  return sections;
}

// Find a section by heading text, case-insensitive, trims trailing markers.
// Returns the matching section or null.
export function findSection(sections, name) {
  const norm = (s) => s.toLowerCase().replace(/[^\w\s]+$/, '').trim();
  const target = norm(name);
  return sections.find(s => norm(s.heading) === target) ?? null;
}

// Status marker detection for phase headings. Returns one of:
//   'shipped' | 'skipped' | 'in-progress' | 'blocked' | 'todo' | null
// Glyphs are checked BEFORE prose, not interleaved with it. A glyph is a
// deliberate mark; a prose word is often about something else in the sentence:
//
//   ⬜ Phase 4: Retry budget rework (scoping COMPLETE)              ← the SCOPING completed
//   Phase 2 — schema migrated ⬜ todo (column rename half DONE)     ← half a RENAME is done
//   Phase 3 (original scope) — ⏭ superseded by the shipped Phase 3  ← a DIFFERENT phase shipped
//
// Interleaved, first-match-wins order called all three shipped, so
// findActivePhase skipped a phase the author had explicitly marked unstarted.
// Within each tier the order is still priority order, which decides a heading
// carrying more than one mark.
const GLYPH_PATTERNS = [
  { kind: 'shipped',     re: /(✅|☑|✔|✓)/ },
  { kind: 'skipped',     re: /(⏭)/ },
  { kind: 'in-progress', re: /(🟡|🔄)/ },
  { kind: 'blocked',     re: /(🚧|🔴)/ },
  { kind: 'todo',        re: /(⬜|⬛|◻|☐)/ },
];

const PROSE_PATTERNS = [
  // A qualifier inverts the word it modifies, and these run BEFORE the plain
  // `shipped` pattern so the qualifier wins. Otherwise `mostly done` and
  // `(partially complete)` both read as shipped, and findActivePhase skips a
  // phase whose own checklist still has open boxes.
  { kind: 'todo',        re: /\b(?:not|never)[\s-]+(?:complete(?:d)?|done|shipped|started)\b/i },
  { kind: 'in-progress', re: /\b(?:partially|partly|mostly|nearly|almost|half)[\s-]*(?:complete(?:d)?|done|shipped)\b/i },
  { kind: 'shipped',     re: /(\bshipped\b|\bdone\b|\bcomplete\b)/i },
  { kind: 'skipped',     re: /(\bskip(?:ped)?\b)/i },
  { kind: 'in-progress', re: /(\bin[-_ ]?(?:progress|flight)\b|\bwip\b)/i },
  { kind: 'blocked',     re: /(\bblocked\b)/i },
  { kind: 'todo',        re: /(\btodo\b|\bnot[-_ ]?started\b)/i },
];

export function detectMarker(heading) {
  for (const { kind, re } of GLYPH_PATTERNS) {
    if (re.test(heading)) return kind;
  }
  for (const { kind, re } of PROSE_PATTERNS) {
    if (re.test(heading)) return kind;
  }
  return null;
}

// Leading decoration a phase heading may carry before the word "Phase":
// emphasis punctuation and any run of status markers. `detectMarker` already
// reads a marker wherever it sits, but this test was anchored at `^phase`, so
// a plan that writes `### ⬜ Phase 2 — …` had NO phases at all — not a
// miscount, an empty phase set, which drops the pickup card to its
// "no ## Phases section" fallback.
// Several of these glyphs are commonly typed in emoji-presentation form
// (the base codepoint plus a variation selector): the skip mark, the ballot
// box, the check mark. `detectMarker` is a substring test so it never
// noticed. This is a character CLASS, and the selector sits between the glyph
// and the space, is not \s, and ends the run — so a heading led by the
// emoji-presentation form was not a phase heading at all, while the bare
// codepoint was. Reported by the owner, 2026-08-16.
const PHASE_DECORATION = String.raw`[\s>*_~\`#-]*(?:[✅🚧⬜🟡⏭☑✔✓◻☐⬛🔴🔄][︎️]?\s*)*`;
const PHASE_LEAD = new RegExp(`^${PHASE_DECORATION}phase\\b`, 'i');
const FILES_MANIFEST_ANCESTOR = new RegExp(`^${PHASE_DECORATION}files\\b`, 'i');

// "Phase 3 outcome" is commentary ABOUT a phase, not a phase. Counting it
// inflates the phase set, and because `findActivePhase` ranks blocked above
// todo, a heading like "Phase 3 smoke findings — BLOCKER" gets picked as the
// plan's active phase over a real unstarted one.
//
// The noun list is deliberately tight. Wrongly excluding a real phase hides
// work; wrongly including commentary only miscounts — so this errs toward
// counting, and a word is added here only once the corpus shows it standing
// for a retrospective rather than a phase.
const PHASE_COMMENTARY = new RegExp(
  `^${PHASE_DECORATION}phase\\s+\\S+\\s+(outcome|progress|notes?|findings?|smoke|retro|review|recap|summary)\\b`,
  'i',
);

// Compound commentary shapes covered by regression fixtures. Keep
// these anchored immediately after the phase identifier: the individual nouns
// all collide with genuine work. In particular, do not add bare `status`,
// `audit`, `design`, `shape`, `plan`, `pre-plan`, or `gap-check`; the corpus has
// executable phases with each of those names. The dated gap-check form below is
// a status report, while `Phase N — gap-check fixes` remains a real phase.
const PHASE_COMPOUND_COMMENTARY = new RegExp(
  `^${PHASE_DECORATION}phase\\s+\\S+\\s+(?:` +
    `execution\\s+status|` +
    `status\\s+snapshot|` +
    `gap[- ]check\\s+\\d{4}-\\d{2}-\\d{2}|` +
    `audit\\s+results?|` +
    `inventory\\s+findings?|` +
    `deviations\\s*(?:\\+|&|and)\\s*(?:open\\s+questions|notes?)|` +
    `design\\s+[-—:]\\s*researched|` +
    `shape\\s+[-—:]\\s*worked\\s+out|` +
    `sub[- ]phases` +
  `)\\b`,
  'i',
);

export function isPhaseHeading(section) {
  if (section.level !== 3) return false;
  if (FILES_MANIFEST_ANCESTOR.test(section.h2Ancestor ?? '')) return false;
  return PHASE_LEAD.test(section.heading)
    && !PHASE_COMMENTARY.test(section.heading)
    && !PHASE_COMPOUND_COMMENTARY.test(section.heading);
}

// A phase's OWN checklist — the boxes directly under its heading, stopping at
// the next heading of any level so a sub-section's checklist is never counted
// as the parent phase's evidence.
export function phaseTally(section) {
  let checked = 0, unchecked = 0;
  for (const line of String(section?.body ?? '').split('\n')) {
    if (/^#{1,6}\s/.test(line)) break;
    if (/^\s*[-*]\s*\[x\]/i.test(line)) checked++;
    else if (/^\s*[-*]\s*\[ \]/.test(line)) unchecked++;
  }
  return { checked, unchecked, total: checked + unchecked };
}

/**
 * A phase whose declared marker its own checklist contradicts.
 *
 * Only two disagreements are reported, because only two are unambiguous:
 *
 *   shipped + an open box  — the plan's own checklist says otherwise
 *   todo    + every box checked — the work is done, the marker says unstarted
 *
 * `blocked` and `skipped` are judgements a tally cannot refute (blocked at 0/7
 * is perfectly coherent), and `in-progress` with everything checked usually
 * means work the checklist does not enumerate. These ambiguous cases are
 * excluded because checklist counts alone cannot establish a conflict.
 *
 * Returns null when there is no conflict, no marker, or no checklist.
 */
export function phaseMarkerConflict(section) {
  const declared = detectMarker(section?.heading ?? '');
  if (declared !== 'shipped' && declared !== 'todo') return null;
  const tally = phaseTally(section);
  if (tally.total === 0) return null;
  if (declared === 'shipped' && tally.unchecked > 0) return { declared, implied: 'in progress', ...tally };
  if (declared === 'todo' && tally.unchecked === 0) return { declared, implied: 'shipped', ...tally };
  return null;
}

// Summarize a phase set: { 'shipped': 2, 'in-progress': 1, 'todo': 2 }
export function summarizePhases(sections) {
  const phases = sections.filter(isPhaseHeading);
  const counts = {};
  for (const p of phases) {
    const k = detectMarker(p.heading) ?? 'todo';
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return { total: phases.length, counts, phases };
}

// Active phase = first phase whose marker is NOT shipped/skipped.
// Priority within active: in-progress > blocked > todo.
export function findActivePhase(sections) {
  const phases = sections.filter(isPhaseHeading);
  const active = phases.filter(p => {
    const m = detectMarker(p.heading);
    return m !== 'shipped' && m !== 'skipped';
  });
  if (active.length === 0) return null;
  const rank = (m) => ({ 'in-progress': 0, 'blocked': 1, 'todo': 2, [null]: 3 })[m] ?? 3;
  return active.sort((a, b) => rank(detectMarker(a.heading)) - rank(detectMarker(b.heading)))[0];
}
