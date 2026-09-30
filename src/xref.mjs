import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildIndex, resolveDocArg } from './index.mjs';
import { resolveBodyLinkTarget } from './body-link.mjs';
import { showDoc } from './show.mjs';
import { decisionSettings, loadDecisionDocs, analyzeDecisions, linksBesideId, openWork, PENDING } from './decisions.mjs';
import { commitRename } from './durable-rename.mjs';
import { stateDir } from './naming.mjs';
import { openFlags, syncCheckFlags } from './flags.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { die, resolveRefPath, toRepoPath } from './util.mjs';
import { bold, dim, yellow } from './color.mjs';

// `runlist xref <file>` — one document's cross-references in one read, so a
// session editing or reporting on a plan starts from what the rest of the
// corpus and the repository say about it, not from the plan alone:
//
//   named by   every document whose frontmatter or body points at it
//   names      what it points at, with status, and whether it is named back
//   decisions  its own records, any linked peer that disagrees, and the
//              records elsewhere it cites beside a link to their document
//   code       the files it cites: live, renamed (to where) or removed, and
//              the commits since the plan's last commit that touched them
//   flags      what is open on it
//
// `runlist xref --check` runs the two findings worth a flag across the corpus:
// open work (an unticked item, a blocker, next_step) naming a file git shows
// removed or renamed, and a decision open or held in one document and ruled
// or closed at a linked peer. Everything else here is context, not a defect:
// code changing under a live plan is the normal state of a live plan.

const CODE_CITATION = /(?<![\w/.@~-])((?:[\w.@[\]-]+\/)+[\w.@[\]-]+\.[A-Za-z][A-Za-z0-9]{0,5})(?::\d+(?:-\d+)?)?(?![\w/])/g;

/** Repo paths a text cites, `file:line` suffixes dropped. Documents, URLs
 * and dot-relative paths are left to the reference checks. */
export function codeCitations(text) {
  const out = new Set();
  for (const m of text.matchAll(CODE_CITATION)) {
    const p = m[1].replace(/\.$/, '');
    if (/\.md$/i.test(p) || p.startsWith('.') || p.includes('//')) continue;
    // A domain (`example.com/a.js`) is a URL with its scheme dropped.
    if (/^[\w-]+\.(?:com|org|net|io|dev|app|ai|co)\//i.test(p)) continue;
    out.add(p);
  }
  return out;
}

function git(args, repoRoot) {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

// Every suffix of every path at a segment boundary, so a plan's shorthand
// (`services/a.ts` for `pkg/src/services/a.ts`) resolves.
function suffixMap(paths) {
  const map = new Map();
  for (const p of paths) {
    const parts = p.split('/');
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(i).join('/');
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(p);
    }
  }
  return map;
}

// Removals and renames, newest first, as [from, to|null] in the order git
// reports them; `range` limits the walk (`old..HEAD`).
function movesIn(repoRoot, range = null) {
  const args = ['-c', 'diff.renameLimit=0', 'log', '--diff-filter=DR', '--name-status', '-z', '--format='];
  if (range) args.push(range);
  const fields = (git(args, repoRoot) ?? '').split('\0').map(f => f.replace(/^\n+/, '')).filter(Boolean);
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    if (fields[i].startsWith('R')) { out.push([fields[i + 1], fields[i + 2]]); i += 2; }
    else if (fields[i] === 'D') out.push([fields[++i], null]);
  }
  return out;
}

// The full history walk is seconds on a large repository, so its result is
// kept in the state directory against the commit it read up to, and a later
// run walks only the commits since. A cache that no longer descends to HEAD
// (history rewritten, another branch) is thrown away and rebuilt.
function historyMoves(repoRoot, { write = true } = {}) {
  const head = git(['rev-parse', 'HEAD'], repoRoot)?.trim();
  if (!head) return new Map();
  const file = path.join(stateDir(repoRoot), 'xref-moves.json');
  let cached = null;
  try { cached = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none yet */ }
  const usable = cached?.head && Array.isArray(cached.moves)
    && (cached.head === head || spawnSync('git', ['merge-base', '--is-ancestor', cached.head, head], { cwd: repoRoot }).status === 0);
  const newer = usable ? (cached.head === head ? [] : movesIn(repoRoot, `${cached.head}..${head}`)) : movesIn(repoRoot);
  const moves = usable ? [...newer, ...cached.moves] : newer;
  if (write && (!usable || newer.length || cached.head !== head)) {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ head, moves }));
      commitRename(tmp, file);
    } catch { /* a cache that cannot be written is rebuilt next run */ }
  }
  const moved = new Map();
  for (const [from, to] of moves) if (from && !moved.has(from)) moved.set(from, to);
  return moved;
}

