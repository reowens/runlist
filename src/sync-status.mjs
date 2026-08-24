import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, normalizeEol } from './frontmatter.mjs';
import { die, isArchivedPath, toRepoPath } from './util.mjs';
import { cyan, dim, green, red, yellow } from './color.mjs';
import { authorizeManagedSweep } from './managed-path.mjs';
import { resolveBodyLinkTarget } from './body-link.mjs';
import {
  MARKER_CLOSE,
  MARKER_OPEN,
  applyStatusCase,
  isHubDoc,
  readPositionalToken,
  scanHubStatusRows,
} from './hub.mjs';

// Hub status drift: a hub rows its children in a table and prints each child's
// status by hand. Nothing keeps that word honest — the child goes `archived`,
// the hub still says `active`, and every later reader plans against a status
// that stopped being true.
//
// dotmd already reads those rows to compute next-pickup, so the guard is
// standing next to the data it needs. Everything it needs is already owned:
// `config.types[<type>].statuses` for the vocabulary (type-aware, so a `doc`
// rowed in a plan hub is judged by the doc vocabulary), the strict Markdown
// body-link resolver, the index for the child's real status, and
// archive-dir-outranks-frontmatter for archived children.
//
// The three-way split below is the part that is easy to get wrong. A row with
// no readable status token is NOT automatically a finding:
//
//   pointer    — the table has no status column at all. Legitimate; many hubs
//                row a child just to say "related". SILENT.
//   unreadable — the table HAS a `Status`/`State` column but no status word can
//                be read from the cell. WARNING: the row opts out of the
//                invariant invisibly, and that is exactly where real drift hides.
//   manageable — a token was found (positionally or in a marker). Compare it.
//
// Collapsing those (treating every unmatched row as a finding) floods perfectly
// correct hubs with false positives.

// Warning when inferred, error when marked — no config knob. `dotmd check`
// exits 0 on warnings and 1 on errors, and that asymmetry is the whole point: a
// positional match is dotmd INFERRING from prose, so it nudges; a marked span is
// the author declaring "dotmd owns this word", so drifting it fails the check.
// No repo that never asked for this feature starts failing builds over an
// inference.
const DRIFT_KIND = 'hub-status-drift';
const UNREADABLE_KIND = 'hub-status-unreadable';

// Mirror `isValidStatus` in validate.mjs: a doc's own type owns its vocabulary,
// falling back to the root set and then the global union for untyped docs.
function statusVocabulary(doc, config) {
  if (doc.type) {
    const typeSet = config.typeStatuses?.get(doc.type);
    if (typeSet?.size) return typeSet;
  }
  return config.rootValidStatuses?.get(doc.root) ?? config.validStatuses ?? new Set();
}

// A doc physically living under the archive dir is archived, whatever its
// frontmatter says — the same precedence the rest of dotmd applies. (The
// frontmatter itself is already an error from `validateDoc`; the hub row should
// still be told the truth rather than agreeing with the stale word.)
function effectiveStatus(doc, config) {
  const archiveStatuses = config.lifecycle?.archiveStatuses ?? new Set(['archived']);
  if (isArchivedPath(doc.path, config) && !archiveStatuses.has(doc.status)) {
    return [...archiveStatuses][0] ?? 'archived';
  }
  return doc.status ?? null;
}

function truncate(text, max = 60) {
  const squeezed = text.trim().replace(/\s+/g, ' ');
  return squeezed.length > max ? `${squeezed.slice(0, max - 1)}…` : squeezed;
}

