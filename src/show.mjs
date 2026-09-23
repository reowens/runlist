import { readFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { parseDocFile, resolveDocArg } from './index.mjs';
import { resolveBodyLinkTarget } from './body-link.mjs';
import { die, normalizeStringList, resolveRefPath, toRepoPath } from './util.mjs';

// `runlist show <file...>` — one document's card as data: its title, status,
// next step, blockers and checklist, the plans and docs its frontmatter names,
// and the documents its body links to. Read-only; nothing is claimed.

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

export function runShow(args, config) {
  const json = args.includes('--json');
  const targets = args.filter(a => !a.startsWith('-'));
  if (!targets.length) die('Usage: runlist show <file...> [--json]');
  const cards = [];
  for (const t of targets) {
    const abs = resolveDocArg(t, config, { dieOnMiss: !json });
    cards.push(abs ? showDoc(abs, config) : { path: t, error: 'not found' });
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(cards, null, 2)}\n`);
    return;
  }
  cards.forEach((c, n) => {
    if (n) process.stdout.write('\n');
    process.stdout.write(`${c.title}  (${c.status ?? 'no status'})\n${c.path}\n`);
    if (c.nextStep) process.stdout.write(`Next: ${c.nextStep}\n`);
    for (const b of c.blockers) process.stdout.write(`Blocker: ${b}\n`);
    if (c.checklist?.total) process.stdout.write(`Checklist: ${c.checklist.completed} of ${c.checklist.total} done\n`);
    for (const r of c.related) process.stdout.write(`${r.field}: ${r.path ?? `${r.ref} (missing)`}${r.status ? `  (${r.status})` : ''}\n`);
    if (c.links.length) process.stdout.write(`Linked from the body: ${c.links.map(l => l.path).join(', ')}\n`);
  });
}
