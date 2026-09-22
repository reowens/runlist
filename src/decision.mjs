import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mutateFileSet } from './atomic-mutation.mjs';
import { authorizeManagedSource } from './managed-path.mjs';
import { walkSections } from './section.mjs';
import { die, nowIso, resolveDocPath, toRepoPath } from './util.mjs';
import { green, dim } from './color.mjs';

// `runlist new decision <plan> --question "…" @record.md`
//
// A decision is not a document of its own: it is an entry in the owning plan's
// decisions section, carrying an id, a disposition and a written record. This
// adds one, numbered after the highest id of its prefix the plan (and the
// register, when there is one) already uses, at the end of the plan's top-level
// decisions section, creating `## Decisions` when the plan has none. A
// decisions heading nested inside a workstream is that workstream's record and
// is left alone.
//
// Config (`runlist.config.mjs`), all optional:
//   export const decisions = {
//     section: 'Decisions',   // the heading the entry lands under
//     prefix: 'D',            // what a new id is written under
//     register: { file: 'docs/plans/register.md', statusLine: 'waiting on you:' },
//   };
// With a register, ids are one sequence across the corpus: the next id is
// numbered after the highest the register or the plan uses, and the register
// gets the entry's index row in the same locked write as the plan. Without
// one, ids are plan-local.

const DISPOSITIONS = new Set(['open', 'held']);
const DECISION_HEADING = /\bdecisions?\b/i;

function splitDoc(raw) {
  if (!raw.startsWith('---\n')) return null;
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return null;
  return { frontmatter: raw.slice(4, end), body: raw.slice(end + 5) };
}

function stripFences(text) {
  return text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
}

