import { readFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, normalizeEol, parseSimpleFrontmatter } from './frontmatter.mjs';
import { buildBrief, collapseFrontmatter, cut, LIMITS, readSection, SURVEY_LIMITS } from './brief.mjs';
import { parseDocFile, resolveDocArg } from './index.mjs';
import { resolveBodyLinkTarget } from './body-link.mjs';
import { die, normalizeStringList, resolveRefPath, shellQuote, toRepoPath } from './util.mjs';

// `runlist show <file...>` — one document's card as data: its title, status,
// next step, blockers and checklist, the plans and docs its frontmatter names,
// and the documents its body links to, followed by its brief (outline and open
// boxes with line numbers; src/brief.mjs). `--section` reads one section in
// place of the whole file. Read-only; nothing is claimed.

// Frontmatter lists that name other documents. The configured reference fields
// are read too; `related_docs` is read whether or not a repo configures it.
const RELATED = ['related_plans', 'related_docs', 'supports_plans', 'parent_plan', 'runlist'];

function relatedFields(config) {
  const configured = [...(config.referenceFields?.bidirectional ?? []), ...(config.referenceFields?.unidirectional ?? [])];
  return [...new Set([...RELATED, ...configured])];
}

function brief(abs, config) {
  try {
    const d = parseDocFile(abs, config, { fast: true });
    return { title: d.title, status: d.status, type: d.type };
  } catch {
    return { title: null, status: null, type: null };
  }
}

