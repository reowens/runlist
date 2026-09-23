import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildIndex, resolveDocArg } from './index.mjs';
import { die } from './util.mjs';

// `runlist decisions` — the open decisions, read from the corpus, never typed.
//
// A decision is an item inside a decisions section of a document: a heading,
// a bold lead, a list bullet or a table row whose first token is an id. A
// register is a fenced block whose first line carries the configured status
// line; its rows are `ID  text` and index the records the documents hold.
//
// Config (`runlist.config.mjs`), every key optional:
//   export const decisions = {
//     section: 'Decisions',          // the word a decisions heading names
//     types: ['plan'],               // which document types carry decisions
//     paths: ['docs/plans'],         // only documents under these, when set
//     id: '[A-Z]{1,3}-?[A-Z]?\\d{1,3}[a-z]?(?:[-.][A-Z0-9]{1,3}\\b)?',
//     prose: false,                  // also read a disposition out of prose
//     vocabulary: { open: [...], held: [...], ruled: [...], closed: [...] },
//     patterns: { ruled: ['regex source', ...] }, // extra prose markers per disposition
//     requires: { open: ['prose', 'citation', 'answers'] },
//     answers: ['regex source', ...], // extra phrases the answers detector accepts
//     register: { file, statusLine },
//     listHeading: 'Waiting on a decision:',
//   };

export const DEFAULTS = Object.freeze({
  section: 'Decisions',
  types: ['plan'],
  paths: null,
  // A compound id (`P4-D2`, `D1-R`, `D1.2`) is read whole; `D1.` at a
  // sentence end is still `D1`.
  id: '[A-Z]{1,3}-?[A-Z]?\\d{1,3}[a-z]?(?:[-.][A-Z0-9]{1,3}\\b)?',
  prose: false,
  vocabulary: {
    ruled: ['ruled', 'ratified', 'resolved', 'approved', 'decided', 'answered', 'settled', 'locked'],
    closed: ['closed', 'withdrawn', 'superseded', 'overtaken', 'retired', 'cancelled', 'canceled', 'not a decision'],
    held: ['held', 'on hold', 'deferred', 'paused', 'parked', 'blocked'],
    open: ['open', 'unruled', 'unratified', 'pending', 'awaiting', 'undecided', 'unanswered', 'tbd'],
  },
  patterns: {},
  requires: {},
  answers: [],
  register: null,
  listHeading: 'Waiting on a decision:',
});

export const PENDING = new Set(['open', 'held']);
const KINDS = ['ruled', 'closed', 'held', 'open'];
const MAX_BODY_LINES = 24;

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function decisionSettings(raw = {}) {
  const s = { ...DEFAULTS, ...raw };
  s.vocabulary = { ...DEFAULTS.vocabulary, ...(raw.vocabulary ?? {}) };
  s.types = [].concat(s.types ?? DEFAULTS.types);
  return s;
}

// ── Grammar ──────────────────────────────────────────────────────────────────

function wordsRe(words) {
  return words.map(w => escapeRe(w).replace(/\s+/g, '\\s+')).join('|');
}

// A heading opens a decisions scope when the section word is one of its first
// 4 words, after any leading enumerator or marker. A heading that only
// mentions a decision further along is about something else.
export function isDecisionHeading(text, section = DEFAULTS.section) {
  const stem = section.toLowerCase().replace(/s$/, '');
  const stripped = text
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/^(?:[A-Z]|[A-Z]?\d+[A-Za-z]?(?:\.\d+)*)[.)]\s+(?:[—–-]\s+)?/, '')
    .replace(/^[^\p{L}\p{N}]+/u, '');
  const words = stripped.split(/\s+/)
    .filter(w => /[\p{L}\p{N}]/u.test(w))
    .slice(0, 4)
    .map(w => w.toLowerCase().replace(/[^\p{L}\p{N}-]+$/u, ''));
  return words.some(w => w === stem || w === `${stem}s`);
}

function itemPatterns(id) {
  return [
    { kind: 'register', re: new RegExp(`^(${id})\\s{1,3}(\\S.*)$`), registerOnly: true },
    { kind: 'table', re: new RegExp(`^\\|\\s*\\**(${id})\\**\\s*\\|(.*)$`) },
    { kind: 'heading', re: new RegExp(`^(#{2,6})\\s+\\**(${id})\\b[\\s,.:—-]*(.*)$`) },
    { kind: 'record', re: new RegExp(`^\\*\\*(${id})\\b[\\s,.:—-]+(.*)$`) },
    { kind: 'list', re: new RegExp(`^[-*]\\s+(?:\\[[ xX]\\]\\s+)?\\**(${id})\\b[\\s,.:—-]+(.*)$`) },
  ];
}

