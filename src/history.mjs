import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { buildIndex, parseDocFile, resolveDocArg } from './index.mjs';
import { filesWithRecords, inRecordDir, recordDirsOf } from './record-dirs.mjs';
import { resolveBodyLinkTarget } from './body-link.mjs';
import { extractBodyLinks } from './extractors.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { analyzeDecisions, decisionSettings, loadDecisionDocs, pendingRows, PENDING } from './decisions.mjs';
import { refTargets } from './xref.mjs';
import { cut } from './brief.mjs';
import { die, normalizeStringList, resolveRefPath, toRepoPath } from './util.mjs';
import { bold, dim } from './color.mjs';

// `runlist history <plan>` — where a plan's past lives: its records (the files
// in its records folder, and records elsewhere whose header links it), the
// plans before and after it, the documents that link it, the commits that
// touched it or its records, and its decisions.
//
// `runlist history --find "<text>"` — where a piece of text lives now, the
// commit that first wrote it, and the plan it came from.
//
// Records are Markdown files under a folder named in `history.recordDirs`
// (default `assets`), beside the plan as `<dir>/assets/<slug>/`. A repository
// usually excludes that folder from the index, and `--find` reads it anyway;
// every other command still skips it. Read-only: git and the working tree are
// read on each call, so nothing goes stale.

const HEADER_LINES = 8;
const HEADER_BYTES = 8192;
const SHOWN = 10;
const PICKAXE_FILES = 25;
const RENAME_HOPS = 3;
const GIT_TIMEOUT_MS = 60_000;
const SUBJECT_WIDTH = 100;

// Frontmatter keys that name a plan before or after this one, read whether or
// not a repository configures them as reference fields.
const BEFORE_KEYS = ['supersedes', 'replaces', 'predecessor', 'predecessors'];
const AFTER_KEYS = ['superseded_by', 'replaced_by', 'successor', 'successors'];
// The same words beside a body link, closest to the link wins. Checked as one
// alternation so `superseded by` is never read as `supersedes`.
const CUE = /\b(superseded(?:\s+\S+){0,2}?\s+by|replaced(?:\s+\S+){0,2}?\s+by|successors?|continued in|tail (?:is )?tracked in|supersedes|replaces|predecessors?|continues|split from)\b/gi;
const isAfterCue = cue => /^(superseded|replaced|successor|continued in|tail)/i.test(cue);
// A cue in an earlier clause or table cell is about something else.
const CLAUSE_BREAK = /[.;!?](?:\s|$)|\|/;
const CUE_WINDOW = 80;

const rel = (abs, config) => toRepoPath(abs, config.repoRoot);
const archiveDirOf = config => config.archiveDir ?? 'archived';

function git(args, repoRoot, { timeout = GIT_TIMEOUT_MS } = {}) {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout });
  if (r.error?.code === 'ETIMEDOUT') return { out: null, timedOut: true };
  if (r.error || r.status !== 0) return { out: null, timedOut: false };
  return { out: r.stdout, timedOut: false };
}

const COMMIT_FORMAT = '--format=\x1e%h\t%cs\t%s';

// `git log` output in COMMIT_FORMAT, with any --name-only files per commit.
function parseCommits(out) {
  const commits = [];
  for (const block of (out ?? '').split('\x1e')) {
    if (!block.trim()) continue;
    const [head, ...files] = block.split('\n').filter(Boolean);
    const [hash, date, ...subject] = head.split('\t');
    commits.push({ hash, date, subject: subject.join('\t'), files });
  }
  return commits;
}

