import { describe, it, afterEach } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/config.mjs';
import {
  splitAtBoundary,
  replaceFrontmatterField,
  insertOrAppendSection,
  runFrontmatterFix,
} from '../src/frontmatter-fix.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from '../src/frontmatter.mjs';

// Characterization tests for the frontmatter-*rewriting* module. These lock the
// current behavior of the three exported pure helpers (the corruption-risk
// core) so the CRLF and guard fixes elsewhere can't silently regress them. The
// CLI happy-path is already covered by doctor.test.mjs (`doctor
// --frontmatter-fix`); here we pin the boundary cases and the orchestrator's
// skip branches that the happy-path fixtures never reach.

describe('splitAtBoundary', () => {
  it('returns the whole value as head when under target', () => {
    deepStrictEqual(splitAtBoundary('short text', 100), { head: 'short text', tail: '' });
  });

  it('splits at the last sentence boundary inside the window', () => {
    const value = 'First sentence. Second sentence here.';
    deepStrictEqual(splitAtBoundary(value, 20), {
      head: 'First sentence.',
      tail: 'Second sentence here.',
    });
  });

  it('falls back to the last whitespace when no sentence boundary lands in the back half', () => {
    const value = 'one two three four five six';
    deepStrictEqual(splitAtBoundary(value, 20), {
      head: 'one two three four',
      tail: 'five six',
    });
  });

  it('hard-cuts at target when no usable boundary exists in the back half', () => {
    // Only whitespace is at index 2 (front half) — below floor(target/2),
    // so neither the sentence nor the whitespace branch fires.
    const value = 'ab cdefghijklmnopqrstuvwxyz';
    deepStrictEqual(splitAtBoundary(value, 20), {
      head: 'ab cdefghijklmnopqrs',
      tail: 'tuvwxyz',
    });
  });

  it('ignores a sentence boundary that sits in the front half (too early)', () => {
    // The only `.` is at index 2; floor(target/2) = 10, so the sentence match
    // (length 3) is rejected and it falls through to the whitespace split.
    const value = 'ab. cdefgh ijklmnopq rstuvwxyz';
    const { head, tail } = splitAtBoundary(value, 20);
    ok(!head.endsWith('.'), `should not split on the early period; got head: ${head}`);
    strictEqual(`${head} ${tail}`.replace(/\s+/g, ' '), value.replace(/\s+/g, ' '));
  });
});

describe('replaceFrontmatterField', () => {
  it('replaces an inline scalar with a folded block scalar, preserving sibling keys and order', () => {
    const fm = 'type: plan\ncurrent_state: old value\nstatus: active';
    const out = replaceFrontmatterField(fm, 'current_state', 'new long value here');
    strictEqual(out, 'type: plan\ncurrent_state: >\n  new long value here\nstatus: active');
  });

  it('collapses internal whitespace of the new value onto one folded line', () => {
    const out = replaceFrontmatterField('current_state: x', 'current_state', 'a\n  b   c\nd');
    strictEqual(out, 'current_state: >\n  a b c d');
  });

  it('appends the field as a folded block scalar when the key is absent', () => {
    const out = replaceFrontmatterField('type: plan\nstatus: active', 'current_state', 'value');
    strictEqual(out, 'type: plan\nstatus: active\ncurrent_state: >\n  value');
  });

  it('consumes the existing multi-line block continuation, leaving no orphan lines', () => {
    const fm = 'current_state: >\n  line one\n  line two\nstatus: active';
    const out = replaceFrontmatterField(fm, 'current_state', 'replacement');
    strictEqual(out, 'current_state: >\n  replacement\nstatus: active');
    // Old continuation must be gone — and the result still round-trips.
    ok(!out.includes('line one') && !out.includes('line two'), 'old block lines removed');
    const parsed = parseSimpleFrontmatter(out);
    strictEqual(parsed.current_state, 'replacement');
    strictEqual(parsed.status, 'active');
  });

  it('replaces only the first occurrence when a key is duplicated', () => {
    const fm = 'current_state: first\ncurrent_state: second';
    const out = replaceFrontmatterField(fm, 'current_state', 'NEW');
    strictEqual(out, 'current_state: >\n  NEW\ncurrent_state: second');
  });
});