// An item that presents as a decision and carries no id: a bold `Decision`
// lead inside a decisions section.
const UNNAMED = /^(?:[-*]\s+(?:\[[ xX]\]\s+)?)?\*\*Decisions?\b/i;

/**
 * Every decision item in one document's text, in file order. Pure.
 * Returns `{id, line, kind, level, context, lines, text}`; `id` is null for an
 * unnamed item.
 */
export function parseDecisionItems(text, settings = DEFAULTS) {
  const s = decisionSettings(settings);
  const lines = text.split('\n');
  // Frontmatter is blanked so line numbers stay file coordinates.
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) for (let i = 0; i <= end; i++) lines[i] = '';
  }
  const patterns = itemPatterns(s.id);
  const statusLine = s.register?.statusLine?.trim().toLowerCase() ?? null;
  const vocab = s.vocabulary;
  const items = [];

  let fence = null;
  let inRegister = false;
  let scope = 0; // the level of the decisions heading in force, 0 for none
  let context = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (fence === null) {
        fence = f[1][0];
        const first = (lines[i + 1] ?? '').trim();
        inRegister = !!statusLine && first.toLowerCase().includes(statusLine);
        context = inRegister ? leadingDisposition(first, vocab) : null;
        if (inRegister) i++; // the status line is not a row
      } else if (f[1][0] === fence) {
        fence = null;
        inRegister = false;
        context = null;
      }
      closeOpen(items);
      continue;
    }
    if (fence !== null && !inRegister) continue;

    if (fence === null) {
      const h = line.match(/^(#{1,6})\s+(.+)$/);
      if (h) {
        const level = h[1].length;
        // A heading that shouts a disposition (`Decisions, both RESOLVED
        // 2025-01-01`) marks the items under it, as a bold lead does.
        // So does one that records a dated ruling (`Decisions, ruled by the
        // owner 2025-01-01`): a date makes the ruling unambiguous in lowercase.
        context = s.prose
          ? proseDisposition(h[2], vocab, s.patterns, { shoutedOnly: true }) ?? datedRulingHeading(h[2], vocab, s.patterns)
          : null;
        const open = items.at(-1);
        if (open && !open.closed && open.kind === 'heading' && level > open.level) {
          // A subheading inside a heading record is part of it.
        } else {
          closeOpen(items);
        }
        if (isDecisionHeading(h[2], s.section)) scope = level;
        else if (scope && level <= scope) scope = 0;
      }
      const lead = line.match(/^\*\*([^*]{1,120})\*\*/);
      if (lead && !patterns.some(p => p.re.test(line))) {
        const kind = leadingDisposition(lead[1], vocab);
        if (kind) context = kind;
      }
    }

    const inScope = inRegister || scope > 0;
    let matched = false;
    if (inScope) {
      for (const p of patterns) {
        if (Boolean(p.registerOnly) !== inRegister) continue;
        const m = line.match(p.re);
        if (!m) continue;
        closeOpen(items);
        const heading = p.kind === 'heading';
        items.push({
          id: heading ? m[2] : m[1],
          line: i + 1,
          kind: p.kind,
          level: heading ? m[1].length : 0,
          context,
          lines: [heading ? m[3] : m[2]],
        });
        matched = true;
        break;
      }
      // A bold `Decision:` field inside a heading record is part of that record.
      const last = items.at(-1);
      const insideRecord = last && !last.closed && last.kind === 'heading';
      if (!matched && !inRegister && !insideRecord && UNNAMED.test(line)) {
        closeOpen(items);
        items.push({ id: null, line: i + 1, kind: 'unnamed', level: 0, context, lines: [line] });
        matched = true;
      }
    }
    if (matched) continue;

    const open = items.at(-1);
    if (!open || open.closed) continue;
    if (open.kind === 'register') { open.closed = true; continue; }
    if (open.kind === 'heading') {
      if (/^#{1,6}\s/.test(line) && line.match(/^(#{1,6})/)[1].length <= open.level) { open.closed = true; continue; }
      open.lines.push(line);
      continue;
    }
    if (line.trim() === '' || /^#{1,6}\s/.test(line) || open.lines.length >= MAX_BODY_LINES) {
      if (line.trim() === '' && open.lines.length < MAX_BODY_LINES && !open.sawBlank) { open.sawBlank = true; continue; }
      open.closed = true;
      continue;
    }
    open.lines.push(line);
    open.sawBlank = false;
  }

  return items.map(({ id, line, kind, level, context: ctx, lines: body }) => ({
    id, line, kind, level, context: ctx, text: body.join('\n').trim(),
  }));
}

function closeOpen(items) {
  const open = items.at(-1);
  if (open) open.closed = true;
}

// ── Disposition ──────────────────────────────────────────────────────────────

/** The disposition a line opens with (`RULED 2026-09-21: …`, `Open, waiting…`). */
export function leadingDisposition(text, vocab = DEFAULTS.vocabulary) {
  const t = text.replace(/^[\s*_`]+/, '');
  for (const kind of KINDS) {
    if (new RegExp(`^(?:${wordsRe(vocab[kind] ?? [])})\\b`, 'i').test(t)) return kind;
  }
  return null;
}

/** An explicit `Disposition: RULED 2026-09-21` line, or a shouted opening word. */
export function explicitDisposition(text, vocab = DEFAULTS.vocabulary) {
  const line = text.match(/\bDisposition\**\s*:\s*\**\s*(\S[^\n]*)$/im);
  if (line) return leadingDisposition(line[1], vocab);
  const first = text.trimStart().match(/^[A-Z][A-Z ]*\b/);
  if (first) {
    const kind = leadingDisposition(first[0], vocab);
    if (kind) return kind;
  }
  return null;
}

const DATE = '20\\d{2}-\\d{2}-\\d{2}';

/**
 * Every disposition word in prose, in order. A ruling word counts only with a
 * date right against it; a closing word only with a reason after it.
 */
export function proseMarkers(text, vocab = DEFAULTS.vocabulary, patterns = {}) {
  const found = [];
  const add = (kind, re, test = () => true) => {
    for (const m of text.matchAll(re)) {
      if (!test(m)) continue;
      found.push({ kind, index: m.index, caps: /[A-Z]/.test(m[1]) && m[1] === m[1].toUpperCase() });
    }
  };
  add('ruled', new RegExp(`\\b(${wordsRe(vocab.ruled ?? [])})\\b[,:;—-]?\\s*(?:\\([^)]{0,48}?)?(?:on\\s+|at\\s+|the\\s+)?${DATE}`, 'gi'));
  add('closed', new RegExp(`\\b(${wordsRe(vocab.closed ?? [])})\\b`, 'gi'),
    m => text.slice(m.index + m[0].length).replace(/[^a-z]/gi, '').length >= 12);
  add('held', new RegExp(`\\b(${wordsRe(vocab.held ?? [])})\\b`, 'gi'));
  add('open', new RegExp(`\\b(${wordsRe(vocab.open ?? [])})\\b`, 'gi'));
  for (const kind of KINDS) {
    for (const src of patterns[kind] ?? []) add(kind, new RegExp(`(${src})`, 'gi'));
  }
  return found.sort((a, b) => a.index - b.index);
}

/**
 * Prose disposition: a shouted word is the row's own line and the last one
 * wins, because rows are edited in place; with nothing shouted, an answer
 * outranks a question.
 */
export function proseDisposition(text, vocab = DEFAULTS.vocabulary, patterns = {}, { shoutedOnly = false } = {}) {
  const markers = proseMarkers(text, vocab, patterns);
  if (!markers.length) return null;
  const caps = markers.filter(m => m.caps);
  if (caps.length) return caps.at(-1).kind;
  if (shoutedOnly) return null;
  for (const kind of KINDS) if (markers.some(m => m.kind === kind)) return kind;
  return null;
}

// Explicit line first, then a shouted word in the item, then the block or bold
// lead the item sits under, then any word in its prose. A lead such as
// `**Ruled 2026-07-02:**` is a deliberate mark over the rows below it; a
// lowercase `open` inside a row is as often about something else.
export function dispositionOf(item, settings = DEFAULTS) {
  const s = decisionSettings(settings);
  const prose = opts => (s.prose ? proseDisposition(item.text, s.vocabulary, s.patterns, opts) : null);
  return explicitDisposition(item.text, s.vocabulary)
    ?? prose({ shoutedOnly: true })
    ?? item.context
    ?? prose()
    ?? null;
}

// ── The record's parts ───────────────────────────────────────────────────────

const CITATION = [
  /`[^`]*\.(?:ts|tsx|swift|mjs|js|sql|json|sh|py|yaml|yml|kt|java|rs|css|graphql|go|rb)(?::\d+)?[^`]*`/,
  /\b[\w@./-]+\.(?:ts|tsx|swift|mjs|sql|graphql|go|rb|py)(?::\d+(?:-\d+)?)?\b/,
  /`[^`]*:\d+(?:-\d+)?`/,
  /\[[^\]]+\]\([^)]*\.md[^)]*\)/,
  /\b[\w-]+\.md\b/,
];
const ANSWER_PHRASE = /\b(each answer|either answer|both answers|the alternative|what visibly (?:changes|differs))\b/i;
const OPTION_CLAUSE = /(?:^|[.;!?]\s+|\|\s*|\*\*)([A-Z][^.:;|\n]{1,70}):\s+[a-z"']/g;

export function sentences(text) {
  return text.replace(/\s+/g, ' ').split(/(?<=[.?!])\s+(?=[A-Z"'`*(])/).map(t => t.trim()).filter(Boolean);
}

/** Which parts an item's own text carries, from the detectors the tool ships. */
export function recordParts(text, settings = DEFAULTS) {
  const s = decisionSettings(settings);
  const body = text.replace(/\s+/g, ' ').trim();
  const prose = sentences(text).some(t => !t.endsWith('?') && t.replace(/[^a-z]/gi, '').length >= 40);
  const citation = CITATION.some(re => re.test(text));
  const extra = (s.answers ?? []).map(src => new RegExp(src, 'i'));
  const answers = ANSWER_PHRASE.test(body)
    || extra.some(re => re.test(body))
    || [...body.matchAll(OPTION_CLAUSE)].length >= 2
    || (/\bYes\b\s*[:,]/i.test(body) && /\bNo\b\s*[:,]/i.test(body));
  return { prose, citation, answers };
}

/** A heading that records a ruling with its date, and no other disposition. */
function datedRulingHeading(text, vocab, patterns) {
  const dated = new RegExp(`\\b(?:${wordsRe(vocab.ruled ?? [])})\\b[^.;?!\\n]{0,40}?${DATE}`, 'i');
  if (!dated.test(text)) return null;
  return proseMarkers(text, vocab, patterns).every(m => m.kind === 'ruled') ? 'ruled' : null;
}

/** Documents an item points at, by basename. */
export function pointedDocs(text) {
  const out = new Set();
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]*\.md)(?:#[^)]*)?\)/g)) out.add(m[1].split('/').pop());
  for (const m of text.matchAll(/\b([\w.-]+\.md)\b/g)) out.add(m[1]);
  return out;
}

// ── Assembly ─────────────────────────────────────────────────────────────────

const LINK = /\[[^\]]*\]\(([^)\s]*\.md)(?:#[^)]*)?\)|\b([\w.-]+\.md)\b/g;
const BESIDE = 24;

/**
 * Documents an item points at about its own id, by basename. A register or
 * table row is one line indexing one id, so any document it names counts;
 * elsewhere the id has to sit beside the link on its line (`other.md`
 * Decisions, D1, or D1 in [other](other.md)). A record that cites another
 * document for something else does not make that document's same id its peer.
 */
export function idPointedDocs(text, id, kind) {
  if (!id) return new Set();
  if (kind === 'register' || kind === 'table') return pointedDocs(text);
  const out = new Set();
  const idRe = new RegExp(`(?<![\\w.-])${escapeRe(id)}(?![\\w]|[-.][A-Z0-9])`, 'g');
  // The item's text starts after its id; the id is put back on its first line.
  for (const line of `${id} ${text}`.split('\n')) {
    const at = [...line.matchAll(idRe)].map(m => [m.index, m.index + m[0].length]);
    if (!at.length) continue;
    for (const m of line.matchAll(LINK)) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (at.some(([a, b]) => (a >= end && a - end <= BESIDE) || (b <= start && start - b <= BESIDE))) {
        out.add((m[1] ?? m[2]).split('/').pop());
      }
    }
  }
  return out;
}

/**
 * Every item across the given documents with its disposition, its parts (its
 * own plus a linked record's) and what it is missing. Pure.
 * @param {{path: string, text: string}[]} docs
 */
export function analyzeDecisions(docs, settings = DEFAULTS) {
  const s = decisionSettings(settings);
  const items = [];
  for (const doc of docs) {
    for (const item of parseDecisionItems(doc.text, s)) {
      items.push({
        ...item,
        doc: doc.path,
        file: path.basename(doc.path),
        disposition: dispositionOf(item, s),
        own: recordParts(item.text, s),
        points: idPointedDocs(item.text, item.id, item.kind),
      });
    }
  }

  const byId = new Map();
  for (const item of items) {
    if (!item.id) continue;
    if (!byId.has(item.id)) byId.set(item.id, []);
    byId.get(item.id).push(item);
  }
  const linked = (a, b) => a !== b && a.file !== b.file && (a.points.has(b.file) || b.points.has(a.file));

  for (const item of items) {
    item.peers = item.id ? byId.get(item.id).filter(p => linked(item, p)) : [];
    const parts = { ...item.own };
    for (const peer of item.peers) for (const k of Object.keys(parts)) if (peer.own[k]) parts[k] = true;
    item.parts = parts;
    // A register row that indexes this record governs its disposition.
    const row = item.kind === 'register' ? null : item.peers.find(p => p.kind === 'register');
    item.effective = row?.disposition ?? item.disposition;
    const missing = [];
    if (!item.id) missing.push('id');
    if (!item.disposition) missing.push('disposition');
    for (const part of s.requires[item.disposition] ?? []) if (!parts[part]) missing.push(part);
    item.missing = missing;
  }
  return items;
}

/** The pending rows, one per decision: linked pairs collapse, a register row preferred. */
export function pendingRows(items, { doc = null, all = false } = {}) {
  let rows = items.filter(i => i.id && (all || PENDING.has(i.effective)));
  if (doc) rows = rows.filter(i => i.doc === doc);
  const kept = [];
  const rank = i => (i.kind === 'register' ? 0 : 1);
  for (const item of [...rows].sort((a, b) => rank(a) - rank(b))) {
    const dup = kept.find(k => k.id === item.id && (k.doc === item.doc || k.peers.includes(item)));
    if (!dup) kept.push(item);
  }
  const shared = new Map();
  for (const k of kept) shared.set(k.id, (shared.get(k.id) ?? 0) + 1);
  return kept
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }) || a.doc.localeCompare(b.doc))
    .map(item => ({
      id: item.id,
      label: shared.get(item.id) > 1 ? `${item.id} (${item.file})` : item.id,
      doc: item.doc,
      line: item.line,
      kind: item.kind,
      disposition: item.effective,
      missing: item.missing,
      text: renderLine(item),
    }));
}

