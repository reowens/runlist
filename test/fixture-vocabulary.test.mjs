import { describe, it } from 'node:test';
import { ok } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// dotmd is developed by running it against a large PRIVATE corpus, and this is
// a PUBLIC repo. The failure mode this guards is invisible in review: you
// measure the corpus, then write a fixture from what you just measured, and a
// real module name ships. It happened across seven test files and the changelog
// before anyone noticed.
//
// A denylist of private names cannot live here — publishing the list IS the
// leak. So this inverts it. The ALLOWLIST is the neutral vocabulary, which is
// safe to publish precisely because those words carry no information, and it
// catches a name nobody had yet identified as private the first time it is
// written. See docs/plans/sanitize-public-repo.md § Phase 5.
//
// Adding a word here is a deliberate act: it must be generic enough that
// nothing is learned from reading it. "preserve the shape, replace the words" —
// a fixture exists to exercise a shape, and any neutral noun exercises it
// identically.
const ALLOWED = new Set([
  // neutral fixture modules
  'atrium', 'beacon', 'catalog', 'gallery', 'kiosk', 'ledger', 'lobby', 'notify',
  'parcel', 'roster',
  // dotmd's own vocabulary — these name the tool, not anyone's product
  'dotmd', 'init', 'doctor', 'plans', 'prompts', 'docs',
  // deliberate placeholders and near-misses used by suggestion/typo tests
  'foo', 'bar', 'baz', 'other', 'mod', 'test', 'x', 'y', 'z', 'a', 'b', 'c',
  'kiosl', 'zzzzzzzzz', 'unknown', 'none', 'null', 'empty',
  // The consumer repo's own codename. Allowed deliberately: the leak is
  // content, not the relationship — a dozen files named it at 0.74.5, and the
  // sanitize plan ruled that naming the repo is not what has to go.
  'platform',
]);

// The forms a module value takes in these fixtures. Each is a real shape found
// in test/, not a guess: inline arrays, scalars (quoted or bare), YAML block
// items written as \n-escapes inside JS string literals, and CLI args.
// `LINE` requires the key to begin a YAML line — preceded by a real newline or
// by the \n escape a fixture uses inside a JS string literal. Without it the
// patterns also match ENGLISH: test titles like "migrates singular `module:` to
// plural `modules:` array" and assertions like "singular `module:` removed" fed
// `to`, `array` and `removed` in as module names. Frontmatter always puts the
// key at a line start, so this costs no real coverage.
const LINE = String.raw`(?:^|\\n)`;
const PATTERNS = [
  { re: new RegExp(`${LINE}modules?:[ \\t]*\\[([^\\]]*)\\]`, 'gm'), split: true },
  { re: new RegExp(`${LINE}modules?:[ \\t]*'([a-z][a-z0-9-]*)'`, 'gm') },
  { re: new RegExp(`${LINE}modules?:[ \\t]*"([a-z][a-z0-9-]*)"`, 'gm') },
  // Bare scalar. The terminator is a negative lookahead rather than an
  // end-of-line anchor: a fixture is usually mid-string-literal, so the value
  // is followed by a quote or a \n escape, not by a real line end.
  { re: new RegExp(`${LINE}modules?:[ \\t]*([a-z][a-z0-9-]*)(?![a-z0-9-])`, 'gm') },
  { re: new RegExp(`${LINE}modules?:\\\\n[ \\t]*-[ \\t]*([a-z][a-z0-9-]*)`, 'gm') },
  { re: /'--module',[ \t]*'([a-z][a-z0-9-]*)'/g },
];

function modulesValuesIn(text) {
  const found = new Set();
  for (const { re, split } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const raw = m[1] ?? '';
      for (const piece of split ? raw.split(',') : [raw]) {
        // Quotes and their backslash escapes both go: a fixture inside a
        // double-quoted JS string writes `modules: [\"name\"]`, so stripping
        // only bare quotes left `\"name\"` unmatched and silently unchecked.
        // And `mod-${i % 2}` reaches here as `mod-`, the literal prefix of a
        // generated name — the prefix is the part a human chose, so it is the
        // part that needs vetting; normalize the dangling hyphen away.
        const word = piece.trim().replace(/[\\'"]/g, '').replace(/-+$/, '').toLowerCase();
        if (/^[a-z][a-z0-9-]*$/.test(word)) found.add(word);
      }
    }
  }
  return found;
}

describe('test fixture vocabulary', () => {
  it('uses only neutral module names', () => {
    const dir = import.meta.dirname;
    const offenders = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.test.mjs') || entry === 'fixture-vocabulary.test.mjs') continue;
      const text = readFileSync(path.join(dir, entry), 'utf8');
      for (const word of modulesValuesIn(text)) {
        if (!ALLOWED.has(word)) offenders.push(`${entry}: ${word}`);
      }
    }
    ok(offenders.length === 0,
      `Module fixture values not in the neutral allowlist:\n  ${offenders.join('\n  ')}\n\n` +
      'If this is a real product/module name, rename the fixture — a neutral word exercises\n' +
      'the same shape. If it is genuinely generic, add it to ALLOWED in this file.');
  });
});
