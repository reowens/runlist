import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok, throws } from 'node:assert';
import {
  escapeTable,
  asString,
  capitalize,
  truncate,
  normalizeStringList,
  normalizeBlockers,
  mergeUniqueStrings,
  escapeRegex,
  die,
  DotmdError,
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

describe('escapeRegex', () => {
  it('escapes regex metacharacters', () => {
    strictEqual(escapeRegex('foo.bar*baz?'), 'foo\\.bar\\*baz\\?');
  });

  it('escapes brackets, parens, braces, and pipes', () => {
    strictEqual(escapeRegex('a(b)[c]{d}|e'), 'a\\(b\\)\\[c\\]\\{d\\}\\|e');
  });

  it('escapes caret, dollar, plus, and backslash', () => {
    strictEqual(escapeRegex('^start$+end\\'), '\\^start\\$\\+end\\\\');
  });

  it('passes alphanumeric strings through unchanged', () => {
    strictEqual(escapeRegex('hello123'), 'hello123');
  });
});

describe('DotmdError', () => {
  it('is an instance of Error', () => {
    const err = new DotmdError('test message');
    ok(err instanceof Error);
  });

  it('has name set to DotmdError', () => {
    const err = new DotmdError('test message');
    strictEqual(err.name, 'DotmdError');
  });

  it('stores the message', () => {
    const err = new DotmdError('something broke');
    strictEqual(err.message, 'something broke');
  });
});

describe('die', () => {
  it('throws a DotmdError', () => {
    throws(() => die('fatal error'), DotmdError);
  });

  it('throws with the correct message', () => {
    throws(() => die('bad input'), { message: 'bad input' });
  });
});