/**
 * What the repository knows about paths: the tracked files, and every path
 * git history removed or renamed (with its rename target, newest first).
 * Built once per run; `resolveCitation` is pure over it.
 */
export function repoPaths(repoRoot, options = {}) {
  const tracked = (git(['ls-files', '-z'], repoRoot) ?? '').split('\0').filter(Boolean);
  const moved = historyMoves(repoRoot, options);
  return { tracked: suffixMap(tracked), moved, movedSuffix: suffixMap([...moved.keys()]) };
}

/** Where a cited path stands: live (with the file or files it names), renamed
 * (to the file it is now, following a chain of renames), removed, or unknown
 * (never tracked: a file the plan has not created yet, or shorthand). */
export function resolveCitation(cited, repo) {
  const live = repo.tracked.get(cited);
  if (live) return { state: 'live', paths: live };
  const olds = repo.movedSuffix.get(cited);
  if (!olds) return { state: 'unknown' };
  for (const old of olds) {
    let to = repo.moved.get(old);
    const seen = new Set([old]);
    while (to && !repo.tracked.has(to) && repo.moved.has(to) && !seen.has(to)) {
      seen.add(to);
      to = repo.moved.get(to);
    }
    if (to && repo.tracked.get(to)?.includes(to)) return { state: 'renamed', from: old, to };
  }
  return { state: 'removed', from: olds[0] };
}

function lastCommitDate(relPath, repoRoot) {
  return git(['log', '-1', '--format=%cI', '--', relPath], repoRoot)?.trim() || null;
}

/** Commits after the document's last commit that touched a cited live file
 * and left the document alone. */
function commitsSince(docPath, files, since, repoRoot) {
  if (!since || !files.length) return [];
  const out = git(['log', `--since=${since}`, '--format=\x1e%h %cs %s', '--name-only', '--', docPath, ...files], repoRoot) ?? '';
  const wanted = new Set(files);
  const commits = [];
  for (const block of out.split('\x1e').filter(b => b.trim())) {
    const [head, ...names] = block.split('\n').filter(Boolean);
    if (names.includes(docPath)) continue;
    const touched = names.filter(n => wanted.has(n));
    if (!touched.length) continue;
    const [hash, date, ...subject] = head.split(' ');
    commits.push({ hash, date, subject: subject.join(' '), files: touched });
  }
  return commits;
}

