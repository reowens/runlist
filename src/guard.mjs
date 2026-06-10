import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGitIgnored } from './git.mjs';
import { recordGuardEvent } from './journal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

// `dotmd guard` is the PreToolUse hook handler. Claude Code pipes the tool-call
// payload on stdin; we evaluate it against a small set of "wrong-move" rules and
// reply with a PreToolUse hook-output JSON object. Every catch is also recorded
// to the cross-repo misuse log so the operator can audit *every* incorrect usage
// — these mistakes never invoke dotmd directly, so the guard is the only place
// they become visible.
//
// Two decision levels:
//   'deny' — block the call and feed the reason back to the model. Reserved for
//            moves that are guaranteed-wrong: committing a gitignored prompt (it
//            would fail anyway) and hand-editing a `status:` field (`dotmd set`
//            is a complete substitute; config `guard: { deny: false }` drops the
//            status rules back to warn).
//   'warn' — let the call proceed but inject teaching context so the agent learns
//            the dotmd-native command. Used for soft mistakes (cat/Read of a
//            prompt) where a human might legitimately do it; we nudge rather
//            than block.

const SHELL_READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'bat', 'view', 'open']);

// A path that ends in .md and sits under a `prompts/` directory is a
// session-local saved prompt regardless of which doc root it belongs to —
// robust across repos without needing the resolved config. Archived prompts
// (`…/prompts/archived/…`, the default nested archive for the prompt type) are
// committable history, NOT session-local, so they're explicitly excluded — the
// guard must not block committing or reading them.
function isPromptPath(p) {
  if (typeof p !== 'string' || !p.endsWith('.md')) return false;
  if (!/(^|\/)prompts\//.test(p)) return false;
  if (/(^|\/)archived\//.test(p)) return false;
  return true;
}

// Loose "is this a dotmd-managed doc" test: a .md file under one of the
// configured doc roots (default `docs/`). Used for the status-edit guard.
function isManagedDoc(p, config) {
  if (typeof p !== 'string' || !p.endsWith('.md')) return false;
  const roots = config?.docsRoots || (config?.docsRoot ? [config.docsRoot] : ['docs']);
  return roots.some(r => {
    const base = path.basename(r);
    return p.includes(`/${base}/`) || p.startsWith(`${base}/`) || p.includes(r);
  });
}

// Pull bare path-looking tokens out of a shell command. Good enough to spot the
// prompt file in `git add docs/prompts/foo.md` or `cat docs/prompts/foo.md`.
function shellTokens(command) {
  if (typeof command !== 'string') return [];
  return command.split(/\s+/).map(t => t.replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

// Decision level for the status-edit rules. Hand-editing `status:` has no
// legitimate variant — `dotmd set` is a complete substitute — so it denies by
// default. `guard: { deny: false }` in config drops it back to warn-only.
function editStatusDecision(config) {
  return config?.guard?.deny === false ? 'warn' : 'deny';
}

function editStatusResult(target, config, detail) {
  return {
    decision: editStatusDecision(config),
    rule: 'edit-status',
    detail,
    reason:
      `Looks like a hand-edit of the \`status:\` field in ${target}. Use \`dotmd set <status> ${target}\` instead — ` +
      `it validates the status against this doc's type, runs lifecycle hooks, fixes refs, and keeps the index in sync. Direct edits skip all of that.`,
  };
}

// In-place stream editors (`sed -i`, `perl -pi`, `awk -i inplace`) are the
// shell-side bypass of the Edit-tool status guard. Only the command text
// before any heredoc marker is scanned — heredoc bodies are document content
// (often prose *describing* these rules), not commands.
const STREAM_EDITOR_INPLACE = [
  /\bsed\b[^|;&<>]*\s-i/,
  /\bperl\b[^|;&<>]*\s-[a-zA-Z]*i/,
  /\bg?awk\b[^|;&<>]*\binplace\b/,
];

function evalBash(command, config, isIgnored) {
  const tokens = shellTokens(command);
  const promptTokens = tokens.filter(isPromptPath);

  // Rule A — committing/adding a gitignored prompt. The exact failure the guard
  // exists for: an agent reflexively `git add`s a session-local prompt that
  // lives under a gitignored path, and the commit dies confusingly.
  if (/\bgit\s+(add|commit|stage)\b/.test(command) && promptTokens.length) {
    const ignored = promptTokens.filter(p => isIgnored(p));
    const targets = ignored.length ? ignored : promptTokens;
    const ignoredNote = ignored.length
      ? ` ${ignored.join(', ')} is gitignored — it cannot be committed.`
      : '';
    return {
      decision: 'deny',
      rule: 'commit-prompt',
      detail: command,
      reason:
        `Saved prompts (${targets.join(', ')}) are session-local dotmd artifacts, not source to commit.${ignoredNote} ` +
        `Don't git add/commit them. The next session consumes a prompt with \`dotmd use <file>\` (or \`dotmd use\` for the oldest pending), which prints the body and archives it atomically.`,
    };
  }

  // Rule B — reading a prompt through the shell instead of consuming it.
  if (tokens.length) {
    const cmd0 = path.basename(tokens[0]);
    if (SHELL_READERS.has(cmd0) && promptTokens.length) {
      return {
        decision: 'warn',
        rule: 'cat-prompt',
        detail: command,
        reason:
          `${promptTokens.join(', ')} is a saved dotmd prompt. Don't \`${cmd0}\` it — run \`dotmd use ${promptTokens[0]}\` ` +
          `to print the body and archive it in one atomic step (prevents the same prompt being consumed twice). Use \`dotmd use\` with no arg for the oldest pending prompt.`,
      };
    }
  }

  // Rule C — in-place stream-editing `status:` in a managed doc. Same wrong-move
  // as the Edit-tool rule, reached via the shell.
  const beforeHeredoc = command.split(/<<-?\s*['"]?\w/)[0];
  if (/status/.test(beforeHeredoc) && STREAM_EDITOR_INPLACE.some(re => re.test(beforeHeredoc))) {
    const managed = shellTokens(beforeHeredoc).filter(t => isManagedDoc(t, config));
    if (managed.length) {
      return editStatusResult(managed[0], config, command);
    }
  }

  return null;
}

function evalRead(filePath) {
  if (!isPromptPath(filePath)) return null;
  return {
    decision: 'warn',
    rule: 'read-prompt',
    detail: filePath,
    reason:
      `${filePath} is a saved dotmd prompt. Prefer \`dotmd use ${filePath}\` over reading it directly — it prints the body and archives the prompt atomically so it can't be double-consumed.`,
  };
}

// Every `status:` line in a snippet, normalized for comparison.
function statusLines(s) {
  if (typeof s !== 'string') return [];
  return (s.match(/^[ \t]*status[ \t]*:[^\n]*/gm) ?? []).map(l => l.trim());
}

// Only fire when the edit actually CHANGES a `status:` line. An edit whose
// old/new strings both carry the same `status:` line is using it as anchor
// context (e.g. adding a `summary:` field above it) — warning on those taught
// sessions to ignore the rule (the health-repo repeat offenses were exactly
// this false positive).
function evalEdit(input, config, deps = {}) {
  const filePath = input?.file_path;
  if (!isManagedDoc(filePath, config)) return null;

  const pairs = [];
  const newStr = input?.new_string ?? input?.new_str;
  if (typeof newStr === 'string') pairs.push([input?.old_string ?? input?.old_str ?? '', newStr]);
  for (const e of Array.isArray(input?.edits) ? input.edits : []) {
    if (typeof e?.new_string === 'string') pairs.push([e.old_string ?? '', e.new_string]);
  }
  if (typeof input?.content === 'string') {
    // Write replaces the whole file — diff against what's on disk. An
    // unreadable/missing target is doc creation, not a status edit.
    const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
    let existing;
    try { existing = readFile(filePath); } catch { existing = null; }
    if (typeof existing === 'string') pairs.push([existing, input.content]);
  }

  const changed = pairs.some(([oldS, newS]) => statusLines(oldS).join('\n') !== statusLines(newS).join('\n'));
  if (!changed) return null;
  return editStatusResult(filePath, config, filePath);
}

// Pure evaluation — `deps.isIgnored(path) -> bool` is injected so tests don't
// need a real git tree. Returns null (no opinion) or a result object.
export function evaluateGuard(payload, config, deps = {}) {
  if (process.env.DOTMD_GUARD === '0') return null;
  const tool = payload?.tool_name;
  const input = payload?.tool_input || {};
  const isIgnored = deps.isIgnored || ((p) => isGitIgnored(p, config?.repoRoot));

  if (tool === 'Bash') return evalBash(input.command || '', config, isIgnored);
  if (tool === 'Read') return evalRead(input.file_path || '');
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') return evalEdit(input, config, deps);
  return null;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', () => resolve(data));
      // Don't hang the tool dispatch if stdin never closes.
      setTimeout(() => resolve(data), 2000);
    } catch {
      resolve(data);
    }
  });
}

function emit(result) {
  if (!result) {
    // No opinion — stay silent, let the tool run.
    process.stdout.write('{}\n');
    return;
  }
  const hookSpecificOutput = { hookEventName: 'PreToolUse' };
  if (result.decision === 'deny') {
    hookSpecificOutput.permissionDecision = 'deny';
    hookSpecificOutput.permissionDecisionReason = result.reason;
  } else {
    // warn — allow the call but teach the agent the dotmd-native path.
    hookSpecificOutput.additionalContext = `[dotmd] ${result.reason}`;
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput }) + '\n');
}

export async function runGuard(argv, config) {
  let payload = {};
  try {
    const raw = await readStdin();
    if (raw && raw.trim()) payload = JSON.parse(raw);
  } catch {
    payload = {};
  }

  let result = null;
  try {
    result = evaluateGuard(payload, config);
  } catch {
    result = null;
  }

  if (result) {
    recordGuardEvent({
      repo: config?.repoRoot,
      tool: payload?.tool_name,
      rule: result.rule,
      decision: result.decision,
      detail: result.detail,
      version: pkg.version,
    });
  }

  emit(result);
  // A guard must never fail the tool dispatch; always exit 0 and let the JSON
  // carry the decision.
  process.exitCode = 0;
}