function readHeader(abs) {
  let fd;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = readSync(fd, buf, 0, HEADER_BYTES, 0);
    return buf.subarray(0, n).toString('utf8').split('\n').slice(0, HEADER_LINES).join('\n');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const docBrief = (abs, config) => {
  try {
    const d = parseDocFile(abs, config, { fast: true });
    return { title: d.title, status: d.status, type: d.type };
  } catch {
    return { title: null, status: null, type: null };
  }
};

/** The repo paths of the plans a record's first lines link, in order. */
export function headerPlans(abs, config) {
  const out = [];
  for (const link of extractBodyLinks(readHeader(abs))) {
    if (link.targetKind !== 'document') continue;
    const target = resolveBodyLinkTarget(link.href, path.dirname(abs), config.repoRoot);
    if (!target.ok || !target.path.endsWith('.md') || target.path === abs) continue;
    if (docBrief(target.path, config).type === 'plan' && !out.includes(rel(target.path, config))) out.push(rel(target.path, config));
  }
  return out;
}

/** The records folders a plan can have: `<dir>/<recordDir>/<slug>/`, and the
 * same beside the archive's parent for an archived plan. */
export function recordFolders(planAbs, config) {
  const slug = path.basename(planAbs, '.md');
  const dir = path.dirname(planAbs);
  const bases = [dir];
  if (path.basename(dir) === archiveDirOf(config)) bases.push(path.dirname(dir));
  return bases.flatMap(base => recordDirsOf(config).map(rd => path.join(base, rd, slug)));
}

// Where a plan sat before it was archived, or where it sits once archived:
// the other path git history may hold it at.
function otherPlanPath(planAbs, config) {
  const dir = path.dirname(planAbs);
  const name = path.basename(planAbs);
  return path.basename(dir) === archiveDirOf(config)
    ? path.join(path.dirname(dir), name)
    : path.join(dir, archiveDirOf(config), name);
}

// The plan a record belongs to: the first plan its header links, else the
// plan its folder is named after.
function recordPlan(abs, config) {
  if (existsSync(abs)) {
    const linked = headerPlans(abs, config);
    if (linked.length) return { plan: linked[0], via: 'header' };
  }
  const parts = rel(abs, config).split('/');
  const at = parts.findIndex(p => recordDirsOf(config).includes(p));
  if (at < 0 || at + 1 >= parts.length - 1) return null;
  const base = path.join(config.repoRoot, ...parts.slice(0, at));
  for (const candidate of [path.join(base, `${parts[at + 1]}.md`), path.join(base, archiveDirOf(config), `${parts[at + 1]}.md`)]) {
    if (existsSync(candidate)) return { plan: rel(candidate, config), via: 'folder' };
  }
  return null;
}

function walkFiles(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(abs, out);
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

function lineAt(buf, offset) {
  let line = 1;
  for (let i = buf.indexOf(10); i !== -1 && i < offset; i = buf.indexOf(10, i + 1)) line++;
  return line;
}

/** Every file holding `needle`, with the line of its first occurrence and
 * the number of occurrences. */
export function filesHolding(files, needle) {
  const want = Buffer.from(needle, 'utf8');
  const hits = [];
  for (const abs of files) {
    let buf;
    try { buf = readFileSync(abs); } catch { continue; }
    let at = buf.indexOf(want);
    if (at === -1) continue;
    const first = at;
    let count = 0;
    while (at !== -1) { count++; at = buf.indexOf(want, at + want.length); }
    hits.push({ abs, line: lineAt(buf, first), count });
  }
  return hits;
}

// Lines of `text` that link `targetRel`, each with the cue word closest
// before the link, if one sits within CUE_WINDOW characters.
function cuedLinks(text, fromAbs, targetRel, config) {
  const out = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!line.includes('](')) return;
    for (const link of extractBodyLinks(line)) {
      if (link.targetKind !== 'document') continue;
      const target = resolveBodyLinkTarget(link.href, path.dirname(fromAbs), config.repoRoot);
      if (!target.ok || rel(target.path, config) !== targetRel) continue;
      const at = line.indexOf(`[${link.text}](`);
      const before = at === -1 ? '' : line.slice(Math.max(0, at - CUE_WINDOW), at);
      const last = [...before.matchAll(CUE)].pop();
      const cue = last && !CLAUSE_BREAK.test(before.slice(last.index + last[0].length)) ? last[1].toLowerCase().replace(/\s+/g, ' ') : null;
      out.push({ line: i + 1, cue });
    }
  });
  return out;
}

