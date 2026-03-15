import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { extractFrontmatter, parseSimpleFrontmatter } from '../src/frontmatter.mjs';

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
});
