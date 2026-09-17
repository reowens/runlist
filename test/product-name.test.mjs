import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The product prints `runlist`. Every string the CLI can print, write or show in
// help lives in a string literal under src/ or bin/ (plus the npm postinstall
// script), so this scans exactly those literals — comments are free to explain
// legacy behavior — and fails on any `dotmd` the allowlist below does not name.
//
// A `dotmd` is allowed for one of two reasons only:
//   1. IDENTITY — something that still exists under that name (the npm
//      package, the GitHub repo, the Claude Code plugin and its files, the
//      `dotmd` executable alias, the OpenCode file name).
//   2. LEGACY READER — a name an older build wrote and this one must keep
//      reading (config files, env vars, state dir, banners, logs, markers).
// Adding an entry for any other reason is how the old name creeps back into
// output; print `runlist` (PRODUCT_NAME in src/naming.mjs) instead.

const ROOT = path.resolve(import.meta.dirname, '..');

const ALLOWED = [
  // 1. IDENTITY
  { re: /dotmd-cli/g, why: 'npm package name (renamed in a later phase)' },
  { re: /dotmd@dotmd/g, why: 'Claude Code plugin id' },
  { re: /reowens\/dotmd/g, why: 'GitHub repository / plugin marketplace source' },
  { re: /\bdotmd\.js\b/g, why: 'installed OpenCode plugin file name' },
  { re: /\/dotmd\.mjs\b/g, why: 'bin/dotmd.mjs, the shared implementation file' },
  { re: /\brl dotmd\b/g, why: 'shell completions register the `dotmd` executable alias' },
  { re: /\bDotmdError\b/g, why: 'exported error class name (public API)' },
  { re: /\bdotmd\.agent-context\b/g, why: 'agent-context JSON schema name — a machine contract' },
  { re: /\bdotmd-export\b/g, why: 'default HTML export directory — renaming would strand existing ignore rules' },
  { re: /dotmd:git-metadata:commit/g, why: 'private git-log record sentinel, never printed' },
  // 2. LEGACY READER
  { re: /DOTMD_[A-Z_]*/g, why: 'legacy environment variables, still honored' },
  { re: /\.dotmd\b/g, why: 'legacy state dir, artifact prefix and dot-config name' },
  { re: /\bdotmd\.config\.m?js\b/g, why: 'legacy config file names, still discovered' },
  { re: /dotmd-generated:/g, why: 'legacy generated-file banner, still recognized' },
  { re: /\bdotmd-(?:misuse|errors)\.log\b/g, why: 'legacy global log names, still read' },
  { re: /__dotmd\b/g, why: 'legacy HTML export fallback directory, still reserved' },
  { re: /migrated-from-dotmd\.json/g, why: 'state-migration marker, keeps its name' },
  { re: /dotmd:canonical-workflow/g, why: 'legacy canonical-workflow marker, still read' },
  { re: /GENERATED:dotmd:(?:start|end)/g, why: 'index block markers already present in existing docs' },
  { re: /\bdotmd_version\b/g, why: 'prompt frontmatter key already present in existing prompts' },
];

// A literal that is exactly `dotmd`, in these files only.
const BARE_ALLOWED = new Map([
  ['src/naming.mjs', 'LEGACY_PRODUCT_NAME'],
  ['src/skill-drift.mjs', 'plugins/dotmd/skills/dotmd/SKILL.md path segments'],
  ['src/update.mjs', 'plugin marketplace name'],
  ['src/host-integration.mjs', 'plugin marketplace name'],
  ['bin/dotmd.mjs', 'tolerates a doubled `dotmd use` prefix typed via the alias'],
]);

const SCANNED = [
  ...readdirSync(path.join(ROOT, 'src')).filter(f => f.endsWith('.mjs')).map(f => `src/${f}`),
  'bin/dotmd.mjs',
  'bin/runlist.mjs',
  'scripts/postinstall.mjs',
];

