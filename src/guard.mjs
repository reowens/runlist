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
//            moves that are guaranteed-wrong (committing a gitignored prompt — it
//            would fail anyway).
//   'warn' — let the call proceed but inject teaching context so the agent learns
//            the dotmd-native command. Used for soft mistakes (cat/Read of a
//            prompt, hand-editing a status field) where a human might legitimately
//            do it; we nudge rather than block.

const SHELL_READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'bat', 'view', 'open']);

// A path that ends in .md and sits under a `prompts/` directory is a saved
// prompt regardless of which doc root it belongs to — robust across repos
// without needing the resolved config.
function isPromptPath(p) {
  return typeof p === 'string' && p.endsWith('.md') && /(^|\/)prompts\//.test(p);
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

const STATUS_LINE = /^\s*status\s*:/m;

function evalEdit(input, config) {
  const filePath = input?.file_path;
  if (!isManagedDoc(filePath, config)) return null;
  // Only fire when the edit actually touches a `status:` frontmatter line.
  const candidates = [input?.new_string, input?.content, input?.new_str]
    .filter(s => typeof s === 'string');
  if (!candidates.some(s => STATUS_LINE.test(s))) return null;
  return {
    decision: 'warn',
    rule: 'edit-status',
    detail: filePath,
    reason:
      `Looks like a hand-edit of the \`status:\` field in ${filePath}. Use \`dotmd set <status> ${filePath}\` instead — ` +
      `it validates the status against this doc's type, runs lifecycle hooks, fixes refs, and keeps the index in sync. Direct edits skip all of that.`,
  };
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
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') return evalEdit(input, config);
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
