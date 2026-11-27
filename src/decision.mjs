import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mutateFileSet } from './atomic-mutation.mjs';
import { authorizeManagedSource } from './managed-path.mjs';
import { die, nowIso, resolveDocPath, toRepoPath } from './util.mjs';
import { green, dim } from './color.mjs';
import {
  codeFor, codeIndex, loadQuestionDeps, planCode, planQuestions, questionId, questionScope, questionSettings, reservedPrefixes,
} from './questions.mjs';

// `runlist new decision <plan> --question "…" @record.md`
//
// Everything new that waits on a person is a question in its plan. This adds
// one numbered item at the end of the plan's Questions section, creating
// `## Questions` when the plan has none:
//
//   5. ABC-Q5 **Which token store?** <the record>
//
// The ID uses the plan's code (`question_code:`), given first when the plan
// has none, and the next number no question of the plan has used. The record
// carries the situation, what exists today with its file and line, and what
// each answer leaves in place. Decision records a plan already holds stay as
// written and are still read by `runlist decisions`; no new one is written.

const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

/** The body's headings outside code fences, as `{index, level, text}` with `index` 0-based. */
function headings(lines, from) {
  const out = [];
  let fence = null;
  for (let i = from; i < lines.length; i++) {
    const f = FENCE.exec(lines[i]);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; continue; }
    const h = !fence && /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (h) out.push({ index: i, level: h[1].length, text: h[2].trim() });
  }
  return out;
}