function frontmatterLinks(abs, config, keys) {
  const fm = parseSimpleFrontmatter(extractFrontmatter(readFileSync(abs, 'utf8')).frontmatter ?? '', []);
  const out = [];
  for (const key of keys) {
    for (const entry of normalizeStringList(fm[key])) {
      const ref = String(entry).replace(/^>\s*/, '').replace(/#.*$/, '').trim();
      const target = ref ? resolveRefPath(ref, path.dirname(abs), config.repoRoot) : null;
      if (target) out.push({ key, path: rel(target, config) });
    }
  }
  return out;
}

/** Plans and documents before and after this plan: an explicit frontmatter
 * key or a cue word beside a link, read both ways, then every other archived
 * plan linked either way. */
function lineage(planAbs, planRel, namedBy, ownTargets, config, byPath) {
  const found = new Map();
  const add = (p, relation, via, { plansOnly = false } = {}) => {
    if (p === planRel || found.has(p)) return;
    const brief = docBrief(path.join(config.repoRoot, p), config);
    if (plansOnly && brief.type !== 'plan') return;
    found.set(p, { path: p, relation, via, ...brief });
  };
  for (const f of frontmatterLinks(planAbs, config, BEFORE_KEYS)) add(f.path, 'before', `${f.key}:`);
  for (const f of frontmatterLinks(planAbs, config, AFTER_KEYS)) add(f.path, 'after', `${f.key}:`);
  const ownText = readFileSync(planAbs, 'utf8');
  for (const target of new Set(ownTargets)) {
    for (const c of cuedLinks(ownText, planAbs, target, config)) {
      if (c.cue) add(target, isAfterCue(c.cue) ? 'after' : 'before', `${planRel}:${c.line} "${c.cue}"`, { plansOnly: true });
    }
  }
  for (const n of namedBy) {
    const abs = path.join(config.repoRoot, n.path);
    for (const f of frontmatterLinks(abs, config, BEFORE_KEYS)) if (f.path === planRel) add(n.path, 'after', `its ${f.key}:`);
    for (const f of frontmatterLinks(abs, config, AFTER_KEYS)) if (f.path === planRel) add(n.path, 'before', `its ${f.key}:`);
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    for (const c of cuedLinks(text, abs, planRel, config)) {
      // `superseded by [this]` in another plan makes that plan the earlier one.
      if (c.cue) add(n.path, isAfterCue(c.cue) ? 'before' : 'after', `${n.path}:${c.line} "${c.cue}"`, { plansOnly: true });
    }
  }
  const archived = p => p.split('/').includes(archiveDirOf(config)) || byPath.get(p)?.status === 'archived';
  for (const p of [...ownTargets, ...namedBy.map(n => n.path)]) {
    if (archived(p) && (byPath.get(p)?.type ?? 'plan') === 'plan') add(p, 'linked', 'archived, linked');
  }
  return [...found.values()];
}

/** The history card for one plan, by absolute path. */
export function historyDoc(planAbs, config, { limit = SHOWN, index = null } = {}) {
  const planRel = rel(planAbs, config);
  const idx = index ?? buildIndex(config, { fast: true });
  const byPath = new Map(idx.docs.map(d => [d.path, d]));
  const self = byPath.get(planRel) ?? parseDocFile(planAbs, config, { fast: true });

  // Records: every file in the plan's records folders, and records elsewhere
  // whose header links the plan. A record must name the plan in its header
  // to be found outside its folder, so only files naming the slug are read.
  const folders = recordFolders(planAbs, config).filter(f => existsSync(f) && statSync(f).isDirectory());
  const inFolder = folders.flatMap(f => walkFiles(f)).sort();
  const records = [];
  const otherFiles = new Map();
  for (const abs of inFolder) {
    if (!abs.endsWith('.md')) {
      const ext = path.extname(abs).slice(1).toLowerCase() || '(none)';
      otherFiles.set(ext, (otherFiles.get(ext) ?? 0) + 1);
      continue;
    }
    records.push({ path: rel(abs, config), title: docBrief(abs, config).title, where: 'folder', namesPlanInHeader: headerPlans(abs, config).includes(planRel) });
  }
  const folderSet = new Set(inFolder);
  const slugFile = path.basename(planAbs);
  for (const hit of filesHolding(filesWithRecords(config).filter(f => !folderSet.has(f) && inRecordDir(rel(f, config), config)), slugFile)) {
    if (headerPlans(hit.abs, config).includes(planRel)) records.push({ path: rel(hit.abs, config), title: docBrief(hit.abs, config).title, where: 'header', namesPlanInHeader: true });
  }

  // Documents that link the plan, as `runlist xref` reads them.
  const ownTargets = refTargets(self, config).map(t => t.path);
  const namedBy = [];
  for (const doc of idx.docs) {
    if (doc.path === planRel) continue;
    const fields = [...new Set(refTargets(doc, config).filter(t => t.path === planRel).map(t => t.field))];
    if (fields.length) namedBy.push({ path: doc.path, status: doc.status ?? null, type: doc.type ?? null, fields });
  }
  namedBy.sort((a, b) => a.path.localeCompare(b.path));

  // Commits on the plan (at its live and archived paths) and its records folders.
  const paths = [planRel, rel(otherPlanPath(planAbs, config), config), ...folders.map(f => rel(f, config))];
  const log = git(['log', COMMIT_FORMAT, '--', ...paths], config.repoRoot);
  const allCommits = parseCommits(log.out);

  // Decisions as `runlist decisions` reads them; an archived plan, which it
  // skips, is read alone.
  const settings = decisionSettings(config.raw?.decisions ?? {});
  const docs = loadDecisionDocs(config, settings);
  const readAlone = !docs.some(d => d.path === planRel);
  const items = analyzeDecisions(readAlone
    ? [{ path: planRel, title: self.title ?? null, text: readFileSync(planAbs, 'utf8') }]
    : docs, settings);
  const rows = pendingRows(items, { doc: planRel, all: true });
  const tally = {};
  for (const r of rows) tally[r.disposition ?? 'none'] = (tally[r.disposition ?? 'none'] ?? 0) + 1;

  return {
    path: planRel,
    title: self.title ?? null,
    status: self.status ?? null,
    records: {
      folders: folders.map(f => rel(f, config)),
      markdown: records,
      otherFiles: Object.fromEntries([...otherFiles].sort((a, b) => b[1] - a[1])),
    },
    lineage: lineage(planAbs, planRel, namedBy, ownTargets, config, byPath),
    linkedFrom: namedBy,
    commits: { total: allCommits.length, paths, shown: allCommits.slice(0, limit).map(({ files, ...c }) => c) },
    decisions: {
      readFrom: readAlone ? 'this plan alone (runlist decisions skips archived plans)' : 'runlist decisions',
      tally,
      items: rows.map(r => ({ id: r.id, line: r.line, disposition: r.disposition, text: r.text })),
    },
  };
}

const more = (n, shown, how = '--all lists all') => (n > shown ? [`  (+${n - shown} more: ${how})`] : []);

function renderHistory(c, { all }) {
  const cap = all ? Infinity : SHOWN;
  const out = [`${bold(c.title ?? c.path)}  (${c.status ?? 'no status'})`, c.path];

  const { markdown, folders, otherFiles } = c.records;
  const others = Object.entries(otherFiles);
  const elsewhere = markdown.filter(r => r.where === 'header').length;
  const headed = markdown.filter(r => r.where === 'folder' && r.namesPlanInHeader).length;
  const folderCount = markdown.length - elsewhere;
  out.push('', bold(`Records (${markdown.length})`));
  if (folders.length) out.push(dim(`  ${folders.join(', ')}: ${folderCount} Markdown, ${headed} naming the plan in their header`));
  else out.push(dim('  no records folder'));
  for (const r of markdown.slice(0, cap)) out.push(`  ${r.path}${r.where === 'header' ? '  (header links the plan)' : ''}${r.title ? dim(`  ${cut(r.title, 70)}`) : ''}`);
  out.push(...more(markdown.length, cap));
  if (others.length) out.push(dim(`  Other files: ${others.map(([ext, n]) => `${n} ${ext}`).join(', ')}`));

  out.push('', bold(`Before and after (${c.lineage.length})`));
  for (const l of c.lineage.slice(0, cap)) {
    const word = l.relation === 'before' ? 'before' : l.relation === 'after' ? 'after ' : 'linked';
    out.push(`  ${word}  ${l.path}  (${l.status ?? 'no status'})${l.relation === 'linked' ? '' : dim(`  ${l.via}`)}`);
  }
  out.push(...more(c.lineage.length, cap));

  out.push('', bold(`Linked from (${c.linkedFrom.length})`));
  for (const n of c.linkedFrom.slice(0, cap)) out.push(`  ${n.path}  (${n.status ?? 'no status'}, ${n.fields.join(', ')})`);
  out.push(...more(c.linkedFrom.length, cap));

  const { total, shown } = c.commits;
  out.push('', bold(`Commits (${total} on the plan and its records${total > shown.length ? `; newest ${shown.length}` : ''})`));
  for (const k of shown) out.push(`  ${k.hash} ${k.date} ${cut(k.subject, SUBJECT_WIDTH)}`);
  if (total > shown.length) out.push(dim(`  (--limit N shows more; git log -- ${c.commits.paths.join(' ')})`));

  const tally = Object.entries(c.decisions.tally);
  out.push('', bold(`Decisions (${c.decisions.items.length}${tally.length ? `: ${tally.map(([k, n]) => `${n} ${k}`).join(', ')}` : ''})`));
  if (c.decisions.readFrom !== 'runlist decisions') out.push(dim(`  read from ${c.decisions.readFrom}`));
  const listed = all ? c.decisions.items : c.decisions.items.filter(d => PENDING.has(d.disposition) || !d.disposition);
  for (const d of listed.slice(0, cap)) out.push(`  ${d.id}  ${d.disposition ?? 'no disposition'}  line ${d.line}  ${cut(d.text, SUBJECT_WIDTH)}`);
  out.push(...more(listed.length, cap));
  if (!all && listed.length < c.decisions.items.length) out.push(dim(`  (open and held shown; --all lists every one, runlist decisions ${c.path} --all reads them)`));
  return `${out.join('\n')}\n`;
}

// Renames a commit made whose new path is one of `files`, as [from, to].
function renamesInto(hash, files, config) {
  const out = git(['diff-tree', '--root', '-r', '-M', '--diff-filter=R', '--name-status', '-z', '--no-commit-id', hash], config.repoRoot).out ?? '';
  const fields = out.split('\0').filter(Boolean);
  const pairs = [];
  for (let i = 0; i + 2 < fields.length && fields[i].startsWith('R'); i += 3) {
    if (files.has(fields[i + 2])) pairs.push([fields[i + 1], fields[i + 2]]);
  }
  return pairs;
}

/** Where `text` lives now, the commit that first wrote it, and its plan. */
export function findText(text, config, { limit = SHOWN } = {}) {
  const files = filesWithRecords(config);
  const hits = filesHolding(files, text).map(h => {
    const p = rel(h.abs, config);
    if (inRecordDir(p, config)) return { path: p, line: h.line, count: h.count, kind: 'record', plan: recordPlan(h.abs, config) };
    const b = docBrief(h.abs, config);
    return { path: p, line: h.line, count: h.count, kind: b.type ?? 'document', status: b.status, plan: b.type === 'plan' ? { plan: p, via: 'itself' } : null };
  });

  // `git log -S` with no path walks every commit's whole tree. Scoped to the
  // files that hold the text, the plans they belong to, those plans' records
  // folders and archive paths, it reaches text written in a plan and moved
  // into a record later.
  let pickaxe = { ran: false, reason: null, paths: [], commits: [] };
  const renamedTo = new Map();
  if (!hits.length) pickaxe.reason = 'the text is in no file now, and git log -S runs only on the files that hold it';
  else if (hits.length > PICKAXE_FILES) pickaxe.reason = `the text is in ${hits.length} files; git log -S runs on ${PICKAXE_FILES} or fewer, so make the text longer`;
  else {
    const scope = new Set();
    for (const h of hits) {
      scope.add(h.path);
      const plan = h.plan?.plan;
      if (!plan) continue;
      const abs = path.join(config.repoRoot, plan);
      scope.add(plan);
      scope.add(rel(otherPlanPath(abs, config), config));
      for (const f of recordFolders(abs, config)) scope.add(rel(f, config));
    }
    // When the oldest commit renamed a file into the scope, the text was
    // older than the rename: add the old path and look again.
    let r;
    let commits = [];
    for (let hop = 0; hop <= RENAME_HOPS; hop++) {
      r = git(['log', `-S${text}`, COMMIT_FORMAT, '--name-only', '--', ...[...scope].sort()], config.repoRoot);
      commits = parseCommits(r.out).reverse();
      if (r.timedOut || !commits.length || hop === RENAME_HOPS) break;
      const oldest = commits[0];
      const sources = renamesInto(oldest.hash, new Set(oldest.files), config).filter(([from]) => !scope.has(from));
      if (!sources.length) break;
      for (const [from, to] of sources) { scope.add(from); renamedTo.set(from, to); }
    }
    pickaxe = { ran: true, timedOut: r.timedOut, reason: r.timedOut ? `git log -S ran past ${GIT_TIMEOUT_MS / 1000} s` : null, paths: [...scope].sort(), commits };
  }

  const first = pickaxe.commits[0] ?? null;
  let cameFrom = null;
  if (first) {
    // A file's path now, after the renames followed above and an archive move.
    const current = file => {
      let p = file;
      for (const seen = new Set(); renamedTo.has(p) && !seen.has(p); p = renamedTo.get(p)) seen.add(p);
      const abs = path.join(config.repoRoot, p);
      return existsSync(abs) ? p : existsSync(otherPlanPath(abs, config)) ? rel(otherPlanPath(abs, config), config) : null;
    };
    // Of the files that commit touched, prefer the plan a holding record
    // belongs to, then a file that holds the text now.
    const recordPlans = new Set(hits.filter(h => h.kind === 'record').map(h => h.plan?.plan).filter(Boolean));
    const holding = new Set(hits.map(h => h.path));
    const file = first.files.find(f => recordPlans.has(current(f))) ?? first.files.find(f => holding.has(current(f))) ?? first.files[0] ?? null;
    if (file && inRecordDir(file, config)) {
      const r = recordPlan(path.join(config.repoRoot, current(file) ?? file), config);
      cameFrom = r ? { plan: r.plan, via: `the record ${file} (${r.via})` } : null;
    } else if (file) {
      const now = current(file);
      cameFrom = { plan: now ?? file, via: now && now !== file ? `${file}, now at ${now}` : `the file it was written in${now ? '' : ' (gone now)'}` };
    }
  }
  if (!cameFrom) {
    const planned = hits.find(h => h.plan);
    if (planned) cameFrom = { plan: planned.plan.plan, via: `${planned.path} (${planned.plan.via})` };
  }

  const messages = git(['log', '-F', `--grep=${text}`, '-n', String(limit), COMMIT_FORMAT], config.repoRoot);
  return {
    text,
    searched: files.length,
    files: hits,
    firstWritten: first ? { hash: first.hash, date: first.date, subject: first.subject, files: first.files } : null,
    cameFrom,
    pickaxe: { ran: pickaxe.ran, reason: pickaxe.reason, paths: pickaxe.paths, commits: pickaxe.commits.slice(0, limit), total: pickaxe.commits.length },
    messages: parseCommits(messages.out).map(({ files, ...c }) => c),
  };
}

function renderFind(r, { all }) {
  const cap = all ? Infinity : SHOWN;
  const out = [`${bold(`"${cut(r.text, 80)}"`)} is in ${r.files.length} file${r.files.length === 1 ? '' : 's'} (${r.searched.toLocaleString('en-US')} Markdown files read, record folders included)`];
  for (const h of r.files.slice(0, cap)) {
    const what = h.kind === 'record' ? `record${h.plan ? ` of ${h.plan.plan}` : ''}` : `${h.kind}${h.status ? `, ${h.status}` : ''}`;
    out.push(`  ${h.path}:${h.line}${h.count > 1 ? ` (${h.count} times)` : ''}  ${dim(`(${what})`)}`);
  }
  out.push(...more(r.files.length, cap));

  out.push('');
  if (r.firstWritten) {
    const f = r.firstWritten;
    out.push(`${bold('First written:')} ${f.hash} ${f.date} ${cut(f.subject, SUBJECT_WIDTH)}`);
    if (f.files.length) out.push(`  in ${f.files.join(', ')}`);
  } else {
    out.push(`${bold('First written:')} ${r.pickaxe.reason ?? 'no commit adds it in the files that hold it (not committed yet)'}`);
  }
  if (r.cameFrom) out.push(`${bold('Came from:')} ${r.cameFrom.plan}  ${dim(`(${r.cameFrom.via})`)}`);

  if (r.pickaxe.total > 1) {
    out.push('', bold(`Commits that changed how often it appears (${r.pickaxe.total}, oldest first)`));
    for (const k of r.pickaxe.commits) out.push(`  ${k.hash} ${k.date} ${cut(k.subject, SUBJECT_WIDTH)}`);
    out.push(...more(r.pickaxe.total, r.pickaxe.commits.length, '--limit N'));
  }
  if (r.pickaxe.ran) out.push(dim(`  git log -S over ${r.pickaxe.paths.length} paths`));

  out.push('', bold(`Commit messages naming it (${r.messages.length}${r.messages.length >= SHOWN ? ', newest' : ''})`));
  for (const k of r.messages) out.push(`  ${k.hash} ${k.date} ${cut(k.subject, SUBJECT_WIDTH)}`);
  return `${out.join('\n')}\n`;
}

function parseArgs(args) {
  const opts = { json: false, all: false, find: null, limit: SHOWN, target: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') opts.json = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--find') opts.find = args[++i] ?? die('--find needs the text to look for');
    else if (a === '--limit') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1) die(`--limit takes a positive whole number, got: ${args[i]}`);
      opts.limit = n;
    } else if (a.startsWith('-')) die(`Unknown option for history: ${a}`);
    else if (opts.target) die('history reads one plan; name one');
    else opts.target = a;
  }
  return opts;
}

export function runHistory(args, config) {
  const opts = parseArgs(args);
  if (opts.find != null) {
    if (opts.target) die('Name a plan or --find "<text>", not both');
    if (!opts.find.trim()) die('--find needs the text to look for');
    const r = findText(opts.find, config, { limit: opts.limit });
    process.stdout.write(opts.json ? `${JSON.stringify(r, null, 2)}\n` : renderFind(r, opts));
    return r;
  }
  if (!opts.target) die('Usage: runlist history <plan> [--limit N] [--all] [--json]   |   runlist history --find "<text>" [--limit N] [--all] [--json]');
  const card = historyDoc(resolveDocArg(opts.target, config), config, { limit: opts.limit });
  process.stdout.write(opts.json ? `${JSON.stringify(card, null, 2)}\n` : renderHistory(card, opts));
  return card;
}