function refTargets(doc, config) {
  const dir = path.dirname(path.join(config.repoRoot, doc.path));
  const out = [];
  for (const [field, refs] of Object.entries(doc.refFields ?? {})) {
    for (const ref of refs) {
      const target = resolveRefPath(String(ref).replace(/#.*$/, ''), dir, config.repoRoot);
      if (target) out.push({ field, path: toRepoPath(target, config.repoRoot) });
    }
  }
  for (const link of doc.bodyLinks ?? []) {
    if (link.targetKind !== 'document') continue;
    const target = resolveBodyLinkTarget(link.href, dir, config.repoRoot);
    if (target.ok) out.push({ field: 'body', path: toRepoPath(target.path, config.repoRoot) });
  }
  return out;
}

/** The lines of a document that are open work: unticked items, frontmatter
 * blockers, and `next_step`. */
export function openWorkLines(text) {
  const lines = openWork(text).map(e => ({ line: e.line, text: e.text }));
  const fm = extractFrontmatter(text).frontmatter;
  if (fm) {
    const next = parseSimpleFrontmatter(fm, []).next_step;
    if (next) {
      const at = text.split('\n').findIndex(l => l.startsWith('next_step:'));
      lines.push({ line: at + 1, text: String(next) });
    }
  }
  return lines;
}

function decisionContext(config) {
  const settings = decisionSettings(config.raw?.decisions ?? {});
  const docs = loadDecisionDocs(config, settings);
  return { docs, items: analyzeDecisions(docs, settings) };
}

const DONE = new Set(['ruled', 'closed']);

/** Decisions whose disposition disagrees with a linked peer's. */
export function decisionConflicts(items) {
  const out = [];
  for (const item of items) {
    if (!PENDING.has(item.disposition)) continue;
    for (const peer of item.peers) {
      if (DONE.has(peer.disposition)) out.push({ item, peer });
    }
  }
  return out;
}

/** Records in other documents that `text` cites: the id beside a link to
 * the record's document on one line. */
function citedDecisions(text, own, items) {
  const byFile = new Map();
  for (const item of items) {
    if (!item.id || item.doc === own) continue;
    if (!byFile.has(item.file)) byFile.set(item.file, []);
    byFile.get(item.file).push(item);
  }
  const found = new Map();
  text.split('\n').forEach((line, i) => {
    if (!line.includes('.md')) return;
    for (const [file, list] of byFile) {
      if (!line.includes(file)) continue;
      for (const item of list) {
        const key = `${item.doc}#${item.id}`;
        if (!found.has(key) && line.includes(item.id) && linksBesideId(line, item.id).has(file)) found.set(key, { item, line: i + 1 });
      }
    }
  });
  return [...found.values()];
}

/** The cross-reference card for one document, by absolute path. */
export function xrefDoc(abs, config, ctx = {}) {
  const rel = toRepoPath(abs, config.repoRoot);
  const text = readFileSync(abs, 'utf8');
  const index = ctx.index ?? buildIndex(config, { fast: true });
  const byPath = new Map(index.docs.map(d => [d.path, d]));

  const card = showDoc(abs, config);
  const selfTargets = new Set(refTargets(byPath.get(rel) ?? { path: rel }, config).map(t => t.path));

  const namedBy = [];
  for (const doc of index.docs) {
    if (doc.path === rel) continue;
    const fields = [...new Set(refTargets(doc, config).filter(t => t.path === rel).map(t => t.field))];
    if (fields.length) namedBy.push({ path: doc.path, status: doc.status ?? null, fields, namedBack: selfTargets.has(doc.path) });
  }
  namedBy.sort((a, b) => a.path.localeCompare(b.path));

  const names = card.related.map(r => {
    const target = r.path ? byPath.get(r.path) : null;
    const back = target ? refTargets(target, config).some(t => t.path === rel) : false;
    return { field: r.field, ref: r.ref, path: r.path, exists: r.exists, status: r.status, namesBack: back };
  });

  const { items } = ctx.decisions ?? decisionContext(config);
  const own = items.filter(i => i.doc === rel && i.id).map(i => ({
    id: i.id,
    line: i.line,
    disposition: i.effective ?? i.disposition,
    disagrees: i.peers
      .filter(p => p.disposition && p.disposition !== i.disposition && (PENDING.has(i.disposition) ? DONE.has(p.disposition) : PENDING.has(p.disposition)))
      .map(p => ({ doc: p.doc, line: p.line, disposition: p.disposition })),
  }));
  const cited = citedDecisions(text, rel, items).map(({ item, line }) => ({
    id: item.id, line, doc: item.doc, recordLine: item.line, disposition: item.effective ?? item.disposition,
  }));

  const repo = ctx.repo ?? repoPaths(config.repoRoot, { write: !config._execution?.suppressSideEffects });
  const code = [...codeCitations(text)].sort().map(cited => ({ cited, ...resolveCitation(cited, repo) }));
  const liveFiles = [...new Set(code.filter(c => c.state === 'live' && c.paths.length === 1).map(c => c.paths[0]))];
  const since = lastCommitDate(rel, config.repoRoot);
  const commits = commitsSince(rel, liveFiles, since, config.repoRoot);

  return {
    path: rel,
    title: card.title,
    status: card.status,
    lastCommit: since,
    namedBy,
    names,
    decisions: { own, cited },
    code,
    commitsSince: commits,
    flags: openFlags(config).filter(f => f.file === rel).map(f => ({ id: f.id, severity: f.severity, line: f.line, text: f.text })),
  };
}

/** The corpus-wide findings `--check` reports, as flag findings. */
export function xrefFindings(config, ctx = {}) {
  const index = ctx.index ?? buildIndex(config, { fast: true });
  const repo = ctx.repo ?? repoPaths(config.repoRoot, { write: !config._execution?.suppressSideEffects });
  const archiveDir = config.archiveDir ?? 'archived';
  const findings = [];
  for (const doc of index.docs) {
    if (doc.type !== 'plan' || doc.status === 'archived' || doc.path.split('/').includes(archiveDir)) continue;
    const text = readFileSync(path.join(config.repoRoot, doc.path), 'utf8');
    for (const work of openWorkLines(text)) {
      for (const cited of codeCitations(work.text)) {
        const r = resolveCitation(cited, repo);
        if (r.state === 'renamed') findings.push({ file: doc.path, line: work.line, severity: 'warn', text: `Open work names ${cited}, which was renamed to ${r.to}.` });
        else if (r.state === 'removed') findings.push({ file: doc.path, line: work.line, severity: 'warn', text: `Open work names ${cited}, which was removed.` });
      }
    }
  }
  const { items } = ctx.decisions ?? decisionContext(config);
  for (const { item, peer } of decisionConflicts(items)) {
    findings.push({ file: item.doc, line: item.line, severity: 'problem', text: `${item.id} is ${item.disposition} here and ${peer.disposition} at ${peer.doc}:${peer.line}.` });
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function renderCard(c) {
  const out = [];
  out.push(`${bold(c.title ?? c.path)}  (${c.status ?? 'no status'})`, c.path);
  out.push(dim(c.lastCommit ? `last committed ${c.lastCommit.slice(0, 10)}` : 'not committed'));

  out.push('', bold(`Named by (${c.namedBy.length})`));
  for (const n of c.namedBy) out.push(`  ${n.path}  (${n.status ?? 'no status'}, ${n.fields.join(', ')})${n.namedBack ? '' : yellow('  not named back')}`);

  out.push('', bold(`Names (${c.names.length})`));
  for (const n of c.names) {
    const where = n.exists ? `${n.path}  (${n.status ?? 'no status'})` : yellow(`${n.ref}  missing`);
    out.push(`  ${n.field}: ${where}${n.exists && !n.namesBack ? dim('  one-way') : ''}`);
  }

  const { own, cited } = c.decisions;
  const tally = new Map();
  for (const d of own) tally.set(d.disposition ?? 'no disposition', (tally.get(d.disposition ?? 'no disposition') ?? 0) + 1);
  out.push('', bold(`Decisions here (${own.length}${tally.size ? `: ${[...tally].map(([k, n]) => `${n} ${k}`).join(', ')}` : ''})`));
  for (const d of own) {
    if (!d.disagrees.length && !PENDING.has(d.disposition) && d.disposition) continue;
    out.push(`  ${d.id}  ${d.disposition ?? 'no disposition'}  line ${d.line}`);
    for (const p of d.disagrees) out.push(yellow(`      ${p.disposition} at ${p.doc}:${p.line}`));
  }
  const byDoc = new Map();
  for (const d of cited) {
    if (!byDoc.has(d.doc)) byDoc.set(d.doc, []);
    byDoc.get(d.doc).push(`${d.id} ${d.disposition ?? 'no disposition'}`);
  }
  out.push('', bold(`Decisions cited from elsewhere (${cited.length})`));
  for (const [doc, list] of byDoc) out.push(`  ${doc}: ${list.join(', ')}`);

  const by = s => c.code.filter(x => x.state === s);
  out.push('', bold(`Code (${c.code.length} cited: ${by('live').length} live, ${by('renamed').length} renamed, ${by('removed').length} removed, ${by('unknown').length} not in the repository)`));
  for (const x of by('renamed')) out.push(yellow(`  ${x.cited}  renamed to ${x.to}`));
  for (const x of by('removed')) out.push(yellow(`  ${x.cited}  removed`));
  if (c.commitsSince.length) {
    const counts = new Map();
    for (const k of c.commitsSince) for (const f of k.files) counts.set(f, (counts.get(f) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8);
    out.push(`  ${c.commitsSince.length} commits since the last commit here touched ${counts.size} cited files:`);
    for (const [f, n] of top) out.push(`    ${f}  ${n}`);
    for (const k of c.commitsSince.slice(0, 5)) out.push(dim(`    ${k.hash} ${k.date} ${k.subject.slice(0, 90)}`));
  }

  out.push('', bold(`Open flags (${c.flags.length})`));
  for (const f of c.flags) out.push(`  ${f.id} ${f.severity}  ${f.text}`);
  return `${out.join('\n')}\n`;
}

export function runXref(args, config) {
  const json = args.includes('--json');
  if (args.includes('--check')) {
    const findings = xrefFindings(config);
    if (args.includes('--flag')) {
      const { added, resolved } = syncCheckFlags(config, 'xref', findings);
      process.stderr.write(`flags: ${added} added, ${resolved} resolved\n`);
    }
    if (json) process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
    else {
      for (const f of findings) process.stdout.write(`${f.file}:${f.line}  ${f.text}\n`);
      process.stdout.write(`${findings.length} cross-reference findings.\n`);
    }
    if (findings.length) process.exitCode = 1;
    return findings;
  }
  const targets = args.filter(a => !a.startsWith('-'));
  if (!targets.length) die('Usage: runlist xref <file...> [--json]   |   runlist xref --check [--flag] [--json]');
  const ctx = { index: buildIndex(config, { fast: true }), repo: repoPaths(config.repoRoot, { write: !config._execution?.suppressSideEffects }), decisions: decisionContext(config) };
  const cards = targets.map(t => xrefDoc(resolveDocArg(t, config), config, ctx));
  if (json) process.stdout.write(`${JSON.stringify(cards, null, 2)}\n`);
  else process.stdout.write(cards.map(renderCard).join('\n'));
  return cards;
}
