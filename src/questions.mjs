import { mkdirStateSync as mkdirSync } from './state-directory.mjs';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stateDir } from './naming.mjs';
import { agentSessionSource, die, toRepoPath } from './util.mjs';
import { dim, green } from './color.mjs';
import { namesId } from './id-names.mjs';

// `questions --raised` runs on every tick of a band above the prompt, so it
// must not load the document index. Everything that scans, resolves or writes
// documents loads it here first.
let deps = null;
export async function loadQuestionDeps() {
  if (deps) return deps;
  const [index, mutation, managed, decisions] = await Promise.all([
    import('./index.mjs'), import('./atomic-mutation.mjs'), import('./managed-path.mjs'), import('./decisions.mjs'),
  ]);
  deps = { ...index, ...mutation, ...managed, ...decisions };
  return deps;
}
const need = () => deps ?? die('internal: loadQuestionDeps() was not awaited');

// `runlist questions` and `runlist question`: the questions a plan puts to a
// person, read from the plan's Questions section, and the ones a session has
// raised for an answer.
//
// A question is a numbered item under a Questions heading (`## Questions`,
// `### Open Questions`, `### 8. Open questions`), up to the next heading of the
// same or a higher level. 4 item forms are read: `1. **Title** body`,
// `- **Q1. Title** body`, `- Q1: title. body` and a table row with a
// `Q1. Title` cell. Once a plan has a code (`question_code:` in frontmatter),
// a question's ID sits on its own line after the list marker, `3. ABC-Q3`
// (or the older `3. ABC-3`), and its number is the question's number from then
// on, so renumbering the list never moves it. A question is answered when its
// title, or the 40 characters after a bold title, carries one of the ruling
// words, or when it is struck through.
//
// Config, `export const questions = { ... }`:
//   types: ['plan'],            // document types whose questions are listed
//   paths: ['docs/plans'],      // where plans live; codes are unique across these, archived included
//   heading: 'regex source',    // a Questions heading (matched case-insensitively)
//   fallbackHeading: 'regex source' | null, // read under the first such heading when a plan has no Questions heading
//   answered: ['regex source', ...], // the ruling words; replaces the default list
//   codeField: 'question_code', // the frontmatter field that holds the plan's code
//
// A raised question is 1 small file per session and question under the state
// directory (`.runlist/questions/`), naming the session, the plan, the number,
// the machine and when it was raised. The question is read from the plan each
// time, so a file whose question the plan has answered is never shown.

export const DEFAULTS = Object.freeze({
  types: ['plan'],
  paths: null,
  heading: '^#{2,4}\\s+(?:[\\d.]+\\s+)?(?:Open\\s+)?Questions\\b',
  fallbackHeading: null,
  answered: [
    '~~',
    '✅',
    '\\b(?:RULED|Ruled|RATIFIED|Ratified|ANSWERED|Answered|RESOLVED|Resolved|CLOSED|Closed|DEFERRED|Deferred|WITHDRAWN|Withdrawn)\\b',
    '(?<!\\bnot\\s)\\b(?:ruled|answered|resolved|decided)(?=:|,?\\s+(?:\\d{4}-\\d\\d-\\d\\d|by\\b))',
  ],
  codeField: 'question_code',
});

export const CODE = /^[A-Z][A-Z0-9]{1,3}$/;

const ITEM = /^(\d+)\.\s+(.*)$/;
const Q_ITEM = /^[-*]\s+\*\*Q(\d+)\b[.,:]?\s*(.*?)\*\*(.*)$/;
const Q_PLAIN = /^[-*]\s+(~~)?Q(\d+)[.,:]\s+(.*)$/;
const Q_ROW = /^\|(?:[^|]*\|)*?\s*(~~)?\s*Q(\d+)\.\s+([^|]*?)\s*\|/;
// An ID after the list marker, `3. ABC-Q3 ` or `3. ABC-3 `. A phase item,
// `ABC-1.2`, is never a question's ID: the number has to end at a space.
const TOKEN = /^(\s*(?:[-*]|\d+\.)\s+)([A-Z][A-Z0-9]{1,3})-Q?(\d+)\s+/;
const ROW_TOKEN = /^(\|(?:[^|]*\|)*?\s*)([A-Z][A-Z0-9]{1,3})-Q?(\d+)\s+(?=(?:~~)?\s*Q\d+\.)/;

const settingsCache = new WeakMap();

/** The questions settings with defaults filled in and the patterns compiled. */
export function questionSettings(raw = {}) {
  if (raw && typeof raw === 'object' && settingsCache.has(raw)) return settingsCache.get(raw);
  const s = { ...DEFAULTS, ...(raw ?? {}) };
  s.types = [].concat(s.types ?? DEFAULTS.types);
  s.paths = s.paths ? [].concat(s.paths).map(p => String(p).replace(/\/$/, '')) : null;
  const source = value => (value instanceof RegExp ? value.source : String(value));
  s.headingRe = new RegExp(source(s.heading), 'i');
  s.fallbackRe = s.fallbackHeading ? new RegExp(source(s.fallbackHeading), 'i') : null;
  s.answeredRe = new RegExp([].concat(s.answered).map(source).join('|'));
  s.codeRe = new RegExp(`^${s.codeField}:\\s*["']?([A-Z][A-Z0-9]{1,3})["']?\\s*$`, 'm');
  if (raw && typeof raw === 'object') settingsCache.set(raw, s);
  return s;
}

