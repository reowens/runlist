// Pure markdown section walker. Regex-walks H1-H6 headings respecting fenced
// code blocks (``` and ~~~). Returns flat list of sections with body content
// and absolute line numbers (1-indexed, matches Read tool's `offset`).

export function walkSections(body) {
  const lines = body.split('\n');
  const fenceRe = /^(`{3,}|~{3,})/;
  const headingRe = /^(#{1,6})\s+(.+?)\s*$/;
  const sections = [];
  let fenceChar = null;

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
    sections.push({
      level: h[1].length,
      heading: h[2],
      lineStart: i + 1, // 1-indexed
      lineEnd: lines.length, // patched below
      bodyLineStart: i + 2,
    });
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
const MARKER_PATTERNS = [
  { kind: 'shipped',     re: /(✅|☑|✔|\bshipped\b|\bdone\b|\bcomplete\b)/i },
  { kind: 'skipped',     re: /(⏭|\bskip(?:ped)?\b)/i },
  { kind: 'in-progress', re: /(🟡|🔄|\bin[-_ ]?(?:progress|flight)\b|\bwip\b)/i },
  { kind: 'blocked',     re: /(🚧|🔴|\bblocked\b)/i },
  { kind: 'todo',        re: /(⬜|⬛|◻|☐|\btodo\b|\bnot[-_ ]?started\b)/i },
];

export function detectMarker(heading) {
  for (const { kind, re } of MARKER_PATTERNS) {
    if (re.test(heading)) return kind;
  }
  return null;
}

export function isPhaseHeading(section) {
  return section.level === 3 && /^phase\b/i.test(section.heading);
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