const clean = t => t
  .replace(/\|/g, ' ')
  .replace(/\*\*/g, '')
  .replace(/`/g, '')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/^\s*(?:[-*]\s+)?Disposition\s*:[^\n]*$/gim, '')
  .replace(/\s+/g, ' ')
  .trim();

function renderLine(item) {
  const partsMissing = item.missing.filter(m => m !== 'id' && m !== 'disposition');
  if (partsMissing.length) return `(record incomplete: missing ${partsMissing.join(', ')})`;
  const body = clean(item.text);
  if (item.kind === 'register') return body;
  const parts = sentences(body);
  const at = parts.findIndex(t => t.endsWith('?'));
  if (at === -1) return body.slice(0, 400);
  return [parts[at], ...parts.slice(at + 1, at + 4)].join(' ');
}

/** Defects, one per finding, for `--check`. */
export function decisionDefects(items) {
  const out = [];
  for (const item of items) {
    if (item.missing.length) {
      out.push({ doc: item.doc, line: item.line, id: item.id, message: `missing ${item.missing.join(', ')}` });
    }
  }
  const seen = new Map();
  for (const item of items) {
    if (!item.id) continue;
    const key = `${item.doc}#${item.id}#${item.kind === 'register'}`;
    const prior = seen.get(key);
    if (prior) out.push({ doc: item.doc, line: item.line, id: item.id, message: `id used again in this document (first at line ${prior.line})` });
    else seen.set(key, item);
  }
  for (const item of items) {
    if (!PENDING.has(item.disposition)) continue;
    for (const peer of item.peers) {
      if (peer.disposition === 'ruled' || peer.disposition === 'closed') {
        out.push({ doc: item.doc, line: item.line, id: item.id, message: `${item.disposition} here, ${peer.disposition} at ${peer.doc}:${peer.line}` });
      }
    }
  }
  return out.sort((a, b) => a.doc.localeCompare(b.doc) || a.line - b.line);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function loadDecisionDocs(config, settings) {
  const s = decisionSettings(settings);
  const types = new Set(s.types);
  const archiveDir = config.archiveDir ?? 'archived';
  const { docs } = buildIndex(config, { fast: true });
  return docs
    // A document whose frontmatter did not parse has no type; it is read rather than dropped.
    .filter(d => (types.has(d.type) || !d.type) && d.status !== 'archived' && !d.path.split('/').includes(archiveDir))
    .filter(d => !s.paths || [].concat(s.paths).some(p => d.path === p || d.path.startsWith(`${p.replace(/\/$/, '')}/`)))
    .map(d => ({ path: d.path, text: readFileSync(path.join(config.repoRoot, d.path), 'utf8') }));
}