/** The card for one document, by absolute path. */
export function showDoc(abs, config) {
  const doc = parseDocFile(abs, config, { fast: true });
  const raw = readFileSync(abs, 'utf8');
  const fm = parseSimpleFrontmatter(extractFrontmatter(raw).frontmatter ?? '', []);
  const dir = path.dirname(abs);
  const seen = new Set([doc.path]);

  const related = [];
  for (const field of relatedFields(config)) {
    for (const entry of normalizeStringList(fm[field])) {
      const ref = String(entry).replace(/^>\s*/, '').replace(/#.*$/, '').trim();
      if (!ref) continue;
      const target = resolveRefPath(ref, dir, config.repoRoot);
      const rel = target ? toRepoPath(target, config.repoRoot) : null;
      if (rel && seen.has(`${field}:${rel}`)) continue;
      if (rel) seen.add(`${field}:${rel}`);
      related.push({ field, ref, path: rel, exists: Boolean(target), ...(target ? brief(target, config) : { title: null, status: null, type: null }) });
    }
  }

  const named = new Set(related.map(r => r.path).filter(Boolean));
  const links = [];
  for (const link of doc.bodyLinks ?? []) {
    if (link.targetKind !== 'document') continue;
    const target = resolveBodyLinkTarget(link.href, dir, config.repoRoot);
    if (!target.ok) continue;
    const rel = toRepoPath(target.path, config.repoRoot);
    if (seen.has(rel) || named.has(rel)) continue;
    seen.add(rel);
    links.push({ path: rel, ...brief(target.path, config) });
  }

  return {
    path: doc.path,
    type: doc.type,
    title: doc.title,
    status: doc.status,
    summary: doc.summary,
    currentState: doc.currentState === 'No current_state set' ? null : doc.currentState,
    nextStep: doc.nextStep,
    blockers: doc.blockers,
    checklist: doc.checklist,
    updated: doc.updated,
    related,
    links,
  };
}

// Fields the text card prints. Everything else non-empty is named on one line
// so a reader knows it is there without printing the frontmatter.
const CARD_FIELDS = new Set(['title', 'status', 'next_step', 'blockers']);

function otherFields(abs, config) {
  const raw = readFileSync(abs, 'utf8');
  const fm = parseSimpleFrontmatter(extractFrontmatter(raw).frontmatter ?? '', []);
  const shown = new Set([...CARD_FIELDS, ...relatedFields(config)]);
  return Object.keys(fm).filter(k => !shown.has(k) && normalizeStringList(fm[k]).some(v => String(v).trim()));
}

function parseShowArgs(args) {
  const opts = { json: false, card: false, all: false, frontmatter: false, section: null, from: null, targets: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') opts.json = true;
    else if (a === '--card') opts.card = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--frontmatter') opts.frontmatter = true;
    else if (a === '--section' || a === '-s') opts.section = args[++i] ?? die('--section needs a heading');
    else if (a === '--from') opts.from = args[++i];
    else if (a.startsWith('-')) die(`Unknown option for show: ${a}`);
    else opts.targets.push(a);
  }
  if (opts.from != null) {
    if (opts.section == null) die('--from continues a --section read; name the section too');
    const n = Number(opts.from);
    if (!Number.isInteger(n) || n < 1) die(`--from takes a line number, got: ${opts.from}`);
    opts.from = n;
  }
  return opts;
}

const pad = (n, width) => String(n).padStart(width);

function runSection(target, opts, config) {
  const abs = resolveDocArg(target, config);
  const rel = toRepoPath(abs, config.repoRoot);
  const r = readSection(readFileSync(abs, 'utf8'), opts.section, { from: opts.from });
  const again = from => `runlist show ${shellQuote(rel)} --section ${shellQuote(opts.section)} --from ${from}`;
  if (opts.json) {
    const { headings, ...rest } = r;
    const out = r.found
      ? { path: rel, ...rest, ...(r.next ? { continue: again(r.next) } : {}) }
      : { path: rel, error: 'no heading matches', query: r.query, headings: headings.map(({ line, level, heading }) => ({ line, level, heading })) };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (!r.found || r.past) process.exitCode = 1;
    return;
  }
  if (!r.found) {
    const list = r.headings.slice(0, 20).map(h => `  ${h.line}  ${cut(`${'#'.repeat(h.level)} ${h.heading}`)}`);
    if (r.headings.length > 20) list.push(`  (+${r.headings.length - 20} more)`);
    process.stderr.write([`No heading in ${rel} matches "${opts.section}". Headings:`, ...list].join('\n') + '\n');
    process.exitCode = 1;
    return;
  }
  const h = r.heading;
  if (r.past) {
    process.stderr.write(`${rel}: "${h.heading}" runs ${h.line} to ${h.end}; --from ${r.from} is past its end.\n`);
    process.exitCode = 1;
    return;
  }
  const width = String(r.to).length;
  const span = r.from === h.line && !r.next ? `${h.line} to ${h.end}` : `${r.from} to ${r.to} of ${h.line} to ${h.end}`;
  const out = [`${rel} lines ${span} (${'#'.repeat(h.level)} ${h.heading}):`];
  for (const row of r.rows) out.push(`${pad(row.line, width)}\t${row.text}`);
  if (r.next) out.push(`(cut at line ${r.to}; the section runs to ${h.end}. Next: ${again(r.next)})`);
  if (r.others.length) out.push(`Also matching: ${r.others.map(o => `${o.line} ${cut(o.heading, 60)}`).join('; ')}`);
  process.stdout.write(out.join('\n') + '\n');
}

function renderBrief(card, brief) {
  const out = [];
  const width = String(brief.lines).length;
  const kb = Math.max(1, Math.round(brief.bytes / 1024));
  out.push('', `Outline: ${brief.lines.toLocaleString('en-US')} lines, ${kb} KB (line, heading)`);
  if (!brief.outline.length) out.push('  (no headings)');
  for (const h of brief.outline) out.push(`  ${pad(h.line, width)}  ${cut(`${'#'.repeat(h.level)} ${h.heading}`)}`);
  if (brief.outlineOmitted) out.push(`  (+${brief.outlineOmitted} deeper headings not shown; a --section read shows them)`);
  const total = brief.boxes.open + brief.boxes.done;
  if (total) {
    out.push(`Open boxes: ${brief.boxes.open} of ${total} (line, text)`);
    for (const b of brief.open) out.push(`  ${pad(b.line, width)}  ${cut(b.text)}`);
    if (brief.openOmitted) out.push(`  (+${brief.openOmitted} more: add --all)`);
  }
  if (brief.frontmatter) {
    out.push(`Frontmatter (lines 1 to ${brief.frontmatterLines}):`, ...brief.frontmatter.map(l => `  ${l}`));
  } else if (card.otherFields?.length) {
    out.push(`Other fields: ${card.otherFields.join(', ')} (--frontmatter prints them)`);
  }
  return out;
}

export function runShow(args, config) {
  const opts = parseShowArgs(args);
  if (!opts.targets.length) die('Usage: runlist show <file...> [--section "<heading>" [--from <line>]] [--all] [--card] [--frontmatter] [--json]');
  if (opts.section != null) {
    if (opts.targets.length > 1) die('--section reads one file; name one');
    runSection(opts.targets[0], opts, config);
    return;
  }
  const limits = opts.targets.length > 1 ? SURVEY_LIMITS : LIMITS;
  const cards = [];
  for (const t of opts.targets) {
    const abs = resolveDocArg(t, config, { dieOnMiss: !opts.json });
    if (!abs) { cards.push({ path: t, error: 'not found' }); continue; }
    const card = showDoc(abs, config);
    if (!opts.card) {
      const raw = readFileSync(abs, 'utf8');
      card.brief = buildBrief(raw, { all: opts.all, limits });
      if (opts.frontmatter) card.brief.frontmatter = collapseFrontmatter(extractFrontmatter(normalizeEol(raw)).frontmatter, limits);
      card.otherFields = otherFields(abs, config);
    }
    cards.push(card);
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(cards, null, 2)}\n`);
    return;
  }
  cards.forEach((c, n) => {
    if (n) process.stdout.write('\n');
    const out = [`${c.title}  (${c.status ?? 'no status'})`, c.path];
    if (c.nextStep) out.push(`Next: ${c.nextStep}`);
    for (const b of c.blockers) out.push(`Blocker: ${b}`);
    // The brief's open-box line carries the same count, read outside code fences.
    if (c.checklist?.total && !c.brief) out.push(`Checklist: ${c.checklist.completed} of ${c.checklist.total} done`);
    for (const r of c.related) out.push(`${r.field}: ${r.path ?? `${r.ref} (missing)`}${r.status ? `  (${r.status})` : ''}`);
    if (c.links.length) out.push(`Linked from the body: ${c.links.map(l => l.path).join(', ')}`);
    if (c.brief) out.push(...renderBrief(c, c.brief));
    process.stdout.write(out.join('\n') + '\n');
  });
  if (!opts.card) {
    const file = cards.length === 1 ? shellQuote(cards[0].path) : '<file>';
    process.stdout.write(`\nOne section: runlist show ${file} --section "<heading>"\n`);
  }
}