/** The next question number: 1 more than any the plan has used, as a list number or as an ID at an item's start. */
export function nextQuestionNumber(markdown, code, settings = questionSettings({})) {
  let max = 0;
  for (const q of planQuestions(markdown, settings)) max = Math.max(max, q.number);
  if (code) {
    const re = new RegExp(`^\\s*(?:[-*]|\\d+\\.|\\|[^|]*\\|)?\\s*(?:\\*\\*)?${code}-Q?(\\d+)\\b(?!\\.\\d)`);
    for (const line of markdown.split('\n')) {
      const m = re.exec(line);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return max + 1;
}

/** The question's list item: its ID and bold title on the first line, the record after it, continuation lines indented under the marker. */
export function questionItem({ number, id, title, record }) {
  const marker = `${number}. `;
  const [first, ...rest] = record.trim().split('\n');
  const indent = ' '.repeat(marker.length);
  return [`${marker}${id} **${title}** ${first.trim()}`, ...rest.map(l => (l.trim() ? `${indent}${l.trimEnd()}` : ''))];
}

/**
 * The markdown with `item` (its lines) at the end of the first Questions
 * section, after its last line of text and before a closing rule, or in a new
 * `## Questions` before Version History or Closeout, else at the end. Pure.
 */
export function insertQuestion(markdown, item, settings = questionSettings({})) {
  const lines = markdown.split('\n');
  const bodyStart = lines[0] === '---' ? lines.indexOf('---', 1) + 1 : 0;
  const all = headings(lines, bodyStart);
  const own = all.find(h => settings.headingRe.test(lines[h.index]));
  if (own) {
    const next = all.find(h => h.index > own.index && h.level <= own.level);
    let at = next ? next.index : lines.length;
    while (at > own.index + 1 && (lines[at - 1].trim() === '' || RULE.test(lines[at - 1]))) at--;
    const tail = at < lines.length && lines[at].trim() !== '' ? [''] : [];
    lines.splice(at, 0, '', ...item, ...tail);
    return { markdown: lines.join('\n'), placement: `under \`${own.text}\`` };
  }
  const block = ['## Questions', '', ...item];
  const before = all.find(h => h.level === 2 && /^(version history|closeout)\b/i.test(h.text));
  if (before) {
    lines.splice(before.index, 0, ...block, '');
    return { markdown: lines.join('\n'), placement: `in a new \`## Questions\` before \`${before.text}\`` };
  }
  return { markdown: `${markdown.replace(/\n+$/, '')}\n\n${block.join('\n')}\n`, placement: 'in a new `## Questions` at the end' };
}

const titleOf = question => `${question.trim().replace(/[\s?.!:;,]+$/, '')}?`;
const same = (a, b) => a.number === b.number && a.title === b.title && a.answered === b.answered;

export async function runNewDecision({ planArg, question, disposition, record, answers = null }, config, { dryRun = false } = {}) {
  const usage = 'Usage: runlist new decision <plan> --question "<the question>" [--answers "<what each answer leaves in place>"] @record.md';
  if (!planArg) die(`${usage}\nThe plan is the file whose Questions section gets the question.`);
  if (!question || !question.trim()) die(`--question is required.\n${usage}`);
  if (/\n/.test(question)) die('--question is one line; the record carries the rest.');
  if (/\*\*|~~/.test(question)) die('--question is plain text, with no ** or ~~: the item writes it in bold.');
  if (!record || !record.trim()) {
    die('A question needs its record: the situation, what exists today with its file and line, and what each answer leaves in place.\n'
      + `Write it to a file and pass @path, pipe it in, or pass --body "...".\n${usage}`);
  }
  if (disposition && disposition.toLowerCase() !== 'open') {
    die('--disposition is no longer taken: a question is open until its plan records the answer.');
  }

  const resolved = resolveDocPath(planArg, config)
    ?? (planArg.endsWith('.md') ? null : resolveDocPath(`${planArg}.md`, config))
    ?? (planArg.includes('/') ? null : resolveDocPath(path.join('plans', `${planArg}.md`), config));
  if (!resolved) die(`No such plan: ${planArg}`);
  const planPath = authorizeManagedSource(resolved, config, { kind: 'Question target' }).path;
  const rel = toRepoPath(planPath, config.repoRoot);
  const slug = path.basename(planPath).replace(/\.md$/, '');

  const raw = readFileSync(planPath, 'utf8');
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n') || text.indexOf('\n---\n', 4) < 0) die(`${rel} has no frontmatter block; runlist only adds questions to managed documents.`);

  const settings = questionSettings(config.raw?.questions);
  let coded = { code: planCode(text, settings), markdown: text };
  if (!coded.code) {
    await loadQuestionDeps();
    const scope = questionScope(config, settings);
    coded = codeFor(slug, text, { settings, rel, taken: codeIndex(scope, settings), reserved: reservedPrefixes(scope, slug) });
  }
  const gaveCode = coded.markdown !== text;

  const number = nextQuestionNumber(coded.markdown, coded.code, settings);
  const id = questionId(coded.code, number);
  const title = titleOf(question);
  const body = answers && answers.trim() ? `${record.trim()} ${answers.trim()}` : record;
  const inserted = insertQuestion(coded.markdown, questionItem({ number, id, title, record: body }), settings);

  const before = planQuestions(coded.markdown, settings);
  const after = planQuestions(inserted.markdown, settings);
  const added = after.filter(q => !before.some(b => same(b, q)));
  if (after.length !== before.length + 1 || added.length !== 1 || added[0].number !== number || added[0].title !== title) {
    die(`${rel}: the new question would not read back as 1 question numbered ${number}; nothing was written.`);
  }
  if (added[0].answered) {
    die(`${rel}: ${id} would read as answered, since its title or the start of its record carries a ruling word or ~~. Reword it; nothing was written.`);
  }

  const end = inserted.markdown.indexOf('\n---\n', 4);
  const front = inserted.markdown.slice(0, end);
  const out = `${/^updated:/m.test(front) ? front.replace(/^updated:.*$/m, `updated: ${nowIso()}`) : front}${inserted.markdown.slice(end)}`;

  const codeNote = gaveCode ? `, giving the plan the code ${coded.code}` : '';
  if (dryRun) {
    process.stdout.write(`[dry-run] Would add ${id} to ${rel} ${inserted.placement}${codeNote}\n`);
    return { id, number, code: coded.code };
  }
  mutateFileSet({ updates: [{ path: planPath, expectedContent: raw, content: out }] }, { repoRoot: config.repoRoot });
  process.stdout.write(`${green('Added')} ${id} to ${rel} ${dim(`${inserted.placement}${codeNote}`)}\n`);
  process.stdout.write(`${dim(`Raise it with: runlist question raise ${slug} ${number}`)}\n`);
  return { id, number, code: coded.code };
}
