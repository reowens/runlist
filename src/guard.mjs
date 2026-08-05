import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectGitCommandPaths } from './git.mjs';
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

// Normalize path separators so the guard's `/`-based matching also fires on
// Windows backslash paths (`docs\prompts\foo.md`). Without this the PreToolUse
// status-edit/commit-prompt guards silently no-op on Windows — protection
// absent exactly where it's needed. On POSIX paths this is a no-op.
function toSlash(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : p;
}

// A path that ends in .md and sits under a `prompts/` directory is a
// session-local saved prompt regardless of which doc root it belongs to —
// robust across repos without needing the resolved config. Archived prompts
// (`…/prompts/archived/…`, the default nested archive for the prompt type) are
// committable history, NOT session-local, so they're explicitly excluded — the
// guard must not block committing or reading them.
function isPromptPath(p, config) {
  const s = toSlash(p);
  if (typeof s !== 'string' || !s.endsWith('.md')) return false;
  if (!/(^|\/)prompts\//.test(s)) return false;
  const archiveDir = toSlash(config?.archiveDir || 'archived').replace(/^\/+|\/+$/g, '');
  if (archiveDir && s.split('/').includes(archiveDir)) return false;
  return true;
}

// Loose "is this a dotmd-managed doc" test: a .md file under one of the
// configured doc roots (default `docs/`). Used for the status-edit guard.
function isManagedDoc(p, config) {
  const s = toSlash(p);
  if (typeof s !== 'string' || !s.endsWith('.md')) return false;
  const roots = config?.docsRoots || (config?.docsRoot ? [config.docsRoot] : ['docs']);
  return roots.some(r => {
    const rNorm = toSlash(r).replace(/\/+$/, '');
    const base = rNorm.split('/').pop();
    return s.includes(`/${base}/`) || s.startsWith(`${base}/`) || s.includes(rNorm);
  });
}

// Minimal shell lexer: preserve quoted/escaped spaces and drop quote syntax so
// command/path decisions operate on argument boundaries rather than whitespace.
function shellTokens(command) {
  if (typeof command !== 'string') return [];
  const tokens = [];
  let token = '';
  let quote = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (escaped) { token += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") {
      const next = command[i + 1];
      if (next && /[\s'"\\|&;]/.test(next)) escaped = true;
      else token += char;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) {
      if (token) { tokens.push(token); token = ''; }
      continue;
    }
    token += char;
  }
  if (escaped) token += '\\';
  if (token) tokens.push(token);
  return tokens;
}

// Drop heredoc bodies, keeping the command line that opens them. Heredoc
// bodies are document content — resume-prompt drafts routinely mention
// `docs/prompts/…` paths and even describe the guard's own rules, and none of
// that is the *command* doing anything.
function stripHeredocBodies(command) {
  if (typeof command !== 'string' || !command.includes('<<')) return command;
  const lines = command.split('\n');
  const out = [];
  let marker = null;
  for (const line of lines) {
    if (marker !== null) {
      if (line.trim() === marker) marker = null;
      continue;
    }
    out.push(line);
    const m = line.match(/<<-?\s*(['"]?)(\w+)\1/);
    if (m) marker = m[2];
  }
  return out.join('\n');
}

// Split a compound command into independently-evaluated segments. Each side of
// a pipe / && / || / ; / newline runs its own program, so a rule should only
// fire on the segment whose program actually touches the prompt — `dotmd check
// docs/prompts/x.md; git commit -- docs/plans/y.md` commits no prompt.
function shellSegments(command) {
  const input = stripHeredocBodies(command);
  const segments = [];
  let segment = '';
  let quote = null;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (escaped) { segment += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { segment += char; escaped = true; continue; }
    if (quote) {
      segment += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; segment += char; continue; }
    const pair = input.slice(i, i + 2);
    if (char === ';' || char === '\n' || char === '|' || pair === '&&') {
      if (segment.trim()) segments.push(segment.trim());
      segment = '';
      if (pair === '&&' || pair === '||') i += 1;
      continue;
    }
    segment += char;
  }
  if (segment.trim()) segments.push(segment.trim());
  return segments;
}

function executableIndex(tokens) {
  let i = 0;
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
  let unwrapping = true;
  while (unwrapping) {
    while (assignment.test(tokens[i] ?? '')) i += 1;
    if (tokens[i] === 'env') {
      i += 1;
      while (i < tokens.length) {
        if (tokens[i] === '-u' || tokens[i] === '--unset') { i += 2; continue; }
        if (tokens[i].startsWith('-') || assignment.test(tokens[i])) { i += 1; continue; }
        break;
      }
      continue;
    }
    if (tokens[i] === 'command') {
      i += 1;
      while (tokens[i]?.startsWith('-')) i += 1;
      continue;
    }
    if (tokens[i] === 'sudo') {
      i += 1;
      while (tokens[i]?.startsWith('-')) {
        if (['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--chdir'].includes(tokens[i])) i += 2;
        else i += 1;
      }
      continue;
    }
    unwrapping = false;
  }
  return i;
}

function parseGitInvocation(tokens, baseCwd) {
  let i = executableIndex(tokens);
  if (path.basename(tokens[i] ?? '') !== 'git') return null;
  i += 1;
  let cwd = baseCwd;
  const valueOptions = new Set(['-c', '--namespace', '--super-prefix', '--config-env']);
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const option = tokens[i];
    if (option === '-C' && tokens[i + 1]) {
      cwd = path.resolve(cwd, tokens[i + 1]);
      i += 2;
    } else if (option.startsWith('-C') && option.length > 2) {
      cwd = path.resolve(cwd, option.slice(2));
      i += 1;
    } else if (option === '--git-dir' || option === '--work-tree'
      || option.startsWith('--git-dir=') || option.startsWith('--work-tree=')) {
      return null; // non-standard repository context: fail open rather than inspect the wrong tree
    } else if (valueOptions.has(option)) i += 2;
    else i += 1;
  }
  const subcommand = tokens[i];
  if (!/^(add|commit|stage)$/.test(subcommand ?? '')) return null;
  return { subcommand, args: tokens.slice(i + 1), cwd };
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

function evalBash(command, config, inspectGitPaths, baseCwd) {
  const segments = shellSegments(command);
  let cwd = baseCwd;

  for (const seg of segments) {
    const segTokens = shellTokens(seg);
    if (!segTokens.length) continue;
    const commandIndex = executableIndex(segTokens);
    const cmd0 = path.basename(segTokens[commandIndex] ?? '');
    const promptTokens = segTokens.filter(token => isPromptPath(token, config));
    if (cmd0 === 'cd' && segTokens[commandIndex + 1]) {
      cwd = path.resolve(cwd, segTokens[commandIndex + 1]);
      continue;
    }

    // Rule A — deny only when Git's current state says the command would
    // actually include a live prompt. This covers broad forms (`add .`, `-A`,
    // pathless commit, commit -a) without blocking ignored or clean prompts.
    const git = parseGitInvocation(segTokens, cwd);
    if (git) {
      const includedPaths = inspectGitPaths(git.subcommand, git.args, git.cwd);
      const targets = [...new Set(includedPaths.filter(candidate => isPromptPath(candidate, config)))];
      if (targets.length > 0) {
        return {
          decision: 'deny',
          rule: 'commit-prompt',
          detail: `git ${git.subcommand} ${targets.join(' ')}`,
          reason:
            `Saved prompts (${targets.join(', ')}) are session-local dotmd artifacts, not source to commit. ` +
            `Don't git add/commit them — commit your other changes without the prompt in the pathspec. ` +
            `The next session consumes a prompt with \`dotmd use <file>\` (or \`dotmd use\` for the oldest pending), which prints the body and archives it atomically.`,
        };
      }
    }

    // Rule B — reading a prompt through the shell instead of consuming it.
    if (SHELL_READERS.has(cmd0) && promptTokens.length) {
      return {
        decision: 'warn',
        rule: 'cat-prompt',
        detail: `${cmd0} ${promptTokens.join(' ')}`,
        reason:
          `${promptTokens.join(', ')} is a saved dotmd prompt. To start work from it, run \`dotmd use ${promptTokens[0]}\` — ` +
          `it commits archive/claim before at-most-once body output (prevents double-consumption). ` +
          `Just peeking or triaging (not consuming)? \`dotmd prompts show ${promptTokens[0]}\` reads it without archiving. Don't \`${cmd0}\` it directly.`,
      };
    }

    // Rule C — only an actual in-place stream-editor invocation can be a
    // status edit. Quoted prose printed by echo/printf is not executable code.
    if (/^(?:sed|perl|g?awk)$/.test(cmd0) && /status/.test(seg)
      && STREAM_EDITOR_INPLACE.some(re => re.test(seg))) {
      const managed = segTokens.filter(token => isManagedDoc(token, config));
      if (managed.length > 0) return editStatusResult(managed[0], config, `status-edit ${managed[0]}`);
    }
  }

  return null;
}

function evalRead(filePath, config) {
  if (!isPromptPath(filePath, config)) return null;
  return {
    decision: 'warn',
    rule: 'read-prompt',
    detail: filePath,
    reason:
      `${filePath} is a saved dotmd prompt. To start work from it, run \`dotmd use ${filePath}\` — it commits archive/claim before at-most-once body output so it can't be double-consumed. ` +
      `Just peeking or triaging (not consuming)? \`dotmd prompts show ${filePath}\` reads it without archiving. ` +
      `Surveying the whole queue? \`dotmd prompts show --all\` peeks every pending prompt in one call — don't Read them file by file.`,
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
  if (!config?.configFound) return null;
  const tool = payload?.tool_name;
  const input = payload?.tool_input || {};
  const inspectGitPaths = deps.inspectGitPaths
    || ((subcommand, args, cwd) => inspectGitCommandPaths(subcommand, args, cwd ?? deps.gitCwd ?? process.cwd()));

  if (tool === 'Bash') return evalBash(input.command || '', config, inspectGitPaths, deps.gitCwd ?? process.cwd());
  if (tool === 'Read') return evalRead(input.file_path || '', config);
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
      // Don't hang the tool dispatch if stdin never closes. unref() so the
      // timer can't hold the event loop open — without it every guard
      // invocation lingered the full 2s AFTER answering, which added ~2s of
      // dead latency to every guarded tool call in every session.
      setTimeout(() => resolve(data), 2000).unref();
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

export async function runGuard(argv, config, opts = {}) {
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

  if (result && !opts.dryRun) {
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