const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Ids are read where a decision item starts (a heading, a list or bold lead,
// a table row or a register row), never from prose, where the same shape is
// as likely to be a job code or a citation of another plan's decision.
function highestId(text, prefix) {
  const re = new RegExp(`^\\s*(?:#{1,6}\\s+|[-*]\\s+(?:\\[[ xX]\\]\\s+)?|\\|\\s*)?\\**${escapeRe(prefix)}(\\d{1,4})\\b`);
  let max = 0;
  for (const line of text.split('\n')) {
    const m = line.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

export function nextDecisionId(body, prefix, register = null) {
  let max = highestId(stripFences(body), prefix);
  if (register) {
    const rows = register.rows.map(row => row.match(new RegExp(`^${escapeRe(prefix)}(\\d{1,4})\\b`))?.[1]);
    for (const n of rows) if (n) max = Math.max(max, Number(n));
  }
  return `${prefix}${max + 1}`;
}

// The register block: a fence whose first line carries the configured status
// line. Returns its rows and where the closing fence sits, or null.
export function findRegister(text, statusLine) {
  const lines = text.split('\n');
  const wanted = statusLine.trim().toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(`{3,}|~{3,})/);
    if (!open) continue;
    let close = i + 1;
    while (close < lines.length && !lines[close].startsWith(open[1])) close++;
    if (close >= lines.length) return null;
    const first = (lines[i + 1] ?? '').trim().toLowerCase();
    if (first.includes(wanted)) {
      return { closeLine: close, rows: lines.slice(i + 2, close).filter(line => line.trim()) };
    }
    i = close;
  }
  return null;
}

export function insertRegisterRow(text, register, row) {
  const lines = text.split('\n');
  let at = register.closeLine;
  while (at > 0 && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, row);
  return lines.join('\n');
}

// Returns the new body and where the entry went. Pure, for tests.
export function insertDecision(body, { id, question, disposition, record, section: heading = 'Decisions' }) {
  const lines = body.split('\n');
  const sections = walkSections(body);
  const named = s => s.heading.replace(/[^\w\s]+$/, '').trim().toLowerCase() === heading.toLowerCase();
  const section = sections.find(s => s.level === 2 && named(s))
    ?? sections.find(s => s.level === 2 && DECISION_HEADING.test(s.heading));
  const level = section ? Math.min(section.level + 1, 6) : 3;
  const entry = [
    `${'#'.repeat(level)} ${id}  ${question.trim()}`,
    '',
    `Disposition: ${disposition.toUpperCase()}.`,
    '',
    record.trim(),
  ];

  if (section) {
    // After the section's last non-blank line, subsections included.
    let at = section.lineEnd;
    while (at > section.lineStart && lines[at - 1].trim() === '') at--;
    const tail = at < lines.length && lines[at].trim() !== '' ? [''] : [];
    lines.splice(at, 0, '', ...entry, ...tail);
    return { body: lines.join('\n'), placement: `under \`${section.heading}\``, heading: section.heading };
  }

  const block = [`## ${heading}`, '', ...entry];
  const before = sections.find(s => s.level === 2 && /^(version history|closeout)\b/i.test(s.heading));
  if (before) {
    lines.splice(before.lineStart - 1, 0, ...block, '');
    return { body: lines.join('\n'), placement: `in a new \`## ${heading}\` before \`${before.heading}\``, heading };
  }
  const trimmed = body.replace(/\n+$/, '');
  return { body: `${trimmed}\n\n${block.join('\n')}\n`, placement: `in a new \`## ${heading}\` at the end`, heading };
}

export function runNewDecision({ planArg, question, disposition, record, answers = null }, config, { dryRun = false } = {}) {
  const usage = 'Usage: runlist new decision <plan> --question "<the question>" @record.md';
  if (!planArg) die(`${usage}\nThe plan is the file whose decisions section gets the entry.`);
  if (!question || !question.trim()) die(`--question is required.\n${usage}`);
  if (/\n/.test(question)) die('--question is one line; the record carries the rest.');
  if (!record || !record.trim()) {
    die('A decision needs its record: the situation, what exists today, and what each answer leaves in place.\n'
      + `Write it to a file and pass @path, pipe it in, or pass --body "...".\n${usage}`);
  }
  disposition = (disposition ?? 'open').toLowerCase();
  if (!DISPOSITIONS.has(disposition)) {
    die(`--disposition must be open or held; a ruled or closed decision is edited in place, not added.`);
  }

  const resolved = resolveDocPath(planArg, config)
    ?? (planArg.endsWith('.md') ? null : resolveDocPath(`${planArg}.md`, config))
    ?? (planArg.includes('/') ? null : resolveDocPath(path.join('plans', `${planArg}.md`), config));
  if (!resolved) die(`No such plan: ${planArg}`);
  const planPath = authorizeManagedSource(resolved, config, { kind: 'Decision target' }).path;
  const planRepoPath = toRepoPath(planPath, config.repoRoot);

  const settings = config.raw?.decisions ?? {};
  const prefix = settings.prefix ?? 'D';
  const section = settings.section ?? 'Decisions';
  let registerPath = null;
  if (settings.register?.file) {
    if (!settings.register.statusLine) die('decisions.register needs a statusLine: the first line of the register block.');
    const registerResolved = resolveDocPath(settings.register.file, config);
    if (!registerResolved) die(`The decisions register in config does not exist: ${settings.register.file}`);
    registerPath = authorizeManagedSource(registerResolved, config, { kind: 'Decision register' }).path;
  }
  const sameFile = registerPath === planPath;
  if (registerPath && (!answers || !answers.trim())) {
    die('--answers is required with a register: the row says what each answer leaves in place and what it costs.\n'
      + `${usage} --answers "Yes: … No: …"`);
  }

  const today = nowIso();
  const planRaw = readFileSync(planPath, 'utf8');
  const registerRaw = registerPath && !sameFile ? readFileSync(registerPath, 'utf8') : null;

  const planDoc = splitDoc(planRaw.replace(/\r\n/g, '\n'));
  if (!planDoc) die(`${planRepoPath} has no frontmatter block; runlist only adds decisions to managed documents.`);
  const registerText = sameFile ? planDoc.body : registerRaw?.replace(/\r\n/g, '\n');
  const register = registerPath ? findRegister(registerText, settings.register.statusLine) : null;
  if (registerPath && !register) {
    die(`${toRepoPath(registerPath, config.repoRoot)} has no block whose first line carries "${settings.register.statusLine}".`);
  }

  const id = nextDecisionId(planDoc.body, prefix, register);
  const inserted = insertDecision(planDoc.body, { id, question, disposition, record, section });
  let planBody = inserted.body;
  let row = null;
  if (register && sameFile) {
    row = registerRow({ id, disposition, today, question, answers, heading: inserted.heading, link: path.basename(planPath) });
    planBody = insertRegisterRow(planBody, findRegister(planBody, settings.register.statusLine), row);
  }
  const bump = fm => (/^updated:/m.test(fm) ? fm.replace(/^updated:.*$/m, `updated: ${today}`) : fm);
  const planOut = `---\n${bump(planDoc.frontmatter)}\n---\n${planBody}`;

  const updates = [{ path: planPath, expectedContent: planRaw, content: planOut }];
  if (register && !sameFile) {
    const link = path.relative(path.dirname(registerPath), planPath).split(path.sep).join('/');
    row = registerRow({ id, disposition, today, question, answers, heading: inserted.heading, link });
    const registerOut = insertRegisterRow(registerText, register, row);
    const registerDoc = splitDoc(registerOut);
    updates.push({
      path: registerPath,
      expectedContent: registerRaw,
      content: registerDoc ? `---\n${bump(registerDoc.frontmatter)}\n---\n${registerDoc.body}` : registerOut,
    });
  }

  const registerRepoPath = registerPath ? toRepoPath(registerPath, config.repoRoot) : null;
  if (dryRun) {
    process.stdout.write(`[dry-run] Would add ${id} to ${planRepoPath} ${inserted.placement}\n`);
    if (row) process.stdout.write(`[dry-run] Would add its row to the register in ${registerRepoPath}:\n  ${row}\n`);
    return { id, row };
  }

  mutateFileSet({ updates }, { repoRoot: config.repoRoot });
  process.stdout.write(`${green('Added')} ${id} to ${planRepoPath} ${dim(inserted.placement)}\n`);
  if (row) process.stdout.write(`${green('Added')} its row to the register in ${registerRepoPath}\n`);
  return { id, row };
}

function registerRow({ id, disposition, today, question, answers, heading, link }) {
  const text = `${question.trim()} ${answers.trim()}`;
  return `${id} ${disposition.toUpperCase()} ${today.slice(0, 10)}: ${text} Record: [${link} § ${heading} ${id}](${link}).`;
}
