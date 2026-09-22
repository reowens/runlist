import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mutateFile } from './atomic-mutation.mjs';
import { authorizeManagedSource } from './managed-path.mjs';
import { walkSections } from './section.mjs';
import { die, nowIso, resolveDocPath, toRepoPath } from './util.mjs';
import { green, dim } from './color.mjs';

// `runlist new decision <plan> --question "…" @record.md`
//
// A decision is not a document of its own: it is an entry in the owning plan's
// decisions section, carrying an id, a disposition and a written record. This
// adds one, numbered after the highest id of its prefix the plan already
// mentions (a cited id from another plan included, so a new id never collides
// with one the text already uses), at the end of the plan's top-level
// decisions section, creating `## Decisions` when the plan has none. A
// decisions heading nested inside a workstream is that workstream's record and
// is left alone.
//
// Config (`runlist.config.mjs`), all optional:
//   export const decisions = { section: 'Decisions', prefix: 'D' };
// `section` is the heading a `decisions` reader would scope to; `prefix` is
// what a new id is numbered under.

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

export function nextDecisionId(body, prefix) {
  const re = new RegExp(`\\b${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d{1,4})\\b`, 'g');
  let max = 0;
  for (const m of stripFences(body).matchAll(re)) max = Math.max(max, Number(m[1]));
  return `${prefix}${max + 1}`;
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
    return { body: lines.join('\n'), placement: `under \`${section.heading}\`` };
  }

  const block = [`## ${heading}`, '', ...entry];
  const before = sections.find(s => s.level === 2 && /^(version history|closeout)\b/i.test(s.heading));
  if (before) {
    lines.splice(before.lineStart - 1, 0, ...block, '');
    return { body: lines.join('\n'), placement: `in a new \`## ${heading}\` before \`${before.heading}\`` };
  }
  const trimmed = body.replace(/\n+$/, '');
  return { body: `${trimmed}\n\n${block.join('\n')}\n`, placement: `in a new \`## ${heading}\` at the end` };
}

export function runNewDecision({ planArg, question, disposition, record }, config, { dryRun = false } = {}) {
  const usage = 'Usage: runlist new decision <plan> --question "<the question>" @record.md';
  if (!planArg) die(`${usage}\nThe plan is the file whose decisions section gets the entry.`);
  if (!question || !question.trim()) die(`--question is required.\n${usage}`);
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
  const filePath = authorizeManagedSource(resolved, config, { kind: 'Decision target' }).path;
  const repoPath = toRepoPath(filePath, config.repoRoot);

  const settings = config.raw?.decisions ?? {};
  const prefix = settings.prefix ?? 'D';
  const section = settings.section ?? 'Decisions';

  let result = null;
  const render = raw => {
    const doc = splitDoc(raw.replace(/\r\n/g, '\n'));
    if (!doc) die(`${repoPath} has no frontmatter block; runlist only adds decisions to managed documents.`);
    const id = nextDecisionId(doc.body, prefix);
    const inserted = insertDecision(doc.body, { id, question, disposition, record, section });
    const frontmatter = /^updated:/m.test(doc.frontmatter)
      ? doc.frontmatter.replace(/^updated:.*$/m, `updated: ${nowIso()}`)
      : doc.frontmatter;
    result = { id, placement: inserted.placement };
    return `---\n${frontmatter}\n---\n${inserted.body}`;
  };

  if (dryRun) {
    render(readFileSync(filePath, 'utf8'));
    process.stdout.write(`[dry-run] Would add ${result.id} to ${repoPath} ${result.placement}\n`);
    return result;
  }

  mutateFile(filePath, { repoRoot: config.repoRoot }, render);
  process.stdout.write(`${green('Added')} ${result.id} to ${repoPath} ${dim(result.placement)}\n`);
  return result;
}