export function runDecisions(args, config) {
  const settings = decisionSettings(config.raw?.decisions ?? {});
  const json = args.includes('--json');
  const all = args.includes('--all');
  const check = args.includes('--check');
  const target = args.find(a => !a.startsWith('-')) ?? null;

  const docs = loadDecisionDocs(config, settings);
  const items = analyzeDecisions(docs, settings);

  if (check) {
    const defects = decisionDefects(items);
    if (json) process.stdout.write(`${JSON.stringify({ ok: defects.length === 0, items: items.length, defects }, null, 2)}\n`);
    else {
      for (const d of defects) process.stdout.write(`${d.doc}:${d.line}  ${d.id ?? '(no id)'}  ${d.message}\n`);
      process.stdout.write(`${items.length} decision items in ${docs.length} documents; ${defects.length} defects.\n`);
    }
    if (defects.length) process.exitCode = 1;
    return;
  }

  let docFilter = null;
  if (target) {
    const idRe = new RegExp(`^(?:${settings.id})$`);
    const resolved = idRe.test(target) ? null : resolveDocArg(target, config, { dieOnMiss: false });
    if (resolved) docFilter = path.relative(config.repoRoot, resolved).split(path.sep).join('/');
    else if (idRe.test(target)) return showRecord(target, items, docs, json);
    else die(`No document or decision id matches "${target}".`);
  }

  const rows = pendingRows(items, { doc: docFilter, all });
  if (json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  if (!rows.length) {
    process.stdout.write(docFilter ? `No open or held decisions in ${docFilter}.\n` : 'No open or held decisions.\n');
  } else {
    process.stdout.write(`${settings.listHeading}\n\n`);
    for (const row of rows) {
      const tag = all ? `[${row.disposition ?? 'none'}] ` : '';
      process.stdout.write(`${row.label}  ${tag}${row.text}\n`);
    }
  }
  const unread = items.filter(i => (!docFilter || i.doc === docFilter) && (!i.id || !i.disposition));
  if (unread.length) {
    const noId = unread.filter(i => !i.id).length;
    process.stderr.write(`${unread.length} decision items could not be read (${noId} with no id, ${unread.length - noId} with no disposition); runlist decisions --check lists them.\n`);
  }
}

function showRecord(id, items, docs, json) {
  const hits = items.filter(i => i.id === id);
  if (!hits.length) die(`No decision ${id} in any document.`);
  if (json) {
    process.stdout.write(`${JSON.stringify(hits.map(h => ({ id, doc: h.doc, line: h.line, kind: h.kind, disposition: h.disposition, missing: h.missing, text: h.text })), null, 2)}\n`);
    return;
  }
  const texts = new Map(docs.map(d => [d.path, d.text.split('\n')]));
  hits.forEach((h, n) => {
    const lines = texts.get(h.doc);
    const bodyLines = h.text.split('\n').filter(l => l.trim() !== '').length;
    // The record as written: its first line through the last line of its body.
    let end = h.line - 1;
    let seen = 0;
    while (end < lines.length && seen < bodyLines) {
      if (lines[end].trim() !== '') seen++;
      end++;
    }
    if (n) process.stdout.write('\n');
    process.stdout.write(`${h.doc}:${h.line}  ${h.disposition ?? 'no disposition'}\n`);
    process.stdout.write(`${lines.slice(h.line - 1, end).join('\n').trimEnd()}\n`);
  });
}
