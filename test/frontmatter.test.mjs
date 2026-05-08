import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { extractFrontmatter, parseSimpleFrontmatter, replaceFrontmatter } from '../src/frontmatter.mjs';

describe('extractFrontmatter', () => {
  it('extracts frontmatter and body', () => {
    const raw = '---\nstatus: active\n---\n# Hello\n';
    const { frontmatter, body } = extractFrontmatter(raw);
    strictEqual(frontmatter, 'status: active');
    strictEqual(body, '# Hello\n');
  });

  it('returns empty frontmatter when no opening fence', () => {
    const raw = '# No frontmatter\nSome text.';
    const { frontmatter, body } = extractFrontmatter(raw);
    strictEqual(frontmatter, '');
    strictEqual(body, raw);
  });

  it('returns empty frontmatter when no closing fence', () => {
    const raw = '---\nstatus: active\n# Missing closing fence';
    const { frontmatter, body } = extractFrontmatter(raw);
    strictEqual(frontmatter, '');
    strictEqual(body, raw);
  });

  it('handles multiline frontmatter', () => {
    const raw = '---\nstatus: active\nupdated: 2025-01-01\nmodule: catalog\n---\nBody text.';
    const { frontmatter, body } = extractFrontmatter(raw);
    strictEqual(frontmatter, 'status: active\nupdated: 2025-01-01\nmodule: catalog');
    strictEqual(body, 'Body text.');
  });

  it('handles empty body after frontmatter', () => {
    const raw = '---\nstatus: active\n---\n';
    const { frontmatter, body } = extractFrontmatter(raw);
    strictEqual(frontmatter, 'status: active');
    strictEqual(body, '');
  });
});

describe('parseSimpleFrontmatter', () => {
  it('parses key-value pairs', () => {
    const result = parseSimpleFrontmatter('status: active\nupdated: 2025-01-01');
    deepStrictEqual(result, { status: 'active', updated: '2025-01-01' });
  });

  it('parses boolean values', () => {
    const result = parseSimpleFrontmatter('draft: true\npublished: false');
    deepStrictEqual(result, { draft: true, published: false });
  });

  it('strips surrounding quotes', () => {
    const result = parseSimpleFrontmatter("title: 'My Title'\nsummary: \"A summary\"");
    deepStrictEqual(result, { title: 'My Title', summary: 'A summary' });
  });

  it('parses YAML lists', () => {
    const result = parseSimpleFrontmatter('modules:\n  - catalog\n  - ledger\n  - roster');
    deepStrictEqual(result, { modules: ['catalog', 'ledger', 'roster'] });
  });

  it('handles empty list (key with no inline value)', () => {
    const result = parseSimpleFrontmatter('blockers:\nstatus: active');
    deepStrictEqual(result, { blockers: [], status: 'active' });
  });

  it('handles mixed scalars and lists', () => {
    const result = parseSimpleFrontmatter('status: active\nsurfaces:\n  - web\n  - ios\nmodule: catalog');
    deepStrictEqual(result, { status: 'active', surfaces: ['web', 'ios'], module: 'catalog' });
  });

  it('skips blank lines', () => {
    const result = parseSimpleFrontmatter('status: active\n\nupdated: 2025-01-01');
    deepStrictEqual(result, { status: 'active', updated: '2025-01-01' });
  });

  it('handles hyphenated keys', () => {
    const result = parseSimpleFrontmatter('current_state: Phase 1 done\nnext_step: Start Phase 2');
    deepStrictEqual(result, { current_state: 'Phase 1 done', next_step: 'Start Phase 2' });
  });

  it('keeps first value for duplicate keys', () => {
    const result = parseSimpleFrontmatter('status: active\nmodule: catalog\nstatus: archived');
    strictEqual(result.status, 'active');
  });

  it('emits a warning when an optional warnings array is passed and a key duplicates', () => {
    const warnings = [];
    parseSimpleFrontmatter('status: active\nstatus: archived', warnings);
    strictEqual(warnings.length, 1);
    strictEqual(warnings[0].key, 'status');
    strictEqual(warnings[0].line, 2);
    ok(warnings[0].message.includes('Duplicate frontmatter key'),
      `expected duplicate-key warning, got: ${warnings[0].message}`);
  });

  it('warns once per duplicate key even when key repeats more than twice', () => {
    const warnings = [];
    parseSimpleFrontmatter('status: a\nstatus: b\nstatus: c', warnings);
    strictEqual(warnings.length, 1, 'should not emit duplicate warnings for the same key');
  });

  it('warns separately for distinct duplicate keys', () => {
    const warnings = [];
    parseSimpleFrontmatter('status: a\nmodule: catalog\nstatus: b\nmodule: ledger', warnings);
    strictEqual(warnings.length, 2);
    deepStrictEqual(warnings.map(w => w.key).sort(), ['module', 'status']);
  });

  it('also warns when a list-valued key is duplicated (silent bug case)', () => {
    const warnings = [];
    const result = parseSimpleFrontmatter(
      'related_plans:\n  - a.md\n  - b.md\nrelated_plans:\n  - c.md\n  - d.md',
      warnings,
    );
    deepStrictEqual(result.related_plans, ['a.md', 'b.md'],
      'first list wins (existing behavior preserved)');
    strictEqual(warnings.length, 1, 'duplicate list key surfaces a warning');
    strictEqual(warnings[0].key, 'related_plans');
  });

  it('omits warnings when no warnings array is passed (backward compatible)', () => {
    // No second argument — should not throw, behavior unchanged.
    const result = parseSimpleFrontmatter('status: a\nstatus: b');
    strictEqual(result.status, 'a');
  });

  it('preserves mismatched quotes as literal text', () => {
    const result = parseSimpleFrontmatter("title: 'hello\"");
    strictEqual(result.title, "'hello\"");
  });

  it('preserves single-char quote as literal text', () => {
    const result = parseSimpleFrontmatter("title: '");
    strictEqual(result.title, "'");
  });
});

describe('replaceFrontmatter', () => {
  it('replaces frontmatter content', () => {
    const raw = '---\nstatus: active\n---\n# Hello\n';
    const result = replaceFrontmatter(raw, 'status: archived');
    strictEqual(result, '---\nstatus: archived\n---\n# Hello\n');
  });

  it('preserves body that contains --- horizontal rules', () => {
    const raw = '---\nstatus: active\n---\n# Title\n\n---\n\nMore content.\n';
    const result = replaceFrontmatter(raw, 'status: ready');
    strictEqual(result, '---\nstatus: ready\n---\n# Title\n\n---\n\nMore content.\n');
  });

  it('returns raw text unchanged when no opening fence', () => {
    const raw = '# No frontmatter\nBody text.';
    const result = replaceFrontmatter(raw, 'status: active');
    strictEqual(result, raw);
  });

  it('returns raw text unchanged when no closing fence', () => {
    const raw = '---\nstatus: active\n# Unclosed';
    const result = replaceFrontmatter(raw, 'status: ready');
    strictEqual(result, raw);
  });
});
