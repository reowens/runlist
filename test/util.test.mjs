import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import {
  escapeTable,
  asString,
  capitalize,
  truncate,
  normalizeStringList,
  normalizeBlockers,
  mergeUniqueStrings,
} from '../src/util.mjs';

describe('escapeTable', () => {
  it('escapes pipe characters', () => {
    strictEqual(escapeTable('foo | bar'), 'foo \\| bar');
  });

  it('handles strings without pipes', () => {
    strictEqual(escapeTable('no pipes'), 'no pipes');
  });

  it('coerces non-strings', () => {
    strictEqual(escapeTable(42), '42');
  });
});

describe('asString', () => {
  it('returns trimmed string', () => {
    strictEqual(asString('  hello  '), 'hello');
  });

  it('returns null for empty string', () => {
    strictEqual(asString(''), null);
  });

  it('returns null for whitespace-only string', () => {
    strictEqual(asString('   '), null);
  });

  it('returns null for non-string', () => {
    strictEqual(asString(42), null);
    strictEqual(asString(null), null);
    strictEqual(asString(undefined), null);
  });
});

describe('capitalize', () => {
  it('capitalizes first letter', () => {
    strictEqual(capitalize('active'), 'Active');
  });

  it('handles already capitalized', () => {
    strictEqual(capitalize('Active'), 'Active');
  });

  it('handles single character', () => {
    strictEqual(capitalize('a'), 'A');
  });
});

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    strictEqual(truncate('short', 10), 'short');
  });

  it('truncates long strings with ellipsis', () => {
    strictEqual(truncate('this is a long string', 10), 'this is...');
  });

  it('returns string at exact max length', () => {
    strictEqual(truncate('exact', 5), 'exact');
  });
});

describe('normalizeStringList', () => {
  it('passes through arrays, trims + filters', () => {
    deepStrictEqual(normalizeStringList(['foo', ' bar ', '', 'baz']), ['foo', 'bar', 'baz']);
  });

  it('wraps a single string in array', () => {
    deepStrictEqual(normalizeStringList('foo'), ['foo']);
  });

  it('returns empty array for empty string', () => {
    deepStrictEqual(normalizeStringList(''), []);
  });

  it('returns empty array for non-string non-array', () => {
    deepStrictEqual(normalizeStringList(null), []);
    deepStrictEqual(normalizeStringList(undefined), []);
  });
});

describe('normalizeBlockers', () => {
  it('passes through array of blockers', () => {
    deepStrictEqual(normalizeBlockers(['blocker1', 'blocker2']), ['blocker1', 'blocker2']);
  });

  it('wraps a string in array', () => {
    deepStrictEqual(normalizeBlockers('blocked by X'), ['blocked by X']);
  });

  it('returns empty array for falsy', () => {
    deepStrictEqual(normalizeBlockers(null), []);
    deepStrictEqual(normalizeBlockers(''), []);
  });
});

describe('mergeUniqueStrings', () => {
  it('deduplicates across lists', () => {
    deepStrictEqual(mergeUniqueStrings(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
  });

  it('filters falsy values', () => {
    deepStrictEqual(mergeUniqueStrings(['a', null, ''], ['b', undefined]), ['a', 'b']);
  });

  it('handles empty input', () => {
    deepStrictEqual(mergeUniqueStrings([], []), []);
  });
});