// Read every hub's rows and classify each one. `hubPaths` narrows the sweep to
// named hubs; when given, quiet/terminal hubs are included too (the user asked
// for that hub by name, so the noise-control rule doesn't apply).
export function collectHubStatusRows(docs, config, { hubPaths = null } = {}) {
  const docByPath = new Map(docs.map(doc => [doc.path, doc]));
  // The filesystem resolver is case-fold-aware, so on a case-folding filesystem a row
  // linking `BILLING-A.md` resolves to the file that is indexed as
  // `billing-a.md` — a path string the exact map can't answer. Fold as a
  // fallback, and only when the fold is unambiguous: on a case-SENSITIVE
  // filesystem those really are two different docs.
  const docByFoldedPath = new Map();
  for (const doc of docs) {
    const key = doc.path.toLowerCase();
    docByFoldedPath.set(key, docByFoldedPath.has(key) ? null : doc);
  }
  // Per-doc: warning suppression is type-scoped, so a status name quiet for one
  // type stays loud for another that declared the same name.
  const quiet = (d) => (config.lifecycle?.isTerminal?.(d.status, d.type)
      ?? config.lifecycle?.terminalStatuses?.has(d.status))
    || config.lifecycle?.skipsWarnings(d.status, d.type);
  const out = [];

  for (const hub of docs) {
    if (!isHubDoc(hub)) continue;
    if (hubPaths) { if (!hubPaths.has(hub.path)) continue; }
    else if (quiet(hub)) continue;

    let raw;
    try { raw = readFileSync(path.join(config.repoRoot, hub.path), 'utf8'); } catch { continue; }
    const { body, bodyLineOffset } = extractFrontmatter(raw);
    const hubDir = path.dirname(path.join(config.repoRoot, hub.path));

    const rows = [];
    for (const row of scanHubStatusRows(body)) {
      const href = row.ref.replace(/#.*$/, '');
      const resolution = resolveBodyLinkTarget(href, hubDir, config.repoRoot);
      // A row whose link is broken is already a body-link finding. Reporting it
      // again as unreadable status would double-report one problem.
      if (!resolution.ok) continue;
      const repoPath = toRepoPath(resolution.path, config.repoRoot);
      const target = docByPath.get(repoPath) ?? docByFoldedPath.get(repoPath.toLowerCase()) ?? null;
      if (!target || target.path === hub.path) continue;
      const actual = effectiveStatus(target, config);
      if (!actual) continue; // missing `status:` is the child's own error

      const vocabulary = statusVocabulary(target, config);
      const span = row.marked
        ?? readPositionalToken(row.statusCell, word => vocabulary.has(word.toLowerCase()));
      const base = {
        lineIndex: row.lineIndex,
        line: bodyLineOffset + row.lineIndex + 1,
        target: target.path,
        actual,
      };
      if (!span) {
        // No status column → pointer row → silent. Status column → the row opts
        // out of the invariant invisibly, which is a finding.
        if (row.hasStatusColumn) {
          rows.push({ ...base, state: 'unreadable', marked: false, span: null, printed: null,
            cell: row.statusCell ? truncate(row.statusCell.raw) : '' });
        }
        continue;
      }
      rows.push({
        ...base,
        state: span.text.toLowerCase() === String(actual).toLowerCase() ? 'ok' : 'drift',
        marked: Boolean(row.marked),
        span,
        printed: span.text,
      });
    }
    if (rows.length) out.push({ hub, rows, bodyLineOffset });
  }
  return out;
}

// The check-pipeline pass. Returns index-level warnings/errors; `src/index.mjs`
// pushes them and attaches them to the owning hub doc.
export function checkHubStatusDrift(docs, config) {
  const warnings = [];
  const errors = [];
  for (const { hub, rows } of collectHubStatusRows(docs, config)) {
    for (const row of rows) {
      if (row.state === 'drift') {
        const entry = {
          path: hub.path,
          level: row.marked ? 'error' : 'warning',
          message: row.marked
            ? `line ${row.line} rows \`${row.target}\` as \`${row.printed}\` inside a \`${MARKER_OPEN}…${MARKER_CLOSE}\` marker, but that doc's status is \`${row.actual}\`. The marker means dotmd owns that word — run \`dotmd sync-status\` to rewrite it, or change the doc's status.`
            : `line ${row.line} rows \`${row.target}\` as \`${row.printed}\`, but that doc's status is \`${row.actual}\`. Run \`dotmd sync-status\` to rewrite the row, or change the doc's status.`,
          meta: { kind: DRIFT_KIND, target: row.target, printed: row.printed, actual: row.actual, line: row.line, marked: row.marked },
        };
        (row.marked ? errors : warnings).push(entry);
      } else if (row.state === 'unreadable') {
        warnings.push({
          path: hub.path,
          level: 'warning',
          message: `line ${row.line} rows \`${row.target}\` under a status column, but no status word could be read from the cell (\`${row.cell}\`). Lead the cell with the status, or wrap the status in \`${MARKER_OPEN}…${MARKER_CLOSE}\`, so drift in this row can be caught.`,
          meta: { kind: UNREADABLE_KIND, target: row.target, line: row.line },
        });
      }
    }
  }
  return { warnings, errors };
}

// Rewrite drifted status words, and (with `adopt`) wrap managed positional
// tokens in markers. `adopt` is separate because wrapping a word in markers is a
// content edit to prose the user wrote: `check --fix` / `doctor` rewrite status
// TOKENS, marked or positional; only `--adopt` ADDS markers.
export function syncHubStatuses(config, { docs, dryRun = false, adopt = false, hubPaths = null, quiet = false } = {}) {
  const hubs = collectHubStatusRows(docs, config, { hubPaths });
  if (hubs.length) {
    authorizeManagedSweep(hubs.map(h => path.join(config.repoRoot, h.hub.path)), config, { kind: 'Hub status sync source' });
  }

  const prefix = dryRun ? dim('[dry-run] ') : '';
  const result = { fixed: 0, adopted: 0, unreadable: 0, hubs: [], skippedLineStart: 0 };

  for (const { hub, bodyLineOffset, rows } of hubs) {
    const absPath = path.join(config.repoRoot, hub.path);
    const raw = normalizeEol(readFileSync(absPath, 'utf8'));
    const lines = raw.split('\n');
    const applied = [];
    let unreadable = 0;

    for (const row of rows) {
      if (row.state === 'unreadable') { unreadable++; continue; }
      const drifted = row.state === 'drift';
      let wrap = adopt && !row.marked;
      // A marker must never begin a line: `reference-planner.mjs` returns any
      // line starting with `<!--` unmodified (CommonMark HTML-block rule), so a
      // link sharing that line would stop being rewritten by moves. A table row
      // always starts with `|`, so this cannot bite in the intended use — the
      // guard is here so a "markers on their own line" idea fails loudly.
      if (wrap && !lines[bodyLineOffset + row.lineIndex].slice(0, row.span.start).trim()) {
        wrap = false;
        result.skippedLineStart++;
      }
      if (!drifted && !wrap) continue;

      const replacement = drifted ? applyStatusCase(row.printed, row.actual) : row.printed;
      const lineIdx = bodyLineOffset + row.lineIndex;
      const line = lines[lineIdx];
      lines[lineIdx] = line.slice(0, row.span.start)
        + (wrap ? MARKER_OPEN : '') + replacement + (wrap ? MARKER_CLOSE : '')
        + line.slice(row.span.end);
      applied.push({ line: row.line, target: row.target, from: row.printed, to: replacement, drifted, wrapped: wrap, marked: row.marked });
      if (drifted) result.fixed++;
      if (wrap) result.adopted++;
    }

    result.unreadable += unreadable;
    if (applied.length === 0) {
      if (unreadable > 0) result.hubs.push({ path: hub.path, changes: [], unreadable });
      continue;
    }
    if (!dryRun) writeFileSync(absPath, lines.join('\n'), 'utf8');
    result.hubs.push({ path: hub.path, changes: applied, unreadable });

    if (!quiet) {
      process.stdout.write(`${prefix}${green('Synced')}: ${hub.path} (${applied.length} row${applied.length === 1 ? '' : 's'})\n`);
      for (const change of applied) {
        const what = change.drifted
          ? `${red(change.from)} → ${green(change.to)}`
          : `${dim('marked')} ${cyan(change.to)}`;
        const wrapNote = change.wrapped && change.drifted ? dim(' + marker') : '';
        process.stdout.write(`${prefix}  ${dim(`line ${change.line}`)} ${what}${wrapNote} ${dim(`(${change.target})`)}\n`);
      }
    }
  }

  if (!quiet) {
    if (result.fixed > 0 || result.adopted > 0) {
      const parts = [];
      if (result.fixed) parts.push(`${result.fixed} row${result.fixed === 1 ? '' : 's'} rewritten`);
      if (result.adopted) parts.push(`${result.adopted} marker${result.adopted === 1 ? '' : 's'} added`);
      process.stdout.write(`\n${prefix}${parts.join(', ')}.\n`);
    }
    if (result.unreadable > 0) {
      process.stdout.write(yellow(`${result.unreadable} row(s) sit under a status column with no readable status word`)
        + ' — lead the cell with the status, or wrap it in '
        + `${MARKER_OPEN}…${MARKER_CLOSE}. Run \`dotmd check\` to list them.\n`);
    }
  }
  return result;
}

// Resolve `dotmd sync-status <hub...>` arguments against the index. Matching by
// path, path+`.md`, or basename slug — the same handles every other verb takes —
// with a hub-aware miss message (a plain plan named here is a mistake worth
// naming, not a silent no-op).
function resolveHubArgs(args, docs) {
  const paths = new Set();
  for (const arg of args) {
    const slug = arg.replace(/\.md$/, '');
    const matches = docs.filter(doc =>
      doc.path === arg || doc.path === `${slug}.md`
      || path.basename(doc.path, '.md') === path.basename(slug));
    if (matches.length === 0) die(`No doc matches "${arg}".`);
    if (matches.length > 1) {
      die(`Multiple docs match "${arg}":\n${matches.map(m => `  ${m.path}`).join('\n')}`);
    }
    const [match] = matches;
    if (!isHubDoc(match)) {
      die(`${match.path} is not a hub — it has no \`runlist:\` and no \`execution_mode: coordination|roadmap\`. `
        + 'Run `dotmd sync-status` with no argument to sweep every hub.');
    }
    paths.add(match.path);
  }
  return paths;
}

export async function runSyncStatus(argv, config, opts = {}) {
  // Dynamic so this module stays importable FROM index.mjs (which needs
  // `checkHubStatusDrift`) without closing an import cycle.
  const { buildIndex } = await import('./index.mjs');

  const adopt = argv.includes('--adopt');
  const json = argv.includes('--json');
  const hubArgs = argv.filter(arg => !arg.startsWith('-'));
  const docs = buildIndex(config).docs;
  const hubPaths = hubArgs.length ? resolveHubArgs(hubArgs, docs) : null;

  const result = syncHubStatuses(config, { docs, dryRun: opts.dryRun, adopt, hubPaths, quiet: json });
  if (json) {
    process.stdout.write(`${JSON.stringify({ dryRun: Boolean(opts.dryRun), adopt, ...result }, null, 2)}\n`);
    return;
  }
  if (result.fixed === 0 && result.adopted === 0 && result.unreadable === 0) {
    process.stdout.write(green('Hub status rows are in sync.') + '\n');
  }
  if (adopt && result.skippedLineStart > 0) {
    process.stdout.write(dim(`${result.skippedLineStart} token(s) left unmarked: a marker may never begin a line.\n`));
  }
}

export { MARKER_CLOSE, MARKER_OPEN };
export const HUB_STATUS_KINDS = Object.freeze({ drift: DRIFT_KIND, unreadable: UNREADABLE_KIND });
