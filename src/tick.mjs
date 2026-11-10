import { readFileSync } from 'node:fs';
import { extractFrontmatter, normalizeEol } from './frontmatter.mjs';
import { walkChecklist } from './section.mjs';
import { resolveDocArg } from './index.mjs';
import { authorizeManagedSource } from './managed-path.mjs';
import { mutateFile } from './atomic-mutation.mjs';
import { renderLifecycleMutation } from './lifecycle.mjs';
import { toRepoPath, die, nowIso } from './util.mjs';
import { green, dim } from './color.mjs';

// `runlist tick <file> <item>`: close one checklist box (`- [ ]` → `- [x]`), or
// reopen it with --undo. <item> is the box's line number as `runlist show`
// prints it, or a piece of its text that names one box. Boxes are found the
// way `show` finds them (walkChecklist, outside code fences), so the numbers
// agree. It writes the working tree only; committing is the caller's business.

const USAGE = 'Usage: runlist tick <file-or-slug> <line|text> [--undo] [--note "<text>"]';
const MARK_RE = /^(\s*[-*]\s+\[)[ xX~](\])/;
const LIST_LIMIT = 20;

function boxesOf(text) {
  const { body, bodyLineOffset } = extractFrontmatter(text);
  return walkChecklist(body).map(box => ({ ...box, line: box.line + bodyLineOffset }));
}

function boxLine(lines, box) {
  const line = lines[box.line - 1].trim();
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

function candidates(lines, boxes) {
  if (!boxes.length) return '  (none)';
  const shown = boxes.slice(0, LIST_LIMIT).map(box => `  ${box.line}  ${boxLine(lines, box)}`);
  if (boxes.length > LIST_LIMIT) shown.push(`  (+${boxes.length - LIST_LIMIT} more)`);
  return shown.join('\n');
}

// The box <item> names. A box already in the target state is returned too, so
// the caller can say so rather than call it missing.
export function findBox(text, item, { undo = false } = {}) {
  const lines = text.split('\n');
  const boxes = boxesOf(text);
  const fromOpen = !undo;
  const state = fromOpen ? 'open' : 'ticked';
  const movable = boxes.filter(box => box.open === fromOpen);
  if (/^\d+$/.test(item)) {
    const box = boxes.find(b => b.line === Number(item));
    if (box) return box;
    die(`Line ${item} is not a checklist box. The ${state} boxes (line, text):\n${candidates(lines, movable)}`);
  }
  const needle = item.toLowerCase();
  const hits = boxes.filter(box => box.text.toLowerCase().includes(needle));
  if (!hits.length) die(`No box matches "${item}". The ${state} boxes (line, text):\n${candidates(lines, movable)}`);
  const live = hits.filter(box => box.open === fromOpen);
  if (live.length === 1) return live[0];
  if (live.length === 0 && hits.length === 1) return hits[0];
  const pool = live.length ? live : hits;
  die(`"${item}" matches ${pool.length} boxes; name one by its line number:\n${candidates(lines, pool)}`);
}

export function runTick(argv, config, opts = {}) {
  const { dryRun } = opts;
  const undo = argv.includes('--undo');
  argv = argv.filter(arg => arg !== '--undo');
  let note = null;
  const noteIdx = argv.indexOf('--note');
  if (noteIdx !== -1) {
    note = argv[noteIdx + 1];
    if (note === undefined || note.startsWith('--') || !note.trim()) die('--note needs a value: --note "<evidence>"');
    if (/[\r\n]/.test(note)) die('--note is one line; it is appended to the box line.');
    note = note.trim();
    argv = argv.filter((_, i) => i !== noteIdx && i !== noteIdx + 1);
  }
  const [input, item] = argv;
  if (!input || item === undefined || argv.length !== 2 || !item.trim()) die(USAGE);

  let filePath = resolveDocArg(input, config);
  filePath = authorizeManagedSource(filePath, config, { kind: 'Tick source' }).path;
  const repoPath = toRepoPath(filePath, config.repoRoot);

  const text = normalizeEol(readFileSync(filePath, 'utf8'));
  const box = findBox(text, item.trim(), { undo });
  const lines = text.split('\n');
  const verb = undo ? 'reopened' : 'ticked';
  if (box.open === undo) {
    process.stdout.write(`${repoPath}:${box.line} is already ${undo ? 'open' : 'ticked'}; nothing changed${note ? ' and the note was not written' : ''}.\n`);
    return { path: repoPath, line: box.line, changed: false };
  }

  const before = lines[box.line - 1];
  let after = before.replace(MARK_RE, `$1${undo ? ' ' : 'x'}$2`);
  if (note) after = `${after.replace(/\s+$/, '')} ${note}`;

  if (dryRun) {
    process.stdout.write(`${dim('[dry-run]')} Would write ${repoPath}:${box.line}: ${after.trim()}\n`);
    return { path: repoPath, line: box.line, changed: false, dryRun: true };
  }

  mutateFile(filePath, { repoRoot: config.repoRoot }, raw => {
    const current = normalizeEol(raw).split('\n');
    if (current[box.line - 1] !== before) die(`${repoPath}:${box.line} changed while it was being ${verb}; nothing was written. Run the command again.`);
    current[box.line - 1] = after;
    const next = current.join('\n');
    return next.startsWith('---\n') ? renderLifecycleMutation(next, { updated: nowIso() }, null) : next;
  });

  const open = boxesOf(normalizeEol(readFileSync(filePath, 'utf8'))).filter(b => b.open).length;
  process.stdout.write(`${green(repoPath)}:${box.line} ${verb}: ${after.trim()}\n`);
  process.stdout.write(dim(`${open} open box${open === 1 ? '' : 'es'} left. Written to the working tree only; it rides your next commit.\n`));
  return { path: repoPath, line: box.line, changed: true };
}