// Minimal JS lexer: yields the text of every quoted string and every static
// part of a template literal, with its line. Comments and regex literals are
// skipped. Good enough for this codebase; a mis-lex shows up as a failure
// below, never as a silent pass, because the self-test pins known literals.
function stringLiterals(src) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  let prevSig = ''; // last significant char/token class for regex detection
  const templateStack = []; // brace depth at which each template's ${ opened
  let braceDepth = 0;
  const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', 'kw']);
  const KEYWORDS_BEFORE_EXPR = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

  function readTemplate(startLine) {
    // i points just after the backtick (or after a closing } of ${})
    let buf = '';
    let bufLine = startLine;
    const start = i;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { buf += src.slice(i, i + 2); if (src[i + 1] === '\n') line += 1; i += 2; continue; }
      if (c === '`') { out.push({ text: buf, line: bufLine, start, end: i }); i += 1; prevSig = 'str'; return; }
      if (c === '$' && src[i + 1] === '{') {
        out.push({ text: buf, line: bufLine, start, end: i });
        i += 2;
        templateStack.push(braceDepth);
        braceDepth += 1;
        prevSig = '{';
        return;
      }
      if (c === '\n') line += 1;
      buf += c;
      i += 1;
    }
  }

  while (i < n) {
    const c = src[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k += 1) if (src[k] === '\n') line += 1;
      i = stop;
      continue;
    }
    if (c === '#' && i === 0 && src[1] === '!') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '"' || c === "'") {
      const startLine = line;
      let buf = '';
      i += 1;
      const start = i;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') { buf += src.slice(i, i + 2); i += 2; continue; }
        if (src[i] === '\n') break;
        buf += src[i];
        i += 1;
      }
      const end = i;
      i += 1;
      out.push({ text: buf, line: startLine, start, end });
      prevSig = 'str';
      continue;
    }
    if (c === '`') { i += 1; readTemplate(line); continue; }
    if (c === '{') { braceDepth += 1; prevSig = '{'; i += 1; continue; }
    if (c === '}') {
      braceDepth -= 1;
      if (templateStack.length && templateStack[templateStack.length - 1] === braceDepth) {
        templateStack.pop();
        i += 1;
        readTemplate(line);
        continue;
      }
      prevSig = '}';
      i += 1;
      continue;
    }
    if (c === '/') {
      if (REGEX_PRECEDERS.has(prevSig)) {
        // regex literal
        i += 1;
        let inClass = false;
        while (i < n) {
          const d = src[i];
          if (d === '\\') { i += 2; continue; }
          if (d === '\n') break;
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { i += 1; break; }
          i += 1;
        }
        while (i < n && /[a-z]/i.test(src[i])) i += 1;
        prevSig = 'id';
        continue;
      }
      prevSig = '/';
      i += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j += 1;
      const word = src.slice(i, j);
      prevSig = KEYWORDS_BEFORE_EXPR.has(word) ? 'kw' : 'id';
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      while (i < n && /[\w.]/.test(src[i])) i += 1;
      prevSig = 'id';
      continue;
    }
    if (c === ')' || c === ']') { prevSig = 'id'; i += 1; continue; }
    prevSig = c;
    i += 1;
  }
  return out;
}

function unexplained(text, file) {
  if (text === 'dotmd') return BARE_ALLOWED.has(file) ? [] : ['dotmd'];
  const covered = new Array(text.length).fill(false);
  for (const { re } of ALLOWED) {
    for (const m of text.matchAll(re)) {
      for (let k = m.index; k < m.index + m[0].length; k += 1) covered[k] = true;
    }
  }
  const out = [];
  for (const m of text.matchAll(/dotmd/gi)) {
    if (!covered[m.index]) out.push(text.slice(Math.max(0, m.index - 30), m.index + 35).replace(/\s+/g, ' '));
  }
  return out;
}

describe('product name in output', () => {
  it('the lexer sees strings and skips comments and regexes', () => {
    const texts = stringLiterals([
      "// 'comment dotmd'",
      "const a = 'one' + \"two\";",
      'const b = `three ${a ? `four` : \'five\'} six`;',
      'const c = /dotmd\\/x/g.test(a) ? 1 : 2; /* block `dotmd` */',
      "const d = x / 2 / 'seven'.length;",
    ].join('\n')).map(l => l.text);
    deepStrictEqual(texts, ['one', 'two', 'three ', 'four', 'five', ' six', 'seven']);
  });

  it('no string literal in src/ or bin/ prints a non-allowlisted dotmd', () => {
    const offenders = [];
    for (const file of SCANNED) {
      const src = readFileSync(path.join(ROOT, file), 'utf8');
      for (const { text, line } of stringLiterals(src)) {
        for (const hit of unexplained(text, file)) offenders.push(`${file}:${line}: …${hit}…`);
      }
    }
    strictEqual(offenders.length, 0, `print \`runlist\`, or allowlist an identity/legacy reader:\n${offenders.join('\n')}`);
  });

  it('the scan actually reaches the help text', () => {
    const src = readFileSync(path.join(ROOT, 'bin/dotmd.mjs'), 'utf8');
    ok(stringLiterals(src).some(l => l.text.startsWith('runlist set <status>')));
  });

  it('every allowlist entry is still needed', () => {
    const texts = SCANNED.flatMap(file => stringLiterals(readFileSync(path.join(ROOT, file), 'utf8')).map(l => ({ file, text: l.text })));
    const unused = ALLOWED.filter(({ re }) => !texts.some(({ text }) => new RegExp(re.source).test(text))).map(({ re }) => re.source);
    deepStrictEqual(unused, []);
    const bareUnused = [...BARE_ALLOWED.keys()].filter(file => !texts.some(t => t.file === file && t.text === 'dotmd'));
    deepStrictEqual(bareUnused, []);
  });
});
