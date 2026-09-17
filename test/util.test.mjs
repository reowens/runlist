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
  suggestCandidates,
  levenshtein,
  levenshteinWithin,
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

describe('levenshteinWithin', () => {
  // The bounded walk exists only to answer the suggester's "within N edits?"
  // faster; if it ever disagrees with the exact matrix inside the limit, the
  // did-you-mean hints change silently. So it is checked against it directly,
  // over the shapes the band edges care about: equal lengths, every gap up to
  // one past the limit, empty strings, and transpositions.
  const alphabet = 'ab-c.md';
  const randomString = (rand, maxLength) => {
    let out = '';
    const length = Math.floor(rand() * (maxLength + 1));
    for (let i = 0; i < length; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
    return out;
  };

  it('agrees with the exact matrix at every limit', () => {
    let seed = 20260917;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let trial = 0; trial < 4000; trial++) {
      const a = randomString(rand, 12);
      const b = randomString(rand, 12);
      for (const limit of [0, 1, 2, 3, 5]) {
        const exact = levenshtein(a, b);
        const bounded = levenshteinWithin(a, b, limit);
        if (exact <= limit) strictEqual(bounded, exact, `within: ${JSON.stringify([a, b, limit])}`);
        else strictEqual(bounded, null, `beyond: ${JSON.stringify([a, b, limit])} exact=${exact}`);
      }
    }
  });

  it('handles empty strings and length gaps', () => {
    strictEqual(levenshteinWithin('', '', 3), 0);
    strictEqual(levenshteinWithin('', 'abc', 3), 3);
    strictEqual(levenshteinWithin('abc', '', 3), 3);
    strictEqual(levenshteinWithin('', 'abcd', 3), null);
    strictEqual(levenshteinWithin('abcd', '', 3), null);
    strictEqual(levenshteinWithin('plan.md', 'plan.md', 0), 0);
    strictEqual(levenshteinWithin('paln.md', 'plan.md', 2), 2);
  });

  it('does not reuse a row across calls', () => {
    strictEqual(levenshteinWithin('aaaaaaaaaa', 'aaaaaaaaaa', 3), 0);
    strictEqual(levenshteinWithin('zzzzzzzzzz', 'aaaaaaaaaa', 3), null);
    strictEqual(levenshteinWithin('aaaaaaaaaa', 'aaaaaaaaaa', 3), 0);
  });
});

describe('suggestCandidates', () => {
  it('returns substring matches first', () => {
    const r = suggestCandidates('auth', ['auth-revamp', 'authn-token', 'unrelated', 'storage']);
    ok(r.includes('auth-revamp'));
    ok(r.includes('authn-token'));
    ok(!r.includes('unrelated'));
  });

  it('falls back to Levenshtein distance for small typos', () => {
    const r = suggestCandidates('payents', ['payments', 'storage', 'cache']);
    ok(r.includes('payments'), `expected payments via fuzzy match, got: ${r.join(', ')}`);
  });

  it('skips Levenshtein matches when distance exceeds the threshold', () => {
    // Distance > 3 should not produce a suggestion (long target, short query).
    const r = suggestCandidates('xyz', ['comprehensive-onboarding-flow', 'unrelated']);
    deepStrictEqual(r, []);
  });

  it('returns at most `max` results', () => {
    const r = suggestCandidates('plan', ['plan-a', 'plan-b', 'plan-c', 'plan-d', 'plan-e'], 3);
    strictEqual(r.length, 3);
  });

  it('returns an empty array when no close matches', () => {
    const r = suggestCandidates('xyzzy', ['auth', 'storage', 'cache']);
    deepStrictEqual(r, []);
  });

  it('returns an empty array on empty input', () => {
    deepStrictEqual(suggestCandidates('', ['a', 'b']), []);
    deepStrictEqual(suggestCandidates('q', []), []);
  });

  it('drops exact matches (suggesting what the user typed is noise)', () => {
    const r = suggestCandidates('auth', ['auth', 'auth-revamp', 'storage']);
    ok(!r.includes('auth'));
  });
});