const DEFAULT_SETTINGS = questionSettings({});

/**
 * Every question under the plan's Questions headings, or under its first
 * fallback heading when it has none, as `{number, title, answered, line}` with
 * `line` 1-based in the file. A Questions heading inside another one's section
 * is read once. Pure.
 */
export function planQuestions(markdown, settings = DEFAULT_SETTINGS) {
  const lines = markdown.split('\n');
  const code = planCode(markdown, settings);
  let starts = lines.flatMap((l, i) => (settings.headingRe.test(l) ? [i] : []));
  if (!starts.length && settings.fallbackRe) starts = lines.flatMap((l, i) => (settings.fallbackRe.test(l) ? [i] : [])).slice(0, 1);
  const found = [];
  const seen = new Set();
  for (const start of starts) {
    const level = /^(#+)/.exec(lines[start] ?? '')?.[1]?.length ?? 2;
    for (const [offset, raw] of lines.slice(start + 1).entries()) {
      const heading = /^(#{1,6})\s/.exec(raw);
      if (heading && heading[1].length <= level) break;
      const at = start + 2 + offset;
      if (seen.has(at)) continue;
      seen.add(at);
      const match = TOKEN.exec(raw) ?? ROW_TOKEN.exec(raw);
      const token = match && match[2] === code ? match : null;
      const line = token ? `${token[1]}${raw.slice(token[0].length)}` : raw;
      const q = readItem(line, settings.answeredRe);
      if (q) found.push({ ...q, number: token ? Number(token[3]) : q.number, line: at });
    }
  }
  return found;
}

function readItem(line, answered) {
  const q = Q_ITEM.exec(line);
  if (q) {
    const title = (q[2] ?? '').trim();
    return { number: Number(q[1]), title, answered: answered.test(title) || answered.test((q[3] ?? '').slice(0, 40)) };
  }
  const plain = Q_PLAIN.exec(line);
  if (plain) {
    const rest = plain[3] ?? '';
    const title = (plain[1] ? rest.split('~~')[0] ?? '' : rest.split(/(?<=[.?!])\s/)[0] ?? '').trim();
    return { number: Number(plain[2]), title, answered: Boolean(plain[1]) || answered.test(title) || answered.test(rest.slice(0, 40)) };
  }
  const row = Q_ROW.exec(line);
  if (row) {
    const title = (row[3] ?? '').replace(/~~/g, '').trim();
    return { number: Number(row[2]), title, answered: Boolean(row[1]) || (answered.test(title) && !title.includes('?')) };
  }
  const item = ITEM.exec(line);
  if (!item) return null;
  const rest = item[2] ?? '';
  const bold = /^\*\*(.+?)\*\*/.exec(rest);
  const struck = /^~~(.+?)~~/.exec(rest);
  const title = (bold ? bold[1] ?? '' : struck ? (struck[1] ?? '').replace(/\*\*/g, '') : rest.split(/(?<=[.?!])\s/)[0] ?? '').trim();
  const after = bold ? rest.slice(bold[0].length, bold[0].length + 40) : '';
  return { number: Number(item[1]), title, answered: answered.test(title) || answered.test(after) || rest.startsWith('~~') };
}

/** The plan's question code from its frontmatter, or null when it has none yet. */
export function planCode(markdown, settings = DEFAULT_SETTINGS) {
  if (!markdown.startsWith('---')) return null;
  const end = markdown.indexOf('\n---', 3);
  const front = end < 0 ? '' : markdown.slice(0, end);
  return settings.codeRe.exec(front)?.[1] ?? null;
}

/** The question numbered `number` while it still waits: not answered and, when `title` is given, still the same question. */
export function openQuestion(markdown, number, title, settings = DEFAULT_SETTINGS) {
  const q = planQuestions(markdown, settings).find(x => x.number === number);
  if (!q || q.answered || (title !== undefined && q.title !== title)) return null;
  return q;
}

/** The ID a question is shown and called by: `ABC-Q3`, or the plan's name and number while it has no code. */
export const questionId = (code, number, plan) => (code ? `${code}-Q${number}` : `${plan} Q${number}`);

/**
 * Reads a typed ID into the ways it can be split: `ABC-Q3`, `abc q3`, `ABC-3`,
 * `abc 3`, `ABC3` (`ABC` 3 or `AB` with a digit in its code, settled by the
 * caller against the codes that exist), and a plan's name with a number,
 * `some-plan Q3`, `:3`, `#3`.
 */
export function parseQuestionId(text) {
  const t = String(text ?? '').trim().replace(/^docs\/plans\//, '');
  const out = [];
  const push = (key, number) => { if (!out.some(o => o.key === key && o.number === number)) out.push({ key, number }); };
  const kind = /^([a-z][a-z0-9]{1,3})\s*[-:#]?\s*q(\d+)$/i.exec(t);
  if (kind && Number(kind[2]) >= 1 && kind[2][0] !== '0') push(kind[1].toUpperCase(), Number(kind[2]));
  const code = /^([a-z][a-z0-9]{1,3})(?:\s*[-:#]\s*|\s+)?(\d+)$/i.exec(t);
  if (code) {
    const whole = `${code[1]}${code[2]}`;
    for (let i = 2; i <= Math.min(4, whole.length - 1); i++) {
      const key = whole.slice(0, i).toUpperCase(), number = Number(whole.slice(i));
      if (CODE.test(key) && number >= 1 && whole.slice(i)[0] !== '0' && (i === code[1].length || !/[-:#\s]/.test(t))) push(key, number);
    }
  }
  const slug = /^([a-z0-9][a-z0-9-]*?)(?:\.md)?(?:\s+|\s*[:#/]\s*|-(?=q))(?:q(?:uestion)?\s*)?(\d+)$/i.exec(t) ?? /^([a-z0-9][a-z0-9-]*?)-(\d+)$/i.exec(t);
  if (slug && Number(slug[2]) >= 1) push(slug[1].toLowerCase(), Number(slug[2]));
  return out;
}

/** Whether a line names question `number`: by its ID in either form (alone or in a written range), `question 3` or `Q3`, never `ABC-3.2`. */
export function namesQuestion(line, number, code) {
  if (code && (namesId(line, `${code}-${number}`) || namesId(line, `${code}-Q${number}`))) return true;
  return new RegExp(`\\b[Qq]uestions?\\s+${number}\\b(?![.-]\\d)|\\bQ${number}\\b(?![.-]\\d)`).test(line);
}

const OPEN_BOX = /^\s*[-*]\s+\[ \]/;

/** The open boxes of a document, outside its frontmatter and code fences, as `{line, text}` with `line` 1-based in the file. */
export function openBoxes(markdown) {
  const lines = markdown.split('\n');
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  const out = [];
  let fence = null;
  for (let i = end + 1; i < lines.length; i++) {
    const l = lines[i];
    const f = /^\s*(`{3,}|~{3,})/.exec(l);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; continue; }
    if (!fence && OPEN_BOX.test(l)) out.push({ line: i + 1, text: l.replace(OPEN_BOX, '').trim() });
  }
  return out;
}

function nextStepText(markdown) {
  const lines = markdown.split('\n');
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  const at = end < 0 ? -1 : lines.slice(0, end).findIndex(l => /^next_step:/.test(l));
  if (at < 0) return '';
  let k = at;
  const step = [lines[k]];
  while (++k < end && !/^[A-Za-z_]+:/.test(lines[k] ?? '')) step.push(lines[k] ?? '');
  return step.join(' ');
}

/** What an answer unlocks in the question's own plan: whether `next_step` names it, and how many open boxes do. */
export function questionReach(markdown, number, code, boxes = openBoxes(markdown)) {
  return {
    nextStep: namesQuestion(nextStepText(markdown), number, code),
    boxes: boxes.filter(b => namesQuestion(b.text, number, code)).length,
  };
}

/**
 * Whether a document is one whose questions are read: its type (from its
 * frontmatter, null when it has none) is a configured one and it sits under a
 * configured path.
 */
export function inQuestionScope(rel, type, settings) {
  if (type && !settings.types.includes(type)) return false;
  return !settings.paths || settings.paths.some(p => rel === p || rel.startsWith(`${p}/`));
}

/**
 * The open questions of 1 document as rows, each with the open boxes that name
 * it (`held`, `{line, text}`) and their count, by the rule `runlist questions`
 * reads. An empty list for a document outside the questions scope. Pure.
 */
export function openQuestionRows(rel, markdown, settings) {
  if (!inQuestionScope(rel, typeOf(markdown), settings)) return [];
  const code = planCode(markdown, settings);
  const boxes = openBoxes(markdown);
  return planQuestions(markdown, settings).filter(q => !q.answered).map(q => {
    const held = boxes.filter(b => namesQuestion(b.text, q.number, code));
    return { ...row(rel, markdown, q, code, settings, boxes), held };
  });
}

// ── Codes ────────────────────────────────────────────────────────────────────

const slugOf = file => path.basename(file).replace(/\.md$/, '');
const read = file => { try { return readFileSync(file, 'utf8'); } catch { return null; } };

/** The documents under the configured plan paths, archived included, as `{file, rel, slug, archived}`. */
export function questionScope(config, settings) {
  const archiveDir = config.archiveDir ?? 'archived';
  return need().collectDocFiles(config)
    .map(file => ({ file, rel: toRepoPath(file, config.repoRoot) }))
    .filter(({ rel }) => !settings.paths || settings.paths.some(p => rel === p || rel.startsWith(`${p}/`)))
    .map(d => ({ ...d, slug: slugOf(d.rel), archived: d.rel.split('/').slice(0, -1).includes(archiveDir) }));
}

/** The codes plans hold, each with the files that hold it: more than 1 file under a code is a collision. */
export function codeIndex(scope, settings) {
  const codes = new Map();
  for (const d of scope) {
    const code = planCode(read(d.file) ?? '', settings);
    if (code) codes.set(code, [...(codes.get(code) ?? []), d.rel]);
  }
  return codes;
}

/** The prefix a plan already numbers its own items with, `HD` in `**HD8**` or `### UR1`, when it labels at least 2. */
export function ownPrefix(markdown) {
  const numbers = new Map();
  for (const m of markdown.matchAll(/^(?:\s*(?:[-*]\s+|\d+\.\s+)?\*\*|#{2,6}\s+)([A-Z]{2,4})(\d{1,3})(?=\*\*|[,.:]|\s)/gm)) {
    numbers.set(m[1], new Set([...(numbers.get(m[1]) ?? []), m[2]]));
  }
  const best = [...numbers].map(([p, n]) => [p, n.size]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best && best[1] >= 2 ? best[0] : null;
}

/** The prefixes other plans number their own items with, which a new code leaves to them. */
export function reservedPrefixes(scope, except = null) {
  const out = new Map();
  for (const d of scope) {
    if (d.slug === except) continue;
    const prefix = ownPrefix(read(d.file) ?? '');
    if (prefix && !out.has(prefix)) out.set(prefix, d.rel);
  }
  return out;
}

/** Whether the plan already labels something with `code` and a number, so `CODE-Q1` would read as one of them. */
export const labelsWith = (markdown, code) => new RegExp(`(?<![A-Za-z0-9])${code}-?\\d`).test(markdown);

/** Candidate codes for a plan, best first: its initials, then shorter and longer spellings and a digit. */
export function codeCandidates(slug, markdown) {
  const words = slug.toUpperCase().split('-').map(w => w.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
  const initials = words.map(w => w[0]).join('');
  const firsts = [
    (initials.length >= 2 ? initials : words[0] ?? '').slice(0, 4),
    words.length >= 2 ? `${words[0]?.slice(0, 2)}${words[1]?.[0] ?? ''}` : (words[0] ?? '').slice(0, 3),
    words.slice(0, 2).map(w => w.slice(0, 2)).join(''),
  ];
  const out = [...firsts];
  for (const f of firsts) for (let d = 2; d <= 9; d++) out.push(`${f.slice(0, 3)}${d}`);
  return [...new Set(out.filter(c => c && CODE.test(c) && !labelsWith(markdown, c)))];
}

function withCode(markdown, code, settings) {
  const end = markdown.indexOf('\n---', 3);
  if (!markdown.startsWith('---') || end < 0) die('the plan has no frontmatter to hold its question code');
  return `${markdown.slice(0, end)}\n${settings.codeField}: ${code}${markdown.slice(end)}`;
}

/**
 * The plan's code, given one first when it has none: `code` when named and
 * free, else the first free candidate. A code is free when no plan in scope,
 * archived included, holds it and no other plan numbers its items with it. A
 * code is never changed once given, since IDs were said with it.
 */
export function codeFor(slug, markdown, { code = null, taken, reserved, settings = DEFAULT_SETTINGS, rel = slug }) {
  const have = planCode(markdown, settings);
  if (have) {
    if (code && code !== have) die(`${rel} already has the code ${have}; a code is never changed, since IDs were said with it`);
    return { code: have, markdown };
  }
  const owner = c => taken.get(c)?.join(', ') ?? reserved.get(c);
  if (code) {
    if (!CODE.test(code)) die(`"${code}" is not a code: 2 to 4 capital letters and digits, starting with a letter`);
    if (owner(code)) die(`the code ${code} is taken by ${owner(code)}`);
    if (labelsWith(markdown, code)) die(`${rel} already labels items ${code} and a number, so ${code}-Q1 would read as one of them: name another code`);
    return { code, markdown: withCode(markdown, code, settings) };
  }
  const pick = codeCandidates(slug, markdown).find(c => !owner(c));
  if (!pick) die(`no free code for ${slug}: name one with runlist question code ${slug} <CODE>`);
  return { code: pick, markdown: withCode(markdown, pick, settings) };
}

/** The plan text with question `q`'s ID written on its line; a line already carrying it in either form is left alone. */
export function withIdOnLine(markdown, q, code) {
  const lines = markdown.split('\n');
  const line = lines[q.line - 1] ?? '';
  const id = questionId(code, q.number);
  if (new RegExp(`(?:^|[\\s|])${code}-Q?${q.number}\\s`).test(line)) return markdown;
  const marked = line.startsWith('|')
    ? line.replace(/(\|\s*)((?:~~)?\s*Q\d+\.)/, `$1${id} $2`)
    : line.replace(/^(\s*(?:[-*]|\d+\.)\s+)/, `$1${id} `);
  if (marked === line) die(`could not write ${id} on line ${q.line}`);
  lines[q.line - 1] = marked;
  return lines.join('\n');
}

/** Why question `q` cannot carry its number as an ID, or null: its number is listed twice, or was used on another line. */
export function numberClash(markdown, all, q, code) {
  const twins = all.filter(x => x.number === q.number && x.line !== q.line);
  if (twins.length) return `question ${q.number} is listed ${twins.length + 1} times (lines ${[q, ...twins].map(x => x.line).join(', ')}); give each its own number, the next free one, before raising it`;
  if (!code) return null;
  const used = markdown.split('\n').findIndex((l, i) => i !== q.line - 1
    && new RegExp(`^\\s*(?:[-*]|\\d+\\.|\\|[^|]*\\|)?\\s*(?:\\*\\*)?${code}-Q?${q.number}\\b(?!\\.\\d)`).test(l));
  return used >= 0 ? `${questionId(code, q.number)} was already used on line ${used + 1}; a number is never reused, so give this question the next free number` : null;
}

// ── Raised questions ─────────────────────────────────────────────────────────

export const raisedDir = config => path.join(stateDir(config.repoRoot), 'questions');
const SESSION = /^[\w-]+$/;
const machineName = () => os.hostname().split('.')[0];

function planFile(input, config) {
  const file = need().resolveDocArg(input, config);
  return need().authorizeManagedSource(file, config, { kind: 'Question source' }).path;
}

/** Raises question `number` of `plan` for `sessionId`, giving the plan its code and the question its ID first. */
export function raiseQuestion(config, { plan, number, sessionId, machine = machineName(), now = () => new Date(), dryRun = false }) {
  const settings = questionSettings(config.raw?.questions);
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1) die(`"${number}" is not a question number`);
  if (!sessionId) die('no agent session id in this shell (CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID or RUNLIST_SESSION_ID), so no session would show it; pass --session <id>');
  if (!SESSION.test(sessionId)) die(`"${sessionId}" is not a session id this can name a file by: letters, digits, _ and - only`);
  const file = planFile(plan, config);
  const rel = toRepoPath(file, config.repoRoot);
  const slug = slugOf(rel);
  const markdown = readFileSync(file, 'utf8');
  const all = planQuestions(markdown, settings);
  if (!all.length) die(`${rel} has no numbered questions under a Questions heading`);
  const q = all.find(x => x.number === n);
  if (!q) die(`${rel} has no question ${n}; its questions are ${all.map(x => x.number).join(', ')}`);
  if (q.answered) die(`question ${n} of ${slug} is already answered in the plan`);
  const clash = numberClash(markdown, all, q, planCode(markdown, settings));
  if (clash) die(`${rel}: ${clash}`);
  const scope = planCode(markdown, settings) ? [] : questionScope(config, settings);
  const coded = codeFor(slug, markdown, { settings, rel, taken: codeIndex(scope, settings), reserved: reservedPrefixes(scope, slug) });
  const next = withIdOnLine(coded.markdown, planQuestions(coded.markdown, settings).find(x => x.number === n) ?? q, coded.code);
  const id = questionId(coded.code, n);
  const dir = raisedDir(config);
  const raised = path.join(dir, `${slug}-${n}-${sessionId}.json`);
  if (dryRun) return { file: raised, question: q, id, plan: rel, wrote: next !== markdown, dryRun: true };
  if (next !== markdown) writePlanFile(file, markdown, next, rel, config);
  let raisedAt = now().toISOString();
  try {
    const before = JSON.parse(readFileSync(raised, 'utf8'));
    if (before.title === q.title && before.raisedAt) raisedAt = before.raisedAt;
  } catch {}
  mkdirSync(dir, { recursive: true });
  writeFileSync(raised, `${JSON.stringify({ sessionId, plan: slug, path: rel, code: coded.code, number: n, id, title: q.title, machine, raisedAt })}\n`);
  return { file: raised, question: q, id, plan: rel, wrote: next !== markdown };
}

function writePlanFile(file, before, after, rel, config) {
  need().mutateFile(file, { repoRoot: config.repoRoot }, raw => {
    if (raw !== before) die(`${rel} changed while its question was being written; nothing was written. Run the command again.`);
    return after;
  });
}

/** Gives a plan its code when it has none (`code` when named) and writes the ID on the line of each open question that can carry one. */
export function codePlan(config, { plan, code = null, taken = null, reserved = null, dryRun = false }) {
  const settings = questionSettings(config.raw?.questions);
  const file = planFile(plan, config);
  const rel = toRepoPath(file, config.repoRoot);
  const slug = slugOf(rel);
  const before = readFileSync(file, 'utf8');
  let scope = null;
  const scoped = () => (scope ??= questionScope(config, settings));
  const coded = codeFor(slug, before, { code, settings, rel, taken: taken ?? codeIndex(scoped(), settings), reserved: reserved ?? reservedPrefixes(scoped(), slug) });
  let markdown = coded.markdown;
  const written = [], skipped = [];
  for (const { line } of planQuestions(markdown, settings).filter(x => !x.answered)) {
    const all = planQuestions(markdown, settings);
    const q = all.find(x => x.line === line);
    const clash = numberClash(markdown, all, q, coded.code);
    if (clash) { skipped.push({ number: q.number, line, why: clash }); continue; }
    const next = withIdOnLine(markdown, q, coded.code);
    if (next !== markdown) { markdown = next; written.push(questionId(coded.code, q.number)); }
  }
  if (markdown !== before && !dryRun) writePlanFile(file, before, markdown, rel, config);
  return { plan: rel, slug, code: coded.code, written, skipped, dryRun };
}

function raisedFiles(config, session = null) {
  const dir = raisedDir(config);
  let names = [];
  try { names = readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { return []; }
  if (session) names = names.filter(f => f.endsWith(`-${session}.json`));
  return names.map(name => ({ name, file: path.join(dir, name) }));
}

const readRaised = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

/** Removes each raised file whose question no longer waits in its plan, and each with no session id. Returns the names removed. */
export function pruneRaised(config) {
  const settings = questionSettings(config.raw?.questions);
  const removed = [];
  for (const { name, file } of raisedFiles(config)) {
    const w = readRaised(file);
    let open = false;
    try { open = Boolean(w?.sessionId) && Boolean(openQuestion(readFileSync(path.join(config.repoRoot, w.path), 'utf8'), w.number, w.title, settings)); } catch {}
    if (!open) { rmSync(file, { force: true }); removed.push(name); }
  }
  return removed;
}

function row(rel, markdown, q, code, settings, boxes = openBoxes(markdown)) {
  const slug = slugOf(rel);
  return {
    id: questionId(code, q.number, slug), plan: slug, path: rel, code, number: q.number, title: q.title,
    answered: q.answered, line: q.line, ...questionReach(markdown, q.number, code, boxes),
  };
}

/** The questions raised on this machine and still open, 1 row per ID however many sessions raised it, oldest first. */
export function listRaised(config, { session = null } = {}) {
  const settings = questionSettings(config.raw?.questions);
  const plans = new Map();
  const byId = new Map();
  for (const { file } of raisedFiles(config, session)) {
    const w = readRaised(file);
    if (!w?.sessionId || typeof w.path !== 'string' || typeof w.number !== 'number') continue;
    if (session && w.sessionId !== session) continue;
    if (!plans.has(w.path)) plans.set(w.path, read(path.join(config.repoRoot, w.path)));
    const markdown = plans.get(w.path);
    const q = markdown && openQuestion(markdown, w.number, w.title, settings);
    if (!q) continue;
    const code = planCode(markdown, settings);
    const id = questionId(code, w.number, w.plan);
    const r = byId.get(id) ?? { ...row(w.path, markdown, q, code, settings), raisedAt: w.raisedAt, raisedBy: [] };
    r.raisedBy.push({ sessionId: w.sessionId, machine: w.machine ?? null, raisedAt: w.raisedAt });
    if (w.raisedAt < r.raisedAt) r.raisedAt = w.raisedAt;
    byId.set(id, r);
  }
  return [...byId.values()].sort((a, b) => String(a.raisedAt).localeCompare(String(b.raisedAt)) || a.id.localeCompare(b.id));
}

const typeOf = markdown => {
  if (!markdown.startsWith('---')) return null;
  const end = markdown.indexOf('\n---', 3);
  return /^type:\s*["']?([\w-]+)["']?\s*$/m.exec(end < 0 ? '' : markdown.slice(0, end))?.[1] ?? null;
};

function withRaised(rows, raised) {
  const by = new Map(raised.map(r => [`${r.path}#${r.number}`, r]));
  return rows.map(r => {
    const w = by.get(`${r.path}#${r.number}`);
    return w ? { ...r, raisedAt: w.raisedAt, raisedBy: w.raisedBy } : { ...r, raisedBy: [] };
  });
}

/** Every open question in the live plans in scope, in file order. */
export function listOpen(config) {
  const settings = questionSettings(config.raw?.questions);
  const rows = [];
  for (const d of questionScope(config, settings).filter(x => !x.archived)) {
    const markdown = read(d.file);
    if (markdown) rows.push(...openQuestionRows(d.rel, markdown, settings).map(({ held, ...r }) => r));
  }
  return withRaised(rows, listRaised(config));
}

/** Every question of one plan, answered ones included. */
export function planRows(config, file, raised = listRaised(config)) {
  const settings = questionSettings(config.raw?.questions);
  const rel = toRepoPath(file, config.repoRoot);
  const markdown = readFileSync(file, 'utf8');
  const code = planCode(markdown, settings);
  return withRaised(planQuestions(markdown, settings).map(q => row(rel, markdown, q, code, settings)), raised);
}

const initials = slug => slug.split('-').map(w => w[0]).join('');

function plansFor(keys, live, raised, settings) {
  const codes = codeIndex(live, settings);
  const byRel = new Map(live.map(d => [d.rel, d]));
  const byCode = keys.flatMap(k => (codes.get(k.key) ?? []).map(rel => ({ doc: byRel.get(rel), number: k.number })));
  if (byCode.length) return byCode;
  for (const k of keys) {
    const named = live.filter(d => d.slug === k.key.toLowerCase());
    if (named.length === 1) return [{ doc: named[0], number: k.number }];
  }
  for (const k of keys) {
    const part = k.key.toLowerCase();
    const fits = d => d.slug.startsWith(part) || initials(d.slug) === part;
    const waiting = new Set(raised.map(r => r.path));
    const w = live.filter(d => waiting.has(d.rel) && fits(d));
    const docs = w.length ? w : live.filter(fits);
    if (docs.length) return docs.map(doc => ({ doc, number: k.number }));
  }
  return [];
}

/** The question's own lines: its item and the lines that continue it. */
export function questionText(markdown, q) {
  const lines = markdown.split('\n');
  const out = [lines[q.line - 1] ?? ''];
  for (const line of lines.slice(q.line)) {
    if (!line.trim() || /^#{1,6}\s/.test(line) || /^(?:\d+\.\s|[-*]\s|\|)/.test(line)) break;
    out.push(line);
  }
  return out.join('\n');
}

/** Resolves a typed ID to exactly 1 question, read from its plan, or dies with why it cannot. */
export function resolveQuestion(config, text) {
  const settings = questionSettings(config.raw?.questions);
  const typed = String(text ?? '').trim();
  const keys = parseQuestionId(typed);
  if (!keys.length) die(`"${typed}" is not a question ID: write it as the plan's code and the number, as in ABC-Q3`);
  const live = questionScope(config, settings).filter(d => !d.archived);
  const raised = listRaised(config);
  const plans = plansFor(keys, live, raised, settings);
  if (!plans.length) die(`no plan has the code, the name or the initials "${keys[0].key}"`);
  if (plans.length > 1) die(`"${typed}" fits ${plans.length} plans: ${plans.slice(0, 8).map(p => `${p.doc.slug} ${p.number}`).join(', ')}${plans.length > 8 ? ', …' : ''}`);
  const { doc, number } = plans[0];
  const markdown = readFileSync(doc.file, 'utf8');
  const code = planCode(markdown, settings);
  const q = planQuestions(markdown, settings).find(x => x.number === number);
  if (!q) die(`${doc.rel} has no question ${number} under its Questions heading`);
  const shown = raised.find(r => r.path === doc.rel && r.number === q.number);
  return { ...row(doc.rel, markdown, q, code, settings), text: questionText(markdown, q), raisedAt: shown?.raisedAt ?? null, raisedBy: shown?.raisedBy ?? [] };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const age = (from, now) => {
  const s = Math.max(0, Math.round((now - Date.parse(from)) / 1000));
  return s < 60 ? `${s} s` : s < 7200 ? `${Math.floor(s / 60)} min` : s < 172_800 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86_400)} d`;
};
const who = (r, self) => (r.sessionId === self ? 'this session' : `session ${String(r.sessionId).slice(0, 8)}`) + (r.machine ? ` on ${r.machine}` : '');
export const holds = r => [r.boxes ? `holds ${r.boxes} box${r.boxes === 1 ? '' : 'es'}` : null, r.nextStep ? 'named by next_step' : null].filter(Boolean);

function formatRaised(rows, { self, now = Date.now(), session } = {}) {
  if (!rows.length) return session ? `No question is raised for session ${session} on this machine.\n` : 'No question is raised on this machine.\n';
  const width = Math.max(...rows.map(r => r.id.length));
  const head = `${rows.length} ${rows.length === 1 ? 'question is' : 'questions are'} raised on this machine. Show one with: runlist questions <ID>\n`;
  return head + rows.map(r => `${r.id.padEnd(width)}  ${r.title}  (${[r.plan, ...holds(r), `${r.raisedBy.map(x => who(x, self)).join(', ')}, ${age(r.raisedAt, now)}`].join('; ')})\n`).join('');
}

function formatOpen(rows) {
  if (!rows.length) return 'No open questions.\n';
  const plans = new Set(rows.map(r => r.path)).size;
  const width = Math.max(...rows.map(r => r.id.length));
  return `${rows.length} open question${rows.length === 1 ? '' : 's'} in ${plans} plan${plans === 1 ? '' : 's'}.\n`
    + rows.map(r => `${r.id.padEnd(width)}  ${r.title}  ${dim(`(${[`${r.path}:${r.line}`, ...holds(r), r.raisedBy.length ? 'raised' : null].filter(Boolean).join('; ')})`)}\n`).join('');
}

function formatPlan(rel, rows) {
  if (!rows.length) return `${rel} has no numbered questions under a Questions heading.\n`;
  const open = rows.filter(r => !r.answered).length;
  const width = Math.max(...rows.map(r => r.id.length));
  return `${rel}: ${rows.length} question${rows.length === 1 ? '' : 's'}, ${open} open\n`
    + rows.map(r => `  ${String(r.line).padStart(4)}  ${r.id.padEnd(width)}  ${r.answered ? 'answered' : 'open    '}  ${r.title}${holds(r).length ? `  ${dim(`(${holds(r).join('; ')})`)}` : ''}\n`).join('');
}

function formatQuestion(q, self) {
  const state = q.answered ? 'answered in the plan' : q.raisedBy.length ? 'open, raised on this machine' : 'open in the plan, not raised on this machine';
  const raised = q.raisedBy.length ? `Raised by ${q.raisedBy.map(x => `${who(x, self)} at ${x.raisedAt}`).join(', ')}.\n` : '';
  const reach = holds(q).length ? `${holds(q).join('; ')}.\n` : '';
  return `${q.id}: ${state}\n${q.path}:${q.line}\n\n${q.text}\n\n${reach}${raised}`;
}

function takeValue(args, name) {
  const at = args.indexOf(name);
  if (at === -1) return null;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('-')) die(`${name} needs a value`);
  args.splice(at, 2);
  return value;
}

function pendingDecisions(config) {
  const { analyzeDecisions, decisionSettings, loadDecisionDocs, pendingRows } = need();
  const settings = decisionSettings(config.raw?.decisions ?? {});
  return pendingRows(analyzeDecisions(loadDecisionDocs(config, settings), settings));
}

function writeDecisions(rows) {
  if (!rows.length) return 'No open or held decision records.\n';
  return `${rows.length} open or held decision record${rows.length === 1 ? '' : 's'}:\n` + rows.map(r => `${r.label}  ${r.text}  ${dim(`(${r.doc}:${r.line})`)}\n`).join('');
}

/** `runlist questions [<plan|ID>...] [--raised] [--session <id>] [--all] [--json]` */
export async function runQuestions(argv, config) {
  const args = [...argv];
  const session = takeValue(args, '--session');
  const json = args.includes('--json');
  const raisedOnly = args.includes('--raised') || Boolean(session);
  const all = args.includes('--all');
  const targets = args.filter(a => !a.startsWith('-'));
  const self = agentSessionSource()?.id ?? null;
  const out = text => process.stdout.write(text);
  const finish = (payload, text) => {
    if (all) {
      const decisions = pendingDecisions(config);
      if (json) return out(`${JSON.stringify({ questions: payload, decisions }, null, 2)}\n`);
      return out(`${text}\n${writeDecisions(decisions)}`);
    }
    return out(json ? `${JSON.stringify(payload, null, 2)}\n` : text);
  };

  if (targets.length || !raisedOnly || all) await loadQuestionDeps();
  if (!targets.length) {
    if (raisedOnly) { const rows = listRaised(config, { session }); return finish(rows, formatRaised(rows, { self, session })); }
    const rows = listOpen(config);
    return finish(rows, formatOpen(rows));
  }
  const rows = [];
  let text = '';
  let single = null;
  let raised = null;
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const file = need().resolveDocArg(target, config, { dieOnMiss: false });
    if (file) {
      let these = planRows(config, file, raised ??= listRaised(config));
      if (raisedOnly) these = these.filter(r => r.raisedBy.length && (!session || r.raisedBy.some(x => x.sessionId === session)));
      rows.push(...these);
      text += formatPlan(toRepoPath(file, config.repoRoot), these);
    } else {
      // `abc 3` typed as 2 words is 1 ID.
      const typed = /^\d+$/.test(targets[i + 1] ?? '') && !/\d$/.test(target) ? `${target} ${targets[++i]}` : target;
      const q = resolveQuestion(config, typed);
      if (i === targets.length - 1 && !rows.length) single = q;
      rows.push(q);
      text += formatQuestion(q, self);
    }
  }
  return finish(single ?? rows, text);
}

const QUESTION_USAGE = 'Usage: runlist question raise <plan> <number> [--session <id>] | runlist question code <plan> [<CODE>] | runlist question code <plan>...';

/** `runlist question raise <plan> <n>` and `runlist question code <plan> [<CODE>]`. */
export async function runQuestion(argv, config, { dryRun = false } = {}) {
  await loadQuestionDeps();
  const args = [...argv];
  const session = takeValue(args, '--session');
  const json = args.includes('--json');
  const [verb, ...rest] = args.filter(a => !a.startsWith('-'));
  const tag = dryRun ? `${dim('[dry-run]')} ` : '';
  if (verb === 'raise') {
    if (rest.length !== 2 || !/^\d+$/.test(rest[1])) die(QUESTION_USAGE);
    const sessionId = session ?? agentSessionSource()?.id ?? null;
    const result = raiseQuestion(config, { plan: rest[0], number: rest[1], sessionId, dryRun });
    const removed = dryRun ? [] : pruneRaised(config);
    if (json) return process.stdout.write(`${JSON.stringify({ id: result.id, plan: result.plan, number: result.question.number, title: result.question.title, file: toRepoPath(result.file, config.repoRoot), sessionId, removed, dryRun }, null, 2)}\n`);
    for (const name of removed) process.stdout.write(`removed ${name}: its question is no longer open, or it names no session\n`);
    process.stdout.write(`${tag}${dryRun ? 'would raise' : 'raised'} ${green(result.id)}, "${result.question.title}" (${result.plan}) for session ${sessionId}${dryRun ? '' : `: ${toRepoPath(result.file, config.repoRoot)}`}\n`);
    return;
  }
  if (verb === 'code') {
    const named = rest.length === 2 && CODE.test(rest[1]) ? rest[1] : null;
    const plans = named ? [rest[0]] : rest;
    if (!plans.length) die(QUESTION_USAGE);
    const settings = questionSettings(config.raw?.questions);
    const scope = questionScope(config, settings);
    const taken = codeIndex(scope, settings);
    const results = [];
    let failed = 0;
    for (const plan of plans) {
      try {
        const file = need().resolveDocArg(plan, config);
        const r = codePlan(config, { plan: file, code: named, taken, reserved: reservedPrefixes(scope, slugOf(file)), dryRun });
        taken.set(r.code, [r.plan]);
        results.push(r);
        if (!json) {
          process.stdout.write(`${tag}${r.plan}: ${r.code}${r.written.length ? `, ${dryRun ? 'would write' : 'wrote'} ${r.written.join(' ')}` : ''}\n`);
          for (const s of r.skipped) process.stdout.write(`  left without an ID: line ${s.line}, ${s.why}\n`);
        }
      } catch (error) {
        if (plans.length === 1) throw error;
        failed++;
        process.stderr.write(`runlist question code: ${plan}: ${error.message}\n`);
      }
    }
    if (json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    if (failed) process.exitCode = 1;
    return;
  }
  die(QUESTION_USAGE);
}