describe('insertOrAppendSection', () => {
  it('appends content to an existing section, before the next header', () => {
    const body = '# Title\n\n## Current State\n\nold para\n\n## Problem\n\nstuff';
    const out = insertOrAppendSection(body, '## Current State', 'new tail');
    ok(out.indexOf('old para') < out.indexOf('new tail'), 'new content lands after existing');
    ok(out.indexOf('new tail') < out.indexOf('## Problem'), 'new content stays inside its section');
    ok(out.includes('## Problem'), 'following section preserved');
  });

  it('inserts a new section just before the first H2 when absent', () => {
    const body = '# Title\n\n## Problem\n\nstuff';
    const out = insertOrAppendSection(body, '## Current State', 'tail');
    ok(out.includes('## Current State'), 'section added');
    ok(out.indexOf('## Current State') < out.indexOf('## Problem'), 'inserted above first H2');
    ok(out.includes('tail'), 'content present');
  });

  it('appends a new section at the end when no H2 exists', () => {
    const body = '# Title\n\nJust a paragraph.';
    const out = insertOrAppendSection(body, '## Next Step', 'tail');
    ok(out.includes('## Next Step'), 'section added');
    ok(out.indexOf('## Next Step') > out.indexOf('Just a paragraph.'), 'appended at end');
  });

  it('matches an existing heading case-insensitively', () => {
    const body = '# Title\n\n## current state\n\nold\n';
    const out = insertOrAppendSection(body, '## Current State', 'added');
    // No duplicate section is created — the existing one absorbs the content.
    const matches = out.match(/##\s+current state/gi) ?? [];
    strictEqual(matches.length, 1, `expected one Current State heading; got ${matches.length}`);
    ok(out.includes('added'), 'content appended to the existing section');
  });
});

describe('runFrontmatterFix (orchestration)', () => {
  let tmpDir;

  function setup(configExtra = '') {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-fmfix-unit-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    const docsDir = path.join(tmpDir, 'docs');
    mkdirSync(path.join(docsDir, 'plans'), { recursive: true });
    mkdirSync(path.join(docsDir, 'archived'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\n${configExtra}`);
    return docsDir;
  }

  function longText(min) {
    let s = '';
    let n = 0;
    while (s.length < min) { n++; s += `Point ${n} covers an aspect of the rollout. `; }
    return { text: s.trim(), last: n };
  }

  function fakeOut() {
    return { chunks: [], write(c) { this.chunks.push(String(c)); return true; }, toString() { return this.chunks.join(''); } };
  }

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fixes an over-cap plan field without dropping any text (no silent data loss)', async () => {
    const docsDir = setup();
    const { text, last } = longText(1700);
    const file = path.join(docsDir, 'plans', 'long.md');
    writeFileSync(file, `---\ntype: plan\nstatus: active\ncurrent_state: "${text}"\n---\n# Long\n\n## Problem\nBody.\n`);

    const config = await resolveConfig(tmpDir);
    const out = fakeOut();
    const { results } = runFrontmatterFix(config, { out });

    strictEqual(results.length, 1, 'one file fixed');
    const after = readFileSync(file, 'utf8');
    // Field is now a folded block scalar and re-parses under the cap.
    const { frontmatter } = extractFrontmatter(after);
    const parsed = parseSimpleFrontmatter(frontmatter);
    ok(parsed.current_state.length <= 1500, `field should be under cap; got ${parsed.current_state.length}`);
    ok(after.includes('## Current State'), 'overflow moved into a body section');
    // The head's first sentence and the tail's last sentence both survive.
    ok(after.includes('Point 1 '), 'head text preserved');
    ok(after.includes(`Point ${last} `), 'tail text preserved');
  });

  it('skips a non-plan doc even when a field is over cap', async () => {
    const docsDir = setup();
    const { text } = longText(1700);
    const file = path.join(docsDir, 'note.md');
    const before = `---\ntype: doc\nstatus: active\ncurrent_state: "${text}"\n---\n# Note\n`;
    writeFileSync(file, before);

    const config = await resolveConfig(tmpDir);
    const out = fakeOut();
    const { results } = runFrontmatterFix(config, { out });

    strictEqual(results.length, 0, 'non-plan docs are not rewritten');
    strictEqual(readFileSync(file, 'utf8'), before, 'file is byte-identical');
    ok(out.toString().includes('No over-cap'), 'reports nothing to fix');
  });

  it('leaves a doc with no frontmatter untouched', async () => {
    const docsDir = setup();
    const file = path.join(docsDir, 'plain.md');
    const before = '# Just markdown\n\nNo frontmatter here.\n';
    writeFileSync(file, before);

    const config = await resolveConfig(tmpDir);
    const { results } = runFrontmatterFix(config, { out: fakeOut() });

    strictEqual(results.length, 0);
    strictEqual(readFileSync(file, 'utf8'), before, 'file is byte-identical');
  });

  it('--dry-run reports the fix but writes nothing', async () => {
    const docsDir = setup();
    const { text } = longText(1700);
    const file = path.join(docsDir, 'plans', 'preview.md');
    const before = `---\ntype: plan\nstatus: active\ncurrent_state: "${text}"\n---\n# Preview\n\n## Problem\nBody.\n`;
    writeFileSync(file, before);

    const config = await resolveConfig(tmpDir);
    const { results } = runFrontmatterFix(config, { out: fakeOut(), dryRun: true });

    strictEqual(results.length, 1, 'dry-run still reports the would-be fix');
    strictEqual(readFileSync(file, 'utf8'), before, 'file untouched in dry-run');
  });
});
